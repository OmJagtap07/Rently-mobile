import 'dart:async';

import 'package:app/dashboards/landlord/monthly_billing_screen.dart';
import 'package:app/services/monthly_billing_repository.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const activeLease = BillingLease(
  id: 'lease-1',
  tenantId: 'tenant-1',
  landlordId: 'landlord-1',
  propertyId: 'property-1',
  unitId: 'unit-1',
  tenantName: 'Asha Tenant',
  propertyName: 'Green Heights',
  roomNumber: '302',
  currentBaseRent: 123450,
  status: 'active',
);

class FakeMonthlyBillingRepository implements MonthlyBillingRepository {
  List<BillingLease> leaseValues = const [activeLease];
  Map<String, RentChargeRecord> chargeValues = {};
  late final StreamController<List<BillingLease>> leases =
      StreamController<List<BillingLease>>.broadcast(
        onListen: () => scheduleMicrotask(() {
          if (leases.hasListener) leases.add(leaseValues);
        }),
      );
  late final StreamController<Map<String, RentChargeRecord>> charges =
      StreamController<Map<String, RentChargeRecord>>.broadcast(
        onListen: () => scheduleMicrotask(() {
          if (charges.hasListener) charges.add(chargeValues);
        }),
      );
  final List<String> savedIds = [];
  final List<List<BillingLineItem>> savedItems = [];
  int finalizeCalls = 0;
  String watchedMonth = '';
  Timestamp nextUpdatedAt = Timestamp(10, 0);

  @override
  Stream<List<BillingLease>> watchLandlordLeases() {
    return leases.stream;
  }

  @override
  Stream<Map<String, RentChargeRecord>> watchChargesForMonth(
    String billingMonth,
  ) {
    watchedMonth = billingMonth;
    return charges.stream;
  }

  @override
  int calculateSubtotal(List<BillingLineItem> lineItems) =>
      lineItems.fold(0, (total, item) => total + item.amount);

  @override
  Future<String> saveDraft({
    required BillingLease lease,
    required String billingMonth,
    required List<BillingLineItem> lineItems,
    required Timestamp? expectedUpdatedAt,
  }) async {
    final currentLease = leaseValues.firstWhere(
      (candidate) => candidate.id == lease.id,
    );
    if (currentLease.status != 'active') {
      throw StateError(
        'This lease is no longer active. Draft editing is unavailable.',
      );
    }

    final id = '${lease.id}_$billingMonth';
    final existing = chargeValues[lease.id];
    if (existing != null &&
        (expectedUpdatedAt == null ||
            existing.updatedAt == null ||
            existing.updatedAt!.compareTo(expectedUpdatedAt) != 0)) {
      throw StateError(
        'This draft changed since it was opened. Reload it before saving.',
      );
    }
    if (existing == null && expectedUpdatedAt != null) {
      throw StateError(
        'This draft is no longer available. Reload the billing screen.',
      );
    }

    savedIds.add(id);
    savedItems.add(lineItems);
    final subtotal = calculateSubtotal(lineItems);
    nextUpdatedAt = Timestamp(nextUpdatedAt.seconds + 1, 0);
    chargeValues = {
      ...chargeValues,
      lease.id: RentChargeRecord(
        id: id,
        status: 'draft',
        lineItems: lineItems,
        subtotal: subtotal,
        total: subtotal,
        dueDate: '$billingMonth-10',
        updatedAt: nextUpdatedAt,
      ),
    };
    charges.add(chargeValues);
    return id;
  }

  @override
  Future<FinalizedRentCharge> finalize(String rentChargeId) async {
    finalizeCalls++;
    final entry = chargeValues.entries.firstWhere(
      (entry) => entry.value.id == rentChargeId,
    );
    final charge = entry.value;
    chargeValues = {
      ...chargeValues,
      entry.key: RentChargeRecord(
        id: charge.id,
        status: 'finalized',
        lineItems: charge.lineItems,
        subtotal: charge.subtotal,
        total: charge.total,
        dueDate: charge.dueDate,
        updatedAt: charge.updatedAt,
      ),
    };
    charges.add(chargeValues);
    return FinalizedRentCharge(total: charge.total, dueDate: charge.dueDate);
  }

  Future<void> dispose() async {
    await leases.close();
    await charges.close();
  }
}

