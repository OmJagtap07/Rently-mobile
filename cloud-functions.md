# Rently 2.0 — Cloud Function Contracts (Phase 2, Frozen)

**Status:** Frozen for implementation
**Version:** 1.1
**Date:** 26 September 2026
**Depends on:** `schema.md` v1.3, `authorization.md` v1.1
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
- `subtotal` recomputed server-side from `lineItems` and must match the stored `subtotal` (catches any client-side arithmetic drift before it becomes historical fact).
- No other `rentCharges` doc already exists for this `leaseId` + `billingMonth` — the composite ID (schema.md §6) makes this a single existence check, not a query.

**Transaction steps:**
1. `rentCharges/{id}.status = 'finalized'`, `finalizedAt = now`, `finalizedBy = caller.uid`, `dueDate = 10th of billingMonth`, `total = subtotal` (fines/adjustments are zero at this point).

**Result:** `{ rentChargeId: string, dueDate: string, total: number }`

**Errors:** `failed-precondition` (not draft, lease not active, or subtotal mismatch), `already-exists` (shouldn't be reachable given the composite ID, but checked defensively), `not-found`, `permission-denied`.

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
1. Create `rentCharges/{id}/adjustments/{newAdjustmentId}`: `type: 'correction'`, `amount`, `reason`, `idempotencyKey`, `createdBy = caller.uid`.
2. `rentCharges/{id}.adjustmentTotal += amount`, `total += amount`.

**Result:** `{ adjustmentId: string, newAdjustmentTotal: number, newTotal: number }`

**Errors:** `failed-precondition` (status not in the allowed set — the error message should distinguish "payment pending" from "already paid" so the landlord UI can explain *why*, per design.md's "don't hide financial info" rule), `already-exists` (duplicate `idempotencyKey` — returns the original adjustment's result rather than erroring, same retry-safety pattern as `applyManualFine()`), `invalid-argument`, `not-found`, `permission-denied`.

**Idempotency:** via `idempotencyKey`, as above — this function's contract was already correct in v1.0; `applyManualFine()` has now been brought in line with it.

---

## 9. `preparePaymentProofUpload`

**Trigger:** callable
**Auth:** `role == 'tenant'`, caller's `uid == rentCharges.tenantId`.

**Input:**
```ts
{ rentChargeId: string }
```

**Validation:**
- `rentCharges/{id}` exists, `status ∈ {finalized, due, overdue}`, `tenantId == caller.uid`.

**Transaction steps:**
1. Cloud Function authenticates the caller and validates the tenant, lease, and rent charge states.
2. Cloud Function generates a short-lived Cloudinary signed-upload authorization using the Cloudinary API secret. (The Cloudinary API secret must NEVER be sent to Flutter).
3. The function returns only the required upload parameters to Flutter.

**Result:**
```ts
{ 
  cloudName: string, 
  apiKey: string, 
  timestamp: number, 
  signature: string, 
  resourceType: string, 
  publicId?: string, 
  folder?: string 
}
```

**Restrictions:** Payment proofs must be image resources only (JPEG/JPG, PNG, WebP), limited in size, uploaded into a Rently-specific Cloudinary folder/prefix, and associated with the intended payment/rent charge.

**Errors:** `failed-precondition` (bill not in a payable state), `not-found`, `permission-denied`.

**Idempotency:** safe to retry. Generates a new short-lived signature.

---

## 10. `createUpiPayment`

**Trigger:** callable
**Auth:** `role == 'tenant'`, caller's `uid == rentCharges.tenantId`.

**Input:**
```ts
{ 
  rentChargeId: string, 
  proof: { provider: 'cloudinary', publicId: string, secureUrl: string, resourceType: string, uploadedAt: any }, 
  transactionRef?: string 
}
```

**Validation:**
- `rentCharges/{id}` exists, `status ∈ {finalized, due, overdue}`, `tenantId == caller.uid`.
- `proof` object is provided and contains Cloudinary metadata.

**Transaction steps:**
1. Create `payments/{newPaymentId}`: `rentChargeId`, denormalized `leaseId`/`tenantId`/`landlordId`/`propertyId`/`unitId`, `method: 'upi_qr'`, `amountDue = rentCharges.total`, `gatewayFee: 0`, `totalPaid = amountDue`, `status: 'pending_verification'`, `proof`, `transactionRef`, `submittedAt = now`.
2. `rentCharges/{id}.status = 'payment_pending'`.

**Result:** `{ paymentId: string }`

**Errors:** `failed-precondition` (bill not in a payable state — already `payment_pending` or `paid`), `not-found`, `permission-denied`.

**Idempotency:** a bill already at `payment_pending` fails fast rather than creating a second competing payment for the same charge.

---

## 11. `verifyUpiPayment`

**Trigger:** callable
**Auth:** `role == 'landlord'`, caller's `uid == payments.landlordId`.

**Input:**
```ts
{ paymentId: string, decision: 'accept' | 'reject', rejectionReason?: string }
```

**Validation:**
- `payments/{id}` exists, `method == 'upi_qr'`, `status == 'pending_verification'`, `landlordId == caller.uid`.
- If `decision == 'reject'`, `rejectionReason` required.

**Transaction steps (accept):**
1. `payments/{id}.status = 'verified'`, `verifiedAt = now`, `verifiedBy = caller.uid`.
2. `rentCharges/{payments.rentChargeId}.status = 'paid'`, `paidAt = now`.

**Transaction steps (reject):**
1. `payments/{id}.status = 'rejected'`, `verifiedAt = now`, `verifiedBy = caller.uid`, `rejectionReason`.
2. `rentCharges/{payments.rentChargeId}.status` reverts to `due` or `overdue` — whichever it would naturally be given `dueDate` vs. today's date, recomputed at this moment (not just "whatever it was before `payment_pending`," in case time passed while the proof sat in review).

**Result:** `{ paymentId: string, decision: string, rentChargeStatus: string }`

**Errors:** `failed-precondition` (wrong method or already resolved), `invalid-argument` (missing rejection reason), `not-found`, `permission-denied`.

**Idempotency:** safe — a payment no longer `pending_verification` fails fast on retry.

---

## 12. `createGatewayPayment`

**Trigger:** callable
**Auth:** `role == 'tenant'`, caller's `uid == rentCharges.tenantId`.

**Input:**
```ts
{ rentChargeId: string }
```

**Validation:**
- `rentCharges/{id}` exists, `status ∈ {finalized, due, overdue}`, `tenantId == caller.uid`.
- **Provider integration itself is out of scope until Phase 7 / provider selection (PRD §20)** — this contract defines the Firestore-side shape only; the actual `gatewayFee` calculation and provider order/session creation are provider-specific and deliberately left unspecified here.

**Transaction steps:**
1. Create `payments/{newPaymentId}`: `method: 'gateway'`, `amountDue = rentCharges.total`, `gatewayFee` (from provider, TBD), `totalPaid = amountDue + gatewayFee`, `status: 'pending_verification'`, `submittedAt = now`.
2. `rentCharges/{id}.status = 'payment_pending'`.
3. Return whatever session/order identifier the (TBD) provider requires the client to continue the payment flow.

**Result:** `{ paymentId: string, providerSessionData: object /* shape TBD per provider */ }`

**Errors:** same pattern as `createUpiPayment`.

**Idempotency:** same pattern as `createUpiPayment`.

**Status:** placeholder contract — do not implement against a specific provider until Phase 7 explicitly selects one.

---

## 13. `verifyGatewayPayment`

**Trigger:** **HTTPS webhook**, not a callable — invoked by the payment provider's server, not the Rently client. Authenticated via the provider's webhook signature verification, **not** Firebase Auth (`context.auth` will be absent; do not check it).

**Input:** provider-specific webhook payload (shape TBD per provider, Phase 7).

**Validation:**
- Verify the webhook signature against the provider's secret before trusting any payload content — this is the entire point of this function existing separately from a client call (architecture.md §11: a client "success" report is never sufficient).
- Resolve the corresponding `payments` doc via the provider's transaction/order reference stored in `transactionRef`.

**Transaction steps:** identical shape to `verifyUpiPayment`'s accept path, driven by the provider's reported outcome instead of a landlord tap: `payments.status = 'verified' | 'failed'`, and on success `rentCharges.status = 'paid'`, `paidAt = now`.

**Result:** HTTP 200 acknowledgment to the provider (providers typically retry on non-200).

**Errors:** signature verification failure → reject the webhook (do not process); unknown `transactionRef` → log and reject.

**Idempotency:** webhook providers commonly retry — the function must check `payments.status` before applying the transition, so a duplicate webhook delivery for an already-`verified` payment is a no-op, not a double-write.

**Status:** placeholder contract, same caveat as `createGatewayPayment`.

---

## 14. Scheduled functions

### `send25thLandlordReminder`
**Trigger:** scheduled, monthly on the 25th.
**Logic:** for every `leases` with `status == 'active'`, create a `notifications` doc for the landlord (`type: 'prepare_bill_reminder'`). No Firestore writes outside `notifications` — this never touches `rentCharges` (architecture.md §8: no bill is auto-generated here).
**Idempotency:** guard against double-firing (e.g. a retried Cloud Scheduler invocation) by keying the notification's existence check on `recipientId + type + billingMonth` before creating a duplicate.

### `send1stTenantNotifications`
**Trigger:** scheduled, monthly on the 1st.
**Logic:** for every `rentCharges` with `status == 'finalized'` and `billingMonth` == the current month, transition `status → 'due'` and create a `notifications` doc for the tenant (`type: 'rent_due'`).
**Idempotency:** same pattern — check `rentCharges.status` before transitioning; a re-run skips anything no longer `finalized`.

### `updateOverdueCharges`
**Trigger:** scheduled, daily.
**Logic:** for every `rentCharges` with `status == 'due'` and `dueDate < today`, transition `status → 'overdue'`, create a `notifications` doc for the landlord (`type: 'overdue_rent'`).
**Idempotency:** skips anything already `overdue`.

### `applyConfiguredLateFines`
**Trigger:** scheduled, daily.
**Logic:** for every `rentCharges` with `status == 'overdue'`, check the applicable `lateFineConfig` (lease override → else property default) against `fineApplications` already recorded (`ruleSource: 'configured'`): if `sequenceNumber` count `< maxRepetitions` and `repeatIntervalDays` have elapsed since the last configured fine (or `startAfterDays` since `dueDate` for the first), apply one — same transaction shape as `applyManualFine()` but `appliedBy: 'system'`, `ruleSource: 'configured'`. Create a `notifications` doc for the tenant (`type: 'late_fine_update'`).
**Idempotency:** the `sequenceNumber`/count check against `maxRepetitions` is itself the guard — a re-run on the same day that already applied today's fine sees the interval hasn't elapsed again and skips.

---

## 15. Summary table

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
| createUpiPayment | callable | tenant |
| verifyUpiPayment | callable | landlord |
| createGatewayPayment | callable | tenant |
| verifyGatewayPayment | webhook | provider |
| send25thLandlordReminder | scheduled | — |
| send1stTenantNotifications | scheduled | — |
| updateOverdueCharges | scheduled | — |
| applyConfiguredLateFines | scheduled | — |

## 16. Open items carried into implementation

Two of the three items from v1.0 are now resolved:

1. ~~Auto-reject of a tenant's other pending `joinRequests` on acceptance~~ — **RESOLVED**, see `acceptJoinRequest()` §4 step 5.
2. ~~`applyManualFine`/`applyAdjustment` idempotency contract~~ — **RESOLVED**, both now require `idempotencyKey` in their input contracts (§7, §8). The client-side UUID generation convention (which library, where it's called from) still needs to be agreed with whoever builds the Flutter forms — a minor implementation detail, not an open design question.
3. Gateway contracts (§12, §13) remain placeholders pending provider selection — correctly still open per PRD §20, do not implement early.

No design-level open items remain. Item 3 is an intentional scope deferral, not an oversight.
