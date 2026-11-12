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

---

# Phase 5 Task 5C-2A — Payment Proof Upload Infrastructure Security Review

**Review date:** 2026-11-12
**Scope:** `functions/src/payment_upload.ts`, `functions/src/payment_upload.integration.test.ts`, `functions/src/index.ts`, `firestore.indexes.json`, and the approved payment contracts.

## Assessment

No confirmed exploitable vulnerability was identified in the reviewed upload infrastructure. The findings below are lifecycle/operational risks and test gaps; they are not confirmed unauthorized access paths.

## Operational risks

### Medium — Upload can finish after expired-intent cleanup

- **Files and lines:** `functions/src/payment_upload.ts:777-845, 874-902, 1088-1104, 1123-1139`
- An upload validates an issued intent before sending bytes to Cloudinary. Cleanup can concurrently move an expired intent to `cleanup_pending`, attempt deletion before the upload creates its asset, and mark cleanup complete. If the in-flight upload then creates the asset, the service may reject its late Cloudinary timestamp but does not enqueue compensating deletion. This can leave an orphaned asset. The reviewed implementation does not attach it to a payment, and the contract requires submission to consume only a valid issued intent.

### Low — Request body is buffered before the application size check

- **Files and lines:** `functions/src/index.ts:1188`, `functions/src/payment_upload.ts:768`
- The HTTP handler passes `request.rawBody` to the service, where the 5,000,000-byte limit is checked. The application-level check therefore occurs after request buffering. Platform request limits still bound the input, but this implementation does not itself enforce the limit while streaming.

### Low — Exhausted reclaimed task may leave source cleanup state stale

- **File and lines:** `functions/src/payment_upload.ts:936-941`
- When a reclaimed task has already exhausted its attempts, the worker marks only the outbox task `terminal_failure`. It does not update the corresponding payment cleanup state, which may remain `processing` rather than `terminal_failure`.

## Test gaps

- **Medium — Upload/cleanup race is not exercised:** `functions/src/payment_upload.integration.test.ts:428-447, 543-650` covers concurrent uploads and cleanup separately, but does not pause an upload while cleanup claims and deletes.
- **Low — HTTP buffering and request-size behavior are not tested:** the integration tests call the service with `Buffer` values rather than invoking the HTTPS handler in `functions/src/index.ts:1168-1190`.
- **Low — Future payment-submission race is outside this implementation:** the tests do not verify atomic submission versus cleanup. The contract requires submission to consume only an unexpired `issued` intent (`cloud-functions.md:367-401`); this should be tested when payment submission is implemented.

## Controls reviewed

- Upload tokens are opaque, authenticated-encrypted tokens scoped to tenant and intent, with an independently checked permission expiry and persisted intent expiry.
- Tenant role and bill ownership, eligible bill status, property/lease consistency, and UPI configuration are checked before intent creation.
- Upload content is checked from bytes, with declared format and size compared against the actual image; no client-supplied folder or public ID is used.
- Cloudinary credentials remain server-side. The adapter fixes the account endpoint, uses `asset_folder`, an opaque public ID, and overwrite disabled, then checks returned metadata.
- Cleanup uses transactional claims and bounded retries. It checks for verified payments before deletion and treats a missing asset as successful deletion.

## Validation notes

- Functions build and lint passed.
- Focused upload and role tests passed: 28 tests.
- Payment Firestore Rules tests passed: 11 tests; 123 non-payment tests were skipped.
- `git diff --check` and Firestore index JSON parsing passed.
- Live Cloudinary operations were not performed; emulator tests use a mock Cloudinary adapter.
