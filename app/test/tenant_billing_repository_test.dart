import 'package:app/services/tenant_billing_repository.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> rentCharge({
  String status = 'due',
  Object subtotal = 10000,
  Object lateFineTotal = 0,
  Object adjustmentTotal = 0,
  Object total = 10000,
  List<Map<String, dynamic>>? lineItems,
}) => {
  'leaseId': 'ended-lease',
  'billingMonth': '2026-03',
  'lineItems':
      lineItems ??
      [
        {'type': 'rent', 'label': 'Rent', 'amount': 10000},
      ],
  'subtotal': subtotal,
  'lateFineTotal': lateFineTotal,
  'adjustmentTotal': adjustmentTotal,
  'total': total,
  'dueDate': '2026-03-10',
  'status': status,
};

void main() {
  test('scopes the query to the authenticated tenant and retains ended-lease bills', () async {
    String? queriedTenant;
    final repository = FirestoreTenantBillingRepository(
      uidProvider: () => 'tenant-42',
      watchDocuments: (tenantId) {
        queriedTenant = tenantId;
        return Stream.value([MapEntry('ended-lease_2026-03', rentCharge())]);
      },
    );

    final bills = await repository.watchTenantBills().first;

    expect(queriedTenant, 'tenant-42');
    expect(bills, hasLength(1));
    expect(bills.single.id, 'ended-lease_2026-03');
  });

  test(
    'fetches a bill from the server and verifies tenant ownership',
    () async {
      String? requestedTenant;
      final repository = FirestoreTenantBillingRepository(
        uidProvider: () => 'tenant-42',
        getDocument: (tenantId, billId) async {
          requestedTenant = tenantId;
          expect(billId, 'bill-1');
          return {...rentCharge(), 'tenantId': tenantId};
        },
      );

      final fetched = await repository.fetchTenantBillFromServer('bill-1');
      expect(requestedTenant, 'tenant-42');
      expect(fetched?.id, 'bill-1');
      expect(fetched?.status, 'due');

      final foreignBillRepository = FirestoreTenantBillingRepository(
        uidProvider: () => 'tenant-42',
        getDocument: (_, _) async => {
          ...rentCharge(),
          'tenantId': 'another-tenant',
        },
      );
      expect(
        await foreignBillRepository.fetchTenantBillFromServer('bill-1'),
        isNull,
      );
    },
  );

  test(
    'skips malformed documents without dropping valid bills or zeroing values',
    () async {
      final repository = FirestoreTenantBillingRepository(
        uidProvider: () => 'tenant-42',
        watchDocuments: (_) => Stream.value([
          MapEntry('valid', rentCharge()),
          MapEntry('bad-total', rentCharge(total: 'not-an-amount')),
          MapEntry('bad-equation', rentCharge(total: 10001)),
          MapEntry(
            'missing-rent',
            rentCharge(
              subtotal: 10000,
              total: 10000,
              lineItems: [
                {'type': 'other', 'label': 'Fee', 'amount': 10000},
              ],
            ),
          ),
          MapEntry('draft', rentCharge(status: 'draft')),
        ]),
      );

      final bills = await repository.watchTenantBills().first;

      expect(bills, hasLength(1));
      expect(bills.single.id, 'valid');
      expect(bills.single.total, 10000);
    },
  );

  test('rejects inconsistent line-item subtotal and billing totals', () {
    expect(
      () => TenantRentBill.fromMap(
        'invalid',
        rentCharge(subtotal: 12000, total: 12000),
      ),
      throwsFormatException,
    );
  });

  test('accepts safe-integer boundaries and signed adjustment credits', () {
    const maxSafe = 9007199254740991;
    final maximumLineItemBill = TenantRentBill.fromMap(
      'max-line',
      rentCharge(
        subtotal: maxSafe,
        total: maxSafe,
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': maxSafe},
        ],
      ),
    );
    final maximumAdjustmentBill = TenantRentBill.fromMap(
      'max-adjustment',
      rentCharge(
        subtotal: 0,
        adjustmentTotal: maxSafe,
        total: maxSafe,
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': 0},
        ],
      ),
    );
    final maximumFineBill = TenantRentBill.fromMap(
      'max-fine',
      rentCharge(
        subtotal: 0,
        lateFineTotal: maxSafe,
        total: maxSafe,
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': 0},
        ],
      ),
    );
    final minimumAdjustmentBill = TenantRentBill.fromMap(
      'min-adjustment',
      rentCharge(
        subtotal: maxSafe,
        adjustmentTotal: -maxSafe,
        total: 0,
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': maxSafe},
        ],
      ),
    );
    final minimumTotalBill = TenantRentBill.fromMap(
      'min-total',
      rentCharge(
        subtotal: 0,
        adjustmentTotal: -maxSafe,
        total: -maxSafe,
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': 0},
        ],
      ),
    );

    expect(maximumLineItemBill.subtotal, maxSafe);
    expect(maximumAdjustmentBill.adjustmentTotal, maxSafe);
    expect(maximumFineBill.lateFineTotal, maxSafe);
    expect(minimumAdjustmentBill.adjustmentTotal, -maxSafe);
    expect(minimumAdjustmentBill.total, 0);
    expect(minimumTotalBill.total, -maxSafe);
  });

  test('rejects values beyond JavaScript safe-integer bounds', () {
    const maxSafe = 9007199254740991;
    final invalidBills = [
      rentCharge(
        subtotal: maxSafe + 1,
        total: maxSafe + 1,
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': maxSafe + 1},
        ],
      ),
      rentCharge(
        subtotal: maxSafe,
        total: maxSafe + 1,
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': maxSafe},
        ],
        lateFineTotal: maxSafe + 1,
        adjustmentTotal: -(maxSafe - 1),
      ),
      rentCharge(
        subtotal: 0,
        total: maxSafe + 1,
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': 0},
        ],
        adjustmentTotal: maxSafe + 1,
      ),
      rentCharge(
        subtotal: 0,
        total: -(maxSafe + 1),
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': 0},
        ],
        adjustmentTotal: -(maxSafe + 1),
      ),
      rentCharge(
        subtotal: maxSafe,
        total: maxSafe + 1,
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': maxSafe},
          {'type': 'other', 'label': 'Fee', 'amount': 1},
        ],
        adjustmentTotal: 0,
      ),
      rentCharge(
        subtotal: 0,
        total: 0,
        lineItems: [
          {'type': 'rent', 'label': 'Rent', 'amount': maxSafe + 1},
        ],
      ),
    ];

    for (var index = 0; index < invalidBills.length; index++) {
      expect(
        () => TenantRentBill.fromMap('unsafe-$index', invalidBills[index]),
        throwsFormatException,
      );
    }
  });

  test('requires one to ten line items and exactly one rent item', () {
    final noItems = rentCharge(subtotal: 0, total: 0, lineItems: const []);
    final elevenItems = List.generate(
      11,
      (index) => {
        'type': index == 0 ? 'rent' : 'other',
        'label': 'Item $index',
        'amount': 1,
      },
    );
    final duplicateRent = rentCharge(
      subtotal: 2,
      total: 2,
      lineItems: [
        {'type': 'rent', 'label': 'Rent 1', 'amount': 1},
        {'type': 'rent', 'label': 'Rent 2', 'amount': 1},
      ],
    );

    for (final (index, invalid) in [
      noItems,
      rentCharge(
        subtotal: 10,
        total: 10,
        lineItems: [
          {'type': 'other', 'label': 'Fee', 'amount': 10},
        ],
      ),
      duplicateRent,
      rentCharge(subtotal: 11, total: 11, lineItems: elevenItems),
    ].indexed) {
      expect(
        () => TenantRentBill.fromMap('invalid-items-$index', invalid),
        throwsFormatException,
      );
    }

    final tenItems = List.generate(
      10,
      (index) => {
        'type': index == 0 ? 'rent' : 'other',
        'label': 'Item $index',
        'amount': 1,
      },
    );
    expect(
      TenantRentBill.fromMap(
        'ten-items',
        rentCharge(subtotal: 10, total: 10, lineItems: tenItems),
      ).lineItems,
      hasLength(10),
    );
  });

  test('rejects line items that do not match backend field structure', () {
    expect(
      () => TenantRentBill.fromMap(
        'extra-line-field',
        rentCharge(
          lineItems: [
            {
              'type': 'rent',
              'label': 'Rent',
              'amount': 10000,
              'unexpected': true,
            },
          ],
        ),
      ),
      throwsFormatException,
    );
  });
}
