# Phase 5 Task 5B — Property UPI Configuration Security Review

**Review date:** 2026-11-12
**Scope:** Property UPI configuration, Firestore authorization, validation, and tenant display.

## Finding

### Low — HTTPS scheme casing mismatch can reject a client-accepted URL

- **Files:** `app/lib/services/property_payment_details.dart:14`, `app/lib/services/property_service.dart:55`, `firestore.rules:254`
- **Confidence:** 10/10
- The Flutter validator lowercases the parsed URL scheme before checking it, so it accepts an uppercase scheme such as `HTTPS://images.example.com/qr.png`. The original URL is stored, while the Firestore Rules expression requires the literal lowercase `https://`. Consequently, a URL accepted by client validation can still be denied on property creation or update.
- **Recommendation:** Normalize the scheme before storing, or align the client and Rules to accept the same scheme casing.

## Other reviewed controls

- Property creation requires the three UPI configuration fields. Property updates are owner-scoped and allowlisted; changing UPI fields requires a valid complete configuration.
- Legacy properties without UPI fields remain readable and can receive unrelated allowed updates.
- Tenants can read linked properties but cannot create or modify property UPI fields. Other landlords cannot update a property they do not own.
- Tenant recipient confirmation is explicit, resets if the details change, and does not claim that Rently verifies recipient identity.
- QR image URLs are HTTPS-only; the image widget has an unavailable-image fallback. No payment credentials or secrets are exposed in the reviewed client code.

## Validation notes

Focused Flutter tests for UPI validation, the payment-information card, property service, and tenant dashboard passed. Firestore Rules tests were not run during this review because no emulator was listening on port 8080.

## Assessment

No exploitable security vulnerability was identified. The implementation is acceptable from a security standpoint, with the low-severity scheme-casing mismatch recommended for correction before release.
