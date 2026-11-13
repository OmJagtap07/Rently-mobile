import 'package:flutter/services.dart';
import 'package:flutter/material.dart';

import '../services/property_payment_details.dart';

class PropertyUpiPaymentInfoCard extends StatefulWidget {
  const PropertyUpiPaymentInfoCard({
    required this.upiId,
    required this.qrImageUrl,
    required this.displayName,
    this.onRecipientConfirmed,
    super.key,
  });

  final String? upiId;
  final String? qrImageUrl;
  final String? displayName;
  final ValueChanged<bool>? onRecipientConfirmed;

  @override
  State<PropertyUpiPaymentInfoCard> createState() =>
      _PropertyUpiPaymentInfoCardState();
}

class _PropertyUpiPaymentInfoCardState
    extends State<PropertyUpiPaymentInfoCard> {
  bool _recipientConfirmed = false;

  @override
  void didUpdateWidget(covariant PropertyUpiPaymentInfoCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.upiId != widget.upiId ||
        oldWidget.qrImageUrl != widget.qrImageUrl ||
        oldWidget.displayName != widget.displayName) {
      _recipientConfirmed = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final upiId = widget.upiId?.trim() ?? '';
    final qrImageUrl = widget.qrImageUrl?.trim() ?? '';
    final displayName = widget.displayName?.trim() ?? '';
    if (propertyUpiDetailsErrors(
      upiId: upiId,
      upiQrImageUrl: qrImageUrl,
      upiDisplayName: displayName,
    ).isNotEmpty) {
      return const Card(
        key: Key('property-upi-not-configured'),
        child: ListTile(
          leading: Icon(Icons.info_outline),
          title: Text('UPI payment details unavailable'),
          subtitle: Text('Contact your landlord for payment information.'),
        ),
      );
    }

    return Card(
      key: const Key('property-upi-payment-info'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Property UPI Payment Information',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            Text('Recipient name: $displayName'),
            const SizedBox(height: 4),
            SelectableText('UPI ID: $upiId'),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: const Key('copy-property-upi-id'),
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: upiId));
                  if (!context.mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('UPI ID copied')),
                  );
                },
                icon: const Icon(Icons.copy),
                label: const Text('Copy UPI ID'),
              ),
            ),
            const SizedBox(height: 12),
            Center(
              child: Image.network(
                qrImageUrl,
                key: const Key('property-upi-qr-image'),
                width: 220,
                height: 220,
                fit: BoxFit.contain,
                errorBuilder: (context, error, stackTrace) => const SizedBox(
                  key: Key('property-upi-qr-error'),
                  height: 80,
                  child: Center(child: Text('QR image could not be loaded.')),
                ),
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Before paying, compare the recipient name shown in your UPI app '
              'with the configured name above. Rently does not independently '
              'verify the recipient identity.',
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              key: const Key('confirm-upi-recipient'),
              onPressed: _recipientConfirmed
                  ? null
                  : () {
                      setState(() => _recipientConfirmed = true);
                      widget.onRecipientConfirmed?.call(true);
                    },
              child: Text(
                _recipientConfirmed
                    ? 'Recipient name confirmed'
                    : 'I confirm the recipient name matches',
              ),
            ),
            if (_recipientConfirmed)
              const Text(
                'Confirmation applies only to this viewing session.',
                key: Key('upi-recipient-confirmed'),
                textAlign: TextAlign.center,
              ),
          ],
        ),
      ),
    );
  }
}
