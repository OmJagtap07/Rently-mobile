import 'dart:developer' as developer;

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';

import 'monthly_billing_repository.dart';

const tenantBillStatuses = {
  'finalized',
  'due',
  'overdue',
  'payment_pending',
  'paid',
};

const maxSafeFirestoreInteger = 9007199254740991;

class TenantRentBill {
  const TenantRentBill({
    required this.id,
    required this.billingMonth,
    required this.lineItems,
    required this.subtotal,
    required this.lateFineTotal,
    required this.adjustmentTotal,
    required this.total,
    required this.dueDate,
    required this.status,
    this.propertyId,
  });

  final String id;
  final String billingMonth;
  final List<BillingLineItem> lineItems;
  final int subtotal;
  final int lateFineTotal;
  final int adjustmentTotal;
  final int total;
  final String dueDate;
  final String status;
  final String? propertyId;

  factory TenantRentBill.fromMap(String id, Map<String, dynamic> data) {
    final billingMonth = data['billingMonth'];
    final rawLineItems = data['lineItems'];
    final subtotal = data['subtotal'];
    final lateFineTotal = data['lateFineTotal'];
    final adjustmentTotal = data['adjustmentTotal'];
    final total = data['total'];
    final dueDate = data['dueDate'];
    final status = data['status'];
    if (billingMonth is! String ||
        !RegExp(r'^\d{4}-(0[1-9]|1[0-2])$').hasMatch(billingMonth) ||
        rawLineItems is! List ||
        rawLineItems.isEmpty ||
        rawLineItems.length > 10 ||
        !_isSafeInteger(subtotal) ||
        !_isSafeInteger(lateFineTotal) ||
        !_isSafeInteger(adjustmentTotal) ||
        !_isSafeInteger(total) ||
        dueDate is! String ||
        !_isValidDueDate(dueDate) ||
        status is! String ||
        !tenantBillStatuses.contains(status)) {
      throw FormatException('Rent charge $id has invalid billing data.');
    }

    final lineItems = rawLineItems
        .map((item) {
          if (item is! Map) {
            throw FormatException('Rent charge $id has an invalid line item.');
          }
          try {
            final lineItem = BillingLineItem.fromMap(
              Map<String, dynamic>.from(item),
            );
            if (item.length != 3 ||
                !item.keys.toSet().containsAll(const {
                  'type',
                  'label',
                  'amount',
                }) ||
                !const {
                  'rent',
                  'electricity',
                  'maintenance',
                  'other',
                }.contains(lineItem.type) ||
                lineItem.label.trim().isEmpty ||
                !_isSafeInteger(lineItem.amount) ||
                lineItem.amount < 0) {
              throw const FormatException('Invalid line item values.');
            }
            return lineItem;
          } on Object {
            throw FormatException('Rent charge $id has an invalid line item.');
          }
        })
        .toList(growable: false);
    final calculatedSubtotal = lineItems.fold<int>(
      0,
      (totalAmount, item) => totalAmount + item.amount,
    );
    final rentItemCount = lineItems.where((item) => item.type == 'rent').length;
    if (subtotal < 0 ||
        lateFineTotal < 0 ||
        rentItemCount != 1 ||
        !_isSafeInteger(calculatedSubtotal) ||
        subtotal != calculatedSubtotal ||
        !_isSafeInteger(subtotal + lateFineTotal + adjustmentTotal) ||
        total != subtotal + lateFineTotal + adjustmentTotal) {
      throw FormatException('Rent charge $id has inconsistent totals.');
    }

    return TenantRentBill(
      id: id,
      billingMonth: billingMonth,
      lineItems: lineItems,
      subtotal: subtotal,
      lateFineTotal: lateFineTotal,
      adjustmentTotal: adjustmentTotal,
      total: total,
      dueDate: dueDate,
      status: status,
      propertyId: data['propertyId'] is String
          ? (data['propertyId'] as String).trim()
          : null,
    );
  }
}

bool _isSafeInteger(Object? value) =>
    value is int &&
    value >= -maxSafeFirestoreInteger &&
    value <= maxSafeFirestoreInteger;

bool _isValidDueDate(String value) {
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value)) return false;
  final date = DateTime.tryParse(value);
  return date != null &&
      date.year.toString().padLeft(4, '0') == value.substring(0, 4) &&
      date.month.toString().padLeft(2, '0') == value.substring(5, 7) &&
      date.day.toString().padLeft(2, '0') == value.substring(8, 10);
}

abstract interface class TenantBillingRepository {
  Stream<List<TenantRentBill>> watchTenantBills();

  Future<TenantRentBill?> fetchTenantBillFromServer(String billId);
}

typedef TenantBillDocumentData = MapEntry<String, Map<String, dynamic>>;
typedef TenantBillDocumentStream =
    Stream<List<TenantBillDocumentData>> Function(String tenantId);
typedef TenantBillDocumentGetter = Future<Map<String, dynamic>?> Function(
  String tenantId,
  String billId,
);

class FirestoreTenantBillingRepository implements TenantBillingRepository {
  FirestoreTenantBillingRepository({
    FirebaseFirestore? firestore,
    FirebaseAuth? auth,
    String? Function()? uidProvider,
    TenantBillDocumentStream? watchDocuments,
    TenantBillDocumentGetter? getDocument,
  }) : this._(firestore, auth, uidProvider, watchDocuments, getDocument);

  FirestoreTenantBillingRepository._(
    this._firestore,
    this._auth,
    this._uidProvider,
    this._watchDocuments,
    this._getDocument,
  );

  final FirebaseFirestore? _firestore;
  final FirebaseAuth? _auth;
  final String? Function()? _uidProvider;
  final TenantBillDocumentStream? _watchDocuments;
  final TenantBillDocumentGetter? _getDocument;

  @override
  Future<TenantRentBill?> fetchTenantBillFromServer(String billId) async {
    final uid = _uidProvider?.call() ?? _auth?.currentUser?.uid;
    if (uid == null) {
      throw StateError('User is not authenticated.');
    }

    final Map<String, dynamic>? data;
    if (_getDocument != null) {
      data = await _getDocument(uid, billId);
    } else {
      final snapshot = await (_firestore ?? FirebaseFirestore.instance)
          .collection('rentCharges')
          .doc(billId)
          .get(const GetOptions(source: Source.server));
      data = snapshot.data();
    }
    if (data == null || data['tenantId'] != uid || data['status'] == 'draft') {
      return null;
    }
    return TenantRentBill.fromMap(billId, data);
  }

  @override
  Stream<List<TenantRentBill>> watchTenantBills() {
    final uid = _uidProvider?.call() ?? _auth?.currentUser?.uid;
    if (uid == null) {
      return Stream.error(StateError('User is not authenticated.'));
    }

    final documents =
        _watchDocuments?.call(uid) ??
        (_firestore ?? FirebaseFirestore.instance)
            .collection('rentCharges')
            .where('tenantId', isEqualTo: uid)
            .snapshots()
            .map(
              (snapshot) => snapshot.docs
                  .map((doc) => MapEntry(doc.id, doc.data()))
                  .toList(growable: false),
            );

    return documents.map((records) {
      final bills = <TenantRentBill>[];
      for (final record in records) {
        if (record.value['status'] == 'draft') continue;
        try {
          bills.add(TenantRentBill.fromMap(record.key, record.value));
        } on FormatException catch (error) {
          developer.log(
            'Skipping malformed tenant rent charge ${record.key}: ${error.message}',
            name: 'rently.tenant_billing',
            level: 900,
          );
        }
      }
      return bills;
    });
  }
}
