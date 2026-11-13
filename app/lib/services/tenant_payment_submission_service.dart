import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'property_payment_details.dart';

const maxPaymentProofBytes = 5000000;

typedef PaymentProofProgress = void Function(int sentBytes, int totalBytes);
typedef PaymentProofCallable = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> payload,
);
typedef PaymentSubmissionCallable = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> payload,
);

class PreparedPaymentProofUpload {
  const PreparedPaymentProofUpload({
    required this.uploadIntentId,
    required this.uploadUrl,
    required this.uploadToken,
  });

  final String uploadIntentId;
  final Uri uploadUrl;
  final String uploadToken;
}

abstract interface class TenantPaymentSubmissionService {
  String get authenticatedTenantId;

  Stream<String?> get authenticatedUserChanges;

  Stream<PropertyPaymentDetails?> watchPropertyPaymentDetails(
    String propertyId,
  );

  Future<TenantPaymentSubmissionAttempt?> loadSubmissionAttempt(
    String rentChargeId,
  );

  Future<TenantPaymentSubmissionAttempt> saveSubmissionAttempt({
    required String expectedTenantId,
    required String rentChargeId,
    required String uploadIntentId,
    required String transactionRef,
    required String idempotencyKey,
    required PaymentSubmissionAttemptState state,
  });

  Future<void> clearSubmissionAttempt({
    required String expectedTenantId,
    required String rentChargeId,
  });

  Future<SubmittedUpiPayment> submitPayment({
    required String expectedTenantId,
    required String rentChargeId,
    required String uploadIntentId,
    required String transactionRef,
    required String idempotencyKey,
  });

  Future<PreparedPaymentProofUpload> prepareProofUpload({
    required String rentChargeId,
    required String idempotencyKey,
    required String format,
    required int bytes,
  });

  Future<void> uploadProof({
    required PreparedPaymentProofUpload permission,
    required List<int> bytes,
    required String format,
    required PaymentProofProgress onProgress,
  });
}

