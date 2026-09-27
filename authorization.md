# Rently 2.0 — Authorization Model (Phase 2, Frozen)

**Status:** Frozen for implementation
**Version:** 1.1
**Date:** 26 September 2026
**Depends on:** `schema.md` v1.3
**Precedes:** `cloud-functions.md`, `firestore.rules`

---

## 0. Governing principle

> Direct Firestore writes are only for isolated data changes whose validity can be fully enforced by Security Rules from a single document (plus simple `get()` ownership checks). Anything that changes **derived state** or requires **multiple documents to remain consistent** goes through a Cloud Function transaction instead. Security Rules for those operations only check "is this caller allowed to invoke this function" (via Auth custom claims / the function's own `context.auth` check) — they do not attempt to validate the write's business logic, because they can't see across documents atomically.

Every row below is classified 🟢 (direct client write, rules-enforced) or 🔒 (Cloud Function only, rules deny direct client writes to the affected fields/collection).

### 0.1 Field-allowlist convention (applies to every 🟢 "update" row below)

A 🟢 update permission never means "any field on this document." Every such row is enforced in `firestore.rules` with a field-diff allowlist — comparing `request.resource.data.diff(resource.data).affectedKeys()` against an explicit allowed set — so a client can't smuggle an unrelated field change into an otherwise-legitimate write (e.g. updating `currentBaseRent` while also silently changing `tenantId`). This applies to every 🟢 update row in §1–§8, not just the ones that call it out by name; where a section below says "update `X`," read that as "update `X` and *only* `X` (plus `updatedAt`), enforced by allowlist."

---

## 1. `users`

| Operation | Landlord | Tenant |
|---|---|---|
| Read own doc | 🟢 | 🟢 |
| Read another user's doc | — | — |
| Create own doc | 🔒 `completeOnboarding()` only | 🔒 `completeOnboarding()` only |
| Update own `fullName`/`phone`/`photoURL` | 🟢 (allowlisted, §0.1) | 🟢 (allowlisted, §0.1) |
| Update own `role` | — | — |
| Update own `activeLeaseId` | — | — |

**Document creation is 🔒, not 🟢 — this was a real gap in the previous version.** A client-writable `create` on `users` would let a new account write its own `role` before any custom claim exists to check it against, which is exactly the circularity problem this section exists to prevent. `completeOnboarding()` (cloud-functions.md) sets the Auth custom claim **and** creates the `users` document in the same Admin SDK operation — there is no window where a client-supplied `role` is ever trusted. Once created, `role` is permanently immutable (no rule path allows changing it — not even an allowlist, since it's excluded from the update allowlist entirely), and `activeLeaseId` is 🔒 as before, written only by `acceptJoinRequest()`/`endLease()` (§5).

---

## 2. `properties`

| Operation | Landlord | Tenant |
|---|---|---|
| Create | 🟢 (own `landlordId`) | — |
| Read (`get`, by ID) | 🟢 own | 🟢 only if a `joinRequests` or `leases` doc already links this tenant to the property (via `get()` cross-check) |
| Read (`list`/query) | 🟢 `where('landlordId','==', uid)` | — (see discovery note) |
| Update | 🟢 own, all fields except... | — |
| Update `joinCode` | 🔒 (regenerating a code is a `resolveJoinCode`-adjacent concern; kept simple by disallowing client rewrite for now — reconsider if a "regenerate code" feature is added) | — |
| Delete | — (never — use `status: 'archived'`) | — |

**Property discovery (before any relationship exists):** a tenant entering a join code has no `joinRequests`/`leases` doc yet, so no rule can key off one. This is why discovery is 🔒 `resolveJoinCode()` (§ cloud-functions.md) rather than a Firestore query — it also prevents a client from running `where('joinCode','==', code)` against the whole collection, which would require a `list`-permitting rule that leaks every property's existence to any authenticated user.

---

## 3. `units`

| Operation | Landlord | Tenant |
|---|---|---|
| Create | 🟢 (own `propertyId`, via `get()` ownership check on the parent property) | — |
| Read | 🟢 own (`where('landlordId','==', uid)`) | 🟢 only the unit referenced by their active lease (`get()` on `leases/{activeLeaseId}` to confirm `unitId` matches) |
| Update `roomNumber`, `baseRent` | 🟢 own | — |
| Update `currentLeaseId`, `status` | — | — |
| Delete | — | — |

`currentLeaseId`/`status` are 🔒 — written only by `acceptJoinRequest()` and `endLease()` (§5), same reasoning as `users.activeLeaseId`: a landlord hand-editing these would let unit state drift out of sync with the lease that's supposed to govern it.

---

## 4. `joinRequests`

| Operation | Landlord | Tenant |
|---|---|---|
| Create | — | 🔒 `createJoinRequest()` only |
| Read | 🟢 own-property (`where('landlordId','==', uid)`) | 🟢 own (`where('tenantId','==', uid)`) |
| Update `status` → `rejected` | 🟢 (own-property request only) | — |
| Update `status` → `accepted` | 🔒 (this is `acceptJoinRequest()`, not a direct status flip — see §5) | — |
| Update any other field | — | — |
| Delete | — | — |

**Creation is 🔒, not 🟢 — this was the other real gap flagged in review.** `joinRequests` requires `landlordId`, but `resolveJoinCode()` deliberately doesn't return it to the tenant (so a client can't enumerate landlord identities via the join-code flow). A direct client `create` would therefore have to either (a) trust a client-supplied `landlordId` — forgeable, letting a tenant misdirect a request to the wrong landlord — or (b) be impossible to write correctly at all. `createJoinRequest()` resolves this by deriving `landlordId` server-side from the `properties` document. Rejecting a request, by contrast, is a single isolated field change with no cross-document consequences and no derived data involved, so it correctly stays 🟢. Accepting one triggers a multi-document transaction, so it's 🔒, as before.

---

## 5. `leases`

| Operation | Landlord | Tenant |
|---|---|---|
| Create | 🔒 `acceptJoinRequest()` only | — |
| Read | 🟢 own-property | 🟢 own |
| Update `status`/`endDate`/`endReason`/`endedBy` | 🔒 `endLease()` only | — |
| Update `currentBaseRent` | 🟢 own-property lease, **only while `status == 'active'`** | — |
| Update any other field | — | — |
| Delete | — | — |

Both creation and termination are 🔒 because each must atomically touch `leases` + `units` + `users` (see the transaction steps in `cloud-functions.md`). `currentBaseRent` is the one field that's a genuinely isolated change — updating it doesn't need to touch any other document (per schema.md §5.1, it only affects *future* bills, which don't exist yet) — so it's safely 🟢.

---

## 6. `rentCharges`

| Operation | Landlord | Tenant |
|---|---|---|
| Create (`draft`) | 🟢 own-property lease | — |
| Update `lineItems`/`subtotal` while `status == 'draft'` | 🟢 own | — |
| Read | 🟢 own-property | 🟢 own |
| `draft` → `finalized` | 🔒 `finalizeRentCharge()` only | — |
| Update `lateFineTotal`/`total` (via fine) | 🔒 `applyManualFine()` / scheduled auto-fine job only | — |
| Update `adjustmentTotal`/`total` (via adjustment) | 🔒 `applyAdjustment()` only | — |
| `finalized/due/overdue` → `payment_pending` | 🔒 (side effect of `payments` create — see §7) | — |
| `payment_pending` → `paid`/`due`/`overdue` | 🔒 `verifyUpiPayment()` / `verifyGatewayPayment()` only | — |
| `due` → `overdue`, `finalized` → `due` | 🔒 scheduled job only | — |
| Delete | — | — |

### 6.1 Subcollection `fineApplications`

| Operation | Landlord | Tenant |
|---|---|---|
| Create, `ruleSource: 'manual'` | 🔒 `applyManualFine()` | — |
| Create, `ruleSource: 'configured'` | 🔒 scheduled job only | — |
| Read | 🟢 own-property (via parent) | 🟢 own (via parent) |

Both paths are 🔒, not just the automatic one — a manual fine still has to update `rentCharges.lateFineTotal`/`total` in the same transaction as creating the record (schema.md §6.2), so it has the identical multi-document problem as everything else in this section.

### 6.2 Subcollection `adjustments`

| Operation | Landlord | Tenant |
|---|---|---|
| Create | 🔒 `applyAdjustment()` only, and only when parent `rentCharges.status` ∈ `{finalized, due, overdue}` | — |
| Read | 🟢 own-property (via parent) | 🟢 own (via parent) |

---

## 7. `payments`

| Operation | Landlord | Tenant |
|---|---|---|
| Create | — | 🟢 own (`status` must be created as `pending_verification`; `verifiedAt`/`verifiedBy`/`rejectionReason` must be absent) |
| Read | 🟢 own-property | 🟢 own |
| Update `status` → `verified`/`rejected` (method `upi_qr`) | 🔒 `verifyUpiPayment()` only | — |
| Update `status` → `verified`/`failed` (method `gateway`) | — | 🔒 `verifyGatewayPayment()` only (server-initiated, no human actor) |
| Update any other field | — | — |
| Delete | — | — |

Payment *creation* is 🟢 because it's a single isolated document with no side effects yet — the side effect (flipping `rentCharges.status` to `payment_pending`) is handled inside the same client-triggered flow as a Cloud Function call (`createUpiPayment()`/`createGatewayPayment()`, see `cloud-functions.md`) rather than a raw Firestore write, precisely so that step is also transactional. Verification is 🔒 for the reason established earlier in this thread: it must atomically update both the `payments` doc and the parent `rentCharges` doc, and — critically — a client "success" report must never be trusted for gateway payments.

**Important Note regarding Cloudinary:** The payment document remains fully protected by this authorization model. The tenant must not be able to arbitrarily create or modify payment records outside the approved payment Cloud Function flow. Do not weaken the existing Firestore authorization model just because the image is stored externally in Cloudinary.

---

## 8. `expenses`

| Operation | Landlord | Tenant |
|---|---|---|
| Create / Read / Update (own-property) | 🟢 | — |
| Archive (`status → 'archived'`) | 🟢 | — |
| Hard delete | — | — |

No cross-document consequences, so still entirely 🟢 — but hard delete is removed and replaced with the same soft-delete pattern as `properties`/`leases`, so `expenses` no longer contradicts schema.md §0's "nothing is ever hard-deleted" rule (a real inconsistency flagged in review).

---

## 9. `notifications`

| Operation | Landlord | Tenant |
|---|---|---|
| Read own (`recipientId == uid`) | 🟢 | 🟢 |
| Mark own as read (`read: true` only) | 🟢 | 🟢 |
| Create | 🔒 (scheduled jobs and the relevant Cloud Functions only — see `cloud-functions.md`) | 🔒 |
| Update any field but `read` | — | — |
| Delete | — | — |

Neither role should ever be able to write a notification claiming to be "for" another user, so creation is fully server-side.

---

## 10. Cloud-Function-only operations (summary)

Pulled together from the sections above, for cross-reference against `cloud-functions.md`:

```
Callable (user-triggered):
  completeOnboarding()
  resolveJoinCode()
  createJoinRequest()
  acceptJoinRequest()
  endLease()
  finalizeRentCharge()
  applyManualFine()
  applyAdjustment()
  preparePaymentProofUpload() (authorizes Cloudinary upload)
  createUpiPayment()          (wraps payments.create + rentCharges → payment_pending)
  verifyUpiPayment()
  createGatewayPayment()
  verifyGatewayPayment()

Scheduled:
  send25thLandlordReminder()
  send1stTenantNotifications()
  updateOverdueCharges()          (finalized → due → overdue)
  applyConfiguredLateFines()      (ruleSource: 'configured')
```

---

## 11. Notes carried forward from design discussion

- `payment_pending` is a single status that must cover *both* payment methods — a gateway attempt in flight blocks adjustments exactly the same way a submitted UPI proof does (this generalization was confirmed during the adjustment-total discussion and applies here too).
- `cancelled` is deliberately **not** a `rentCharges` status yet — no confirmed product requirement (schema.md §12). If one emerges, it needs its own authorization row and function (`cancelRentCharge()`) designed before it's added anywhere.
- **RESOLVED:** a tenant's other `pending` join requests auto-reject the moment one is accepted, as part of `acceptJoinRequest()`'s transaction (schema.md §4, cloud-functions.md §3). No longer an open item.
- **RESOLVED:** `users` document creation and role assignment are both 🔒, handled atomically by `completeOnboarding()` (§1, cloud-functions.md §2) — this closes the role/custom-claim circularity (need a role to call a function that assigns a role) that existed in v1.0 of this document.

## 12. Changelog

**v1.1** (this revision, per architecture audit):
- `users` document creation changed from 🟢 to 🔒 (`completeOnboarding()`) — closes the role/custom-claim circularity (§1).
- `joinRequests` creation changed from 🟢 to 🔒 (`createJoinRequest()`) — a client-supplied `landlordId` would have been either forgeable or impossible to obtain correctly, since `resolveJoinCode()` deliberately withholds it (§4).
- Added §0.1, naming the field-diff allowlist convention explicitly and applying it to every 🟢 update row rather than leaving it implicit in `currentBaseRent`'s row alone.
- `expenses` hard delete replaced with soft-delete (`status: archived`), consistent with schema.md's "nothing hard-deleted" rule (§8).
- Resolved the two remaining open items from v1.0 (§11).

**v1.0**: initial frozen draft.
