import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:app/dashboards/landlord/landlord_payment_review_screen.dart';
import 'package:app/services/landlord_payment_review_repository.dart';

void main() {
  testWidgets('denies access when the repository rejects a non-landlord', (
    tester,
  ) async {
    final repository = _FakePaymentReviewRepository(unauthorized: true);
    await _pumpScreen(tester, repository);

    expect(find.text('Only landlords can review payments.'), findsOneWidget);
    expect(
      find.byKey(const Key('payment-review-card-payment-1')),
      findsNothing,
    );
  });

  testWidgets('filters the queue to pending payments and shows details', (
    tester,
  ) async {
    final repository = _FakePaymentReviewRepository(
      payments: [
        _review(),
        _review(paymentId: 'verified-payment', status: 'verified'),
      ],
    );
    await _pumpScreen(tester, repository);

    expect(find.text('Tenant One'), findsOneWidget);
    expect(find.text('Maple House • Room 2'), findsOneWidget);
    expect(find.text('Billing month: 2026-11'), findsOneWidget);
    expect(find.text('Amount: ₹1250'), findsOneWidget);
    expect(find.text('UTR: UTR123'), findsOneWidget);
    expect(find.text('Submitted: 2026-11-13 10:00 UTC'), findsOneWidget);
    expect(
      find.byKey(const Key('payment-proof-image-payment-1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('payment-review-card-verified-payment')),
      findsNothing,
    );

    await tester.tap(find.byKey(const Key('view-proof-payment-1')));
    await tester.pumpAndSettle();
    expect(find.byType(InteractiveViewer), findsOneWidget);
  });

  testWidgets('accepts through the callable contract and refreshes the queue', (
    tester,
  ) async {
    final repository = _FakePaymentReviewRepository(payments: [_review()]);
    await _pumpScreen(tester, repository);

    await tester.tap(find.byKey(const Key('accept-payment-payment-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirm-payment-accept')));
    await tester.pumpAndSettle();

    expect(repository.requests.single.toCallablePayload(), {
      'paymentId': 'payment-1',
      'decision': 'accept',
    });
    expect(repository.watchCount, 2);
    expect(
      find.text('No UPI payments are awaiting verification.'),
      findsOneWidget,
    );
  });

  testWidgets('requires a valid Other explanation before rejecting', (
    tester,
  ) async {
    final repository = _FakePaymentReviewRepository(payments: [_review()]);
    await _pumpScreen(tester, repository);

    await tester.tap(find.byKey(const Key('reject-payment-payment-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('rejection-reason-dropdown')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Other').last);
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('other-rejection-explanation')),
      '  too short  ',
    );
    await tester.tap(find.byKey(const Key('confirm-payment-rejection')));
    await tester.pumpAndSettle();
    expect(find.text('Enter 10-500 characters.'), findsOneWidget);
    expect(repository.requests, isEmpty);

    await tester.enterText(
      find.byKey(const Key('other-rejection-explanation')),
      '  Payment details do not match  ',
    );
    await tester.tap(find.byKey(const Key('confirm-payment-rejection')));
    await tester.pumpAndSettle();

    final request = repository.requests.single;
    expect(request.decision, 'reject');
    expect(request.rejectionReasonCode, 'other');
    expect(request.rejectionExplanation, 'Payment details do not match');
    expect(
      request.toCallablePayload()['rejectionExplanation'],
      'Payment details do not match',
    );
  });

  testWidgets('prevents duplicate submissions while a decision is pending', (
    tester,
  ) async {
    final repository = _FakePaymentReviewRepository(
      payments: [_review()],
      decisionGate: Completer<void>(),
    );
    await _pumpScreen(tester, repository);

    await tester.tap(find.byKey(const Key('accept-payment-payment-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirm-payment-accept')));
    await tester.pump();

    final acceptButton = tester.widget<ElevatedButton>(
      find.byKey(const Key('accept-payment-payment-1')),
    );
    expect(acceptButton.onPressed, isNull);
    expect(repository.requests, hasLength(1));

    repository.decisionGate!.complete();
    await tester.pumpAndSettle();
    expect(repository.requests, hasLength(1));
  });

  testWidgets('shows an actionable error when the callable fails', (
    tester,
  ) async {
    final repository = _FakePaymentReviewRepository(
      payments: [_review()],
      failure: FirebaseFunctionsException(
        code: 'failed-precondition',
        message: 'Payment is not pending.',
      ),
    );
    await _pumpScreen(tester, repository);

    await tester.tap(find.byKey(const Key('accept-payment-payment-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirm-payment-accept')));
    await tester.pumpAndSettle();

    expect(
      find.text(
        'This payment is no longer awaiting review. Refresh the queue.',
      ),
      findsOneWidget,
    );
    expect(find.text('Refresh'), findsOneWidget);
  });

  testWidgets('keeps a pending payment from an ended lease reviewable', (
    tester,
  ) async {
    final repository = _FakePaymentReviewRepository(
      payments: [_review(leaseStatus: 'ended')],
    );
    await _pumpScreen(tester, repository);

    expect(find.text('Historical lease'), findsOneWidget);
    expect(
      find.byKey(const Key('payment-review-card-payment-1')),
      findsOneWidget,
    );
  });
}

Future<void> _pumpScreen(
  WidgetTester tester,
  LandlordPaymentReviewRepository repository,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: LandlordPaymentReviewScreen(repository: repository)),
    ),
  );
  await tester.pumpAndSettle();
}

LandlordPaymentReview _review({
  String paymentId = 'payment-1',
  String status = 'pending_verification',
  String leaseStatus = 'active',
}) => LandlordPaymentReview(
  paymentId: paymentId,
  rentChargeId: 'bill-1',
  leaseId: 'lease-1',
  tenantId: 'tenant-1',
  landlordId: 'landlord-1',
  propertyId: 'property-1',
  unitId: 'unit-1',
  tenantName: 'Tenant One',
  propertyName: 'Maple House',
  roomNumber: 'Room 2',
  billingMonth: '2026-11',
  amountPaise: 125000,
  transactionRef: 'UTR123',
  submittedAt: DateTime.utc(2026, 11, 13, 10),
  proofUrl: 'https://res.cloudinary.com/test/proof.jpg',
  leaseStatus: leaseStatus,
  status: status,
);

class _FakePaymentReviewRepository implements LandlordPaymentReviewRepository {
  _FakePaymentReviewRepository({
    this.payments = const [],
    this.unauthorized = false,
    this.failure,
    this.decisionGate,
  });

  final List<LandlordPaymentReview> payments;
  final bool unauthorized;
  final Object? failure;
  final Completer<void>? decisionGate;
  final List<VerifyUpiPaymentRequest> requests = [];
  int watchCount = 0;

  @override
  Stream<List<LandlordPaymentReview>> watchPendingPayments() {
    watchCount++;
    if (unauthorized) {
      return Stream.error(StateError('Only landlords can review payments.'));
    }
    return Stream.value(List.unmodifiable(payments));
  }

  @override
  Future<VerifyUpiPaymentResult> decidePayment(
    VerifyUpiPaymentRequest request,
  ) async {
    requests.add(request);
    request.toCallablePayload();
    if (decisionGate != null) await decisionGate!.future;
    if (failure != null) throw failure!;
    payments.removeWhere((payment) => payment.paymentId == request.paymentId);
    return VerifyUpiPaymentResult(
      paymentId: request.paymentId,
      decision: request.decision,
      rentChargeStatus: request.decision == 'accept' ? 'paid' : 'due',
    );
  }
}
