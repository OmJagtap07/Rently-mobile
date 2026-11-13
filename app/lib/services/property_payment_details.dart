class PropertyPaymentDetails {
  const PropertyPaymentDetails({
    required this.upiId,
    required this.upiQrImageUrl,
    required this.upiDisplayName,
  });

  final String upiId;
  final String upiQrImageUrl;
  final String upiDisplayName;

  static PropertyPaymentDetails? fromMap(Map<String, dynamic> data) {
    final upiId = data['upiId'];
    final upiQrImageUrl = data['upiQrImageUrl'];
    final upiDisplayName = data['upiDisplayName'];
    if (upiId is! String ||
        upiQrImageUrl is! String ||
        upiDisplayName is! String ||
        propertyUpiDetailsErrors(
          upiId: upiId,
          upiQrImageUrl: upiQrImageUrl,
          upiDisplayName: upiDisplayName,
        ).isNotEmpty) {
      return null;
    }
    return PropertyPaymentDetails(
      upiId: upiId.trim(),
      upiQrImageUrl: upiQrImageUrl.trim(),
      upiDisplayName: upiDisplayName.trim(),
    );
  }
}

String? validateUpiId(String? value) {
  final upiId = value?.trim() ?? '';
  if (!RegExp(r'^[A-Za-z0-9._-]{2,100}@[A-Za-z0-9.-]{2,100}$')
      .hasMatch(upiId)) {
    return 'Enter a valid UPI ID, such as name@bank';
  }
  return null;
}

String? validateUpiQrImageUrl(String? value) {
  final input = value?.trim() ?? '';
  final uri = Uri.tryParse(input);
  if (uri == null ||
      uri.scheme.toLowerCase() != 'https' ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.path.isEmpty) {
    return 'Enter a valid HTTPS QR image URL';
  }
  return null;
}

String normalizeUpiQrImageUrl(String value) => value.trim().replaceFirst(
  RegExp(r'^https:', caseSensitive: false),
  'https:',
);

String? validateUpiDisplayName(String? value) {
  final displayName = value?.trim() ?? '';
  if (displayName.isEmpty || displayName.length > 100) {
    return 'Enter a recipient name (up to 100 characters)';
  }
  return null;
}

void validatePropertyUpiDetails({
  required String upiId,
  required String upiQrImageUrl,
  required String upiDisplayName,
}) {
  final errors = propertyUpiDetailsErrors(
    upiId: upiId,
    upiQrImageUrl: upiQrImageUrl,
    upiDisplayName: upiDisplayName,
  );
  if (errors.isNotEmpty) {
    throw ArgumentError(errors.join(' '));
  }
}

List<String> propertyUpiDetailsErrors({
  required String upiId,
  required String upiQrImageUrl,
  required String upiDisplayName,
}) {
  return [
    validateUpiId(upiId),
    validateUpiQrImageUrl(upiQrImageUrl),
    validateUpiDisplayName(upiDisplayName),
  ].whereType<String>().toList(growable: false);
}
