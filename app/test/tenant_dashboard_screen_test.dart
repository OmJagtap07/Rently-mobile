import 'dart:async';

import 'package:app/dashboards/tenant_dashboard_screen.dart';
import 'package:app/dashboards/landlord_dashboard_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('updates the pending message when unit availability changes', (
    tester,
  ) async {
    final availability = StreamController<bool>.broadcast();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PendingJoinRequestAvailabilityMessage(
            availabilityStream: availability.stream,
          ),
        ),
      ),
    );
    availability.add(true);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));
    expect(
      find.text(
        'Your request is pending landlord approval. A unit will be assigned '
        'if your request is accepted.',
      ),
      findsOneWidget,
    );
    expect(
      find.textContaining('All units are currently rented out'),
      findsNothing,
    );

    availability.add(false);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));
    expect(
      find.text(
        "All units are currently rented out. Your request is still pending. "
        "We'll assign you a unit when one becomes available.",
      ),
      findsOneWidget,
    );

    availability.add(true);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1));
    expect(
      find.text(
        'Your request is pending landlord approval. A unit will be assigned '
        'if your request is accepted.',
      ),
      findsOneWidget,
    );
    await availability.close();
  });

  testWidgets('explains unavailable units without rejecting the request', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: NoAvailableUnitsNotice())),
    );

    expect(
      find.text(
        'No units are currently available. This request will remain pending. '
        'You can accept it once a unit becomes vacant.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('displays the tenant previous lease details', (tester) async {
    final leases = StreamController<List<Map<String, dynamic>>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TenantPreviousLeaseHistorySection(
            tenantId: 'tenant-a',
            leasesStream: leases.stream,
          ),
        ),
      ),
    );

    leases.add([
      {
        'tenantId': 'tenant-a',
        'status': 'ended',
        'propertyName': 'Green Heights',
        'roomNumber': '302',
        'joiningDate': '2025-01-15',
        'endDate': '2025-12-31',
        'currentBaseRent': 125000,
      },
    ]);
    await tester.pump();

    expect(find.text('Previous Leases'), findsOneWidget);
    expect(find.text('Green Heights'), findsOneWidget);
    expect(find.text('Room 302'), findsOneWidget);
    expect(find.text('Joined: 2025-01-15'), findsOneWidget);
    expect(find.text('Ended: 2025-12-31'), findsOneWidget);
    expect(find.text('Base Rent: ₹1250 / month'), findsOneWidget);
    await leases.close();
  });

  testWidgets('displays multiple ended leases once each', (tester) async {
    final leases = StreamController<List<Map<String, dynamic>>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TenantPreviousLeaseHistorySection(
            tenantId: 'tenant-a',
            leasesStream: leases.stream,
          ),
        ),
      ),
    );

    leases.add([
      {
        'tenantId': 'tenant-a',
        'status': 'ended',
        'propertyName': 'Green Heights',
        'roomNumber': '302',
        'joiningDate': '2025-01-15',
        'endDate': '2025-12-31',
        'currentBaseRent': 125000,
      },
      {
        'tenantId': 'tenant-a',
        'status': 'ended',
        'propertyName': 'Lake View',
        'roomNumber': '204',
        'joiningDate': '2024-01-01',
        'endDate': '2024-12-31',
        'currentBaseRent': 90000,
      },
    ]);
    await tester.pump();

    expect(find.text('Green Heights'), findsOneWidget);
    expect(find.text('Lake View'), findsOneWidget);
    expect(find.text('Room 302'), findsOneWidget);
    expect(find.text('Room 204'), findsOneWidget);
    expect(find.text('Previous Leases'), findsOneWidget);
    await leases.close();
  });

  testWidgets('excludes active and other tenants leases from history', (
    tester,
  ) async {
    final leases = StreamController<List<Map<String, dynamic>>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TenantPreviousLeaseHistorySection(
            tenantId: 'tenant-a',
            leasesStream: leases.stream,
          ),
        ),
      ),
    );

    leases.add([
      {
        'tenantId': 'tenant-a',
        'status': 'active',
        'propertyName': 'Current Property',
        'roomNumber': '101',
      },
      {
        'tenantId': 'tenant-b',
        'status': 'ended',
        'propertyName': 'Private Other Property',
        'roomNumber': '999',
      },
    ]);
    await tester.pump();

    expect(find.text('Previous Leases'), findsNothing);
    expect(find.text('Current Property'), findsNothing);
    expect(find.text('Private Other Property'), findsNothing);
    expect(find.text('Room 999'), findsNothing);
    await leases.close();
  });

  testWidgets('keeps active lease content visible with previous history', (
    tester,
  ) async {
    final leases = StreamController<List<Map<String, dynamic>>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TenantActiveTenancyContent(
            tenantId: 'tenant-a',
            leasesStream: leases.stream,
            activeLeaseChildren: [
              const Card(
                child: Column(
                  children: [
                    Text('Active Lease'),
                    Text('Current Property'),
                    Text('Room 101'),
                    Text('Monthly Rent'),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );

    leases.add([
      {
        'tenantId': 'tenant-a',
        'status': 'ended',
        'propertyName': 'Previous Property',
        'roomNumber': '302',
        'joiningDate': '2025-01-15',
        'endDate': '2025-12-31',
        'currentBaseRent': 125000,
      },
    ]);
    await tester.pump();

    expect(find.text('Active Lease'), findsOneWidget);
    expect(find.text('Current Property'), findsOneWidget);
    expect(find.text('Room 101'), findsOneWidget);
    expect(find.text('Monthly Rent'), findsOneWidget);
    expect(find.text('Previous Property'), findsOneWidget);
    await leases.close();
  });

  testWidgets('hides the history section when no ended leases exist', (
    tester,
  ) async {
    final leases = StreamController<List<Map<String, dynamic>>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TenantPreviousLeaseHistorySection(
            tenantId: 'tenant-a',
            leasesStream: leases.stream,
          ),
        ),
      ),
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    leases.add([]);
    await tester.pump();
    expect(find.text('Previous Leases'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    await leases.close();
  });

  testWidgets('empty history does not break active tenancy content', (
    tester,
  ) async {
    final leases = StreamController<List<Map<String, dynamic>>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TenantActiveTenancyContent(
            tenantId: 'tenant-a',
            leasesStream: leases.stream,
            activeLeaseChildren: const [Text('Current lease content')],
          ),
        ),
      ),
    );

    leases.add([]);
    await tester.pump();

    expect(find.text('Current lease content'), findsOneWidget);
    expect(find.text('Previous Leases'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    await leases.close();
  });

  testWidgets('shows an error when tenant lease history cannot load', (
    tester,
  ) async {
    final leases = StreamController<List<Map<String, dynamic>>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TenantPreviousLeaseHistorySection(
            tenantId: 'tenant-a',
            leasesStream: leases.stream,
          ),
        ),
      ),
    );

    leases.addError(StateError('Firestore unavailable'));
    await tester.pump();
    expect(find.text('Unable to load previous leases.'), findsOneWidget);
    await leases.close();
  });
}