Future<void> pumpBilling(
  WidgetTester tester,
  FakeMonthlyBillingRepository repository,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: MonthlyBillingScreen(
          repository: repository,
          initialMonth: DateTime(2026, 11),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  late FakeMonthlyBillingRepository repository;

  setUp(() {
    repository = FakeMonthlyBillingRepository();
  });

  tearDown(() async {
    await repository.dispose();
  });

  test('paise formatting and rupee parsing preserve integer paise', () {
    expect(formatPaise(123450), '₹1234.50');
    expect(formatPaise(120000), '₹1200');
    expect(parseRupeesToPaise('1234.5'), 123450);
    expect(parseRupeesToPaise('12.345'), isNull);
  });

  testWidgets('lists active leases and opens billing for the selected tenant', (
    tester,
  ) async {
    await pumpBilling(tester, repository);

    expect(find.text('Asha Tenant'), findsOneWidget);
    expect(find.text('Green Heights · Room 302'), findsOneWidget);
    expect(find.text('Not prepared'), findsOneWidget);
    expect(find.text('November 2026'), findsOneWidget);
    expect(repository.watchedMonth, '2026-11');

    await tester.tap(find.byKey(const Key('edit-bill-lease-1')));
    await tester.pumpAndSettle();
    expect(find.text('Prepare draft bill'), findsOneWidget);
    expect(
      tester
          .widget<TextFormField>(find.byKey(const Key('rent-amount')))
          .controller!
          .text,
      '1234.50',
    );
    expect(find.text('Due date: 2026-11-10'), findsOneWidget);
  });

  testWidgets('allows selecting a different billing month', (tester) async {
    await pumpBilling(tester, repository);

    await tester.tap(find.byTooltip('Next billing month'));
    await tester.pumpAndSettle();

    expect(find.text('December 2026'), findsOneWidget);
    expect(repository.watchedMonth, '2026-12');
  });

  testWidgets(
    'manual charges and multiple other entries calculate and save draft',
    (tester) async {
      await pumpBilling(tester, repository);
      await tester.tap(find.byKey(const Key('edit-bill-lease-1')));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('electricity-amount')),
        '234.50',
      );
      await tester.enterText(find.byKey(const Key('maintenance-amount')), '50');
      await tester.tap(find.byKey(const Key('add-other-charge')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('other-label-0')), 'Water');
      await tester.enterText(find.byKey(const Key('other-amount-0')), '100');
      await tester.tap(find.byKey(const Key('add-other-charge')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('other-label-1')), 'Parking');
      await tester.enterText(find.byKey(const Key('other-amount-1')), '25');
      await tester.pump();

      expect(find.text('₹1644'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('save-draft')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('save-draft')));
      await tester.pumpAndSettle();

      expect(repository.savedIds, ['lease-1_2026-11']);
      expect(repository.savedItems.single.map((item) => item.type), [
        'rent',
        'electricity',
        'maintenance',
        'other',
        'other',
      ]);
      expect(repository.savedItems.single.map((item) => item.amount), [
        123450,
        23450,
        5000,
        10000,
        2500,
      ]);
      expect(find.text('Draft'), findsOneWidget);
      expect(find.text('Due date: 2026-11-10'), findsOneWidget);
      expect(find.text('Total'), findsOneWidget);
      expect(find.text('₹1644'), findsNWidgets(2));
    },
  );

  testWidgets('saved draft reloads and can be edited without another bill ID', (
    tester,
  ) async {
    repository.chargeValues = {
      activeLease.id: RentChargeRecord(
        id: 'lease-1_2026-11',
        status: 'draft',
        lineItems: const [
          BillingLineItem(type: 'rent', label: 'Rent', amount: 123450),
          BillingLineItem(
            type: 'electricity',
            label: 'Electricity',
            amount: 5000,
          ),
          BillingLineItem(
            type: 'maintenance',
            label: 'Maintenance',
            amount: 2500,
          ),
          BillingLineItem(type: 'other', label: 'Water', amount: 1000),
        ],
        subtotal: 131950,
        total: 131950,
        dueDate: '2026-11-10',
        updatedAt: Timestamp(10, 0),
      ),
    };
    await pumpBilling(tester, repository);

    expect(find.text('Water'), findsOneWidget);
    expect(find.text('Draft'), findsOneWidget);
    await tester.tap(find.byKey(const Key('edit-bill-lease-1')));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextFormField>(find.byKey(const Key('other-label-0')))
          .controller!
          .text,
      'Water',
    );
    expect(
      tester
          .widget<TextFormField>(find.byKey(const Key('electricity-amount')))
          .controller!
          .text,
      '50',
    );
    await tester.enterText(find.byKey(const Key('electricity-amount')), '60');
    await tester.ensureVisible(find.byKey(const Key('save-draft')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('save-draft')));
    await tester.pumpAndSettle();

    expect(repository.savedIds, ['lease-1_2026-11']);
    expect(find.text('Draft'), findsOneWidget);
    expect(find.text('₹1329.50'), findsNWidgets(2));
  });

  testWidgets(
    'prevents creating a second draft when the month already has one',
    (tester) async {
      repository.chargeValues = {
        activeLease.id: RentChargeRecord(
          id: 'lease-1_2026-11',
          status: 'draft',
          lineItems: const [
            BillingLineItem(type: 'rent', label: 'Rent', amount: 123450),
            BillingLineItem(
              type: 'electricity',
              label: 'Electricity',
              amount: 0,
            ),
            BillingLineItem(
              type: 'maintenance',
              label: 'Maintenance',
              amount: 0,
            ),
          ],
          subtotal: 123450,
          total: 123450,
          dueDate: '2026-11-10',
          updatedAt: Timestamp(10, 0),
        ),
      };
      await pumpBilling(tester, repository);

      expect(find.text('Prepare draft'), findsNothing);
      expect(find.text('Edit draft'), findsOneWidget);
      await tester.tap(find.byKey(const Key('edit-bill-lease-1')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('save-draft')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('save-draft')));
      await tester.pumpAndSettle();
      expect(repository.savedIds, ['lease-1_2026-11']);
    },
  );

  testWidgets('caps other charges at the backend ten-item limit', (
    tester,
  ) async {
    await pumpBilling(tester, repository);
    await tester.tap(find.byKey(const Key('edit-bill-lease-1')));
    await tester.pumpAndSettle();

    for (var index = 0; index < 7; index++) {
      await tester.tap(find.byKey(const Key('add-other-charge')));
      await tester.pumpAndSettle();
    }

    final addButton = tester.widget<TextButton>(
      find.byKey(const Key('add-other-charge')),
    );
    expect(addButton.onPressed, isNull);
    expect(find.text('Add (7/7)'), findsOneWidget);
  });

  testWidgets(
    'requires confirmation before finalizing and locks finalized bill',
    (tester) async {
      repository.chargeValues = {
        activeLease.id: RentChargeRecord(
          id: 'lease-1_2026-11',
          status: 'draft',
          lineItems: const [
            BillingLineItem(type: 'rent', label: 'Rent', amount: 123450),
            BillingLineItem(
              type: 'electricity',
              label: 'Electricity',
              amount: 0,
            ),
            BillingLineItem(
              type: 'maintenance',
              label: 'Maintenance',
              amount: 0,
            ),
          ],
          subtotal: 123450,
          total: 123450,
          dueDate: '2026-11-10',
          updatedAt: Timestamp(10, 0),
        ),
      };
      await pumpBilling(tester, repository);
      await tester.tap(find.byKey(const Key('finalize-bill-lease-1')));
      await tester.pumpAndSettle();

      expect(find.text('Finalize bill?'), findsOneWidget);
      expect(repository.finalizeCalls, 0);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(repository.finalizeCalls, 0);

      await tester.tap(find.byKey(const Key('finalize-bill-lease-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('confirm-finalize-bill')));
      await tester.pumpAndSettle();

      expect(repository.finalizeCalls, 1);
      expect(find.text('Finalized'), findsOneWidget);
      expect(find.text('Edit draft'), findsNothing);
      expect(find.textContaining('read-only'), findsOneWidget);
    },
  );

  testWidgets('rejects a stale draft edit without replacing newer values', (
    tester,
  ) async {
    repository.chargeValues = {
      activeLease.id: RentChargeRecord(
        id: 'lease-1_2026-11',
        status: 'draft',
        lineItems: const [
          BillingLineItem(type: 'rent', label: 'Rent', amount: 123450),
          BillingLineItem(
            type: 'electricity',
            label: 'Electricity',
            amount: 5000,
          ),
        ],
        subtotal: 128450,
        total: 128450,
        dueDate: '2026-11-10',
        updatedAt: Timestamp(10, 0),
      ),
    };
    await pumpBilling(tester, repository);
    await tester.tap(find.byKey(const Key('edit-bill-lease-1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('electricity-amount')), '60');

    final latest = repository.chargeValues[activeLease.id]!;
    repository.chargeValues[activeLease.id] = RentChargeRecord(
      id: latest.id,
      status: latest.status,
      lineItems: const [
        BillingLineItem(type: 'rent', label: 'Rent', amount: 123450),
        BillingLineItem(
          type: 'electricity',
          label: 'Electricity',
          amount: 7000,
        ),
      ],
      subtotal: 130450,
      total: 130450,
      dueDate: latest.dueDate,
      updatedAt: Timestamp(11, 0),
    );

    await tester.ensureVisible(find.byKey(const Key('save-draft')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('save-draft')));
    await tester.pumpAndSettle();

    expect(find.textContaining('changed since it was opened'), findsOneWidget);
    expect(repository.chargeValues[activeLease.id]!.lineItems[1].amount, 7000);
    expect(repository.savedIds, isEmpty);
  });

  testWidgets('lease ending while the editor is open prevents saving', (
    tester,
  ) async {
    repository.chargeValues = {
      activeLease.id: RentChargeRecord(
        id: 'lease-1_2026-11',
        status: 'draft',
        lineItems: const [
          BillingLineItem(type: 'rent', label: 'Rent', amount: 123450),
        ],
        subtotal: 123450,
        total: 123450,
        dueDate: '2026-11-10',
        updatedAt: Timestamp(10, 0),
      ),
    };
    await pumpBilling(tester, repository);
    await tester.tap(find.byKey(const Key('edit-bill-lease-1')));
    await tester.pumpAndSettle();
    repository.leaseValues = [
      BillingLease(
        id: activeLease.id,
        tenantId: activeLease.tenantId,
        landlordId: activeLease.landlordId,
        propertyId: activeLease.propertyId,
        unitId: activeLease.unitId,
        tenantName: activeLease.tenantName,
        propertyName: activeLease.propertyName,
        roomNumber: activeLease.roomNumber,
        currentBaseRent: activeLease.currentBaseRent,
        status: 'ended',
      ),
    ];

    await tester.ensureVisible(find.byKey(const Key('save-draft')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('save-draft')));
    await tester.pumpAndSettle();

    expect(find.textContaining('lease is no longer active'), findsOneWidget);
    expect(repository.savedIds, isEmpty);
  });

  testWidgets('ended lease draft remains visible and read-only', (
    tester,
  ) async {
    repository.leaseValues = [
      BillingLease(
        id: activeLease.id,
        tenantId: activeLease.tenantId,
        landlordId: activeLease.landlordId,
        propertyId: activeLease.propertyId,
        unitId: activeLease.unitId,
        tenantName: activeLease.tenantName,
        propertyName: activeLease.propertyName,
        roomNumber: activeLease.roomNumber,
        currentBaseRent: activeLease.currentBaseRent,
        status: 'ended',
      ),
    ];
    repository.chargeValues = {
      activeLease.id: RentChargeRecord(
        id: 'lease-1_2026-11',
        status: 'draft',
        lineItems: const [
          BillingLineItem(type: 'rent', label: 'Rent', amount: 123450),
        ],
        subtotal: 123450,
        total: 123450,
        dueDate: '2026-11-10',
        updatedAt: Timestamp(10, 0),
      ),
    };
    await pumpBilling(tester, repository);

    expect(find.text('Asha Tenant'), findsOneWidget);
    expect(find.text('Draft'), findsOneWidget);
    expect(find.textContaining('retained for history'), findsOneWidget);
    expect(find.byKey(const Key('edit-bill-lease-1')), findsNothing);
    expect(find.byKey(const Key('finalize-bill-lease-1')), findsNothing);
  });

  testWidgets('shows lease loading and stream errors', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MonthlyBillingScreen(
            repository: repository,
            initialMonth: DateTime(2026, 11),
          ),
        ),
      ),
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    repository.leases.addError(StateError('lease stream unavailable'));
    await tester.pump();
    expect(find.textContaining('Could not load leases'), findsOneWidget);
  });

  testWidgets('shows billing stream errors', (tester) async {
    await pumpBilling(tester, repository);
    repository.charges.addError(StateError('billing stream unavailable'));
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('Could not load bills'), findsOneWidget);
  });
}
