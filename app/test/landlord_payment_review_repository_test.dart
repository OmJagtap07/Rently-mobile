import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:app/services/landlord_payment_review_repository.dart';

void main() {
  group('VerifyUpiPaymentRequest', () {
    test('exposes all approved rejection codes and labels', () {
      expect(upiPaymentRejectionReasons, {
        'old_or_used_screenshot': 'Old or previously used screenshot',
        'blurry_or_unreadable_screenshot': 'Blurry or unreadable screenshot',
        'incomplete_amount': 'Payment amount is incomplete',
        'incorrect_utr': 'Incorrect UTR/reference number',
        'payment_not_received': "Payment not received in landlord's account",
        'screenshot_bill_mismatch': 'Screenshot does not match this rent bill',
        'other': 'Other',
      });
    });

    test('accept payload contains only the payment ID and decision', () {
      final payload = const VerifyUpiPaymentRequest(
        paymentId: 'payment-1',
        decision: 'accept',
      ).toCallablePayload();

      expect(payload, {'paymentId': 'payment-1', 'decision': 'accept'});
    });

    test('each predefined reason omits rejectionExplanation', () {
      for (final reasonCode in upiPaymentRejectionReasons.keys.where(
        (code) => code != 'other',
      )) {
        final payload = VerifyUpiPaymentRequest(
          paymentId: 'payment-1',
          decision: 'reject',
          rejectionReasonCode: reasonCode,
        ).toCallablePayload();

        expect(payload, {
          'paymentId': 'payment-1',
          'decision': 'reject',
          'rejectionReasonCode': reasonCode,
        });
        expect(payload.containsKey('rejectionExplanation'), isFalse);
      }
    });

    test('Other explanations are trimmed and boundary validated', () {
      final tenCharacters = VerifyUpiPaymentRequest(
        paymentId: 'payment-1',
        decision: 'reject',
        rejectionReasonCode: 'other',
        rejectionExplanation: '  1234567890  ',
      ).toCallablePayload();
      expect(tenCharacters['rejectionExplanation'], '1234567890');

      final fiveHundredCharacters = VerifyUpiPaymentRequest(
        paymentId: 'payment-1',
        decision: 'reject',
        rejectionReasonCode: 'other',
        rejectionExplanation: List.filled(500, 'x').join(),
      ).toCallablePayload();
      expect(
        (fiveHundredCharacters['rejectionExplanation'] as String).length,
        500,
      );

      for (final explanation in [
        '123456789',
        List.filled(501, 'x').join(),
        '          ',
      ]) {
        expect(
          () => VerifyUpiPaymentRequest(
            paymentId: 'payment-1',
            decision: 'reject',
            rejectionReasonCode: 'other',
            rejectionExplanation: explanation,
          ).toCallablePayload(),
          throwsArgumentError,
        );
      }
    });

    test('predefined reasons reject any supplied explanation', () {
      for (final explanation in ['', '   ', 'some explanation']) {
        expect(
          () => VerifyUpiPaymentRequest(
            paymentId: 'payment-1',
            decision: 'reject',
            rejectionReasonCode: 'incorrect_utr',
            rejectionExplanation: explanation,
          ).toCallablePayload(),
          throwsArgumentError,
        );
      }
    });
  });

  group('LandlordPaymentReview.fromRecords', () {
    test(
      'maps linked records from an ended lease without current unit state',
      () {
        final review = LandlordPaymentReview.fromRecords(
          paymentId: 'payment-1',
          landlordId: 'landlord-1',
          payment: _payment(),
          lease: _lease(status: 'ended'),
          rentCharge: _rentCharge(),
        );

        expect(review.paymentId, 'payment-1');
        expect(review.tenantName, 'Tenant One');
        expect(review.propertyName, 'Maple House');
        expect(review.roomNumber, 'Room 2');
        expect(review.billingMonth, '2026-11');
        expect(review.amountPaise, 125000);
        expect(review.transactionRef, 'UTR123');
        expect(review.leaseStatus, 'ended');
        expect(review.proofUrl, 'https://res.cloudinary.com/test/proof.jpg');
      },
    );

    test('rejects mismatched linked records', () {
      expect(
        () => LandlordPaymentReview.fromRecords(
          paymentId: 'payment-1',
          landlordId: 'landlord-1',
          payment: _payment(),
          lease: _lease(status: 'ended', tenantId: 'another-tenant'),
          rentCharge: _rentCharge(),
        ),
        throwsFormatException,
      );
    });
  });

  test('validates the callable result contract', () {
    const request = VerifyUpiPaymentRequest(
      paymentId: 'payment-1',
      decision: 'accept',
    );
    final result = VerifyUpiPaymentResult.fromCallableResponse({
      'success': true,
      'paymentId': 'payment-1',
      'decision': 'accept',
      'rentChargeStatus': 'paid',
    }, request: request);
    expect(result.rentChargeStatus, 'paid');

    expect(
      () => VerifyUpiPaymentResult.fromCallableResponse({
        'success': true,
        'paymentId': 'payment-1',
        'decision': 'accept',
        'rentChargeStatus': 'due',
      }, request: request),
      throwsStateError,
    );
  });
}

Map<String, dynamic> _payment() => {
  'rentChargeId': 'bill-1',
  'leaseId': 'lease-1',
  'tenantId': 'tenant-1',
  'landlordId': 'landlord-1',
  'propertyId': 'property-1',
  'unitId': 'unit-1',
  'status': 'pending_verification',
  'method': 'upi_qr',
  'amountDue': 125000,
  'transactionRef': 'UTR123',
  'submittedAt': Timestamp.fromDate(DateTime.utc(2026, 11, 13, 10)),
  'proof': {
    'provider': 'cloudinary',
    'resourceType': 'image',
    'secureUrl': 'https://res.cloudinary.com/test/proof.jpg',
  },
};

Map<String, dynamic> _lease({
  required String status,
  String tenantId = 'tenant-1',
}) => {
  'status': status,
  'tenantId': tenantId,
  'landlordId': 'landlord-1',
  'propertyId': 'property-1',
  'unitId': 'unit-1',
  'tenantName': 'Tenant One',
  'propertyName': 'Maple House',
  'roomNumber': 'Room 2',
};

Map<String, dynamic> _rentCharge() => {
  'status': 'payment_pending',
  'billingMonth': '2026-11',
  'tenantId': 'tenant-1',
  'landlordId': 'landlord-1',
  'leaseId': 'lease-1',
  'propertyId': 'property-1',
  'unitId': 'unit-1',
};
