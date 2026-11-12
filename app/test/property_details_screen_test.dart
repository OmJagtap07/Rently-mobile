// ignore_for_file: depend_on_referenced_packages

import 'package:app/dashboards/landlord/property_details_screen.dart';
import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart'
    as firestore_platform;
import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart'
    as auth_platform;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/test.dart'
    as firebase_core_test;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _LeaseRecord {
  final String id;
  final Map<String, dynamic> data;

  const _LeaseRecord(this.id, this.data);
}

class _TestFirestorePlatform
    extends firestore_platform.FirebaseFirestorePlatform {
  final List<_LeaseRecord> leases;
  final List<_LeaseRecord> units;

  _TestFirestorePlatform(
    FirebaseApp app, {
    required this.leases,
    required this.units,
  }) : super(appInstance: app);

  @override
  firestore_platform.FirebaseFirestorePlatform delegateFor({
    required FirebaseApp app,
    required String databaseId,
  }) => this;

  @override
  firestore_platform.CollectionReferencePlatform collection(
    String collectionPath,
  ) => _TestCollection(this, collectionPath);

  @override
  firestore_platform.DocumentReferencePlatform doc(String documentPath) {
    final pathParts = documentPath.split('/');
    final recordId = pathParts.last;
    final record = pathParts.first == 'units'
        ? _findRecord(units, recordId)
        : _findRecord(leases, recordId);
    return _TestDocumentReference(this, documentPath, record?.data);
  }

  _LeaseRecord? _findRecord(List<_LeaseRecord> records, String id) {
    for (final record in records) {
      if (record.id == id) return record;
    }
    return null;
  }

  List<_LeaseRecord> recordsFor(String collectionPath) {
    return collectionPath == 'units' ? units : leases;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _TestCollection extends firestore_platform.CollectionReferencePlatform {
  _TestCollection(super.firestore, super.path) {
    parameters['where'] = <List<dynamic>>[];
  }

  @override
  firestore_platform.DocumentReferencePlatform doc([String? documentPath]) {
    return firestore.doc('$path/${documentPath ?? 'generated'}');
  }

  @override
  firestore_platform.QueryPlatform where(List<List<dynamic>> conditions) {
    return _TestQuery(firestore, path, conditions);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _TestQuery extends firestore_platform.QueryPlatform {
  final String collectionPath;

  _TestQuery(
    firestore_platform.FirebaseFirestorePlatform firestore,
    this.collectionPath,
    List<List<dynamic>> conditions,
  ) : super(firestore, {'where': conditions});

  @override
  bool get isCollectionGroupQuery => false;

  @override
  firestore_platform.QueryPlatform where(List<List<dynamic>> conditions) {
    return _TestQuery(firestore, collectionPath, [
      ...parameters['where'] as List<List<dynamic>>,
      ...conditions,
    ]);
  }

  @override
  Stream<firestore_platform.QuerySnapshotPlatform> snapshots({
    bool includeMetadataChanges = false,
    firestore_platform.ServerTimestampBehavior serverTimestampBehavior =
        firestore_platform.ServerTimestampBehavior.none,
    required firestore_platform.ListenSource listenSource,
  }) async* {
    final platform = firestore as _TestFirestorePlatform;
    final conditions = parameters['where'] as List<List<dynamic>>;
    final records = platform.recordsFor(collectionPath).where((record) {
      return conditions.every((condition) {
        final value = condition[2];
        return record.data.values.contains(value);
      });
    });
    final documents = records
        .map(
          (record) => firestore_platform.DocumentSnapshotPlatform(
            firestore,
            '$collectionPath/${record.id}',
            record.data,
            firestore_platform.InternalSnapshotMetadata(
              hasPendingWrites: false,
              isFromCache: false,
            ),
          ),
        )
        .toList();

    yield firestore_platform.QuerySnapshotPlatform(
      documents,
      [],
      firestore_platform.SnapshotMetadataPlatform(false, false),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _TestDocumentReference
    extends firestore_platform.DocumentReferencePlatform {
  final Map<String, dynamic>? recordData;

  _TestDocumentReference(super.firestore, super.path, this.recordData);

  @override
  Future<firestore_platform.DocumentSnapshotPlatform> get([
    firestore_platform.GetOptions options =
        const firestore_platform.GetOptions(),
  ]) async {
    return firestore_platform.DocumentSnapshotPlatform(
      firestore,
      path,
      recordData,
      firestore_platform.InternalSnapshotMetadata(
        hasPendingWrites: false,
        isFromCache: false,
      ),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _TestAuthPlatform extends auth_platform.FirebaseAuthPlatform {
  auth_platform.UserPlatform? _user;

  _TestAuthPlatform(FirebaseApp app) : super(appInstance: app) {
    _user = _TestUserPlatform(
      this,
      auth_platform.InternalUserDetails(
        userInfo: auth_platform.InternalUserInfo(
          uid: 'landlord-1',
          isAnonymous: false,
          isEmailVerified: true,
        ),
        providerData: [],
      ),
    );
  }

  @override
  auth_platform.FirebaseAuthPlatform delegateFor({required FirebaseApp app}) =>
      this;

  @override
  auth_platform.FirebaseAuthPlatform setInitialValues({
    auth_platform.InternalUserDetails? currentUser,
    String? languageCode,
  }) => this;

  @override
  auth_platform.UserPlatform? get currentUser => _user;

  @override
  set currentUser(auth_platform.UserPlatform? value) => _user = value;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _TestUserPlatform extends auth_platform.UserPlatform {
  _TestUserPlatform(
    auth_platform.FirebaseAuthPlatform auth,
    auth_platform.InternalUserDetails user,
  ) : super(auth, _TestMultiFactorPlatform(auth), user);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _TestMultiFactorPlatform extends auth_platform.MultiFactorPlatform {
  _TestMultiFactorPlatform(super.auth);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FirebaseApp app;
  late _TestFirestorePlatform firestore;

  setUpAll(() async {
    firebase_core_test.setupFirebaseCoreMocks();
    app = await Firebase.initializeApp();
    auth_platform.FirebaseAuthPlatform.instance = _TestAuthPlatform(app);
    firestore = _TestFirestorePlatform(app, leases: [], units: []);
    firestore_platform.FirebaseFirestorePlatform.instance = firestore;
  });

  setUp(() {
    firestore.units
      ..clear()
      ..addAll([
        _LeaseRecord('unit-101', {
          'landlordId': 'landlord-1',
          'propertyId': 'property-1',
          'roomNumber': '101',
          'baseRent': 125000,
          'status': 'occupied',
          'currentLeaseId': 'active-lease',
        }),
        _LeaseRecord('unit-202', {
          'landlordId': 'landlord-1',
          'propertyId': 'property-1',
          'roomNumber': '202',
          'baseRent': 90000,
          'status': 'vacant',
          'currentLeaseId': null,
        }),
        _LeaseRecord('unit-303', {
          'landlordId': 'landlord-1',
          'propertyId': 'property-1',
          'roomNumber': '303',
          'baseRent': 85000,
          'status': 'vacant',
          'currentLeaseId': null,
        }),
      ]);
    firestore.leases
      ..clear()
      ..addAll([
        _LeaseRecord('active-lease', {
          'landlordId': 'landlord-1',
          'unitId': 'unit-101',
          'tenantName': 'Current Tenant',
          'tenantPhone': '555-0101',
          'joiningDate': '2025-10-01',
          'currentBaseRent': 125000,
          'status': 'active',
        }),
        _LeaseRecord('ended-lease-one', {
          'landlordId': 'landlord-1',
          'unitId': 'unit-101',
          'tenantName': 'Previous Tenant One',
          'joiningDate': '2024-01-01',
          'endDate': '2025-09-30',
          'status': 'ended',
        }),
        _LeaseRecord('ended-lease-two', {
          'landlordId': 'landlord-1',
          'unitId': 'unit-101',
          'tenantName': 'Previous Tenant Two',
          'joiningDate': '2023-01-01',
          'endDate': '2023-12-31',
          'status': 'ended',
        }),
        _LeaseRecord('other-room-lease', {
          'landlordId': 'landlord-1',
          'unitId': 'unit-202',
          'tenantName': 'Other Room Tenant',
          'joiningDate': '2025-02-01',
          'endDate': '2025-08-31',
          'status': 'ended',
        }),
      ]);
  });

  testWidgets(
    'room history shows active and previous tenancies only for that room',
    (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: PropertyDetailsScreen(
            propertyId: 'property-1',
            propertyData: {
              'name': 'Green Heights',
              'address': '1 Main Street',
              'joinCode': 'ABC12345',
            },
          ),
        ),
      );
      await tester.pump();

      await tester.tap(find.text('Room 101'));
      await tester.pumpAndSettle();
      expect(find.text('Current Tenant'), findsOneWidget);
      expect(find.text('Joining Date:'), findsOneWidget);
      expect(find.text('2025-10-01'), findsOneWidget);
      expect(find.text('₹1250'), findsOneWidget);

      await tester.tap(find.text('Room History'));
      await tester.pumpAndSettle();
      expect(find.text('Current Tenant'), findsOneWidget);
      expect(find.text('2025-10-01 → Present'), findsOneWidget);
      expect(find.text('Active'), findsOneWidget);
      expect(find.text('Previous Tenant One'), findsOneWidget);
      expect(find.text('2024-01-01 → 2025-09-30'), findsOneWidget);
      expect(find.text('Ended'), findsNWidgets(2));
      expect(find.text('Previous Tenant Two'), findsOneWidget);
      expect(find.text('2023-01-01 → 2023-12-31'), findsOneWidget);
      expect(find.text('Other Room Tenant'), findsNothing);

      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Room 202'));
      await tester.pumpAndSettle();

      expect(find.text('Other Room Tenant'), findsOneWidget);
      expect(find.text('Previous Tenant One'), findsNothing);
      expect(find.text('Previous Tenant Two'), findsNothing);
    },
  );

  testWidgets('room history shows the empty state when no leases exist', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: PropertyDetailsScreen(
          propertyId: 'property-1',
          propertyData: {
            'name': 'Green Heights',
            'address': '1 Main Street',
            'joinCode': 'ABC12345',
          },
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.text('Room 303'));
    await tester.pumpAndSettle();
    expect(
      find.text('No historical tenancies recorded for this room.'),
      findsOneWidget,
    );
  });
}