class FirebaseTenantPaymentSubmissionService
    implements TenantPaymentSubmissionService {
  FirebaseTenantPaymentSubmissionService({
    FirebaseFirestore? firestore,
    FirebaseFunctions? functions,
    FirebaseAuth? auth,
    String? Function()? uidProvider,
    TenantPaymentAttemptStorage? attemptStorage,
    http.Client? httpClient,
    PaymentProofCallable? prepareCallable,
    PaymentSubmissionCallable? submitCallable,
  }) : _firestore = firestore,
       _functions = functions,
       _auth = auth,
       _uidProvider = uidProvider,
       _attemptStorage = attemptStorage ?? SecureTenantPaymentAttemptStorage(),
       _httpClient = httpClient ?? http.Client(),
       _prepareCallable = prepareCallable,
       _submitCallable = submitCallable;

  final FirebaseFirestore? _firestore;
  final FirebaseFunctions? _functions;
  final FirebaseAuth? _auth;
  final String? Function()? _uidProvider;
  final TenantPaymentAttemptStorage _attemptStorage;
  final http.Client _httpClient;
  final PaymentProofCallable? _prepareCallable;
  final PaymentSubmissionCallable? _submitCallable;

  String _authenticatedUid() {
    final uid = _uidProvider?.call() ?? _auth?.currentUser?.uid;
    if (uid == null || uid.isEmpty) {
      throw const PaymentAttemptStorageException('User is not authenticated.');
    }
    return uid;
  }

  @override
  String get authenticatedTenantId => _authenticatedUid();

  @override
  Stream<String?> get authenticatedUserChanges =>
      (_auth ?? FirebaseAuth.instance).authStateChanges().map(
        (user) => user?.uid,
      );

  String _attemptStorageKey(String uid, String rentChargeId) {
    String encode(String value) =>
        base64Url.encode(utf8.encode(value)).replaceAll('=', '');
    return 'rently.tenant_upi_submission.v1.'
        '${encode(uid)}.${encode(rentChargeId)}';
  }

  @override
  Future<TenantPaymentSubmissionAttempt?> loadSubmissionAttempt(
    String rentChargeId,
  ) async {
    final uid = _authenticatedUid();
    final value = await _attemptStorage.read(
      _attemptStorageKey(uid, rentChargeId),
    );
    if (_authenticatedUid() != uid) {
      throw const PaymentAttemptStorageException(
        'The authenticated tenant changed during payment recovery.',
      );
    }
    if (value == null) return null;
    final attempt = TenantPaymentSubmissionAttempt.fromJson(jsonDecode(value));
    if (attempt.tenantId != uid || attempt.rentChargeId != rentChargeId) {
      throw const FormatException('Payment recovery data is for another bill.');
    }
    return attempt;
  }

  @override
  Future<TenantPaymentSubmissionAttempt> saveSubmissionAttempt({
    required String expectedTenantId,
    required String rentChargeId,
    required String uploadIntentId,
    required String transactionRef,
    required String idempotencyKey,
    required PaymentSubmissionAttemptState state,
  }) async {
    final uid = _authenticatedUid();
    if (uid != expectedTenantId) {
      throw const PaymentAttemptStorageException(
        'The authenticated tenant changed during payment recovery.',
      );
    }
    final attempt = TenantPaymentSubmissionAttempt(
      tenantId: uid,
      rentChargeId: rentChargeId,
      uploadIntentId: uploadIntentId,
      transactionRef: normalizeUtrReference(transactionRef),
      idempotencyKey: idempotencyKey,
      state: state,
    );
    TenantPaymentSubmissionAttempt.fromJson(attempt.toJson());
    await _attemptStorage.write(
      _attemptStorageKey(attempt.tenantId, rentChargeId),
      jsonEncode(attempt.toJson()),
    );
    return attempt;
  }

  @override
  Future<void> clearSubmissionAttempt({
    required String expectedTenantId,
    required String rentChargeId,
  }) async {
    final uid = _authenticatedUid();
    if (uid != expectedTenantId) {
      throw const PaymentAttemptStorageException(
        'The authenticated tenant changed during payment recovery.',
      );
    }
    await _attemptStorage.delete(_attemptStorageKey(uid, rentChargeId));
  }

  @override
  Stream<PropertyPaymentDetails?> watchPropertyPaymentDetails(
    String propertyId,
  ) {
    return (_firestore ?? FirebaseFirestore.instance)
        .collection('properties')
        .doc(propertyId)
        .snapshots()
        .map(
          (snapshot) => snapshot.exists
              ? PropertyPaymentDetails.fromMap(snapshot.data()!)
              : null,
        );
  }

  @override
  Future<SubmittedUpiPayment> submitPayment({
    required String expectedTenantId,
    required String rentChargeId,
    required String uploadIntentId,
    required String transactionRef,
    required String idempotencyKey,
  }) async {
    if (_authenticatedUid() != expectedTenantId) {
      throw const PaymentAttemptStorageException(
        'The authenticated tenant changed during payment submission.',
      );
    }
    final payload = {
      'rentChargeId': rentChargeId,
      'uploadIntentId': uploadIntentId,
      'transactionRef': transactionRef.trim(),
      'idempotencyKey': idempotencyKey,
    };
    late final Map<String, dynamic> data;
    try {
      data = _submitCallable != null
          ? await _submitCallable(payload)
          : (await (_functions ?? FirebaseFunctions.instance)
                    .httpsCallable('createUpiPayment')
                    .call<Map<String, dynamic>>(payload))
                .data;
    } on FirebaseFunctionsException catch (error) {
      throw _mapSubmissionException(error);
    }

    final paymentId = data['paymentId'];
    if (data['success'] != true ||
        paymentId is! String ||
        paymentId.isEmpty ||
        data['status'] != 'pending_verification') {
      throw const PaymentSubmissionException(
        PaymentSubmissionFailure.other,
        'The payment submission could not be confirmed. Retry safely.',
      );
    }
    return SubmittedUpiPayment(
      paymentId: paymentId,
      status: 'pending_verification',
    );
  }

  PaymentSubmissionException _mapSubmissionException(
    FirebaseFunctionsException error,
  ) {
    final message = (error.message ?? '').toLowerCase();
    if (error.code == 'failed-precondition' &&
        message.contains('upload intent') &&
        (message.contains('expired') || message.contains('unavailable'))) {
      return const PaymentSubmissionException(
        PaymentSubmissionFailure.expiredUploadIntent,
        'This proof upload has expired. Upload the screenshot again to '
        'continue.',
      );
    }
    if (error.code == 'already-exists' &&
        message.contains('utr/reference has already been used')) {
      return const PaymentSubmissionException(
        PaymentSubmissionFailure.duplicateUtr,
        'This UTR/reference was already used for this bill. Enter a different '
        'UTR before submitting.',
      );
    }
    if (error.code == 'failed-precondition' &&
        message.contains('only a due or overdue rent charge')) {
      return const PaymentSubmissionException(
        PaymentSubmissionFailure.billIneligible,
        'This bill is no longer due or overdue and cannot accept payment.',
      );
    }
    if (error.code == 'unavailable' || error.code == 'deadline-exceeded') {
      return const PaymentSubmissionException(
        PaymentSubmissionFailure.network,
        'Could not confirm the submission because of a connection issue. '
        'Retry; the same request key will be reused.',
      );
    }
    return const PaymentSubmissionException(
      PaymentSubmissionFailure.other,
      'Payment submission failed. Check the bill and try again.',
    );
  }

  @override
  Future<PreparedPaymentProofUpload> prepareProofUpload({
    required String rentChargeId,
    required String idempotencyKey,
    required String format,
    required int bytes,
  }) async {
    late final Map<String, dynamic> data;
    try {
      final payload = {
        'rentChargeId': rentChargeId,
        'idempotencyKey': idempotencyKey,
        'recipientNameConfirmed': true,
        'format': format,
        'bytes': bytes,
      };
      data = _prepareCallable != null
          ? await _prepareCallable(payload)
          : (await (_functions ?? FirebaseFunctions.instance)
                    .httpsCallable('preparePaymentProofUpload')
                    .call<Map<String, dynamic>>(payload))
                .data;
    } on FirebaseFunctionsException {
      throw const PaymentUploadException(
        'Could not prepare the proof upload. Check your bill and try again.',
      );
    }
    final uploadIntentId = data['uploadIntentId'];
    final uploadUrl = data['uploadUrl'];
    final uploadToken = data['uploadToken'];
    final uri = uploadUrl is String ? Uri.tryParse(uploadUrl) : null;
    if (uploadIntentId is! String ||
        uploadIntentId.isEmpty ||
        uri == null ||
        !_isSecureUploadUri(uri) ||
        uri.host.isEmpty ||
        uploadToken is! String ||
        uploadToken.isEmpty) {
      throw const PaymentUploadException(
        'The upload service returned an invalid permission. Please try again.',
      );
    }
    return PreparedPaymentProofUpload(
      uploadIntentId: uploadIntentId,
      uploadUrl: uri,
      uploadToken: uploadToken,
    );
  }

  @override
  Future<void> uploadProof({
    required PreparedPaymentProofUpload permission,
    required List<int> bytes,
    required String format,
    required PaymentProofProgress onProgress,
  }) async {
    if (bytes.isEmpty || bytes.length > maxPaymentProofBytes) {
      throw const PaymentUploadException(
        'Choose an image no larger than 5 MB.',
      );
    }
    final mimeType = switch (format) {
      'jpg' || 'jpeg' => 'image/jpeg',
      'png' => 'image/png',
      'webp' => 'image/webp',
      _ => throw const PaymentUploadException(
        'Choose a JPG, PNG, or WebP image.',
      ),
    };

    final request = http.StreamedRequest('POST', permission.uploadUrl)
      ..contentLength = bytes.length
      ..headers.addAll({
        'Authorization': 'Bearer ${permission.uploadToken}',
        'Content-Type': mimeType,
      });
    final responseFuture = _httpClient.send(request);
    onProgress(0, bytes.length);
    const chunkSize = 32 * 1024;
    for (var offset = 0; offset < bytes.length; offset += chunkSize) {
      final end = min(offset + chunkSize, bytes.length);
      request.sink.add(bytes.sublist(offset, end));
      onProgress(end, bytes.length);
    }
    await request.sink.close();

    late final http.StreamedResponse response;
    try {
      response = await responseFuture;
    } on http.ClientException {
      throw const PaymentUploadException(
        'Could not connect to the upload service. Check your connection and '
        'retry.',
      );
    }
    final body = await response.stream.bytesToString();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw PaymentUploadException(_responseError(body));
    }
    final decoded = _decodeResponse(body);
    if (decoded['success'] != true ||
        decoded['uploadIntentId'] != permission.uploadIntentId) {
      throw const PaymentUploadException(
        'The upload could not be confirmed. Retry the upload.',
      );
    }
  }

  bool _isSecureUploadUri(Uri uri) {
    if (uri.userInfo.isNotEmpty || uri.fragment.isNotEmpty) return false;
    if (uri.scheme == 'https' && uri.host.isNotEmpty) return true;
    return uri.scheme == 'http' &&
        const {'localhost', '127.0.0.1', '10.0.2.2'}.contains(uri.host);
  }

  String _responseError(String body) {
    final decoded = _decodeResponse(body);
    final error = decoded['error'];
    if (error is String && error.trim().isNotEmpty) {
      return error.trim();
    }
    return 'Proof upload failed. Check your connection and retry.';
  }

  Map<String, dynamic> _decodeResponse(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic>) return decoded;
    } on FormatException {
      // Use the generic upload error for non-JSON responses.
    }
    return const {};
  }
}

