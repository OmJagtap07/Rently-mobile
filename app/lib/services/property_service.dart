import 'dart:math';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';

class PropertyService {
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
    String? googleMapsLink,
  }) async {
    final uid = currentUid;
    if (uid == null) throw Exception('User not authenticated');

    final joinCode = _generateJoinCode();
    final docRef = _firestore.collection('properties').doc();
    final now = FieldValue.serverTimestamp();

    await docRef.set({
      'landlordId': uid,
      'name': name.trim(),
      'address': address.trim(),
      'googleMapsLink': googleMapsLink?.trim().isEmpty ?? true ? null : googleMapsLink!.trim(),
      'joinCode': joinCode,
      'status': 'active',
      'createdAt': now,
      'updatedAt': now,
    });

    return docRef.id;
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
  Stream<QuerySnapshot<Map<String, dynamic>>> getPropertyUnitsStream(String propertyId) {
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
  Stream<QuerySnapshot<Map<String, dynamic>>> getLandlordLeasesStream({String? status}) {
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

  /// Stream of room tenancy history (active and past leases for a specific room).
  Stream<QuerySnapshot<Map<String, dynamic>>> getUnitLeasesStream(String unitId) {
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
      if (message != null && message.trim().isNotEmpty) 'message': message.trim(),
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
  Future<DocumentSnapshot<Map<String, dynamic>>> getLease(String leaseId) async {
    return await _firestore.collection('leases').doc(leaseId).get();
  }

  /// Fetch details of a unit document.
  Future<DocumentSnapshot<Map<String, dynamic>>> getUnit(String unitId) async {
    return await _firestore.collection('units').doc(unitId).get();
  }

  /// Fetch details of a property document.
  Future<DocumentSnapshot<Map<String, dynamic>>> getProperty(String propertyId) async {
    return await _firestore.collection('properties').doc(propertyId).get();
  }
}
