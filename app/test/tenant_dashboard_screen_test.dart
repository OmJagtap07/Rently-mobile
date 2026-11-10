import 'package:app/dashboards/tenant_dashboard_screen.dart';
import 'package:app/dashboards/landlord_dashboard_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows the availability message for a pending request', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: PendingJoinRequestAvailabilityMessage()),
      ),
    );

    expect(
      find.text(
        "All units are currently rented out. Your request is still pending. "
        "We'll assign you a unit when one becomes available.",
      ),
      findsOneWidget,
    );
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
}