class PaymentUploadException implements Exception {
  const PaymentUploadException(this.message);

  final String message;

  @override
  String toString() => message;
}

enum PaymentSubmissionFailure {
  expiredUploadIntent,
  duplicateUtr,
  billIneligible,
  network,
  other,
}

class PaymentSubmissionException implements Exception {
  const PaymentSubmissionException(this.failure, this.message);

  final PaymentSubmissionFailure failure;
  final String message;

  @override
  String toString() => message;
}

class PaymentAttemptStorageException implements Exception {
  const PaymentAttemptStorageException(this.message);

  final String message;

  @override
  String toString() => message;
}

class SubmittedUpiPayment {
  const SubmittedUpiPayment({required this.paymentId, required this.status});

  final String paymentId;
  final String status;
}

enum PaymentSubmissionAttemptState {
  proofUploaded,
  submitting,
  uncertain,
  submitted,
}

class TenantPaymentSubmissionAttempt {
  const TenantPaymentSubmissionAttempt({
    required this.tenantId,
    required this.rentChargeId,
    required this.uploadIntentId,
    required this.transactionRef,
    required this.idempotencyKey,
    required this.state,
  });

  final String tenantId;
  final String rentChargeId;
  final String uploadIntentId;
  final String transactionRef;
  final String idempotencyKey;
  final PaymentSubmissionAttemptState state;

