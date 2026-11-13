# Rently 2.0 — Authorization Model (Phase 2, Frozen)

**Status:** Frozen for implementation
**Version:** 1.3 — approved UPI payment defaults
**Date:** 12 November 2026
**Depends on:** `schema.md` v1.5
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
| Create | 🟢 (own `landlordId`; valid required `upiId`, `upiQrImageUrl`, and `upiDisplayName`) | — |
| Read (`get`, by ID) | 🟢 own | 🟢 only if a `joinRequests` or `leases` doc already links this tenant to the property (via `get()` cross-check) |
| Read (`list`/query) | 🟢 `where('landlordId','==', uid)` | — (see discovery note) |
| Update | 🟢 own, allowed property fields; UPI configuration fields must be updated together and valid | — |
| Read UPI configuration | — | 🟢 through the existing linked-property read; read-only |
| Update `joinCode` | 🔒 (regenerating a code is a `resolveJoinCode`-adjacent concern; kept simple by disallowing client rewrite for now — reconsider if a "regenerate code" feature is added) | — |
| Delete | — (never — use `status: 'archived'`) | — |

**Property discovery (before any relationship exists):** a tenant entering a join code has no `joinRequests`/`leases` doc yet, so no rule can key off one. This is why discovery is 🔒 `resolveJoinCode()` (§ cloud-functions.md) rather than a Firestore query — it also prevents a client from running `where('joinCode','==', code)` against the whole collection, which would require a `list`-permitting rule that leaks every property's existence to any authenticated user.

Property UPI configuration is writable only by the owning landlord. New
properties require all three valid UPI fields. Existing properties without
these fields remain readable and may be updated in other allowed fields; the
owning landlord must configure all three together before tenants can use their
payment information.

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
| Update `lineItems`/`subtotal`/`total` while `status == 'draft'` | 🟢 own | — |
| Read | 🟢 own-property | 🟢 own |
| `draft` → `finalized` | 🔒 `finalizeRentCharge()` only | — |
| Update `lateFineTotal`/`total` (via fine) | 🔒 `applyManualFine()` / scheduled auto-fine job only | — |
| Update `adjustmentTotal`/`total` (via adjustment) | 🔒 `applyAdjustment()` only | — |
| `finalized/due/overdue` → `payment_pending` | 🔒 (side effect of `payments` create — see §7) | — |
| `payment_pending` → `paid`/`due`/`overdue` | 🔒 `verifyUpiPayment()` only | — |
| `due` → `overdue`, `finalized` → `due` | 🔒 scheduled job only | — |
| Delete | — | — |

Draft creation stores the billing-month due date (the 10th) and a provisional
`total` equal to `subtotal`. Drafts allow at most 10 line items; Rules validate
each item's exact shape, type, and integer-paise amount, the subtotal sum, and
the provisional total. Draft edits may update `lineItems`, `subtotal`, and
`total` together, but must still satisfy the same validation. Finalization
revalidates the line items server-side and writes the authoritative totals and
due date.

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
| Create UPI payment | 🔒 `createUpiPayment()` only | 🔒 `createUpiPayment()` only |
| Read | 🟢 own-property | 🟢 own |
| Update `status` → `verified`/`rejected` (method `upi_qr`) | 🔒 `verifyUpiPayment()` only, owning landlord | — |
| Update payment, proof, snapshots, or cleanup state | 🔒 backend only | 🔒 backend only |
| Delete | — | — |

Payment creation is 🔒 even though a payment document is involved, because
creating it must atomically consume a single-use upload intent, claim the UTR,
and transition the bill to `payment_pending`. Firestore Rules deny direct
client create, update, and delete for every role. The owning landlord's
verification or rejection is performed by `verifyUpiPayment()` in a
transaction; clients cannot directly set payment or bill state.

`verifyUpiPayment()` requires an authenticated landlord whose UID is the
payment's `landlordId`. Before either decision, it must independently verify
that `payment.rentChargeId` identifies the linked rent charge, the payment's
tenant and landlord IDs match that bill, and the rent charge references the
same tenant, landlord, lease, property, and unit as the payment. The lease
must reference the same tenant, landlord, property, and unit; the property
must belong to that landlord; and the unit must belong to that property and
landlord with its `currentLeaseId` and status consistent with the linked
lease under schema.md §§3 and 5 (ending a lease clears its `currentLeaseId`).
Mismatched or missing linked records are rejected. Payment IDs copied
into denormalized fields are not sufficient evidence of ownership.

