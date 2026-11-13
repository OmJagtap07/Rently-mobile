import 'package:flutter/services.dart';
import 'package:app/widgets/property_upi_payment_info_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
    'shows property-specific details and requires recipient confirmation',
    (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: PropertyUpiPaymentInfoCard(
              upiId: 'owner@bank',
              qrImageUrl: 'https://images.example.com/qr.png',
              displayName: 'Property Owner',
            ),
          ),
        ),
      );

      expect(find.text('Recipient name: Property Owner'), findsOneWidget);
      expect(find.text('UPI ID: owner@bank'), findsOneWidget);
      expect(
        find.textContaining('Rently does not independently verify'),
        findsOneWidget,
      );
      expect(find.byKey(const Key('upi-recipient-confirmed')), findsNothing);

      await tester.tap(find.byKey(const Key('confirm-upi-recipient')));
      await tester.pump();

      expect(find.byKey(const Key('upi-recipient-confirmed')), findsOneWidget);
      expect(find.text('Recipient name confirmed'), findsOneWidget);
    },
  );

  testWidgets('does not confirm a changed property recipient automatically', (
    tester,
  ) async {
    Widget paymentCard(String upiId) => MaterialApp(
      home: Scaffold(
        body: PropertyUpiPaymentInfoCard(
          upiId: upiId,
          qrImageUrl: 'https://images.example.com/qr.png',
          displayName: 'Property Owner',
        ),
      ),
    );

    await tester.pumpWidget(paymentCard('owner@bank'));
    await tester.tap(find.byKey(const Key('confirm-upi-recipient')));
    await tester.pump();
    expect(find.byKey(const Key('upi-recipient-confirmed')), findsOneWidget);

    await tester.pumpWidget(paymentCard('different@bank'));
    await tester.pump();

    expect(find.byKey(const Key('upi-recipient-confirmed')), findsNothing);
    expect(find.text('I confirm the recipient name matches'), findsOneWidget);
  });

  testWidgets('shows unavailable details for a legacy property', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: PropertyUpiPaymentInfoCard(
            upiId: null,
            qrImageUrl: null,
            displayName: null,
          ),
        ),
      ),
    );

    expect(
      find.byKey(const Key('property-upi-not-configured')),
      findsOneWidget,
    );
    expect(find.text('UPI payment details unavailable'), findsOneWidget);
  });

  testWidgets('copies the UPI ID and confirms the action', (tester) async {
    String? copiedText;
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copiedText =
            (call.arguments as Map<Object?, Object?>)['text'] as String?;
      }
      return null;
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: PropertyUpiPaymentInfoCard(
            upiId: 'owner@bank',
            qrImageUrl: 'https://images.example.com/qr.png',
            displayName: 'Property Owner',
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('copy-property-upi-id')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(copiedText, 'owner@bank');
    expect(find.text('UPI ID copied'), findsOneWidget);
  });
}
