import 'dart:math';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';

import 'monthly_billing_repository.dart';
import 'property_payment_details.dart';

class PropertyService implements MonthlyBillingRepository {
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;
  final FirebaseFunctions _functions = FirebaseFunctions.instance;
  final FirebaseAuth _auth = FirebaseAuth.instance;

  String? get currentUid => _auth.currentUser?.uid;

  // ───────────────────────── LANDLORD: PROPERTIES ─────────────────────────

  /// Generates an 8-character uppercase alphanumeric join code.
  String _generateJoinCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    final rnd = Random();
    return List.generate(8, (index) => chars[rnd.nextInt(chars.length)]).join();
  }

  /// Create a new property under the landlord.
  Future<String> createProperty({
    required String name,
    required String address,
    required String upiId,
    required String upiQrImageUrl,
    required String upiDisplayName,
    String? googleMapsLink,
  }) async {
    final uid = currentUid;
    if (uid == null) throw Exception('User not authenticated');
    validatePropertyUpiDetails(
      upiId: upiId,
      upiQrImageUrl: upiQrImageUrl,
      upiDisplayName: upiDisplayName,
    );

    final joinCode = _generateJoinCode();
    final docRef = _firestore.collection('properties').doc();
    final now = FieldValue.serverTimestamp();

    await docRef.set({
      'landlordId': uid,
      'name': name.trim(),
      'address': address.trim(),
      'googleMapsLink': googleMapsLink?.trim().isEmpty ?? true
          ? null
          : googleMapsLink!.trim(),
      'upiId': upiId.trim(),
      'upiQrImageUrl': normalizeUpiQrImageUrl(upiQrImageUrl),
      'upiDisplayName': upiDisplayName.trim(),
      'joinCode': joinCode,
      'status': 'active',
      'createdAt': now,
      'updatedAt': now,
    });

    return docRef.id;
  }

  Future<void> updatePropertyUpiDetails({
    required String propertyId,
    required String upiId,
    required String upiQrImageUrl,
    required String upiDisplayName,
  }) async {
    final uid = currentUid;
    if (uid == null) throw Exception('User not authenticated');
    validatePropertyUpiDetails(
      upiId: upiId,
      upiQrImageUrl: upiQrImageUrl,
      upiDisplayName: upiDisplayName,
    );

    await _firestore.collection('properties').doc(propertyId).update({
      'upiId': upiId.trim(),
      'upiQrImageUrl': normalizeUpiQrImageUrl(upiQrImageUrl),
      'upiDisplayName': upiDisplayName.trim(),
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  /// Stream of all active/managed properties for the current landlord.
  Stream<QuerySnapshot<Map<String, dynamic>>> getLandlordPropertiesStream() {
    final uid = currentUid;
    if (uid == null) return const Stream.empty();

    return _firestore
        .collection('properties')
        .where('landlordId', isEqualTo: uid)
        .snapshots();
  }

  // ───────────────────────── LANDLORD: UNITS ─────────────────────────

  /// Create a new unit inside a property.
  Future<String> createUnit({
    required String propertyId,
    required String roomNumber,
    required int baseRentRupees,
  }) async {
    final uid = currentUid;
    if (uid == null) throw Exception('User not authenticated');

    final unitRef = _firestore.collection('units').doc();
    final now = FieldValue.serverTimestamp();

    await unitRef.set({
      'propertyId': propertyId,
      'landlordId': uid,
      'roomNumber': roomNumber.trim(),
      'baseRent': baseRentRupees * 100, // stored in paise
      'status': 'vacant',
      'createdAt': now,
      'updatedAt': now,
    });

    return unitRef.id;
  }

  /// Stream of all units belonging to a specific property.
  Stream<QuerySnapshot<Map<String, dynamic>>> getPropertyUnitsStream(
    String propertyId,
  ) {
    final uid = currentUid;
    if (uid == null) return const Stream.empty();

    return _firestore
        .collection('units')
        .where('landlordId', isEqualTo: uid)
        .where('propertyId', isEqualTo: propertyId)
        .snapshots();
  }

  // ───────────────────────── LANDLORD: JOIN REQUESTS ─────────────────────────

  /// Stream of pending join requests for this landlord.
  Stream<QuerySnapshot<Map<String, dynamic>>> getPendingJoinRequestsStream() {
    final uid = currentUid;
    if (uid == null) return const Stream.empty();

    return _firestore
        .collection('joinRequests')
        .where('landlordId', isEqualTo: uid)
        .where('status', isEqualTo: 'pending')
        .snapshots();
  }

  /// Accept a join request by assigning a unit and creating a lease via Cloud Function.
  Future<void> acceptJoinRequest({
    required String joinRequestId,
    required String unitId,
    String? joiningDate,
  }) async {
    final callable = _functions.httpsCallable('acceptJoinRequest');
    await callable.call({
      'joinRequestId': joinRequestId,
      'unitId': unitId,
      if (joiningDate != null) 'joiningDate': joiningDate,
    });
  }

  /// Reject a join request directly via Firestore client (allowed by security rules).
  Future<void> rejectJoinRequest(String joinRequestId) async {
    final uid = currentUid;
    if (uid == null) throw Exception('User not authenticated');

    final now = FieldValue.serverTimestamp();
    await _firestore.collection('joinRequests').doc(joinRequestId).update({
      'status': 'rejected',
      'respondedAt': now,
      'respondedBy': uid,
      'updatedAt': now,
    });
  }

  // ───────────────────────── PHASE 4: LEASE & TENANT HISTORY ─────────────────────────

  /// End an active tenancy via Cloud Function.
  Future<void> endLease({
    required String leaseId,
    required String endDate,
    String? endReason,
  }) async {
    final callable = _functions.httpsCallable('endLease');
    await callable.call({
      'leaseId': leaseId,
      'endDate': endDate,
      if (endReason != null && endReason.trim().isNotEmpty)
        'endReason': endReason.trim(),
    });
  }

  /// Stream of landlord's leases (optionally filtered by status: 'active' or 'ended').
  Stream<QuerySnapshot<Map<String, dynamic>>> getLandlordLeasesStream({
    String? status,
  }) {
    final uid = currentUid;
    if (uid == null) return const Stream.empty();

    Query<Map<String, dynamic>> query = _firestore
        .collection('leases')
        .where('landlordId', isEqualTo: uid);

    if (status != null) {
      query = query.where('status', isEqualTo: status);
    }

    return query.snapshots();
  }

  @override
  Stream<List<BillingLease>> watchLandlordLeases() {
    return getLandlordLeasesStream().map(
      (snapshot) => snapshot.docs
          .map((doc) => BillingLease.fromMap(doc.id, doc.data()))
          .toList(),
    );
  }

  @override
  Stream<Map<String, RentChargeRecord>> watchChargesForMonth(
    String billingMonth,
  ) {
    final uid = currentUid;
    if (uid == null) return const Stream.empty();

    return _firestore
        .collection('rentCharges')
        .where('landlordId', isEqualTo: uid)
        .where('billingMonth', isEqualTo: billingMonth)
        .snapshots()
        .map(
          (snapshot) => {
            for (final doc in snapshot.docs)
              doc.data()['leaseId'] as String: RentChargeRecord.fromMap(
                doc.id,
                doc.data(),
              ),
          },
        );
  }

  @override
  Future<String> saveDraft({
    required BillingLease lease,
    required String billingMonth,
    required List<BillingLineItem> lineItems,
    required Timestamp? expectedUpdatedAt,
  }) async {
    final uid = currentUid;
    if (uid == null) throw Exception('User not authenticated');
    if (!RegExp(r'^(0[0-9]{3}|[1-9][0-9]{3})-(0[1-9]|1[0-2])$')
        .hasMatch(billingMonth)) {
      throw ArgumentError.value(billingMonth, 'billingMonth');
    }

    final rentChargeId = '${lease.id}_$billingMonth';
    final subtotal = calculateSubtotal(lineItems);
    final rentChargeRef = _firestore
        .collection('rentCharges')
        .doc(rentChargeId);
    final leaseRef = _firestore.collection('leases').doc(lease.id);

    await _firestore.runTransaction((transaction) async {
      final existing = await transaction.get(rentChargeRef);
      final leaseSnapshot = await transaction.get(leaseRef);
      final leaseData = leaseSnapshot.data();
      if (!leaseSnapshot.exists ||
          leaseData?['status'] != 'active' ||
          leaseData?['landlordId'] != uid ||
          leaseData?['tenantId'] != lease.tenantId ||
          leaseData?['propertyId'] != lease.propertyId ||
          leaseData?['unitId'] != lease.unitId) {
        throw StateError(
          'This lease is no longer active. Draft editing is unavailable.',
        );
      }

      if (existing.exists) {
        final existingData = existing.data()!;
        if (existingData['status'] != 'draft') {
          throw StateError('Finalized bills cannot be edited.');
        }

        if (expectedUpdatedAt == null) {
          if (_matchesDraft(
            existingData,
            lease: lease,
            billingMonth: billingMonth,
            lineItems: lineItems,
            subtotal: subtotal,
          )) {
            return;
          }
          throw StateError(
            'A draft already exists. Reload it before making changes.',
          );
        }

        final currentUpdatedAt = existingData['updatedAt'];
        if (currentUpdatedAt is! Timestamp ||
            currentUpdatedAt.compareTo(expectedUpdatedAt) != 0) {
          throw StateError(
            'This draft changed since it was opened. Reload it before saving.',
          );
        }

        transaction.update(rentChargeRef, {
          'lineItems': lineItems.map((item) => item.toMap()).toList(),
          'subtotal': subtotal,
          'total': subtotal,
          'updatedAt': FieldValue.serverTimestamp(),
        });
        return;
      }

      if (expectedUpdatedAt != null) {
        throw StateError(
          'This draft is no longer available. Reload the billing screen.',
        );
      }

      final now = FieldValue.serverTimestamp();
      transaction.set(rentChargeRef, {
        'status': 'draft',
        'leaseId': lease.id,
        'landlordId': uid,
        'tenantId': lease.tenantId,
        'propertyId': lease.propertyId,
        'unitId': lease.unitId,
        'billingMonth': billingMonth,
        'lineItems': lineItems.map((item) => item.toMap()).toList(),
        'subtotal': subtotal,
        'lateFineTotal': 0,
        'adjustmentTotal': 0,
        'total': subtotal,
        'dueDate': '$billingMonth-10',
        'createdAt': now,
        'updatedAt': now,
      });
    });

    return rentChargeId;
  }

  bool _matchesDraft(
    Map<String, dynamic> data, {
    required BillingLease lease,
    required String billingMonth,
    required List<BillingLineItem> lineItems,
    required int subtotal,
  }) {
    final savedItems = data['lineItems'];
    if (savedItems is! List || savedItems.length != lineItems.length) {
      return false;
    }

    for (var index = 0; index < lineItems.length; index++) {
      final saved = savedItems[index];
      final item = lineItems[index];
      if (saved is! Map ||
          saved['type'] != item.type ||
          saved['label'] != item.label ||
          saved['amount'] != item.amount) {
        return false;
      }
    }

    return data['leaseId'] == lease.id &&
        data['landlordId'] == lease.landlordId &&
        data['tenantId'] == lease.tenantId &&
        data['propertyId'] == lease.propertyId &&
        data['unitId'] == lease.unitId &&
        data['billingMonth'] == billingMonth &&
        data['subtotal'] == subtotal &&
        data['total'] == subtotal;
  }

  @override
  Future<FinalizedRentCharge> finalize(String rentChargeId) async {
    final result = await _functions.httpsCallable('finalizeRentCharge').call({
      'rentChargeId': rentChargeId,
    });
    final data = Map<String, dynamic>.from(result.data as Map);
    final total = data['total'];
    final dueDate = data['dueDate'];
    if (total is! int || dueDate is! String) {
      throw StateError('finalizeRentCharge returned an invalid response.');
    }
    return FinalizedRentCharge(total: total, dueDate: dueDate);
  }

  @override
  int calculateSubtotal(List<BillingLineItem> lineItems) {
    if (lineItems.isEmpty || lineItems.length > 10) {
      throw ArgumentError('A bill must have between one and ten line items.');
    }
    final allowedTypes = {'rent', 'electricity', 'maintenance', 'other'};
    var rentCount = 0;
    var subtotal = 0;
    for (final item in lineItems) {
      if (!allowedTypes.contains(item.type) ||
          item.label.trim().isEmpty ||
          item.amount < 0 ||
          item.amount > 9007199254740991) {
        throw ArgumentError('The bill contains an invalid line item.');
      }
      if (item.type == 'rent') rentCount++;
      subtotal += item.amount;
      if (subtotal > 9007199254740991) {
        throw ArgumentError('The bill total exceeds the supported range.');
      }
    }
    if (rentCount != 1) {
      throw ArgumentError('A bill must contain exactly one rent line item.');
    }
    return subtotal;
  }

  /// Stream of room tenancy history (active and past leases for a specific room).
  Stream<QuerySnapshot<Map<String, dynamic>>> getUnitLeasesStream(
    String unitId,
  ) {
    final uid = currentUid;
    if (uid == null) return const Stream.empty();

    return _firestore
        .collection('leases')
        .where('landlordId', isEqualTo: uid)
        .where('unitId', isEqualTo: unitId)
        .snapshots();
  }

  /// Stream of all leases belonging to the tenant (active and past).
  Stream<QuerySnapshot<Map<String, dynamic>>> getTenantLeasesStream() {
    final uid = currentUid;
    if (uid == null) return const Stream.empty();

    return _firestore
        .collection('leases')
        .where('tenantId', isEqualTo: uid)
        .snapshots();
  }

  // ───────────────────────── TENANT: JOIN & LEASE ─────────────────────────

  /// Resolve a join code to get preview information about a property.
  Future<Map<String, dynamic>> resolveJoinCode(String joinCode) async {
    final callable = _functions.httpsCallable('resolveJoinCode');
    final result = await callable.call({'joinCode': joinCode.trim()});
    return Map<String, dynamic>.from(result.data as Map);
  }

  /// Submit a join request to an active property.
  Future<String> submitJoinRequest({
    required String propertyId,
    String? message,
  }) async {
    final callable = _functions.httpsCallable('createJoinRequest');
    final result = await callable.call({
      'propertyId': propertyId,
      if (message != null && message.trim().isNotEmpty)
        'message': message.trim(),
    });
    final data = Map<String, dynamic>.from(result.data as Map);
    return data['joinRequestId'] as String;
  }

  /// Stream of join requests submitted by the current tenant.
  Stream<QuerySnapshot<Map<String, dynamic>>> getTenantJoinRequestsStream() {
    final uid = currentUid;
    if (uid == null) return const Stream.empty();

    return _firestore
        .collection('joinRequests')
        .where('tenantId', isEqualTo: uid)
        .snapshots();
  }

  /// Fetch details of a lease document.
  Future<DocumentSnapshot<Map<String, dynamic>>> getLease(
    String leaseId,
  ) async {
    return await _firestore.collection('leases').doc(leaseId).get();
  }

  /// Fetch details of a unit document.
  Future<DocumentSnapshot<Map<String, dynamic>>> getUnit(String unitId) async {
    return await _firestore.collection('units').doc(unitId).get();
  }

  /// Fetch details of a property document.
  Future<DocumentSnapshot<Map<String, dynamic>>> getProperty(
    String propertyId,
  ) async {
    return await _firestore.collection('properties').doc(propertyId).get();
  }
}
