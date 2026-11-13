import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';

const Map<String, String> upiPaymentRejectionReasons = {
  'old_or_used_screenshot': 'Old or previously used screenshot',
  'blurry_or_unreadable_screenshot': 'Blurry or unreadable screenshot',
  'incomplete_amount': 'Payment amount is incomplete',
  'incorrect_utr': 'Incorrect UTR/reference number',
  'payment_not_received': "Payment not received in landlord's account",
  'screenshot_bill_mismatch': 'Screenshot does not match this rent bill',
  'other': 'Other',
};

class LandlordPaymentReview {
  const LandlordPaymentReview({
    required this.paymentId,
    required this.rentChargeId,
    required this.leaseId,
    required this.tenantId,
    required this.landlordId,
    required this.propertyId,
    required this.unitId,
    required this.tenantName,
    required this.propertyName,
    required this.roomNumber,
    required this.billingMonth,
    required this.amountPaise,
    required this.transactionRef,
    required this.submittedAt,
    required this.proofUrl,
    required this.leaseStatus,
    this.status = 'pending_verification',
  });

  final String paymentId;
  final String rentChargeId;
  final String leaseId;
  final String tenantId;
  final String landlordId;
  final String propertyId;
  final String unitId;
  final String tenantName;
  final String propertyName;
  final String roomNumber;
  final String billingMonth;
  final int amountPaise;
  final String transactionRef;
  final DateTime submittedAt;
  final String proofUrl;
  final String leaseStatus;
  final String status;

  factory LandlordPaymentReview.fromRecords({
    required String paymentId,
    required String landlordId,
    required Map<String, dynamic> payment,
    required Map<String, dynamic> lease,
    required Map<String, dynamic> rentCharge,
  }) {
    String requiredString(Map<String, dynamic> data, String field) {
      final value = data[field];
      if (value is! String || value.trim().isEmpty) {
        throw FormatException('Payment review record is missing $field.');
      }
      return value;
    }

    final rentChargeId = requiredString(payment, 'rentChargeId');
    final leaseId = requiredString(payment, 'leaseId');
    final tenantId = requiredString(payment, 'tenantId');
    final paymentLandlordId = requiredString(payment, 'landlordId');
    final propertyId = requiredString(payment, 'propertyId');
    final unitId = requiredString(payment, 'unitId');
    final billingMonth = requiredString(rentCharge, 'billingMonth');
    final amountPaise = payment['amountDue'];
    final submittedAt = payment['submittedAt'];
    final transactionRef = requiredString(payment, 'transactionRef');
    final proofData = payment['proof'];
    final leaseStatus = lease['status'];

    if (payment['status'] != 'pending_verification' ||
        payment['method'] != 'upi_qr' ||
        paymentLandlordId != landlordId ||
        rentCharge['status'] != 'payment_pending' ||
        amountPaise is! int ||
        submittedAt is! Timestamp ||
        proofData is! Map ||
        (leaseStatus != 'active' && leaseStatus != 'ended')) {
      throw const FormatException(
        'Payment review record is not eligible or is incomplete.',
      );
    }

    final proof = Map<String, dynamic>.from(proofData);
    final proofUrl = proof['secureUrl'];
    final proofUri = proofUrl is String ? Uri.tryParse(proofUrl) : null;
    if (proof['provider'] != 'cloudinary' ||
        proof['resourceType'] != 'image' ||
        proofUri == null ||
        proofUri.scheme != 'https') {
      throw const FormatException('Payment proof metadata is invalid.');
    }

    final relationshipsMatch =
        lease['tenantId'] == tenantId &&
        lease['landlordId'] == landlordId &&
        lease['propertyId'] == propertyId &&
        lease['unitId'] == unitId &&
        rentCharge['tenantId'] == tenantId &&
        rentCharge['landlordId'] == landlordId &&
        rentCharge['leaseId'] == leaseId &&
        rentCharge['propertyId'] == propertyId &&
        rentCharge['unitId'] == unitId;
    if (!relationshipsMatch) {
      throw const FormatException(
        'Payment, lease, and rent charge references do not match.',
      );
    }

    final tenantName = lease['tenantName'];
    final propertyName = lease['propertyName'];
    final roomNumber = lease['roomNumber'];
    return LandlordPaymentReview(
      paymentId: paymentId,
      rentChargeId: rentChargeId,
      leaseId: leaseId,
      tenantId: tenantId,
      landlordId: paymentLandlordId,
      propertyId: propertyId,
      unitId: unitId,
      tenantName: tenantName is String && tenantName.trim().isNotEmpty
          ? tenantName.trim()
          : 'Tenant $tenantId',
      propertyName: propertyName is String && propertyName.trim().isNotEmpty
          ? propertyName.trim()
          : 'Property $propertyId',
      roomNumber: roomNumber is String && roomNumber.trim().isNotEmpty
          ? roomNumber.trim()
          : 'Unit $unitId',
      billingMonth: billingMonth,
      amountPaise: amountPaise,
      transactionRef: transactionRef,
      submittedAt: submittedAt.toDate(),
      proofUrl: proofUrl as String,
      leaseStatus: leaseStatus as String,
    );
  }
}

class VerifyUpiPaymentRequest {
  const VerifyUpiPaymentRequest({
    required this.paymentId,
    required this.decision,
    this.rejectionReasonCode,
    this.rejectionExplanation,
  });

  final String paymentId;
  final String decision;
  final String? rejectionReasonCode;
  final String? rejectionExplanation;