  Map<String, String> toJson() => {
    'tenantId': tenantId,
    'rentChargeId': rentChargeId,
    'uploadIntentId': uploadIntentId,
    'transactionRef': transactionRef,
    'idempotencyKey': idempotencyKey,
    'state': state.name,
  };

  factory TenantPaymentSubmissionAttempt.fromJson(Object? value) {
    if (value is! Map<String, dynamic>) {
      throw const FormatException('Invalid payment submission recovery data.');
    }
    final tenantId = value['tenantId'];
    final rentChargeId = value['rentChargeId'];
    final uploadIntentId = value['uploadIntentId'];
    final transactionRef = value['transactionRef'];
    final idempotencyKey = value['idempotencyKey'];
    final rawState = value['state'];
    PaymentSubmissionAttemptState? state;
    for (final candidate in PaymentSubmissionAttemptState.values) {
      if (candidate.name == rawState) {
        state = candidate;
        break;
      }
    }
    if (tenantId is! String ||
        tenantId.isEmpty ||
        rentChargeId is! String ||
        rentChargeId.isEmpty ||
        uploadIntentId is! String ||
        uploadIntentId.isEmpty ||
        transactionRef is! String ||
        normalizeUtrReference(transactionRef) != transactionRef ||
        validateUtrReference(transactionRef) != null ||
        idempotencyKey is! String ||
        idempotencyKey.isEmpty ||
        state == null) {
      throw const FormatException('Invalid payment submission recovery data.');
    }
    return TenantPaymentSubmissionAttempt(
      tenantId: tenantId,
      rentChargeId: rentChargeId,
      uploadIntentId: uploadIntentId,
      transactionRef: transactionRef,
      idempotencyKey: idempotencyKey,
      state: state,
    );
  }
}

abstract interface class TenantPaymentAttemptStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SecureTenantPaymentAttemptStorage implements TenantPaymentAttemptStorage {
  SecureTenantPaymentAttemptStorage({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

String normalizeUtrReference(String value) => value.trim().toUpperCase();

String? validateUtrReference(String value) {
  final trimmed = value.trim();
  if (!RegExp(r'^[A-Za-z0-9]{6,30}$').hasMatch(trimmed)) {
    return 'Enter a 6–30 character alphanumeric UTR/reference number.';
  }
  return null;
}

String? detectPaymentProofFormat(List<int> bytes) {
  if (bytes.length >= 3 &&
      bytes[0] == 0xff &&
      bytes[1] == 0xd8 &&
      bytes[2] == 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 8 &&
      const [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ].asMap().entries.every((entry) => bytes[entry.key] == entry.value)) {
    return 'png';
  }
  if (bytes.length >= 12 &&
      String.fromCharCodes(bytes.sublist(0, 4)) == 'RIFF' &&
      String.fromCharCodes(bytes.sublist(8, 12)) == 'WEBP') {
    return 'webp';
  }
  return null;
}

String createPaymentUploadIdempotencyKey() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0'));
  final value = hex.join();
  return '${value.substring(0, 8)}-${value.substring(8, 12)}-'
      '${value.substring(12, 16)}-${value.substring(16, 20)}-'
      '${value.substring(20)}';
}
