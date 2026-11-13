import 'package:app/services/monthly_billing_repository.dart';
import 'package:app/services/property_service.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart'
    as firestore_platform;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart'
    as core_platform;
import 'package:flutter_test/flutter_test.dart';

late _RecordingFirestorePlatform firestore;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    final firebasePlatform = _TestFirebasePlatform();
    Firebase.delegatePackingProperty = firebasePlatform;
    await Firebase.initializeApp(
      options: const FirebaseOptions(
        apiKey: 'test-api-key',
        appId: '1:123456789:web:test',
        messagingSenderId: '123456789',
        projectId: 'rently-service-test',
      ),
    );
    firestore = _RecordingFirestorePlatform(appInstance: Firebase.app());
    firestore_platform.FirebaseFirestorePlatform.instance = firestore;
  });

  setUp(() {
    firestore.documents.clear();
    firestore.operations.clear();
    firestore.documentWrites.clear();
  });

  group('PropertyService property UPI configuration', () {
    test('accepts and stores uppercase HTTPS with other URL parts preserved', () async {
      final service = _service();
      const inputUrl =
          'HTTPS://Images.Example.com:8443/qr.png?size=large&format=png#preview';

      final propertyId = await service.createProperty(
        name: 'Example Property',
        address: '1 Example Road',
        upiId: 'owner@bank',
        upiQrImageUrl: inputUrl,
        upiDisplayName: 'Property Owner',
      );

      expect(propertyId, 'generated-id');
      expect(firestore.operations, ['set:properties/generated-id']);
      expect(
        firestore.documentWrites['properties/generated-id']?['upiQrImageUrl'],
        'https://Images.Example.com:8443/qr.png?size=large&format=png#preview',
      );
    });
  });

  group('PropertyService.saveDraft transaction', () {
    test(
      'rejects a stale updatedAt without overwriting newer bill data',
      () async {
        final newerBill = _draft(updatedAt: Timestamp(11, 0), amount: 1500);
        firestore.documents['rentCharges/lease-1_2026-11'] = newerBill;
        firestore.documents['leases/lease-1'] = _activeLease();

        await expectLater(
          _service().saveDraft(
            lease: _lease,
            billingMonth: '2026-11',
            lineItems: _editedItems,
            expectedUpdatedAt: Timestamp(10, 0),
          ),
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              contains('changed since it was opened'),
            ),
          ),
        );

        expect(firestore.operations, [
          'read:rentCharges/lease-1_2026-11',
          'read:leases/lease-1',
        ]);
        expect(
          firestore.documents['rentCharges/lease-1_2026-11']!['lineItems'],
          newerBill['lineItems'],
        );
        expect(
          firestore.documents['rentCharges/lease-1_2026-11']!['updatedAt'],
          Timestamp(11, 0),
        );
      },
    );

    test(
      'allows an edit when updatedAt matches and reads before writing',
      () async {
        firestore.documents['rentCharges/lease-1_2026-11'] = _draft(
          updatedAt: Timestamp(10, 0),
          amount: 1000,
        );
        firestore.documents['leases/lease-1'] = _activeLease();

        final id = await _service().saveDraft(
          lease: _lease,
          billingMonth: '2026-11',
          lineItems: _editedItems,
          expectedUpdatedAt: Timestamp(10, 0),
        );

        expect(id, 'lease-1_2026-11');
        expect(firestore.operations, [
          'read:rentCharges/lease-1_2026-11',
          'read:leases/lease-1',
          'write:rentCharges/lease-1_2026-11',
        ]);
        expect(firestore.transaction!.writes, hasLength(1));
        expect(
          firestore.transaction!.writes.single.keys.map(
            (field) => field.components.join('.'),
          ),
          containsAll(['lineItems', 'subtotal', 'total', 'updatedAt']),
        );
      },
    );

    test(
      'rejects saving when the lease is inactive before the transaction',
      () async {
        firestore.documents['rentCharges/lease-1_2026-11'] = _draft(
          updatedAt: Timestamp(10, 0),
          amount: 1000,
        );
        firestore.documents['leases/lease-1'] = _activeLease(status: 'ended');

        await expectLater(
          _service().saveDraft(
            lease: _lease,
            billingMonth: '2026-11',
            lineItems: _editedItems,
            expectedUpdatedAt: Timestamp(10, 0),
          ),
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              contains('lease is no longer active'),
            ),
          ),
        );

        expect(firestore.operations, [
          'read:rentCharges/lease-1_2026-11',
          'read:leases/lease-1',
        ]);
        expect(firestore.transaction!.writes, isEmpty);
        expect(
          firestore.documents['rentCharges/lease-1_2026-11']!['lineItems'],
          _draft(updatedAt: Timestamp(10, 0), amount: 1000)['lineItems'],
        );
      },
    );
  });
}

final _lease = BillingLease(
  id: 'lease-1',
  tenantId: 'tenant-1',
  landlordId: 'landlord-1',
  propertyId: 'property-1',
  unitId: 'unit-1',
  tenantName: 'Tenant',
  propertyName: 'Property',
  roomNumber: '1',
  currentBaseRent: 1000,
);

final _editedItems = const [
  BillingLineItem(type: 'rent', label: 'Rent', amount: 1250),
];

