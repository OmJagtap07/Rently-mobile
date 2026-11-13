# Rently 2.0 — Cloud Function Contracts (Phase 2, Frozen)

**Status:** Frozen for implementation
**Version:** 1.4 — due/overdue-only UPI payment submission
**Date:** 13 November 2026
**Depends on:** `schema.md` v1.5, `authorization.md` v1.3
**Next:** `firestore.rules`

---

## 0. Conventions used below

- **Trigger type** is `callable` (invoked via the client SDK, `context.auth` populated from Firebase Auth) or `scheduled` (Cloud Scheduler / pub-sub, no end-user auth context) unless noted otherwise.
- **Auth** describes who is allowed to call it, checked at the top of the function body — Security Rules do not (and cannot) enforce this; the function must.
- Every callable function that writes returns either `{ success: true, ...data }` or throws an `HttpsError` with one of a fixed set of error codes, listed per function, so client error handling doesn't have to guess.
- **Idempotency** notes what happens if the same call is retried (network blip, double-tap) — every mutating function must be safe to retry.
- All multi-document writes use `db.runTransaction()`, not a batch, whenever a read-then-write consistency check is needed (batches can't read); a plain batch is used only where every write is unconditional.

---

## 1. `completeOnboarding`

**Trigger:** callable
**Auth:** any authenticated Firebase user — this is the one function in the whole system callable *without* a role, since role doesn't exist yet at this point. It fills the gap flagged in review: without it, there was no defined way for a `role` custom claim to ever come into existence, which every other Auth check in this document depends on.

**Input:**
```ts
{ role: 'landlord' | 'tenant', fullName: string, phone: string }
```

**Validation:**
- No `users/{caller.uid}` document already exists.
- Caller's Auth token has no `role` custom claim already set.
- (Both checks exist so this function can only ever run once per account — re-onboarding or role-switching is not supported, matching the "role is set once at onboarding" rule.)

**Steps (not a Firestore transaction — this uses the Admin SDK, which bypasses rules entirely, so ordering just needs to be safe against a mid-failure retry):**
1. `admin.auth().setCustomUserClaims(caller.uid, { role })`.
2. Create `users/{caller.uid}`: `uid`, `role`, `fullName`, `phone`, `email` (from the Auth record), `onboardingCompleted: true`.

**Result:** `{ uid: string, role: string }`

**Errors:** `already-exists` (profile or claim already set), `invalid-argument` (bad role value).

**Idempotency:** step 1 (`setCustomUserClaims`) is naturally idempotent — setting the same claim twice is harmless. Step 2 is guarded by the "no existing doc" check, so a retry after a partial failure (claim set, doc creation failed) will skip step 1's effect being re-checked and just retry step 2. Recommend checking "does the claim already match `role`" before re-attempting step 1 on retry, so a retry after full success cleanly no-ops instead of hitting `already-exists` confusingly.

**Client-side note (not this function's responsibility, but necessary to call out):** Firebase custom claims only take effect in a client's ID token after that token is refreshed. The client must call `getIdToken(true)` (force refresh) immediately after this function resolves, or Security Rules checking `request.auth.token.role` will still see no role until the token naturally refreshes (up to an hour later).

---

## 2. `resolveJoinCode`

**Trigger:** callable
**Auth:** any authenticated user with `role == 'tenant'`

**Input:**
```ts
{ joinCode: string }
```

**Validation:**
- `joinCode` non-empty, matches expected format (e.g. 8 alphanumeric chars).
- A `properties` doc exists with this `joinCode` and `status == 'active'`.

**Transaction steps:** none — read-only.

**Result:**
```ts
{ propertyId: string, name: string, address: string }
```
Deliberately excludes `joinCode`, `landlordId`, and any other field — this is the "limited property information" the design doc calls for, not the full document.

**Errors:** `not-found` (no active property with that code), `invalid-argument` (malformed code).

**Idempotency:** trivially safe — pure read.

---

## 3. `createJoinRequest`

**Trigger:** callable
**Auth:** `role == 'tenant'`.

**Input:**
```ts
{ propertyId: string, message?: string }
```

**Validation:**
- `properties/{propertyId}` exists, `status == 'active'`.
- `users/{caller.uid}.activeLeaseId == null` — a tenant already in an active tenancy cannot apply elsewhere. (`acceptJoinRequest()` re-checks this again at accept-time regardless, since time passes between request and acceptance — this check just avoids letting an obviously-invalid request get created in the first place.)
- No existing `joinRequests` doc with `tenantId == caller.uid`, `propertyId == propertyId`, `status == 'pending'` — this is the natural idempotency guard (see below), no client-supplied key needed.

**Transaction steps:**
1. Read `properties/{propertyId}.landlordId` — **derived server-side, never accepted from the client.** This is the fix for the gap flagged in review: `resolveJoinCode()` deliberately withholds `landlordId` from the tenant, so a direct client `create` on `joinRequests` could never have populated this field correctly (or worse, could have trusted a forged one).
2. Create `joinRequests/{newRequestId}`: `tenantId = caller.uid`, `propertyId`, `landlordId` (from step 1), `status: 'pending'`, `message`, `requestedAt = now`.

**Result:** `{ joinRequestId: string }`

**Errors:** `failed-precondition` (property not active, tenant already has an active lease), `already-exists` (duplicate pending request for this tenant/property — returns the existing request's ID rather than erroring, so a client retry is a clean no-op), `not-found`, `permission-denied`.

**Idempotency:** the tenant+property+`pending` uniqueness check *is* the idempotency guard — no separate key needed, unlike `applyManualFine()`/`applyAdjustment()` where no natural key exists.

---

## 4. `acceptJoinRequest`

**Trigger:** callable
**Auth:** `role == 'landlord'`, and the caller's `uid` must equal the target `joinRequests.landlordId`.

**Input:**
```ts
{ joinRequestId: string, unitId: string }
```

**Validation:**
- `joinRequests/{joinRequestId}` exists, `status == 'pending'`, `landlordId == caller.uid`.
- `units/{unitId}` exists, `propertyId == joinRequests.propertyId`, `landlordId == caller.uid`, `status == 'vacant'`.
- Re-read `users/{joinRequests.tenantId}.activeLeaseId` **inside the transaction** — must be `null`. (This is the race-condition check flagged earlier: two landlords accepting the same tenant near-simultaneously must not both succeed.)

**Transaction steps (in one `runTransaction`):**
1. `joinRequests/{id}.status = 'accepted'`, `respondedAt = now`, `respondedBy = caller.uid`.
2. Create `leases/{newLeaseId}`: `tenantId`, `landlordId`, `propertyId`, `unitId`, `joiningDate` (input or `today`), `currentBaseRent = units.baseRent`, `status: 'active'`.
3. `units/{unitId}.currentLeaseId = newLeaseId`, `status = 'occupied'`.
4. `users/{tenantId}.activeLeaseId = newLeaseId`.
5. **Query `joinRequests` where `tenantId == joinRequests.tenantId` and `status == 'pending'` (a bounded read via `transaction.get(query)`, supported in the Admin SDK), excluding the request being accepted, and set each to `status = 'rejected'`, `autoRejected: true`, `respondedAt = now`, `respondedBy` left absent.** This is the resolved auto-reject behavior (schema.md §4): once a tenant has an active lease, any other pending applications no longer represent a valid future tenancy, and leaving them visible would let another landlord act on a stale request. A tenant is expected to hold only a handful of pending requests at once, so this stays a small, bounded read.

**Result:** `{ leaseId: string, autoRejectedCount: number }`

**Errors:** `failed-precondition` (unit not vacant, request not pending, or tenant already has an active lease — the race-condition case), `not-found`, `permission-denied`.

**Idempotency:** re-calling with the same `joinRequestId` after success fails fast with `failed-precondition` (`status` is no longer `pending`) — safe to retry, won't double-create a lease or re-run the auto-rejection.

---

## 5. `endLease`

**Trigger:** callable
**Auth:** `role == 'landlord'`, caller's `uid == leases.landlordId`.

**Input:**
```ts
{ leaseId: string, endDate: string /* YYYY-MM-DD */, endReason?: string }
```

**Validation:**
- `leases/{leaseId}` exists, `status == 'active'`, `landlordId == caller.uid`.
- `endDate` is a valid date, not before `joiningDate`.

**Transaction steps:**
1. `leases/{id}.status = 'ended'`, `endDate`, `endReason`, `endedBy = caller.uid`.
2. `units/{leases.unitId}.currentLeaseId = null`, `status = 'vacant'`.
3. `users/{leases.tenantId}.activeLeaseId = null`.

**Result:** `{ leaseId: string, status: 'ended' }`

**Errors:** `failed-precondition` (lease already ended), `not-found`, `permission-denied`, `invalid-argument` (bad date).

**Idempotency:** safe — retried call on an already-ended lease fails with `failed-precondition` rather than re-running the side effects.

**Note:** does *not* touch any `rentCharges` — an ended lease's unpaid/overdue bills remain exactly as they are (historical record, per schema.md §14/architecture.md §14). Collecting on them after move-out is a landlord/offline concern, not something this function resolves.

---

## 6. `finalizeRentCharge`

**Trigger:** callable
**Auth:** `role == 'landlord'`, caller's `uid == rentCharges.landlordId`.

**Input:**
```ts
{ rentChargeId: string }
```

**Validation:**
- `rentCharges/{id}` exists, `status == 'draft'`, `landlordId == caller.uid`.
- Parent `leases.status == 'active'`.
- `billingMonth` matches the ID's month segment (defense-in-depth against a malformed draft).
- `lineItems` contains at most 10 entries and exactly one `rent` entry; each item is validated server-side.
- `subtotal` recomputed server-side from `lineItems` and must match the stored `subtotal` (catches any client-side arithmetic drift before it becomes historical fact).
- Draft `total` matches `subtotal`, and its precomputed `dueDate` is the 10th of `billingMonth`.
- No other `rentCharges` doc already exists for this `leaseId` + `billingMonth` — the composite ID (schema.md §6) makes this a single existence check, not a query.

**Transaction steps:**
1. `rentCharges/{id}.status = 'finalized'`, `finalizedAt = now`, `finalizedBy = caller.uid`, `dueDate = 10th of billingMonth`, `total = subtotal` (fines/adjustments are zero at this point).

**Result:** `{ rentChargeId: string, dueDate: string, total: number }`

**Errors:** `failed-precondition` (not draft, lease not active, invalid line items, or subtotal mismatch), `already-exists` (shouldn't be reachable given the composite ID, but checked defensively), `not-found`, `permission-denied`.

**Idempotency:** safe — retrying after success hits `failed-precondition` (`status` no longer `draft`).

---

## 7. `applyManualFine`

**Trigger:** callable
**Auth:** `role == 'landlord'`, caller's `uid == rentCharges.landlordId`.

**Input:**
```ts
{ rentChargeId: string, amount: number /* paise */, reason: string, idempotencyKey: string }
```
`idempotencyKey` is **required**, not optional — fixed here per review: v1.0 contradicted itself by omitting it from the input contract while requiring it in the idempotency note. It's a client-generated UUID, same pattern as `applyAdjustment()` (§8), and is now persisted as `fineApplications.idempotencyKey` (schema.md §6.2).

**Validation:**
- `rentCharges/{id}` exists, `status ∈ {finalized, due, overdue}`, `landlordId == caller.uid`.
- `amount > 0`, `reason` non-empty (schema.md §6.2: reason required for `ruleSource: 'manual'`).
- No existing `fineApplications` doc under this `rentChargeId` with this `idempotencyKey`.

**Transaction steps:**
1. Create `rentCharges/{id}/fineApplications/{newFineId}`: `amount`, `ruleSource: 'manual'`, `reason`, `idempotencyKey`, `appliedAt = now`, `appliedBy = caller.uid`, `sequenceNumber` = count of existing fines + 1.
2. `rentCharges/{id}.lateFineTotal += amount`, `total += amount`.

**Result:** `{ fineId: string, newLateFineTotal: number, newTotal: number }`

**Errors:** `failed-precondition` (wrong status), `invalid-argument` (amount ≤ 0, missing reason, or missing `idempotencyKey`), `already-exists` (duplicate `idempotencyKey` — the retry case, returns the original fine's result rather than erroring, so a client retry after a dropped response gets the same answer instead of a confusing failure), `not-found`, `permission-denied`.

**Idempotency:** enforced via `idempotencyKey`, as above — not naturally idempotent otherwise, since there's no other uniqueness to key off (unlike, say, `finalizeRentCharge()`, where `status` itself guards against a repeat).

---

## 8. `applyAdjustment`

**Trigger:** callable
**Auth:** `role == 'landlord'`, caller's `uid == rentCharges.landlordId`.

**Input:**
```ts
{ rentChargeId: string, amount: number /* paise, can be negative */, reason: string, idempotencyKey: string }
```

**Validation:**
- `rentCharges/{id}` exists, `status ∈ {finalized, due, overdue}` — **explicitly rejected at `payment_pending` and `paid`** (schema.md §6.1/§6.3).
- `reason` non-empty.
- No existing `adjustments` doc with this `idempotencyKey` (same pattern as `applyManualFine`, needed for the same reason).

**Transaction steps:**
1. Create `rentCharges/{id}/adjustments/{idempotencyKey}`: `type: 'correction'`, `amount`, `reason`, `idempotencyKey`, `createdBy = caller.uid`.
2. `rentCharges/{id}.adjustmentTotal += amount`, `total += amount`.

**Result:** `{ adjustmentId: string, newAdjustmentTotal: number, newTotal: number }`

**Errors:** `failed-precondition` (status not in the allowed set — the error message should distinguish "payment pending" from "already paid" so the landlord UI can explain *why*, per design.md's "don't hide financial info" rule), `already-exists` (the key was reused with a different payload), `invalid-argument`, `not-found`, `permission-denied`.

**Idempotency:** `idempotencyKey` is a UUID, normalized to lowercase, and used as the adjustment document ID and persisted value. A retry with the same key and payload (including a case variant) does not write again; it returns the existing adjustment ID and the bill's current rollup totals. Reusing the key with a different payload returns `already-exists`.

---

## 9. `preparePaymentProofUpload`

**Trigger:** callable
**Auth:** authenticated `role == 'tenant'`; caller UID must own the
`rentCharges/{rentChargeId}` document.

**Input:**
```ts
{
  rentChargeId: string,
  idempotencyKey: string, // UUID
  recipientNameConfirmed: true,
  format: 'jpg' | 'jpeg' | 'png' | 'webp',
  bytes: number // 1–5,000,000 inclusive
}
```

**Validation:** bill exists, belongs to the caller, has status `due` or
`overdue`, and its lease/property references are consistent. A `finalized`
bill is not eligible until the scheduled transition changes it to `due`. The
property must contain valid `upiId`, `upiQrImageUrl`, and `upiDisplayName`.
Validate and normalize the UUID to lowercase before computing the intent
document ID. The Flutter flow must require explicit recipient-name
confirmation before calling this function; the acknowledgement is not proof
that Rently verified recipient identity. Never accept a client-selected
Cloudinary folder or `publicId`. Reject a missing/unsupported format or byte
count outside 1–5,000,000 before issuing upload authorization. Normalize the
declared format to lowercase and store it and the declared byte count in the
intent; these client declarations are untrusted and must be checked against
the uploaded file and Cloudinary metadata.

**Intent and upload authorization:**
1. In a Firestore transaction, re-read bill and scoped intent. Create
   `paymentUploadIntents/{sha256(lowercase(idempotencyKey))}`
   with tenant and bill IDs, a random `publicId`, fixed Rently folder,
   `resourceType: 'image'`, declared format/bytes, `status: 'issued'`,
   `createdAt = now`, and `expiresAt = now + 15 minutes`.
2. A retry with the same scope/key and identical declared format/bytes reuses
   the same unexpired issued intent. Reusing the key with a different scope or
   declared file metadata, or reusing a consumed intent, returns
   `already-exists`; an expired intent returns `failed-precondition`.
3. Issue a scoped upload permission expiring at the earlier of `now + 10
   minutes` and the persisted intent's `expiresAt`; persist its expiry as
   `uploadPermissionExpiresAt`. On a retry, a renewed permission must not
   extend the original intent's 15-minute expiry.
4. The upload endpoint must reject requests after the permission expiry and
   independently reject an expired, consumed, or non-`issued` intent. It must
   enforce the 5 MB (5,000,000-byte) stream limit and approved image formats
   from the actual uploaded content before forwarding the upload to
   Cloudinary. Keep Cloudinary credentials server-side.
5. Before calling Cloudinary, transactionally set a random `uploadClaimId` and
   `uploadClaimExpiresAt = now + 7 minutes` on the intent. Reject a second
   active claim. After Cloudinary returns, transactionally clear the matching
   claim only if the intent remains `issued` and valid. If the intent became
   invalid while the upload was in progress, change it to `cleanup_pending`
   and enqueue the deterministic compensation task in the same transaction.

**Cloudinary expiry constraint:** [Cloudinary's signature documentation](https://cloudinary.com/documentation/authentication_signatures)
states that a standard timestamp-based signed upload remains valid for one
hour. Therefore, never return a standard Cloudinary upload signature directly
to Flutter. The 10-minute permission is enforced by the required
server-mediated upload endpoint; only that endpoint uses Cloudinary
authentication. The endpoint must validate the tenant's scoped token and its
10-minute expiry before it forwards any file bytes to Cloudinary.

**Result:**
```ts
{
  success: true,
  uploadIntentId: string,
  uploadUrl: string, // Rently authenticated upload endpoint
  uploadToken: string, // opaque, scoped, expires within 10 minutes
  uploadPermissionExpiresAt: number, // Unix milliseconds
  intentExpiresAt: number // Unix milliseconds, 15 minutes from intent creation
}
```

`uploadPaymentProof` is an HTTPS endpoint called with the authenticated tenant
session, `uploadIntentId`, a scoped bearer `uploadToken`, and the image stream.
The token is bound to the tenant and intent and expires within 10 minutes. The
endpoint independently checks the token expiry and intent status/15-minute
expiry, enforces the declared and actual size/format, and uploads under the
intent's fixed `publicId`/folder with overwrite disabled. It keeps all
Cloudinary authentication server-side. The endpoint response only confirms
upload completion; `createUpiPayment()` remains responsible for verifying
Cloudinary metadata and atomically consuming the intent.

Accept only JPEG/JPG, PNG, or WebP images of 1–5,000,000 bytes, uploaded to the
fixed folder under an unguessable public ID with overwrite disabled. The
upload endpoint validates the actual content and size before forwarding, and
the backend independently verifies the Cloudinary asset metadata before
submission. The upload permission expires after 10 minutes; the persisted
intent expires after 15 minutes. Both expiries are independently enforced.
Upload success alone never creates a payment or changes bill state. The
permission may be replayed before its expiry, but the persisted intent can be
consumed only once at submission.

The handler checks `Content-Length` before accessing the runtime-provided
`rawBody`, then checks the actual buffered byte count immediately. Firebase
HTTPS request middleware may buffer the body before handler execution, so the
handler cannot guarantee rejection before platform-level buffering; the
header check avoids an additional application-level read/allocation, and the
actual-byte check remains authoritative. Reject unsupported `Content-Type`
values before reading `rawBody`, then verify the byte signature and structure
independently of the declared MIME type.

An upload claim lasts 7 minutes, longer than the HTTPS function's 120-second
timeout. Expired-intent cleanup transactionally defers while the claim lease is
active. If Cloudinary creates the asset after the intent has expired or become
invalid, the upload transaction queues compensating deletion rather than
marking the intent cleaned or returning a usable proof. Expired claims are
reclaimable so crashed handlers cannot block cleanup indefinitely.

**Errors:** `failed-precondition` (bill not payable, UPI details unavailable,
or expired intent), `invalid-argument` (unsupported format or byte count),
`not-found`, `permission-denied`,
`already-exists` (idempotency key reused for another scope or consumed intent).

## 10. `createUpiPayment`

**Trigger:** callable
**Auth:** authenticated `role == 'tenant'`; caller UID must own the bill.

**Input:**
```ts
{
  rentChargeId: string,
  uploadIntentId: string,
  idempotencyKey: string, // UUID; lowercase payment document ID
  transactionRef: string
}
```

**Validation:**
- Bill, lease, and tenant ownership must agree; bill status is `due` or
  `overdue`. A `finalized` bill is not eligible until its scheduled transition
  changes it to `due`.
- Validate and normalize the idempotency UUID to lowercase. Trim the required
  UTR/reference; require 6–30 ASCII alphanumeric characters
  (`^[A-Za-z0-9]{6,30}$`) after trimming. Preserve the trimmed submitted value
  in payment history and use its uppercase form for the per-bill uniqueness
  claim.
- Intent exists, belongs to this tenant and bill, is `issued`, and is not
  expired or consumed. Its 15-minute expiry must be valid at consumption.
  Reject an intent with an unexpired `uploadClaimExpiresAt`; upload completion
  must release its claim before payment submission can consume the intent.
  Independently verify from Cloudinary asset metadata that the upload
  completed while a valid 10-minute upload permission was in force.
- Verify the Cloudinary asset server-side by intent public ID and fixed
  folder: correct account, exact ID/folder, HTTPS secure URL, image resource
  type, format matching the intent's declared JPG/JPEG/PNG/WebP value, and
  actual size matching the declared byte count and not exceeding 5,000,000
  bytes. Verify the Cloudinary upload timestamp is no later than the issued
  upload permission's expiry. Ignore client-provided proof metadata.
- Validate bill financial rollups as safe integer paise and require
  `total == subtotal + lateFineTotal + adjustmentTotal`.

**Transaction steps:**
1. Check `payments/{idempotencyKey}` before requiring the Cloudinary asset. If
   it exists, return it only when tenant, bill, UTR, and intent match;
   otherwise reject key reuse. This makes retries work even if later cleanup
   has removed an already-submitted asset.
2. Verify the Cloudinary asset before entering the Firestore transaction.
3. In the transaction check `payments/{idempotencyKey}` again to handle
   concurrent retries. Return the matching record or reject key reuse.
4. Re-read bill and intent, require an eligible bill, an unexpired 15-minute
   intent, a matching `issued` intent, and no active upload claim. Verify from
   Cloudinary metadata that the upload completed before the 10-minute
   permission expired, and
   verify that
   `rentCharges/{rentChargeId}/upiReferences/{SHA256(uppercase(trimmed UTR))}`
   does not already exist.
5. Create `payments/{idempotencyKey}` with server-derived denormalized IDs,
   `method: 'upi_qr'`, `amountDue = rentCharges.total`, `gatewayFee = 0`,
   `totalPaid = amountDue`, `status: 'pending_verification'`, verified proof
   metadata, required `transactionRef`, `upiIdSnapshot`,
   `upiDisplayNameSnapshot`, and server timestamps. Initialize
   `proofCleanup.status = 'not_requested'`.
6. In that transaction consume the intent, set `consumedByPaymentId`, create
   the UTR claim, and set bill status to `payment_pending`.
7. Create a deterministic `payment_proof_submitted` notification for the
   owning landlord, related to this payment. Do not include proof URL or full
   UTR in push text.

**Result:** `{ success: true, paymentId: string, status: 'pending_verification' }`

**Errors:** `failed-precondition` (bill not payable, intent invalid/expired,
or proof invalid), `invalid-argument` (UUID or UTR invalid),
`already-exists` (key or UTR already claimed), `not-found`,
`permission-denied`.

**Idempotency:** same key and same tenant/bill/UTR/intent returns the existing
payment without another write. Same key with different values is rejected.
Different keys race on the bill transaction; only one transitions an eligible
bill to `payment_pending`. After rejection, a new attempt requires a new key,
intent, and UTR. Never overwrite prior attempts. A failed submission leaves
the bill unchanged and intent unconsumed.

The Flutter flow must require tenant confirmation that the displayed
recipient name matches their UPI app before initiating upload and before
enabling submission. This is a user acknowledgement, not independent
verification by Rently.

## 11. `verifyUpiPayment`

**Trigger:** callable
**Auth:** authenticated `role == 'landlord'`; caller UID must equal the
payment's `landlordId`.

**Input:**
```ts
{
  paymentId: string,
  decision: 'accept' | 'reject',
  rejectionReasonCode?: 'old_or_used_screenshot'
    | 'blurry_or_unreadable_screenshot'
    | 'incomplete_amount'
    | 'incorrect_utr'
    | 'payment_not_received'
    | 'screenshot_bill_mismatch'
    | 'other',
  rejectionExplanation?: string
}
```

Require payment method `upi_qr`, status `pending_verification`, and a linked
bill in `payment_pending`. Independently validate the complete linked-record
relationship before either decision:

- The payment's `rentChargeId` identifies the linked rent charge, its tenant
  and landlord IDs match that bill.
- The rent charge references the same tenant, landlord, lease, property, and
  unit as the payment.
- The lease references the same tenant, landlord, property, and unit.
- The property belongs to the same landlord.
- The unit belongs to the same property and landlord, and its current lease
  relationship and status are consistent with the linked lease under
  schema.md §§3 and 5 (ending a lease clears its `currentLeaseId`).
- The authenticated caller UID matches the payment's landlord ID.

Reject missing or inconsistent linked records; do not rely only on IDs copied
into the payment document.

Rejection requires one `rejectionReasonCode` from the listed choices. Persist
the selected code and its exact canonical display label: “Old or previously
used screenshot”, “Blurry or unreadable screenshot”, “Payment amount is
incomplete”, “Incorrect UTR/reference number”, “Payment not received in
landlord's account”, “Screenshot does not match this rent bill”, or “Other”.
For the six predefined reasons, `rejectionExplanation` must be absent; reject
the request if it is supplied, including as a blank string. For `other`, require
a trimmed `rejectionExplanation` of 10–500 characters. Persist the explanation
only for `other`. Do not accept an arbitrary reason for the predefined codes.

For `accept`, reject any rejection code or explanation in the input.

**Accept transaction:** atomically set payment status to `verified`,
`reviewedAt = now`, `reviewedBy = caller.uid`, and `proofCleanup.status =
retained`; set bill status to `paid` and `paidAt = now`; create a deterministic
`payment_accepted` notification for the tenant. Proof remains in Cloudinary
and is never queued for deletion.

**Reject transaction:** atomically set payment status to `rejected`,
`reviewedAt`, `reviewedBy`, `rejectionReasonCode`, and canonical
`rejectionReason`; for `other`, also set `rejectionExplanation`; set
`proofCleanup.status = pending` and `proofCleanup.requestedAt = now`; restore
bill status to `overdue` only when `dueDate` is earlier than the current UTC
date (`YYYY-MM-DD`), otherwise `due`; enqueue a deterministic
`paymentProofCleanupOutbox` task;
and create a deterministic `payment_rejected` notification for the tenant.
Notification body includes the selected rejection reason and, for `other`, its
explanation; it explains a new attempt may be submitted. The payment and proof
metadata remain in Firestore. A rejected payment does not automatically label
the tenant fraudulent.

**Result:** `{ success: true, paymentId: string, decision: 'accept' | 'reject', rentChargeStatus: 'paid' | 'due' | 'overdue' }`

**Errors:** `failed-precondition` (wrong method, resolved payment, or
bill/payment mismatch), `invalid-argument` (missing/unknown rejection code,
explanation supplied for a predefined reason, or missing/invalid `other`
explanation),
`not-found`, `permission-denied`.

**Idempotency:** retrying the same decision after commit returns the committed
result without duplicating notifications or cleanup tasks. A conflicting
decision after resolution fails.

## 12. Payment proof cleanup and expired upload recovery

**Trigger:** server-only outbox workers and scheduled recovery; no client
callable.

`recoverPaymentProofCleanup` periodically scans due outbox tasks and expired,
unconsumed intents. Rejected proofs and expired, unconsumed intents enqueue
deterministic `paymentProofCleanupOutbox` tasks (`paymentId` for a rejected
proof; `uploadIntentId` for an abandoned upload). Each task has exactly one
source record. For a rejected-payment task, `paymentId` must identify the
rejected payment and `publicId` must exactly match its immutable
`proof.publicId`; the worker verifies this binding before deletion. The worker
also checks that no verified payment references that proof. In one transaction,
cleanup changes an expired `issued` intent to `cleanup_pending` and creates its
task, unless an unexpired upload claim exists; active claims defer cleanup. A
late upload transactionally creates or requeues its deterministic compensation
task. A consumed intent is never eligible.
Initialize each task with `attempts: 0`, `manualRetryCount: 0`, and
`errorHistory: []`.
Use transactional claim leases and exponential backoff
(`baseDelay × 2^(attempts - 1)`); permit at most five failed deletion attempts
per automatic retry cycle. A failure on attempt five, including a reclaimed
task whose attempts are already exhausted, sets the task and linked cleanup
state to `terminal_failure` in the same transaction. Preserve the task,
`lastError`, and append-only `errorHistory` for administrative/manual retry;
manual requeue resets only the current-cycle `attempts`, increments
`manualRetryCount`, and retains prior errors. Treat an already-absent asset as
successful deletion, not a failed attempt. Delete only the recorded public ID
under the fixed folder using Cloudinary credentials from Secret Manager.
Re-check immediately before deletion that no verified payment references the
asset.

On success, mark the task completed and payment cleanup `deleted` or intent
`cleaned`. Transient failures append error details and set the next attempt.
A submission racing cleanup must transactionally
consume the intent before cleanup claims it; only one path wins.
Deploy indexes for cleanup tasks `(status, nextAttemptAt)` and
`(status, claimExpiresAt)`, plus expired issued intents `(status, expiresAt)`.

---

## 13. Scheduled functions

### `send25thLandlordReminder`
**Trigger:** scheduled, monthly on the 25th at 09:00 UTC.
**Logic:** group active leases by landlord and create one `notifications` doc for each landlord (`type: 'prepare_bill_reminder'`) for the following UTC billing month. It also creates a server-only delivery outbox record. The notification ID is a deterministic hash of `recipientId + type + upcoming billingMonth`; no `billingMonth` field is added to the notification. This function never reads or writes `rentCharges` (architecture.md §8: no bill is auto-generated here).
**Idempotency:** the notification and outbox record are created in a Firestore transaction. A retried or overlapping scheduler invocation sees the deterministic notification ID and does not create another reminder.

### `send1stTenantNotifications`
**Trigger:** scheduled, monthly on the 1st at 09:00 UTC.
**Logic:** for every `rentCharges` with `status == 'finalized'` and `billingMonth` equal to the current UTC month, atomically transition `status → 'due'` and create a `notifications` doc for the tenant (`type: 'rent_due'`) plus a delivery outbox record. Notification IDs are deterministic hashes of the rent-charge document ID.
**Idempotency:** the transaction re-reads the bill and only transitions a still-finalized current-month bill. A retry or overlapping invocation skips bills already transitioned.

### FCM delivery and token lifecycle

`registerDeviceToken()` and `unregisterDeviceToken()` are authenticated,
user-scoped callables. Tokens are stored in the user's `deviceTokens`
subcollection under a SHA-256 token ID; clients cannot read or write that
subcollection directly. Calls include the expected UID, which the server
compares with the authenticated UID to reject account-switch races. Flutter
stores the UID/token ownership pair in platform secure storage. It persists
pending removals before attempting cleanup, unregisters only while the matching
UID is authenticated, and retries pending cleanup on that user's next sign-in.
Sign-out is not blocked indefinitely: the cleanup call has a short timeout and
the durable local retry state is retained on failure. A token pending removal
for one UID is not registered to another UID.

Creation of a delivery outbox record fans out per-device tasks. A Firestore
create trigger sends each push using Firebase Admin Messaging. A transaction
claims each device task for five minutes. Confirmed invalid tokens are removed
atomically with the terminal delivery state, from only the recipient's
user-scoped token path.

Transient FCM failures are persisted as `pending` with exponential delays
starting at one minute, doubling per attempt and capped at six hours. At most
five send attempts are made. Known permanent FCM errors and exhausted retries
are recorded as terminal `failed` tasks with error details; confirmed invalid
tokens use terminal `invalid`. A UTC worker runs every five minutes, retrying
due tasks and reclaiming expired `sending` leases using the same transactional
claim. The `devices` collection-group indexes for `(status, nextAttemptAt)` and
`(status, leaseExpiresAt)` must be deployed with the functions.

Delivery is at-least-once, not exactly-once. If FCM accepts a push but its
acknowledgment is lost, or the worker crashes before persisting `sent`, a later
retry can send a duplicate. The Firestore notification document remains the
durable source of truth.

Android uses the existing Firebase app configuration. iOS is not configured in
this repository: add `ios/Runner/GoogleService-Info.plist` generated for the
Runner target's actual bundle identifier, rerun FlutterFire configuration with
the real iOS Firebase options, enable the Push Notifications and Background
Modes capabilities in Xcode, and configure an APNs authentication key in
Firebase Console before claiming iOS push support. Until then, startup displays
a configuration-required screen instead of initializing Firebase with
fabricated values. Web builds require the Firebase Messaging service worker and
a Web Push VAPID key supplied as
`--dart-define=FCM_WEB_VAPID_KEY=<public-web-push-key>`. The web key is not a
service-account credential. Do not enable web push until the service worker,
VAPID key, and authorized hosting origin are configured.

### `updateOverdueCharges`
**Trigger:** scheduled, daily.
**Logic:** for every `rentCharges` with `status == 'due'` and `dueDate < today`, transition `status → 'overdue'`, create a `notifications` doc for the landlord (`type: 'overdue_rent'`).
**Idempotency:** skips anything already `overdue`.

### `applyConfiguredLateFines`
**Trigger:** scheduled, daily.
**Logic:** for every `rentCharges` with `status == 'overdue'`, check the applicable `lateFineConfig` (lease override → else property default) against `fineApplications` already recorded (`ruleSource: 'configured'`): if `sequenceNumber` count `< maxRepetitions` and `repeatIntervalDays` have elapsed since the last configured fine (or `startAfterDays` since `dueDate` for the first), apply one — same transaction shape as `applyManualFine()` but `appliedBy: 'system'`, `ruleSource: 'configured'`. Create a `notifications` doc for the tenant (`type: 'late_fine_update'`).
**Idempotency:** the `sequenceNumber`/count check against `maxRepetitions` is itself the guard — a re-run on the same day that already applied today's fine sees the interval hasn't elapsed again and skips.

---

## 14. Summary table

| Function | Trigger | Actor |
|---|---|---|
| completeOnboarding | callable | any (pre-role) |
| resolveJoinCode | callable | tenant |
| createJoinRequest | callable | tenant |
| acceptJoinRequest | callable | landlord |
| endLease | callable | landlord |
| finalizeRentCharge | callable | landlord |
| applyManualFine | callable | landlord |
| applyAdjustment | callable | landlord |
| preparePaymentProofUpload | callable | tenant |
| uploadPaymentProof | HTTPS upload endpoint | tenant with valid scoped upload token |
| createUpiPayment | callable | tenant |
| verifyUpiPayment | callable | landlord |
| recoverPaymentProofCleanup | scheduled/outbox worker | — |
| send25thLandlordReminder | scheduled | — |
| send1stTenantNotifications | scheduled | — |
| updateOverdueCharges | scheduled | — |
| applyConfiguredLateFines | scheduled | — |

## 15. Open items carried into implementation

1. ~~Auto-reject of a tenant's other pending `joinRequests` on acceptance~~ — **RESOLVED**, see `acceptJoinRequest()` §4 step 5.
2. ~~`applyManualFine`/`applyAdjustment` idempotency contract~~ — **RESOLVED**, both now require `idempotencyKey` in their input contracts (§7, §8). The client-side UUID generation convention (which library, where it's called from) still needs to be agreed with whoever builds the Flutter forms — a minor implementation detail, not an open design question.
3. Landlord approval and rejection of UPI QR payments are in scope through
   `verifyUpiPayment()` (§11). Gateway payment integration, gateway
   verification, webhooks, and automated gateway reconciliation remain
   deferred. Provider selection remains deferred to Phase 7 per PRD §20.
4. The proof defaults are resolved: JPG/JPEG/PNG/WebP, 5 MB maximum, a
   10-minute upload permission, and a 15-minute persisted intent. Configure
   the fixed Cloudinary folder and cleanup worker cadence.
5. Cleanup is limited to five failed attempts per automatic retry cycle with
   exponential backoff; set the base delay and define the administrative
   requeue procedure. Cleanup uses its own outbox, not the notification
   delivery records.
6. UTR is resolved to a trimmed 6–30 character ASCII alphanumeric value,
   unique case-insensitively per bill. Rejection reasons use the fixed enum;
   `other` requires a 10–500 character explanation.
7. Cloudinary's standard signed-upload signature lasts one hour, so the
   server-mediated `uploadPaymentProof` endpoint is mandatory to enforce the
   10-minute permission. Never send that standard signature to Flutter.

These are implementation/configuration decisions, not permission to weaken
authorization, extend the signature scope, or accept unverified Cloudinary
metadata.

## 16. Required implementation tests

- Callable role, authentication, and ownership tests: unauthenticated callers,
  wrong roles, another tenant's bill/intent, another landlord's payment, and
  missing or inconsistent tenant/bill/lease/property/unit relationships.
- Submission integrity tests: missing/invalid UTR, 6/30-character boundaries,
  out-of-range and non-alphanumeric UTRs, invalid or expired upload permission
  and intent independently, wrong Cloudinary account/public ID/folder,
  non-HTTPS URL, each accepted/rejected format, sizes at 1 byte and 5,000,000
  bytes and above 5,000,000 bytes, declared-vs-actual metadata mismatch,
  malformed proof metadata,
  invalid paise totals, and immutable UPI snapshots.
- Transaction/concurrency tests: payment and bill transition commit together
  or neither; duplicate UTR claims; same-key identical retry; same-key
  different-payload rejection; concurrent distinct submissions; and new
  payment/UTR after rejection without overwriting history.
- Verification tests: owning landlord accept/reject, foreign landlord denied,
  each predefined rejection reason, explanation rejected for predefined
  reasons even when blank, trimmed `other` explanation required within
  10–500 characters, duplicate decision idempotency,
  due-versus-overdue restoration at the UTC date boundary, notification emitted
  once with the selected reason and explanation, and no fraud label.
- Cleanup tests: expired unused upload deletion, rejected proof deletion,
  exponential retry timing, exactly five failed attempts before terminal
  failure, preserved error history across manual retry, concurrent claims,
  already-absent asset handling, and verified proof never deleted.
- Rules tests: direct client payment create/update/delete denied for all roles;
  direct access to upload intents, UTR claims, and cleanup tasks denied; only
  existing tenant/owning-landlord payment reads allowed.
