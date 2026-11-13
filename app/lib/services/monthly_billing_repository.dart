import 'package:cloud_firestore/cloud_firestore.dart';

class BillingLease {
  const BillingLease({
    required this.id,
    required this.tenantId,
    required this.landlordId,
    required this.propertyId,
    required this.unitId,
    required this.tenantName,
    required this.propertyName,
    required this.roomNumber,
    required this.currentBaseRent,
    this.status = 'active',
  });

  final String id;
  final String tenantId;
  final String landlordId;
  final String propertyId;
  final String unitId;
  final String tenantName;
  final String propertyName;
  final String roomNumber;
  final int currentBaseRent;
  final String status;

  factory BillingLease.fromMap(String id, Map<String, dynamic> data) {
    return BillingLease(
      id: id,
      tenantId: data['tenantId'] as String? ?? '',
      landlordId: data['landlordId'] as String? ?? '',
      propertyId: data['propertyId'] as String? ?? '',
      unitId: data['unitId'] as String? ?? '',
      tenantName: data['tenantName'] as String? ?? 'Tenant',
      propertyName: data['propertyName'] as String? ?? 'Property',
      roomNumber: data['roomNumber'] as String? ?? '',
      currentBaseRent: data['currentBaseRent'] as int? ?? 0,
      status: data['status'] as String? ?? 'active',
    );
  }
}

class BillingLineItem {
  const BillingLineItem({
    required this.type,
    required this.label,
    required this.amount,
  });

  final String type;
  final String label;
  final int amount;

  factory BillingLineItem.fromMap(Map<String, dynamic> data) {
    return BillingLineItem(
      type: data['type'] as String,
      label: data['label'] as String,
      amount: data['amount'] as int,
    );
  }

  Map<String, dynamic> toMap() => {
    'type': type,
    'label': label,
    'amount': amount,
  };
}

class RentChargeRecord {
  const RentChargeRecord({
    required this.id,
    required this.status,
    required this.lineItems,
    required this.subtotal,
    required this.total,
    required this.dueDate,
    this.updatedAt,
  });

  final String id;
  final String status;
  final List<BillingLineItem> lineItems;
  final int subtotal;
  final int total;
  final String dueDate;
  final Timestamp? updatedAt;

  factory RentChargeRecord.fromMap(String id, Map<String, dynamic> data) {
    final rawItems = data['lineItems'] as List<dynamic>? ?? const [];
    return RentChargeRecord(
      id: id,
      status: data['status'] as String? ?? 'draft',
      lineItems: rawItems
          .map(
            (item) =>
                BillingLineItem.fromMap(Map<String, dynamic>.from(item as Map)),
          )
          .toList(),
      subtotal: data['subtotal'] as int? ?? 0,
      total: data['total'] as int? ?? 0,
      dueDate: data['dueDate'] as String? ?? '',
      updatedAt: data['updatedAt'] as Timestamp?,
    );
  }
}

class FinalizedRentCharge {
  const FinalizedRentCharge({required this.total, required this.dueDate});

  final int total;
  final String dueDate;
}

abstract interface class MonthlyBillingRepository {
  Stream<List<BillingLease>> watchLandlordLeases();

  Stream<Map<String, RentChargeRecord>> watchChargesForMonth(
    String billingMonth,
  );

  Future<String> saveDraft({
    required BillingLease lease,
    required String billingMonth,
    required List<BillingLineItem> lineItems,
    required Timestamp? expectedUpdatedAt,
  });

  Future<FinalizedRentCharge> finalize(String rentChargeId);

  int calculateSubtotal(List<BillingLineItem> lineItems);
}

String formatPaise(int amount) {
  final absoluteAmount = amount.abs();
  final rupees = absoluteAmount ~/ 100;
  final paise = amount.abs() % 100;
  final sign = amount < 0 ? '-' : '';
  if (paise == 0) return '₹$sign$rupees';
  return '₹$sign$rupees.${paise.toString().padLeft(2, '0')}';
}

int? parseRupeesToPaise(String value) {
  final match = RegExp(r'^(\d+)(?:\.(\d{1,2}))?$').firstMatch(value.trim());
  if (match == null) return null;

  final rupees = int.tryParse(match.group(1)!);
  final paise = int.tryParse((match.group(2) ?? '').padRight(2, '0'));
  if (rupees == null || paise == null) return null;

  final total = rupees * 100 + paise;
  return total <= 9007199254740991 ? total : null;
}
