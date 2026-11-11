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
}