`paymentUploadIntents`, `rentCharges/{id}/upiReferences`, and
`paymentProofCleanupOutbox` are server-only. The tenant receives a scoped
10-minute upload token only after `preparePaymentProofUpload()` authorizes an
eligible bill and validates the declared format and size against JPG, JPEG,
PNG, or WebP and 5 MB (5,000,000 bytes). A server-mediated upload endpoint
must enforce the token expiry before forwarding the upload to Cloudinary; the
Cloudinary API secret and direct Cloudinary signature are never exposed to
Flutter. The persisted intent expires after 15 minutes, independently of the
upload token, and cannot be consumed after expiry. Cloudinary upload success
does not create a payment or mark a bill paid. No cleanup task may delete
proof referenced by a verified payment.

`createUpiPayment()` requires a trimmed 6–30 character ASCII alphanumeric UTR;
the trimmed submitted value is stored and its uppercase form is used for
per-bill uniqueness. Only the owning landlord may approve or reject a payment
through `verifyUpiPayment()`, using one of the frozen rejection reason codes.
For the six predefined reasons, `rejectionExplanation` must be absent and a
supplied value, including a blank string, is rejected. The `other` reason
requires a trimmed 10–500 character explanation, which alone is retained and
shown with the selected reason to the tenant. A rejection alone must not
assign or imply a fraud label.

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

### Device tokens and delivery outbox

`users/{uid}/deviceTokens/{tokenHash}` and
`notificationDeliveries/{notificationId}` (including its `devices` subcollection)
are server-only. Clients register or unregister only their own FCM token through
authenticated `registerDeviceToken()` / `unregisterDeviceToken()` callables;
Rules deny direct reads and writes to token and delivery records. Scheduled and
delivery functions use Admin SDK transactions and writes.

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
  preparePaymentProofUpload() (creates tenant/bill-scoped upload intent)
  createUpiPayment()          (consumes intent + claims UTR + bill → payment_pending)
  verifyUpiPayment()          (owning landlord accepts/rejects)

Scheduled:
  send25thLandlordReminder()
  send1stTenantNotifications()
  updateOverdueCharges()          (finalized → due → overdue)
  applyConfiguredLateFines()      (ruleSource: 'configured')
  recoverPaymentProofCleanup()    (rejected/expired proof cleanup)
```

---

## 11. Notes carried forward from design discussion

- `payment_pending` is the UPI state for a submitted proof awaiting landlord
  review. UPI submission and owning-landlord approval/rejection are in scope
  through the callable contracts. Gateway payment integration, gateway
  verification, webhooks, and automated reconciliation remain deferred to
  provider selection.
- `cancelled` is deliberately **not** a `rentCharges` status yet — no confirmed product requirement (schema.md §12). If one emerges, it needs its own authorization row and function (`cancelRentCharge()`) designed before it's added anywhere.
- **RESOLVED:** a tenant's other `pending` join requests auto-reject the moment one is accepted, as part of `acceptJoinRequest()`'s transaction (schema.md §4, cloud-functions.md §3). No longer an open item.
- **RESOLVED:** `users` document creation and role assignment are both 🔒, handled atomically by `completeOnboarding()` (§1, cloud-functions.md §2) — this closes the role/custom-claim circularity (need a role to call a function that assigns a role) that existed in v1.0 of this document.

## 12. Changelog

**v1.3** (approved UPI payment defaults):
- Added upload format/size limits and independent 10-minute upload-permission and 15-minute intent expiries.
- Added UTR format/length validation, reason-coded landlord rejection, and the required explanation and tenant-notification behavior for `other`.
- Documented that rejected payments do not imply fraud and specified five-attempt cleanup behavior in schema.md.

**v1.2** (UPI payment submission contract):
- Changed payment creation from client-writable to callable-only; Rules deny all direct client payment writes.
- Added server-only authorization for upload intents, per-bill UTR claims, and proof-cleanup outbox tasks.
- Limited the active payment contract to UPI and the owning landlord's callable verification/rejection.

**v1.1** (this revision, per architecture audit):
- `users` document creation changed from 🟢 to 🔒 (`completeOnboarding()`) — closes the role/custom-claim circularity (§1).
- `joinRequests` creation changed from 🟢 to 🔒 (`createJoinRequest()`) — a client-supplied `landlordId` would have been either forgeable or impossible to obtain correctly, since `resolveJoinCode()` deliberately withholds it (§4).
- Added §0.1, naming the field-diff allowlist convention explicitly and applying it to every 🟢 update row rather than leaving it implicit in `currentBaseRent`'s row alone.
- `expenses` hard delete replaced with soft-delete (`status: archived`), consistent with schema.md's "nothing hard-deleted" rule (§8).
- Resolved the two remaining open items from v1.0 (§11).

**v1.0**: initial frozen draft.
