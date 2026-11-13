import 'dart:async';
import 'dart:typed_data';

import 'package:app/dashboards/tenant/tenant_billing_screen.dart';
import 'package:app/services/monthly_billing_repository.dart';
import 'package:app/services/property_payment_details.dart';
import 'package:app/services/tenant_billing_repository.dart';
import 'package:app/services/tenant_payment_submission_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

TenantRentBill bill({
  required String id,
  required String month,
  String status = 'finalized',
  int lateFineTotal = 0,
  int adjustmentTotal = 0,
  String? propertyId,
}) {
  return TenantRentBill(
    id: id,
    billingMonth: month,
    lineItems: const [
      BillingLineItem(type: 'rent', label: 'Monthly rent', amount: 120000),
      BillingLineItem(type: 'electricity', label: 'Electricity', amount: 1250),
    ],
    subtotal: 121250,
    lateFineTotal: lateFineTotal,
    adjustmentTotal: adjustmentTotal,
    total: 121250 + lateFineTotal + adjustmentTotal,
    dueDate: '$month-10',
    status: status,
    propertyId: propertyId,
  );
}

class FakeTenantBillingRepository implements TenantBillingRepository {
  FakeTenantBillingRepository(
    this.streams, {
    Map<String, TenantRentBill> serverBills = const {},
    this.failServerFetch = false,
    this.serverFetchGate,
    this.serverFetchError,
  }) : serverBills = Map.of(serverBills);

  final List<Stream<List<TenantRentBill>>> streams;
  final Map<String, TenantRentBill> serverBills;
  final Completer<TenantRentBill?>? serverFetchGate;
  Object? serverFetchError;
  bool failServerFetch;
  int watchCount = 0;

  @override
  Stream<List<TenantRentBill>> watchTenantBills() {
    watchCount++;
    if (streams.isEmpty) return Stream.value(const []);
    return streams.removeAt(0).map((bills) {
      for (final bill in bills) {
        serverBills[bill.id] = bill;
      }
      return bills;
    });
  }

  @override
  Future<TenantRentBill?> fetchTenantBillFromServer(String billId) async {
    final gate = serverFetchGate;
    if (gate != null) return gate.future;
    if (serverFetchError != null) throw serverFetchError!;
    if (failServerFetch) throw Exception('Server unavailable.');
    return serverBills[billId];
  }
}