Map<String, dynamic> _activeLease({String status = 'active'}) => {
  'status': status,
  'landlordId': 'landlord-1',
  'tenantId': 'tenant-1',
  'propertyId': 'property-1',
  'unitId': 'unit-1',
};

Map<String, dynamic> _draft({
  required Timestamp updatedAt,
  required int amount,
}) => {
  'status': 'draft',
  'leaseId': 'lease-1',
  'landlordId': 'landlord-1',
  'tenantId': 'tenant-1',
  'propertyId': 'property-1',
  'unitId': 'unit-1',
  'billingMonth': '2026-11',
  'lineItems': [
    {'type': 'rent', 'label': 'Rent', 'amount': amount},
  ],
  'subtotal': amount,
  'total': amount,
  'updatedAt': updatedAt,
};

PropertyService _service() => _TestPropertyService();

class _TestPropertyService extends PropertyService {
  @override
  String? get currentUid => 'landlord-1';
}

class _TestFirebasePlatform extends core_platform.FirebasePlatform {
  core_platform.FirebaseAppPlatform? _app;

  @override
  List<core_platform.FirebaseAppPlatform> get apps =>
      _app == null ? const [] : [_app!];

  @override
  core_platform.FirebaseAppPlatform app([
    String name = core_platform.defaultFirebaseAppName,
  ]) {
    final app = _app;
    if (app == null || app.name != name) {
      throw StateError('Firebase app $name has not been initialized.');
    }
    return app;
  }

  @override
  Future<core_platform.FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final resolvedOptions = options;
    if (resolvedOptions == null) {
      throw ArgumentError.notNull('options');
    }
    return _app = core_platform.FirebaseAppPlatform(
      name ?? core_platform.defaultFirebaseAppName,
      resolvedOptions,
    );
  }
}

class _RecordingFirestorePlatform
    extends firestore_platform.FirebaseFirestorePlatform {
  _RecordingFirestorePlatform({required super.appInstance});

  final Map<String, Map<String, dynamic>> documents = {};
  final Map<String, Map<String, dynamic>> documentWrites = {};
  final List<String> operations = [];
  _RecordingTransactionPlatform? transaction;

  @override
  firestore_platform.FirebaseFirestorePlatform delegateFor({
    required FirebaseApp app,
    required String databaseId,
  }) => this;

  @override
  firestore_platform.CollectionReferencePlatform collection(
    String collectionPath,
  ) => _TestCollectionReference(this, collectionPath);

  @override
  firestore_platform.DocumentReferencePlatform doc(String documentPath) =>
      _TestDocumentReference(this, documentPath);

  @override
  Future<T?> runTransaction<T>(
    firestore_platform.TransactionHandler<T> transactionHandler, {
    Duration timeout = const Duration(seconds: 30),
    int maxAttempts = 5,
  }) async {
    final recordingTransaction = _RecordingTransactionPlatform(
      firestore: this,
      documents: documents,
      operations: operations,
    );
    transaction = recordingTransaction;
    return transactionHandler(recordingTransaction);
  }
}

class _TestCollectionReference
    extends firestore_platform.CollectionReferencePlatform {
  _TestCollectionReference(super.firestore, super.path);

  @override
  firestore_platform.DocumentReferencePlatform doc([String? path]) =>
      _TestDocumentReference(
        firestore,
        path == null ? '${this.path}/generated-id' : '${this.path}/$path',
      );
}

class _TestDocumentReference
    extends firestore_platform.DocumentReferencePlatform {
  _TestDocumentReference(super.firestore, super.path);

  @override
  Future<void> set(
    Map<String, dynamic> data, [
    firestore_platform.SetOptions? options,
  ]) async {
    firestore.operations.add('set:$path');
    firestore.documentWrites[path] = data;
  }
}

class _RecordingTransactionPlatform
    extends firestore_platform.TransactionPlatform {
  _RecordingTransactionPlatform({
    required this.firestore,
    required this.documents,
    required this.operations,
  });

  final _RecordingFirestorePlatform firestore;
  final Map<String, Map<String, dynamic>> documents;
  final List<String> operations;
  final List<Map<firestore_platform.FieldPath, dynamic>> writes = [];
  bool _hasWritten = false;

  @override
  List<firestore_platform.InternalTransactionCommand> get commands => [];

  @override
  Future<firestore_platform.DocumentSnapshotPlatform> get(String path) async {
    if (_hasWritten) {
      throw StateError('Firestore transaction read occurred after a write.');
    }
    operations.add('read:$path');
    return firestore_platform.DocumentSnapshotPlatform(
      firestore,
      path,
      documents[path],
      firestore_platform.InternalSnapshotMetadata(
        hasPendingWrites: false,
        isFromCache: false,
      ),
    );
  }

  @override
  firestore_platform.TransactionPlatform update(
    String path,
    Map<firestore_platform.FieldPath, dynamic> data,
  ) {
    _hasWritten = true;
    operations.add('write:$path');
    writes.add(data);
    return this;
  }

  @override
  firestore_platform.TransactionPlatform set(
    String path,
    Map<String, dynamic> data, [
    firestore_platform.SetOptions? options,
  ]) => throw UnsupportedError('Unexpected transaction set on $path.');

  @override
  firestore_platform.TransactionPlatform delete(String path) =>
      throw UnsupportedError('Unexpected transaction delete on $path.');
}
