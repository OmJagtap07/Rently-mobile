import 'package:app/services/property_payment_details.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('property UPI validation', () {
    test('accepts a supported UPI ID', () {
      expect(validateUpiId('owner.name-1@bank.example'), isNull);
    });

    test('rejects malformed UPI IDs', () {
      expect(validateUpiId('not-a-vpa'), isNotNull);
      expect(validateUpiId('owner@'), isNotNull);
    });

    test('accepts only HTTPS QR image URLs with a host and path', () {
      expect(
        validateUpiQrImageUrl('https://images.example.com/qr.png'),
        isNull,
      );
      expect(
        validateUpiQrImageUrl(
          'HTTPS://Images.Example.com/qr.png?size=large&format=png',
        ),
        isNull,
      );
      expect(
        validateUpiQrImageUrl('http://images.example.com/qr.png'),
        isNotNull,
      );
      expect(validateUpiQrImageUrl('https:///qr.png'), isNotNull);
      expect(
        validateUpiQrImageUrl('https://user:pass@example.com/qr.png'),
        isNotNull,
      );
      expect(validateUpiQrImageUrl('https://example.com'), isNotNull);
    });

    test('normalizes only the QR URL scheme', () {
      expect(
        normalizeUpiQrImageUrl(
          ' HTTPS://Images.Example.com/qr.png?size=large&format=png#preview ',
        ),
        'https://Images.Example.com/qr.png?size=large&format=png#preview',
      );
    });

    test('requires a non-blank recipient name of at most 100 characters', () {
      expect(validateUpiDisplayName('  Property Owner  '), isNull);
      expect(validateUpiDisplayName('   '), isNotNull);
      expect(validateUpiDisplayName(List.filled(101, 'x').join()), isNotNull);
    });
  });
}
