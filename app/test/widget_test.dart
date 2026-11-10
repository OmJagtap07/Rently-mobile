import 'package:app/auth/auth_layout.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('AuthLayout displays its child', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: AuthLayout(child: Text('Rently'))),
    );

    expect(find.text('Rently'), findsOneWidget);
  });
}
