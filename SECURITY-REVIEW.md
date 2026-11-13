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

---

# Phase 5 Task 5C-4 — UPI Payment Submission Security Review

**Review date:** 2026-11-13
**Scope:** `createUpiPayment`, payment/upload validation, Firestore transaction, notification/outbox writes, related tests, contracts, and the complete Task 5C-4 diff.

## Assessment

No confirmed tenant-ownership bypass, duplicate-payment race, duplicate-notification path, or client-side financial-value trust was identified. The transaction creates the payment, consumes the upload intent, claims the normalized UTR, updates the bill, and creates the notification and delivery record together. The initial review identified a non-positive bill total integrity defect. A follow-up change now rejects non-positive totals both during adjustment and payment submission.

## Findings

### Medium (fixed) — Non-positive bill totals could be submitted as payments

- **Files:** `functions/src/payment_upload.ts`; `functions/src/index.ts`
- **Confidence:** 9/10
- The original implementation checked safe-integer rollups but did not require a positive bill total; adjustments could reduce a valid total to zero or below. The follow-up now rejects `newTotal <= 0` in `applyAdjustment` and `amountDue <= 0` in `createUpiPayment`.
- **Resolution:** Regression tests cover zero and negative payment totals and adjustment results. Relevant tests: `functions/src/index.integration.test.ts` and `functions/src/payment_upload.integration.test.ts`.

### Low — A retry after ambiguous Cloudinary upload success cannot recover

- **Files and lines:** `functions/src/payment_upload.ts:1413-1436, 2078-2080`; `app/lib/dashboards/tenant/tenant_billing_screen.dart:335-366`
- **Confidence:** 9/10
- If Cloudinary stores the asset but its response is lost, the upload handler clears the claim and returns an error. Retrying with the same intent uses the same public ID and `overwrite: false`, so it fails against the already-created asset. The tenant must obtain a new intent, leaving the first asset for cleanup.
- **Recommended action:** On an ambiguous failure or matching-asset conflict, fetch and validate the existing asset against the intent, then complete the intent idempotently.

## Test gaps and deployment risks

- The tests cover sequential normalized-UTR uniqueness and same-key submission concurrency, but not concurrent submissions using different idempotency keys and the same normalized UTR. They also omit mismatched lease/property ownership, invalid Cloudinary public ID/folder/HTTPS metadata, and upload timestamps outside the permission window. Relevant tests: `functions/src/payment_upload.integration.test.ts:369-398, 997-1079, 1132-1173`.
- Firestore Rules default-deny upload intents, UTR claims, and cleanup records, but the Rules tests do not explicitly assert these denials: `firestore.rules:530-534`; `tests/firestore.rules.test.ts:774-819`.
- The tenant app does not yet invoke `createUpiPayment`; it stops at “Proof uploaded — awaiting submission.” This is an end-to-end release blocker, but is outside the backend-only scope of Task 5C-4: `app/lib/services/tenant_payment_submission_service.dart:30-45`; `app/lib/dashboards/tenant/tenant_billing_screen.dart:516-524`.
- Deployment requires `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, and `PAYMENT_UPLOAD_TOKEN_SECRET`. The token secret must be at least 32 characters: `functions/src/index.ts:40-43, 1102-1181`; `functions/src/payment_upload.ts:664-667`.

## Controls reviewed

- Tenant role and tenant/lease/bill/property/upload-intent ownership are checked server-side.
- Both upload preparation and payment creation require `due` or `overdue` status.
- Cloudinary proof metadata is verified before transaction commit; upload-intent consumption and normalized UTR claiming are transactional.
- Identical payment retries return the existing payment; payload changes for the same key are rejected.
- Payment totals are derived from the bill, and UPI ID and recipient display name are stored as snapshots.
- Notification and delivery/outbox creation are atomic with payment creation, avoiding a second notification on an idempotent retry.
- Payment records remain server-only; no Rules changes are required.

## Validation notes

- Payment submission and callable-role tests passed: 46 tests across 2 suites, using the Auth and Firestore emulators.
- Billing notification regression tests passed: 14 tests, using the Auth and Firestore emulators.
- Functions lint, build, and `git diff --check` passed.
- Cloudinary behavior was exercised through test mocks; no live Cloudinary operation or deployment was performed.

## Acceptance

The medium financial-integrity defect is fixed and its focused tests pass. The low-severity ambiguous-upload retry behavior and the listed coverage gaps remain; the tenant UI also still needs to call `createUpiPayment` before the complete workflow is release-ready.

---

# Phase 5 Task 5C-6 — Landlord UPI Payment Review UI Security Review

**Review date:** 2026-11-13
**Scope:** Landlord payment-review repository, screen, dashboard navigation, tests, callable integration, and Firestore composite index.

## Assessment

No confirmed security vulnerabilities were found. The UI is acceptable, with emulator-backed payment integration testing recommended before end-to-end sign-off.

## Findings — Test coverage gaps

### Medium — Firebase repository authorization and query behavior are not directly tested

- **Files and lines:** `app/lib/services/landlord_payment_review_repository.dart:269-288`; `app/test/landlord_payment_review_repository_test.dart:99-134`
- **Confidence:** 8/10
- The repository checks the authenticated user's landlord role and scopes the pending-payment query by that user's UID. Existing tests cover record mapping and a linked-record mismatch, but do not directly exercise the Firebase auth claim, query scope, or configured callable region.
- **Assessment:** This is a coverage gap, not a confirmed authorization defect. Callable role tests and Firestore Rules independently enforce landlord authorization.

### Low — Proof-image and network/session error fallbacks are not directly tested

- **Files and lines:** `app/lib/dashboards/landlord/landlord_payment_review_screen.dart:186-201, 277-295`; `app/test/landlord_payment_review_screen_test.dart:23-52, 140-164`
- **Confidence:** 8/10
- Widget tests cover proof display/viewing and a failed-precondition callable response, but not missing, invalid, deleted, or inaccessible proof images, nor the mapped network and expired-session errors.
- **Assessment:** The screen provides image fallbacks and actionable error messages; those cases remain unverified by focused tests.

## Controls reviewed

- The repository checks the authenticated user's `role` claim and queries `payments` by that user's `landlordId` and `pending_verification` status. Firestore Rules additionally scope payment reads to the owning landlord.
- The repository validates payment, lease, and rent-charge identifiers and ownership fields. The callable independently validates payment, bill, lease, property, unit, tenant, and landlord relationships.
- Historical payments use the payment's linked lease and rent-charge records; the UI does not require the unit's current lease assignment to match.
- The UI invokes `verifyUpiPayment` using the default `us-central1` region and sends only `accept` or `reject`. Predefined rejection reasons omit `rejectionExplanation`; `Other` explanations are trimmed and limited to 10-500 characters.
- The UI prevents concurrent submissions, refreshes the queue after success, and relies on the callable's idempotency and conflict rejection for retries.
- Proof URLs are checked for HTTPS and expected Cloudinary image metadata. Failed image loads render fallback text.
- The composite index matches the collection query's ascending `landlordId` and `status` fields. The index was not deployed during this review.

## Validation notes

- Landlord payment-review Flutter tests passed: 15 tests.
- Callable role tests passed: 19 tests.
- The emulator-backed payment integration suite stalled and did not complete. The full payment decision workflow therefore remains unverified end-to-end.
- A prior full Flutter test run passed 91 tests.

## Recommendation

Accept the UI implementation. Run the emulator-backed payment integration suite before treating the full verification flow as validated.