class FakeTenantPaymentSubmissionService
    implements TenantPaymentSubmissionService {
  FakeTenantPaymentSubmissionService({
    this.propertyDetailsStream,
    this.uploadGate,
    this.submissionGate,
    this.submissionFailures = const [],
    this.failNextUpload = false,
    this.tenantId = 'tenant-test',
  });

  final Stream<PropertyPaymentDetails?>? propertyDetailsStream;
  final StreamController<String?> _authChanges =
      StreamController<String?>.broadcast();
  final Completer<void>? uploadGate;
  final Completer<void>? submissionGate;
  final List<PaymentSubmissionException> submissionFailures;
  bool failNextUpload;
  bool signedOut = false;
  String tenantId;
  int prepareCalls = 0;
  int uploadCalls = 0;
  final submissionPayloads = <Map<String, String>>[];
  String? lastBillId;
  String? lastFormat;
  int? lastByteCount;
  String? lastIdempotencyKey;
  final Map<String, TenantPaymentSubmissionAttempt> attempts = {};

  @override
  String get authenticatedTenantId {
    if (signedOut) {
      throw const PaymentAttemptStorageException('User is not authenticated.');
    }
    return tenantId;
  }

  @override
  Stream<String?> get authenticatedUserChanges =>
      Stream<String?>.multi((controller) {
        controller.add(signedOut ? null : tenantId);
        final subscription = _authChanges.stream.listen(
          controller.add,
          onError: controller.addError,
        );
        controller.onCancel = subscription.cancel;
      });

  void changeAuthenticatedUser(String? uid) {
    signedOut = uid == null;
    if (uid != null) tenantId = uid;
    _authChanges.add(uid);
  }

  Future<void> closeAuthChanges() => _authChanges.close();

  @override
  Future<TenantPaymentSubmissionAttempt?> loadSubmissionAttempt(
    String rentChargeId,
  ) async {
    final attempt = attempts[rentChargeId];
    return attempt?.tenantId == tenantId ? attempt : null;
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
    if (expectedTenantId != tenantId) {
      throw const PaymentAttemptStorageException(
        'The authenticated tenant changed.',
      );
    }
    final attempt = TenantPaymentSubmissionAttempt(
      tenantId: tenantId,
      rentChargeId: rentChargeId,
      uploadIntentId: uploadIntentId,
      transactionRef: normalizeUtrReference(transactionRef),
      idempotencyKey: idempotencyKey,
      state: state,
    );
    attempts[rentChargeId] = attempt;
    return attempt;
  }

  @override
  Future<void> clearSubmissionAttempt({
    required String expectedTenantId,
    required String rentChargeId,
  }) async {
    if (expectedTenantId != tenantId || signedOut) {
      throw const PaymentAttemptStorageException(
        'The authenticated tenant changed.',
      );
    }
    attempts.remove(rentChargeId);
  }

  @override
  Stream<PropertyPaymentDetails?> watchPropertyPaymentDetails(
    String propertyId,
  ) {
    expect(propertyId, 'property-1');
    return propertyDetailsStream ??
        Stream.value(
          const PropertyPaymentDetails(
            upiId: 'owner@bank',
            upiQrImageUrl: 'https://images.example.com/qr.png',
            upiDisplayName: 'Property Owner',
          ),
        );
  }

  @override
  Future<PreparedPaymentProofUpload> prepareProofUpload({
    required String rentChargeId,
    required String idempotencyKey,
    required String format,
    required int bytes,
  }) async {
    prepareCalls++;
    lastBillId = rentChargeId;
    lastIdempotencyKey = idempotencyKey;
    lastFormat = format;
    lastByteCount = bytes;
    return PreparedPaymentProofUpload(
      uploadIntentId: 'intent-$prepareCalls',
      uploadUrl: Uri.parse('https://functions.example.test/upload'),
      uploadToken: 'opaque-test-token',
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
    expect(expectedTenantId, tenantId);
    submissionPayloads.add({
      'rentChargeId': rentChargeId,
      'uploadIntentId': uploadIntentId,
      'transactionRef': transactionRef,
      'idempotencyKey': idempotencyKey,
    });
    await submissionGate?.future;
    if (submissionFailures.isNotEmpty) {
      throw submissionFailures.removeAt(0);
    }
    return const SubmittedUpiPayment(
      paymentId: 'payment-1',
      status: 'pending_verification',
    );
  }

  @override
  Future<void> uploadProof({
    required PreparedPaymentProofUpload permission,
    required List<int> bytes,
    required String format,
    required PaymentProofProgress onProgress,
  }) async {
    uploadCalls++;
    onProgress(0, bytes.length);
    onProgress(bytes.length ~/ 2, bytes.length);
    await uploadGate?.future;
    if (failNextUpload) {
      failNextUpload = false;
      throw const PaymentUploadException('Upload unavailable.');
    }
    onProgress(bytes.length, bytes.length);
  }
}

final _validPng = Uint8List.fromList([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

PaymentProofPicker proofPicker([Uint8List? bytes]) =>
    () async =>
        PickedPaymentProof(name: 'receipt.png', bytes: bytes ?? _validPng);

FakeTenantBillingRepository repositoryFor(TenantRentBill bill) =>
    FakeTenantBillingRepository(
      [
        Stream.value([bill]),
      ],
      serverBills: {bill.id: bill},
    );

FakeTenantBillingRepository repositoryForBill({
  required String id,
  required String month,
  String status = 'due',
  String? propertyId,
}) => repositoryFor(
  bill(id: id, month: month, status: status, propertyId: propertyId),
);

Future<void> pumpBilling(
  WidgetTester tester,
  TenantBillingRepository repository,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: TenantBillingScreen(
        repository: repository,
        paymentService: FakeTenantPaymentSubmissionService(),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> ensurePaymentWidgetVisible(
  WidgetTester tester,
  Finder finder,
) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
}

Future<void> uploadProofForSubmission(WidgetTester tester) async {
  await ensurePaymentWidgetVisible(
    tester,
    find.byKey(const Key('confirm-upi-recipient')),
  );
  await tester.tap(find.byKey(const Key('confirm-upi-recipient')));
  await tester.pumpAndSettle();
  await ensurePaymentWidgetVisible(
    tester,
    find.byKey(const Key('payment-utr-input')),
  );
  await tester.enterText(
    find.byKey(const Key('payment-utr-input')),
    ' abc123 ',
  );
  await ensurePaymentWidgetVisible(
    tester,
    find.byKey(const Key('select-payment-proof')),
  );
  await tester.tap(find.byKey(const Key('select-payment-proof')));
  await tester.pumpAndSettle();
  await ensurePaymentWidgetVisible(
    tester,
    find.byKey(const Key('upload-payment-proof')),
  );
  await tester.tap(find.byKey(const Key('upload-payment-proof')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('lists bills newest month first and shows bill statuses', (
    tester,
  ) async {
    final repository = FakeTenantBillingRepository([
      Stream.value([
        bill(id: 'older', month: '2026-10', status: 'paid'),
        bill(id: 'newer', month: '2026-11', status: 'due'),
      ]),
    ]);

    await pumpBilling(tester, repository);

    expect(find.text('November 2026'), findsOneWidget);
    expect(find.text('October 2026'), findsOneWidget);
    expect(find.text('Due'), findsOneWidget);
    expect(find.text('Paid'), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(const Key('tenant-bill-newer'))).dy,
      lessThan(
        tester.getTopLeft(find.byKey(const Key('tenant-bill-older'))).dy,
      ),
    );
  });

  testWidgets(
    'opens bill details with line items, total, due date and status',
    (tester) async {
      final repository = FakeTenantBillingRepository([
        Stream.value([
          bill(id: 'november', month: '2026-11', status: 'overdue'),
        ]),
      ]);

      await pumpBilling(tester, repository);
      await tester.tap(find.byKey(const Key('tenant-bill-november')));
      await tester.pumpAndSettle();

      expect(find.text('Bill breakdown'), findsOneWidget);
      expect(find.text('Monthly rent'), findsOneWidget);
      expect(find.text('₹1200'), findsOneWidget);
      expect(find.text('Electricity'), findsOneWidget);
      expect(find.text('₹12.50'), findsOneWidget);
      expect(find.text('Due date: 10 Nov 2026'), findsOneWidget);
      expect(find.text('Overdue'), findsOneWidget);
      expect(find.byKey(const Key('tenant-bill-total')), findsOneWidget);
      expect(
        tester.widget<Text>(find.byKey(const Key('tenant-bill-total'))).data,
        '₹1212.50',
      );
    },
  );

  testWidgets('shows fines and adjustment credits separately from line items', (
    tester,
  ) async {
    final repository = FakeTenantBillingRepository([
      Stream.value([
        bill(
          id: 'adjusted',
          month: '2026-11',
          lateFineTotal: 500,
          adjustmentTotal: -250,
        ),
      ]),
    ]);

    await pumpBilling(tester, repository);
    await tester.tap(find.byKey(const Key('tenant-bill-adjusted')));
    await tester.pumpAndSettle();

    expect(find.text('Subtotal'), findsOneWidget);
    expect(find.text('Late fines added'), findsOneWidget);
    expect(find.text('₹5'), findsOneWidget);
    expect(find.text('Adjustment credit'), findsOneWidget);
    expect(find.text('₹-2.50'), findsOneWidget);
    expect(find.text('Total payable'), findsOneWidget);
    expect(find.text('₹1215'), findsOneWidget);
    expect(
      find.text(
        'Line items form the subtotal. Fines and adjustments are shown separately.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('labels finalized and payment-pending bills', (tester) async {
    final repository = FakeTenantBillingRepository([
      Stream.value([
        bill(id: 'finalized', month: '2026-11'),
        bill(id: 'pending', month: '2026-10', status: 'payment_pending'),
      ]),
    ]);

    await pumpBilling(tester, repository);

    expect(find.text('Finalized'), findsOneWidget);
    expect(find.text('Payment pending'), findsOneWidget);
  });

  testWidgets('shows an empty state when the tenant has no finalized bills', (
    tester,
  ) async {
    final repository = FakeTenantBillingRepository([Stream.value([])]);

    await pumpBilling(tester, repository);

    expect(find.byKey(const Key('tenant-bills-empty')), findsOneWidget);
    expect(find.text('No finalized bills yet.'), findsOneWidget);
  });

  testWidgets('shows an error state and retries the bill stream', (
    tester,
  ) async {
    final repository = FakeTenantBillingRepository([
      Stream.error(StateError('permission denied')),
      Stream.value([bill(id: 'retry-bill', month: '2026-11')]),
    ]);

    await tester.pumpWidget(
      MaterialApp(home: TenantBillingScreen(repository: repository)),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('Could not load your bills'), findsOneWidget);
    await tester.tap(find.byKey(const Key('retry-tenant-bills')));
    await tester.pumpAndSettle();

    expect(repository.watchCount, 2);
    expect(find.byKey(const Key('tenant-bill-retry-bill')), findsOneWidget);
  });

  testWidgets('shows a loading indicator while bills are loading', (
    tester,
  ) async {
    final controller = StreamController<List<TenantRentBill>>();
    final repository = FakeTenantBillingRepository([controller.stream]);

    await tester.pumpWidget(
      MaterialApp(home: TenantBillingScreen(repository: repository)),
    );
    await tester.pump();

    expect(find.byKey(const Key('tenant-bills-loading')), findsOneWidget);

    await controller.close();
  });

  testWidgets('requires recipient confirmation and resets on changed details', (
    tester,
  ) async {
    final details = StreamController<PropertyPaymentDetails?>.broadcast();
    final service = FakeTenantPaymentSubmissionService(
      propertyDetailsStream: details.stream,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: bill(
            id: 'upi-bill',
            month: '2026-11',
            status: 'due',
            propertyId: 'property-1',
          ),
          billingRepository: repositoryForBill(
            id: 'upi-bill',
            month: '2026-11',
            propertyId: 'property-1',
          ),
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pump();
    details.add(
      const PropertyPaymentDetails(
        upiId: 'owner@bank',
        upiQrImageUrl: 'https://images.example.com/qr.png',
        upiDisplayName: 'Property Owner',
      ),
    );
    await tester.pumpAndSettle();
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('confirm-upi-recipient')),
    );
    final uploadButton = find.byKey(const Key('upload-payment-proof'));
    expect(tester.widget<ElevatedButton>(uploadButton).onPressed, isNull);

    await tester.tap(find.byKey(const Key('confirm-upi-recipient')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('upi-recipient-confirmed')), findsOneWidget);

    details.add(
      const PropertyPaymentDetails(
        upiId: 'new-owner@bank',
        upiQrImageUrl: 'https://images.example.com/updated-qr.png',
        upiDisplayName: 'New Property Owner',
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('upi-recipient-confirmed')), findsNothing);
    expect(tester.widget<ElevatedButton>(uploadButton).onPressed, isNull);
    await details.close();
  });

  testWidgets('requires a server-confirmed bill status before upload', (
    tester,
  ) async {
    final billRecord = bill(
      id: 'unverified-status-bill',
      month: '2026-11',
      status: 'due',
      propertyId: 'property-1',
    );
    final repository = repositoryFor(billRecord)..failServerFetch = true;
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: billRecord,
          billingRepository: repository,
          paymentService: FakeTenantPaymentSubmissionService(),
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Checking'), findsOneWidget);
    expect(find.byKey(const Key('select-payment-proof')), findsNothing);
    expect(find.byKey(const Key('retry-tenant-bill-status')), findsOneWidget);

    repository.failServerFetch = false;
    await tester.tap(find.byKey(const Key('retry-tenant-bill-status')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('select-payment-proof')), findsOneWidget);
  });

  testWidgets(
    'validates UTR and rejects unsupported or oversized proof images',
    (tester) async {
      final service = FakeTenantPaymentSubmissionService();
      var selectedProof = proofPicker();
      await tester.pumpWidget(
        MaterialApp(
          home: TenantBillDetailsScreen(
            bill: bill(
              id: 'validation-bill',
              month: '2026-11',
              status: 'due',
              propertyId: 'property-1',
            ),
            billingRepository: repositoryForBill(
              id: 'validation-bill',
              month: '2026-11',
              propertyId: 'property-1',
            ),
            paymentService: service,
            pickPaymentProof: () => selectedProof(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await ensurePaymentWidgetVisible(
        tester,
        find.byKey(const Key('payment-utr-input')),
      );
      await tester.enterText(
        find.byKey(const Key('payment-utr-input')),
        'ABCDE',
      );
      await ensurePaymentWidgetVisible(
        tester,
        find.byKey(const Key('select-payment-proof')),
      );
      await tester.tap(find.byKey(const Key('select-payment-proof')));
      await tester.pumpAndSettle();
      await ensurePaymentWidgetVisible(
        tester,
        find.byKey(const Key('confirm-upi-recipient')),
      );
      await tester.tap(find.byKey(const Key('confirm-upi-recipient')));
      await tester.pumpAndSettle();
      final uploadButton = find.byKey(const Key('upload-payment-proof'));
      expect(tester.widget<ElevatedButton>(uploadButton).onPressed, isNull);
      expect(service.prepareCalls, 0);

      selectedProof = proofPicker(Uint8List.fromList('GIF89a'.codeUnits));
      await ensurePaymentWidgetVisible(
        tester,
        find.byKey(const Key('select-payment-proof')),
      );
      await tester.tap(find.byKey(const Key('select-payment-proof')));
      await tester.pumpAndSettle();
      expect(find.text('Choose a JPG, PNG, or WebP image.'), findsOneWidget);

      selectedProof = proofPicker(Uint8List(maxPaymentProofBytes + 1));
      await tester.tap(find.byKey(const Key('select-payment-proof')));
      await tester.pumpAndSettle();
      expect(find.text('Choose an image no larger than 5 MB.'), findsOneWidget);

      await tester.enterText(
        find.byKey(const Key('payment-utr-input')),
        ' abC123 ',
      );
      expect(service.prepareCalls, 0);
    },
  );

  testWidgets('shows progress, offers retry, and never marks bill paid', (
    tester,
  ) async {
    final uploadGate = Completer<void>();
    final service = FakeTenantPaymentSubmissionService(
      uploadGate: uploadGate,
      failNextUpload: true,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: bill(
            id: 'upload-bill',
            month: '2026-11',
            status: 'due',
            propertyId: 'property-1',
          ),
          billingRepository: repositoryForBill(
            id: 'upload-bill',
            month: '2026-11',
            propertyId: 'property-1',
          ),
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('confirm-upi-recipient')),
    );
    await tester.tap(find.byKey(const Key('confirm-upi-recipient')));
    await tester.pumpAndSettle();
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('payment-utr-input')),
    );
    await tester.enterText(
      find.byKey(const Key('payment-utr-input')),
      ' abC123 ',
    );
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('select-payment-proof')),
    );
    await tester.tap(find.byKey(const Key('select-payment-proof')));
    await tester.pumpAndSettle();
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('upload-payment-proof')),
    );
    await tester.ensureVisible(find.byKey(const Key('upload-payment-proof')));
    await tester.tap(find.byKey(const Key('upload-payment-proof')));
    await tester.pump();
    expect(service.uploadCalls, 1);
    expect(find.text('Uploading 50%'), findsOneWidget);
    expect(
      find.byKey(const Key('payment-proof-upload-progress')),
      findsOneWidget,
    );
    uploadGate.complete();
    await tester.pumpAndSettle();

    expect(find.textContaining('Upload unavailable.'), findsOneWidget);
    expect(find.text('Retry proof upload'), findsOneWidget);
    expect(service.prepareCalls, 1);
    expect(service.uploadCalls, 1);
    final firstKey = service.lastIdempotencyKey;
    expect(service.lastBillId, 'upload-bill');
    expect(service.lastFormat, 'png');
    expect(service.lastByteCount, _validPng.length);
    expect(firstKey, isNotEmpty);

    await tester.tap(find.byKey(const Key('upload-payment-proof')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('payment-proof-awaiting-submission')),
      findsOneWidget,
    );
    expect(find.text('Proof uploaded — awaiting submission'), findsOneWidget);
    expect(find.textContaining('has not been submitted'), findsOneWidget);
    await tester.drag(find.byType(ListView).last, const Offset(0, 1000));
    await tester.pumpAndSettle();
    expect(find.text('Due'), findsOneWidget);
    expect(find.text('Paid'), findsNothing);
    expect(find.text('Payment pending'), findsNothing);
    expect(service.lastIdempotencyKey, firstKey);
    expect(service.prepareCalls, 2);
    expect(service.uploadCalls, 2);
  });

  testWidgets('submits proof and refreshes the bill from the repository', (
    tester,
  ) async {
    final billUpdates = StreamController<List<TenantRentBill>>.broadcast();
    final repository = FakeTenantBillingRepository([billUpdates.stream]);
    final service = FakeTenantPaymentSubmissionService();
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: bill(
            id: 'submit-bill',
            month: '2026-11',
            status: 'due',
            propertyId: 'property-1',
          ),
          billingRepository: repository,
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    billUpdates.add([
      bill(
        id: 'submit-bill',
        month: '2026-11',
        status: 'due',
        propertyId: 'property-1',
      ),
    ]);
    await tester.pumpAndSettle();

    await uploadProofForSubmission(tester);
    await tester.ensureVisible(find.byKey(const Key('submit-payment-proof')));
    await tester.tap(find.byKey(const Key('submit-payment-proof')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('payment-submitted')), findsOneWidget);
    expect(find.text('Checking'), findsOneWidget);
    expect(find.text('Due'), findsNothing);
    expect(service.submissionPayloads, hasLength(1));
    expect(service.submissionPayloads.single, {
      'rentChargeId': 'submit-bill',
      'uploadIntentId': 'intent-1',
      'transactionRef': 'ABC123',
      'idempotencyKey': service.submissionPayloads.single['idempotencyKey'],
    });
    expect(
      service.submissionPayloads.single['idempotencyKey'],
      matches(RegExp(r'^[0-9a-f-]{36}$')),
    );

    repository.failServerFetch = true;
    billUpdates.addError(StateError('listener disconnected'));
    await tester.pumpAndSettle();
    expect(find.text('Checking'), findsOneWidget);
    expect(find.text('Due'), findsNothing);
    expect(find.byKey(const Key('tenant-bill-status-message')), findsOneWidget);
    expect(find.byKey(const Key('submit-payment-proof')), findsNothing);

    repository.failServerFetch = false;
    billUpdates.add([
      bill(
        id: 'submit-bill',
        month: '2026-11',
        status: 'payment_pending',
        propertyId: 'property-1',
      ),
    ]);
    await tester.pumpAndSettle();

    await tester.drag(find.byType(ListView), const Offset(0, 2000));
    await tester.pumpAndSettle();
    expect(find.text('Payment pending'), findsOneWidget);
    expect(find.byKey(const Key('payment-submitted')), findsOneWidget);
    expect(find.text('Paid'), findsNothing);
    expect(service.attempts, isEmpty);
    await billUpdates.close();
  });

  testWidgets('restores an uncertain submission and retries the same payload', (
    tester,
  ) async {
    final billRecord = bill(
      id: 'recovery-bill',
      month: '2026-11',
      status: 'due',
      propertyId: 'property-1',
    );
    final repository = repositoryFor(billRecord);
    final service = FakeTenantPaymentSubmissionService(
      submissionFailures: [
        const PaymentSubmissionException(
          PaymentSubmissionFailure.network,
          'Connection unavailable.',
        ),
      ],
    );
    Widget buildScreen() => MaterialApp(
      home: TenantBillDetailsScreen(
        bill: billRecord,
        billingRepository: repository,
        paymentService: service,
        pickPaymentProof: proofPicker(),
      ),
    );

    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();
    await uploadProofForSubmission(tester);
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('submit-payment-proof')),
    );
    await tester.tap(find.byKey(const Key('submit-payment-proof')));
    await tester.pumpAndSettle();
    final originalPayload = service.submissionPayloads.single;
    expect(
      service.attempts['recovery-bill']?.state,
      PaymentSubmissionAttemptState.uncertain,
    );

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('payment-proof-awaiting-submission')),
      findsOneWidget,
    );
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('confirm-upi-recipient')),
    );
    await tester.tap(find.byKey(const Key('confirm-upi-recipient')));
    await tester.pumpAndSettle();
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('submit-payment-proof')),
    );
    await tester.tap(find.byKey(const Key('submit-payment-proof')));
    await tester.pumpAndSettle();

    expect(service.submissionPayloads, hasLength(2));
    expect(service.submissionPayloads[1], originalPayload);
    expect(service.uploadCalls, 1);
    expect(find.byKey(const Key('payment-submitted')), findsOneWidget);
  });

  testWidgets('does not restore an attempt for another bill or tenant', (
    tester,
  ) async {
    final service = FakeTenantPaymentSubmissionService();
    final firstBill = bill(
      id: 'private-bill',
      month: '2026-11',
      status: 'due',
      propertyId: 'property-1',
    );
    final firstRepository = repositoryFor(firstBill);
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: firstBill,
          billingRepository: firstRepository,
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await uploadProofForSubmission(tester);
    final savedIntent = service.attempts['private-bill']!.uploadIntentId;

    service.tenantId = 'another-tenant';
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: firstBill,
          billingRepository: repositoryFor(firstBill),
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('payment-proof-awaiting-submission')),
      findsNothing,
    );
    expect(find.byKey(const Key('select-payment-proof')), findsOneWidget);

    service.tenantId = 'tenant-test';
    final otherBill = bill(
      id: 'another-bill',
      month: '2026-10',
      status: 'due',
      propertyId: 'property-1',
    );
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: otherBill,
          billingRepository: repositoryFor(otherBill),
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.byKey(const Key('payment-proof-awaiting-submission')),
      findsNothing,
    );
    expect(find.byKey(const Key('select-payment-proof')), findsOneWidget);
    expect(service.attempts['private-bill']?.uploadIntentId, savedIntent);
  });

  testWidgets('retries ambiguous submission with the same idempotency key', (
    tester,
  ) async {
    final service = FakeTenantPaymentSubmissionService(
      submissionFailures: [
        const PaymentSubmissionException(
          PaymentSubmissionFailure.network,
          'Connection unavailable.',
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: bill(
            id: 'network-bill',
            month: '2026-11',
            status: 'due',
            propertyId: 'property-1',
          ),
          billingRepository: repositoryForBill(
            id: 'network-bill',
            month: '2026-11',
            propertyId: 'property-1',
          ),
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await uploadProofForSubmission(tester);

    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('submit-payment-proof')),
    );
    await tester.tap(find.byKey(const Key('submit-payment-proof')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Connection unavailable'), findsOneWidget);
    expect(find.text('Retry payment submission'), findsOneWidget);
    final firstPayload = service.submissionPayloads.single;

    await tester.tap(find.byKey(const Key('submit-payment-proof')));
    await tester.pumpAndSettle();

    expect(service.submissionPayloads, hasLength(2));
    expect(service.submissionPayloads[1], firstPayload);
    expect(find.byKey(const Key('payment-submitted')), findsOneWidget);
  });

  testWidgets('prevents duplicate taps while submission is in progress', (
    tester,
  ) async {
    final submissionGate = Completer<void>();
    final service = FakeTenantPaymentSubmissionService(
      submissionGate: submissionGate,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: bill(
            id: 'duplicate-tap-bill',
            month: '2026-11',
            status: 'due',
            propertyId: 'property-1',
          ),
          billingRepository: repositoryForBill(
            id: 'duplicate-tap-bill',
            month: '2026-11',
            propertyId: 'property-1',
          ),
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await uploadProofForSubmission(tester);

    final submitButton = find.byKey(const Key('submit-payment-proof'));
    await tester.ensureVisible(submitButton);
    await tester.tap(submitButton);
    await tester.pump();
    expect(service.submissionPayloads, hasLength(1));
    expect(tester.widget<ElevatedButton>(submitButton).onPressed, isNull);
    await tester.tap(submitButton);
    await tester.pump();
    expect(service.submissionPayloads, hasLength(1));

    submissionGate.complete();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('payment-submitted')), findsOneWidget);
  });

  testWidgets('expired upload intent allows a fresh proof upload', (
    tester,
  ) async {
    final service = FakeTenantPaymentSubmissionService(
      submissionFailures: [
        const PaymentSubmissionException(
          PaymentSubmissionFailure.expiredUploadIntent,
          'This proof upload has expired.',
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: bill(
            id: 'expired-intent-bill',
            month: '2026-11',
            status: 'due',
            propertyId: 'property-1',
          ),
          billingRepository: repositoryForBill(
            id: 'expired-intent-bill',
            month: '2026-11',
            propertyId: 'property-1',
          ),
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await uploadProofForSubmission(tester);
    final firstUploadKey = service.lastIdempotencyKey;

    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('submit-payment-proof')),
    );
    await tester.tap(find.byKey(const Key('submit-payment-proof')));
    await tester.pumpAndSettle();
    expect(find.text('This proof upload has expired.'), findsOneWidget);
    expect(find.text('Retry proof upload'), findsOneWidget);

    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('upload-payment-proof')),
    );
    await tester.tap(find.byKey(const Key('upload-payment-proof')));
    await tester.pumpAndSettle();

    expect(service.prepareCalls, 2);
    expect(service.lastIdempotencyKey, isNot(firstUploadKey));
    expect(
      find.byKey(const Key('payment-proof-awaiting-submission')),
      findsOneWidget,
    );
  });

  testWidgets('duplicate UTR requires a fresh proof and new key', (
    tester,
  ) async {
    final service = FakeTenantPaymentSubmissionService(
      submissionFailures: [
        const PaymentSubmissionException(
          PaymentSubmissionFailure.duplicateUtr,
          'This UTR/reference was already used for this bill.',
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: bill(
            id: 'duplicate-utr-bill',
            month: '2026-11',
            status: 'due',
            propertyId: 'property-1',
          ),
          billingRepository: repositoryForBill(
            id: 'duplicate-utr-bill',
            month: '2026-11',
            propertyId: 'property-1',
          ),
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await uploadProofForSubmission(tester);

    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('submit-payment-proof')),
    );
    await tester.tap(find.byKey(const Key('submit-payment-proof')));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('UTR/reference was already used'),
      findsOneWidget,
    );

    final utrInput = find.byKey(const Key('payment-utr-input'));
    await tester.enterText(utrInput, 'xyz789');
    expect(find.byKey(const Key('select-payment-proof')), findsOneWidget);
    await tester.tap(find.byKey(const Key('select-payment-proof')));
    await tester.pumpAndSettle();
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('upload-payment-proof')),
    );
    await tester.tap(find.byKey(const Key('upload-payment-proof')));
    await tester.pumpAndSettle();
    expect(service.uploadCalls, 2);
    expect(service.submissionPayloads, hasLength(1));

    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('submit-payment-proof')),
    );
    expect(
      tester
          .widget<ElevatedButton>(find.byKey(const Key('submit-payment-proof')))
          .onPressed,
      isNotNull,
    );
    await tester.tap(find.byKey(const Key('submit-payment-proof')));
    await tester.pumpAndSettle();

    expect(service.submissionPayloads, hasLength(2));
    expect(service.submissionPayloads[0]['transactionRef'], 'ABC123');
    expect(service.submissionPayloads[1]['transactionRef'], 'XYZ789');
    expect(
      service.submissionPayloads[1]['idempotencyKey'],
      isNot(service.submissionPayloads[0]['idempotencyKey']),
    );
    expect(
      service.submissionPayloads[1]['uploadIntentId'],
      isNot(service.submissionPayloads[0]['uploadIntentId']),
    );
    expect(find.byKey(const Key('payment-submitted')), findsOneWidget);
  });

  testWidgets('logout invalidates a server reconciliation in progress', (
    tester,
  ) async {
    final billRecord = bill(
      id: 'logout-refresh-bill',
      month: '2026-11',
      status: 'due',
      propertyId: 'property-1',
    );
    final fetchGate = Completer<TenantRentBill?>();
    final repository = FakeTenantBillingRepository(
      [const Stream<List<TenantRentBill>>.empty()],
      serverBills: {billRecord.id: billRecord},
      serverFetchGate: fetchGate,
    );
    final service = FakeTenantPaymentSubmissionService();
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: billRecord,
          billingRepository: repository,
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pump();

    service.changeAuthenticatedUser(null);
    await tester.pumpAndSettle();
    expect(find.text('Checking'), findsOneWidget);
    expect(find.byKey(const Key('select-payment-proof')), findsNothing);

    fetchGate.complete(billRecord);
    await tester.pumpAndSettle();
    expect(find.text('Checking'), findsOneWidget);
    expect(find.byKey(const Key('select-payment-proof')), findsNothing);
    await service.closeAuthChanges();
  });

  testWidgets('unauthenticated StateError keeps payment actions blocked', (
    tester,
  ) async {
    final billRecord = bill(
      id: 'state-error-bill',
      month: '2026-11',
      status: 'due',
      propertyId: 'property-1',
    );
    final repository = repositoryFor(billRecord)
      ..serverFetchError = StateError('User is not authenticated.');
    final service = FakeTenantPaymentSubmissionService();
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: billRecord,
          billingRepository: repository,
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Checking'), findsOneWidget);
    expect(find.byKey(const Key('retry-tenant-bill-status')), findsOneWidget);
    expect(find.byKey(const Key('select-payment-proof')), findsNothing);

    repository.serverFetchError = null;
    await tester.tap(find.byKey(const Key('retry-tenant-bill-status')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('select-payment-proof')), findsOneWidget);
    await service.closeAuthChanges();
  });

  testWidgets(
    'logout and another tenant cannot see the previous attempt, which its owner can recover',
    (tester) async {
      final billRecord = bill(
        id: 'tenant-switch-bill',
        month: '2026-11',
        status: 'due',
        propertyId: 'property-1',
      );
      final service = FakeTenantPaymentSubmissionService()
        ..attempts[billRecord.id] = TenantPaymentSubmissionAttempt(
          tenantId: 'tenant-test',
          rentChargeId: billRecord.id,
          uploadIntentId: 'private-intent',
          transactionRef: 'ABC123',
          idempotencyKey: 'private-key',
          state: PaymentSubmissionAttemptState.proofUploaded,
        );
      Widget buildScreen() => MaterialApp(
        home: TenantBillDetailsScreen(
          bill: billRecord,
          billingRepository: repositoryFor(billRecord),
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      );

      await tester.pumpWidget(buildScreen());
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('payment-proof-awaiting-submission')),
        findsOneWidget,
      );

      service.changeAuthenticatedUser(null);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('payment-proof-awaiting-submission')),
        findsNothing,
      );
      expect(service.attempts[billRecord.id]?.uploadIntentId, 'private-intent');

      service.changeAuthenticatedUser('tenant-other');
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('payment-proof-awaiting-submission')),
        findsNothing,
      );
      expect(find.byKey(const Key('select-payment-proof')), findsOneWidget);
      expect(service.attempts[billRecord.id]?.tenantId, 'tenant-test');

      service.changeAuthenticatedUser('tenant-test');
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('payment-proof-awaiting-submission')),
        findsOneWidget,
      );
      expect(service.attempts[billRecord.id]?.uploadIntentId, 'private-intent');
      await service.closeAuthChanges();
    },
  );

  testWidgets('late upload completion after logout cannot restore payment UI', (
    tester,
  ) async {
    final uploadGate = Completer<void>();
    final service = FakeTenantPaymentSubmissionService(uploadGate: uploadGate);
    final billRecord = bill(
      id: 'logout-upload-bill',
      month: '2026-11',
      status: 'due',
      propertyId: 'property-1',
    );
    await tester.pumpWidget(
      MaterialApp(
        home: TenantBillDetailsScreen(
          bill: billRecord,
          billingRepository: repositoryFor(billRecord),
          paymentService: service,
          pickPaymentProof: proofPicker(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('confirm-upi-recipient')),
    );
    await tester.tap(find.byKey(const Key('confirm-upi-recipient')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('payment-utr-input')),
      'ABC123',
    );
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('select-payment-proof')),
    );
    await tester.tap(find.byKey(const Key('select-payment-proof')));
    await tester.pumpAndSettle();
    await ensurePaymentWidgetVisible(
      tester,
      find.byKey(const Key('upload-payment-proof')),
    );
    await tester.tap(find.byKey(const Key('upload-payment-proof')));
    await tester.pump();
    expect(service.uploadCalls, 1);

    service.changeAuthenticatedUser(null);
    await tester.pumpAndSettle();
    uploadGate.complete();
    await tester.pumpAndSettle();

    expect(
      find.byKey(const Key('payment-proof-awaiting-submission')),
      findsNothing,
    );
    expect(find.byKey(const Key('select-payment-proof')), findsNothing);
    expect(service.attempts, isEmpty);
    await service.closeAuthChanges();
  });

  testWidgets(
    'late submission completion after logout cannot update payment UI',
    (tester) async {
      final submissionGate = Completer<void>();
      final service = FakeTenantPaymentSubmissionService(
        submissionGate: submissionGate,
      );
      final billRecord = bill(
        id: 'logout-submit-bill',
        month: '2026-11',
        status: 'due',
        propertyId: 'property-1',
      );
      await tester.pumpWidget(
        MaterialApp(
          home: TenantBillDetailsScreen(
            bill: billRecord,
            billingRepository: repositoryFor(billRecord),
            paymentService: service,
            pickPaymentProof: proofPicker(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await uploadProofForSubmission(tester);
      await tester.ensureVisible(find.byKey(const Key('submit-payment-proof')));
      await tester.tap(find.byKey(const Key('submit-payment-proof')));
      await tester.pump();
      expect(service.submissionPayloads, hasLength(1));

      service.changeAuthenticatedUser(null);
      await tester.pumpAndSettle();
      submissionGate.complete();
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('payment-submitted')), findsNothing);
      expect(find.byKey(const Key('submit-payment-proof')), findsNothing);
      expect(
        service.attempts[billRecord.id]?.state,
        PaymentSubmissionAttemptState.submitting,
      );
      await service.closeAuthChanges();
    },
  );

  testWidgets('late submission completion after disposal cannot update UI', (
    tester,
  ) async {
    final submissionGate = Completer<void>();
    final service = FakeTenantPaymentSubmissionService(
      submissionGate: submissionGate,
    );
    final billRecord = bill(
      id: 'disposed-submit-bill',
      month: '2026-11',
      status: 'due',
      propertyId: 'property-1',
    );
    Widget buildScreen() => MaterialApp(
      home: TenantBillDetailsScreen(
        bill: billRecord,
        billingRepository: repositoryFor(billRecord),
        paymentService: service,
        pickPaymentProof: proofPicker(),
      ),
    );
    await tester.pumpWidget(buildScreen());
    await tester.pumpAndSettle();
    await uploadProofForSubmission(tester);
    await tester.ensureVisible(find.byKey(const Key('submit-payment-proof')));
    await tester.tap(find.byKey(const Key('submit-payment-proof')));
    await tester.pump();
    expect(service.submissionPayloads, hasLength(1));

    await tester.pumpWidget(const SizedBox.shrink());
    submissionGate.complete();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(
      service.attempts[billRecord.id]?.state,
      PaymentSubmissionAttemptState.submitting,
    );
    await service.closeAuthChanges();
  });
}