  Map<String, Object?> toCallablePayload() {
    if (paymentId.trim().isEmpty) {
      throw ArgumentError.value(paymentId, 'paymentId');
    }
    if (decision == 'accept') {
      if (rejectionReasonCode != null || rejectionExplanation != null) {
        throw ArgumentError(
          'Accept decisions cannot include rejection details.',
        );
      }
      return {'paymentId': paymentId, 'decision': 'accept'};
    }
    if (decision != 'reject' ||
        rejectionReasonCode == null ||
        !upiPaymentRejectionReasons.containsKey(rejectionReasonCode)) {
      throw ArgumentError('A valid rejection reason is required.');
    }

    if (rejectionReasonCode == 'other') {
      final explanation = rejectionExplanation?.trim();
      if (explanation == null ||
          explanation.length < 10 ||
          explanation.length > 500) {
        throw ArgumentError(
          'Other explanations must contain 10-500 characters.',
        );
      }
      return {
        'paymentId': paymentId,
        'decision': 'reject',
        'rejectionReasonCode': rejectionReasonCode,
        'rejectionExplanation': explanation,
      };
    }

    if (rejectionExplanation != null) {
      throw ArgumentError(
        'Predefined rejection reasons cannot include an explanation.',
      );
    }
    return {
      'paymentId': paymentId,
      'decision': 'reject',
      'rejectionReasonCode': rejectionReasonCode,
    };
  }
}

class VerifyUpiPaymentResult {
  const VerifyUpiPaymentResult({
    required this.paymentId,
    required this.decision,
    required this.rentChargeStatus,
  });

  final String paymentId;
  final String decision;
  final String rentChargeStatus;

  factory VerifyUpiPaymentResult.fromCallableResponse(
    Object? response, {
    required VerifyUpiPaymentRequest request,
  }) {
    if (response is! Map) {
      throw StateError('verifyUpiPayment returned an invalid response.');
    }
    final data = Map<String, dynamic>.from(response);
    final status = data['rentChargeStatus'];
    final validStatus = request.decision == 'accept'
        ? status == 'paid'
        : status == 'due' || status == 'overdue';
    if (data['success'] != true ||
        data['paymentId'] != request.paymentId ||
        data['decision'] != request.decision ||
        !validStatus) {
      throw StateError('verifyUpiPayment returned an invalid response.');
    }
    return VerifyUpiPaymentResult(
      paymentId: request.paymentId,
      decision: request.decision,
      rentChargeStatus: status as String,
    );
  }
}

abstract interface class LandlordPaymentReviewRepository {
  Stream<List<LandlordPaymentReview>> watchPendingPayments();

  Future<VerifyUpiPaymentResult> decidePayment(VerifyUpiPaymentRequest request);
}

class FirebaseLandlordPaymentReviewRepository
    implements LandlordPaymentReviewRepository {
  FirebaseLandlordPaymentReviewRepository({
    FirebaseAuth? auth,
    FirebaseFirestore? firestore,
    FirebaseFunctions? functions,
  }) : _auth = auth ?? FirebaseAuth.instance,
       _firestore = firestore ?? FirebaseFirestore.instance,
       _functions = functions ?? FirebaseFunctions.instance;

  final FirebaseAuth _auth;
  final FirebaseFirestore _firestore;
  final FirebaseFunctions _functions;

  Future<String> _requireLandlordUid() async {
    final user = _auth.currentUser;
    if (user == null) {
      throw StateError('Sign in with a landlord account to review payments.');
    }
    final token = await user.getIdTokenResult();
    if (token.claims?['role'] != 'landlord') {
      throw StateError('Only landlords can review payments.');
    }
    return user.uid;
  }

  @override
  Stream<List<LandlordPaymentReview>> watchPendingPayments() async* {
    final landlordId = await _requireLandlordUid();
    final payments = _firestore
        .collection('payments')
        .where('landlordId', isEqualTo: landlordId)
        .where('status', isEqualTo: 'pending_verification');

    await for (final snapshot in payments.snapshots()) {
      final reviews = await Future.wait(
        snapshot.docs.map((paymentDoc) async {
          final payment = paymentDoc.data();
          final leaseId = payment['leaseId'];
          final rentChargeId = payment['rentChargeId'];
          if (leaseId is! String || rentChargeId is! String) {
            throw const FormatException(
              'Payment is missing its lease or rent charge reference.',
            );
          }
          // Resolve ownership through the payment's historical lease, not the
          // unit's current assignment.
          final linkedRecords = await Future.wait([
            _firestore.collection('leases').doc(leaseId).get(),
            _firestore.collection('rentCharges').doc(rentChargeId).get(),
          ]);
          final lease = linkedRecords[0];
          final rentCharge = linkedRecords[1];
          if (!lease.exists || !rentCharge.exists) {
            throw const FormatException(
              'Payment history is missing its linked lease or rent charge.',
            );
          }
          return LandlordPaymentReview.fromRecords(
            paymentId: paymentDoc.id,
            landlordId: landlordId,
            payment: payment,
            lease: lease.data()!,
            rentCharge: rentCharge.data()!,
          );
        }),
      );
      reviews.sort(
        (left, right) => right.submittedAt.compareTo(left.submittedAt),
      );
      yield List.unmodifiable(reviews);
    }
  }

  @override
  Future<VerifyUpiPaymentResult> decidePayment(
    VerifyUpiPaymentRequest request,
  ) async {
    await _requireLandlordUid();
    final payload = request.toCallablePayload();
    final response = await _functions
        .httpsCallable('verifyUpiPayment')
        .call<Object?>(payload);
    return VerifyUpiPaymentResult.fromCallableResponse(
      response.data,
      request: request,
    );
  }
}
