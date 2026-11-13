import 'dart:convert';
import 'dart:typed_data';

import 'package:app/services/tenant_payment_submission_service.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

class CapturingHttpClient extends http.BaseClient {
  CapturingHttpClient({
    this.statusCode = 200,
    this.responseBody = '{"success":true,"uploadIntentId":"intent-1"}',
  });

  final int statusCode;
  final String responseBody;
  http.BaseRequest? request;
  Uint8List? uploadedBytes;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    this.request = request;
    uploadedBytes = await request.finalize().toBytes();
    return http.StreamedResponse(
      Stream.value(utf8.encode(responseBody)),
      statusCode,
    );
  }
}

class MemoryPaymentAttemptStorage implements TenantPaymentAttemptStorage {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

void main() {
  test('validates trimmed UTRs at the 6 and 30 character boundaries', () {
    expect(validateUtrReference('  abc123  '), isNull);
    expect(validateUtrReference('A' * 30), isNull);
    expect(validateUtrReference('A' * 5), isNotNull);
    expect(validateUtrReference('A' * 31), isNotNull);
    expect(validateUtrReference('ABC-123'), isNotNull);
    expect(validateUtrReference('ABC 123'), isNotNull);
    expect(validateUtrReference(''), isNotNull);
  });

  test('detects supported image signatures and rejects other formats', () {
    expect(
      detectPaymentProofFormat(Uint8List.fromList([0xff, 0xd8, 0xff, 0x00])),
      'jpeg',
    );
    expect(
      detectPaymentProofFormat(
        Uint8List.fromList([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
      'png',
    );
    expect(
      detectPaymentProofFormat(Uint8List.fromList('RIFF0000WEBP'.codeUnits)),
      'webp',
    );
    expect(
      detectPaymentProofFormat(Uint8List.fromList('GIF89a'.codeUnits)),
      isNull,
    );
    expect(maxPaymentProofBytes, 5000000);
  });

  test('matches the callable and raw HTTPS upload endpoint contract', () async {
    final uploadedBytes = Uint8List.fromList([0x89, 0x50, 0x4e, 0x47]);
    final client = CapturingHttpClient();
    Map<String, dynamic>? callablePayload;
    final service = FirebaseTenantPaymentSubmissionService(
      httpClient: client,
      prepareCallable: (payload) async {
        callablePayload = payload;
        return {
          'uploadIntentId': 'intent-1',
          'uploadUrl': 'https://functions.example.test/uploadPaymentProof',
          'uploadToken': 'opaque-upload-token',
        };
      },
    );

    final permission = await service.prepareProofUpload(
      rentChargeId: 'bill-1',
      idempotencyKey: 'd75a980b-182b-4b1e-aed4-81cba8a454a2',
      format: 'png',
      bytes: uploadedBytes.length,
    );
    expect(callablePayload, {
      'rentChargeId': 'bill-1',
      'idempotencyKey': 'd75a980b-182b-4b1e-aed4-81cba8a454a2',
      'recipientNameConfirmed': true,
      'format': 'png',
      'bytes': uploadedBytes.length,
    });

    final progress = <(int, int)>[];
    await service.uploadProof(
      permission: permission,
      bytes: uploadedBytes,
      format: 'png',
      onProgress: (sent, total) => progress.add((sent, total)),
    );
    expect(client.request?.url, permission.uploadUrl);
    expect(
      client.request?.headers['Authorization'],
      'Bearer opaque-upload-token',
    );
    expect(client.request?.headers['Content-Type'], 'image/png');
    expect(client.uploadedBytes, uploadedBytes);
    expect(progress.first, (0, uploadedBytes.length));
    expect(progress.last, (uploadedBytes.length, uploadedBytes.length));
  });

  test('rejects a non-HTTPS upload endpoint outside local emulators', () async {
    final service = FirebaseTenantPaymentSubmissionService(
      prepareCallable: (_) async => {
        'uploadIntentId': 'intent-1',
        'uploadUrl': 'http://upload.example.test/proof',
        'uploadToken': 'opaque-upload-token',
      },
    );

    await expectLater(
      service.prepareProofUpload(
        rentChargeId: 'bill-1',
        idempotencyKey: 'd75a980b-182b-4b1e-aed4-81cba8a454a2',
        format: 'png',
        bytes: 42,
      ),
      throwsA(isA<PaymentUploadException>()),
    );
  });

  test('calls createUpiPayment with the exact backend payload', () async {
    Map<String, dynamic>? callablePayload;
    final service = FirebaseTenantPaymentSubmissionService(
      uidProvider: () => 'tenant-1',
      submitCallable: (payload) async {
        callablePayload = payload;
        return {
          'success': true,
          'paymentId': 'payment-1',
          'status': 'pending_verification',
        };
      },
    );

    final result = await service.submitPayment(
      expectedTenantId: 'tenant-1',
      rentChargeId: 'bill-1',
      uploadIntentId: 'a' * 64,
      transactionRef: ' ABC123 ',
      idempotencyKey: 'd75a980b-182b-4b1e-aed4-81cba8a454a2',
    );

    expect(callablePayload, {
      'rentChargeId': 'bill-1',
      'uploadIntentId': 'a' * 64,
      'transactionRef': 'ABC123',
      'idempotencyKey': 'd75a980b-182b-4b1e-aed4-81cba8a454a2',
    });
    expect(result.paymentId, 'payment-1');
    expect(result.status, 'pending_verification');
  });

  test(
    'recovers the same attempt only for the matching tenant and bill',
    () async {
      final storage = MemoryPaymentAttemptStorage();
      var tenantId = 'tenant-1';
      final firstService = FirebaseTenantPaymentSubmissionService(
        uidProvider: () => tenantId,
        attemptStorage: storage,
      );

      final saved = await firstService.saveSubmissionAttempt(
        rentChargeId: 'bill-1',
        uploadIntentId: 'intent-1',
        transactionRef: ' abc123 ',
        idempotencyKey: 'key-1',
        state: PaymentSubmissionAttemptState.uncertain,
        expectedTenantId: 'tenant-1',
      );

      final reopenedService = FirebaseTenantPaymentSubmissionService(
        uidProvider: () => tenantId,
        attemptStorage: storage,
      );
      final restored = await reopenedService.loadSubmissionAttempt('bill-1');
      expect(restored?.tenantId, saved.tenantId);
      expect(restored?.rentChargeId, saved.rentChargeId);
      expect(restored?.uploadIntentId, saved.uploadIntentId);
      expect(restored?.idempotencyKey, saved.idempotencyKey);
      expect(restored?.transactionRef, 'ABC123');
      expect(restored?.state, PaymentSubmissionAttemptState.uncertain);
      expect(
        await reopenedService.loadSubmissionAttempt('another-bill'),
        isNull,
      );

      tenantId = 'tenant-2';
      expect(await reopenedService.loadSubmissionAttempt('bill-1'), isNull);
      await expectLater(
        firstService.saveSubmissionAttempt(
          expectedTenantId: 'tenant-1',
          rentChargeId: 'bill-1',
          uploadIntentId: 'intent-2',
          transactionRef: 'XYZ789',
          idempotencyKey: 'key-2',
          state: PaymentSubmissionAttemptState.proofUploaded,
        ),
        throwsA(isA<PaymentAttemptStorageException>()),
      );
    },
  );

  test('clearing an attempt cannot delete another tenant attempt', () async {
    final storage = MemoryPaymentAttemptStorage();
    var tenantId = 'tenant-1';
    final service = FirebaseTenantPaymentSubmissionService(
      uidProvider: () => tenantId,
      attemptStorage: storage,
    );
    await service.saveSubmissionAttempt(
      expectedTenantId: 'tenant-1',
      rentChargeId: 'bill-1',
      uploadIntentId: 'intent-1',
      transactionRef: 'ABC123',
      idempotencyKey: 'key-1',
      state: PaymentSubmissionAttemptState.proofUploaded,
    );

    tenantId = 'tenant-2';
    await service.saveSubmissionAttempt(
      expectedTenantId: 'tenant-2',
      rentChargeId: 'bill-1',
      uploadIntentId: 'intent-2',
      transactionRef: 'XYZ789',
      idempotencyKey: 'key-2',
      state: PaymentSubmissionAttemptState.proofUploaded,
    );

    await expectLater(
      service.clearSubmissionAttempt(
        expectedTenantId: 'tenant-1',
        rentChargeId: 'bill-1',
      ),
      throwsA(isA<PaymentAttemptStorageException>()),
    );
    expect(
      (await service.loadSubmissionAttempt('bill-1'))?.uploadIntentId,
      'intent-2',
    );

    tenantId = 'tenant-1';
    expect(
      (await service.loadSubmissionAttempt('bill-1'))?.uploadIntentId,
      'intent-1',
    );
  });

  test('maps callable submission errors to actionable states', () async {
    final cases = [
      (
        code: 'failed-precondition',
        message: 'The payment proof upload intent is expired or unavailable.',
        failure: PaymentSubmissionFailure.expiredUploadIntent,
      ),
      (
        code: 'already-exists',
        message:
            'This UTR/reference has already been used for this rent charge.',
        failure: PaymentSubmissionFailure.duplicateUtr,
      ),
      (
        code: 'failed-precondition',
        message: 'Only a due or overdue rent charge can accept payment.',
        failure: PaymentSubmissionFailure.billIneligible,
      ),
      (
        code: 'unavailable',
        message: 'Network unavailable.',
        failure: PaymentSubmissionFailure.network,
      ),
    ];

    for (final testCase in cases) {
      final service = FirebaseTenantPaymentSubmissionService(
        uidProvider: () => 'tenant-1',
        submitCallable: (_) async => throw FirebaseFunctionsException(
          code: testCase.code,
          message: testCase.message,
        ),
      );

      await expectLater(
        service.submitPayment(
          expectedTenantId: 'tenant-1',
          rentChargeId: 'bill-1',
          uploadIntentId: 'a' * 64,
          transactionRef: 'ABC123',
          idempotencyKey: 'd75a980b-182b-4b1e-aed4-81cba8a454a2',
        ),
        throwsA(
          isA<PaymentSubmissionException>().having(
            (error) => error.failure,
            'failure',
            testCase.failure,
          ),
        ),
      );
    }
  });
}
