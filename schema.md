# Rently 2.0 — Firestore Schema (Phase 1, Frozen)

**Status:** Frozen for implementation
**Version:** 1.3 — revised per architecture audit (see changelog, §12)
**Date:** 26 September 2026
**Scope:** New Firebase project. Does not migrate the existing `transactions`/`tenants` collections from the current web app (see Phase 0 audit — those collections lack the relational structure needed here).

---

## 0. Conventions

- All documents include `createdAt` (server timestamp, immutable) and `updatedAt` (server timestamp, set on every write).
- All IDs referencing another document are named `<entity>Id` and store the referenced document's ID as a plain string (Firestore does not enforce foreign keys — Security Rules and app logic must).
- Denormalized fields (e.g. `landlordId` copied onto a `unit` doc) exist specifically so Security Rules can check ownership without a second read. They are written once at creation and are **not** kept in sync if the source ever changes (source docs like property ownership are not expected to change hands).
- Money fields are stored as **integers in paise** (₹1 = 100), never floats, to avoid rounding errors. UI divides by 100 for display.
- Dates that represent a calendar day only (e.g. `billingMonth`) are stored as strings, not Timestamps, to avoid timezone drift. Everything else is a Firestore `Timestamp`.
- Nothing in this schema is ever hard-deleted by the app. "Ended" / "archived" / "rejected" are status values, not deletions.

---

## 1. `users`

**Document ID:** Firebase Auth `uid`

| Field | Type | Required | Notes |
|---|---|---|---|
| uid | string | yes | duplicate of doc ID, for query convenience |
| role | string enum: `landlord` \| `tenant` | yes | set once at onboarding, not switchable |
| fullName | string | yes | |
| phone | string | yes | |
| email | string | yes | from Auth |
| photoURL | string | no | |
| onboardingCompleted | boolean | yes | |
| activeLeaseId | string (ref → leases) | no | **tenant only**, denormalized for fast "my current lease" lookups |
| createdAt / updatedAt | Timestamp | yes | |

> **Not stored here:** joining date. It lives only on `leases.joiningDate` — the tenant UI reads it via `activeLeaseId` rather than a duplicated field on `users`. A field only gets duplicated here if a concrete query need shows up that can't be served by the lease lookup (none identified so far).

**Relationships:** `activeLeaseId` → `leases`. A landlord's owned properties are found by querying `properties where landlordId == uid`, not stored on the user doc (avoids an unbounded array).

---

## 2. `properties`

**Document ID:** auto-generated

| Field | Type | Required | Notes |
|---|---|---|---|
| landlordId | string (ref → users) | yes | owner |
| name | string | yes | |
| address | string | yes | |
| googleMapsLink | string | no | |
| joinCode | string | yes | unique, tenant-facing code used to find/apply to this property |
| status | enum: `active` \| `archived` | yes | soft-delete only |
| lateFineConfig | map, see §6 | no | property-level default; a lease may override |
| createdAt / updatedAt | Timestamp | yes | |

**Relationships:** `units`, `joinRequests`, `leases`, `expenses` all reference `propertyId`.

---

## 3. `units`

**Document ID:** auto-generated

| Field | Type | Required | Notes |
|---|---|---|---|
| propertyId | string (ref → properties) | yes | |
| landlordId | string | yes | denormalized from property, for Security Rules |
| roomNumber | string | yes | e.g. `"302"` — string, not number, so formats like `"3A"` stay valid |
| baseRent | integer (paise) | yes | current default rent for this unit; used to prefill new `rentCharges`, does **not** retroactively change past charges |
| status | enum: `vacant` \| `occupied` | yes | derived/maintained on lease create/end |
| currentLeaseId | string (ref → leases) | no | null when vacant |
| createdAt / updatedAt | Timestamp | yes | |

---

## 4. `joinRequests`

**Document ID:** auto-generated

| Field | Type | Required | Notes |
|---|---|---|---|
| tenantId | string (ref → users) | yes | |
| propertyId | string (ref → properties) | yes | |
| landlordId | string | yes | denormalized |
| status | enum: `pending` \| `accepted` \| `rejected` | yes | |
| message | string | no | optional note from tenant |
| requestedAt | Timestamp | yes | |
| respondedAt | Timestamp | no | |
| respondedBy | string (ref → users, landlordId) | no | absent for auto-rejected requests (see `autoRejected` below) |
| autoRejected | boolean | no | `true` if this request was rejected automatically because the tenant's *other* request was accepted first (see `acceptJoinRequest()` in cloud-functions.md), as opposed to a landlord explicitly declining it. Defaults to `false`/absent. |

**Not stored here:** room/unit assignment. Assignment happens as a separate step (creating the `leases` doc) after acceptance — per architecture.md §5, acceptance and room assignment are distinct actions.

**RESOLVED:** a tenant may hold multiple `pending` requests across different properties simultaneously. The moment any one is accepted, `acceptJoinRequest()` automatically rejects the tenant's other pending requests in the same transaction (`autoRejected: true`) — a tenant with an `activeLeaseId` set shouldn't leave stale applications sitting in other landlords' inboxes. `createJoinRequest()` also refuses new requests once `activeLeaseId != null`.

---

## 5. `leases`

**Document ID:** auto-generated

| Field | Type | Required | Notes |
|---|---|---|---|
| tenantId | string (ref → users) | yes | |
| landlordId | string | yes | denormalized |
| propertyId | string (ref → properties) | yes | |
| unitId | string (ref → units) | yes | |
| joiningDate | string `YYYY-MM-DD` | yes | landlord-set, tenant-read-only |
| currentBaseRent | integer (paise) | yes | can be updated by landlord for **future** billing months only; never rewrites past `rentCharges` |
| status | enum: `active` \| `ended` | yes | |
| endDate | string `YYYY-MM-DD` | no | set when ended |
| endReason | string | no | optional |
| endedBy | string (ref → users) | no | |
| createdAt / updatedAt | Timestamp | yes | |

**Historical-record rule:** ending a lease sets `status: 'ended'` and `endDate`; the document is never deleted. `units.currentLeaseId` is cleared and `units.status` set to `vacant` in the same write (batch/transaction).

### 5.1 Rent value hierarchy (authoritative order)

Three fields relate to "rent." They are **not** three independent values — each is authoritative for a different purpose, and each only flows *forward* to prefill the next, never backward to rewrite it:

```
units.baseRent            →  default only, used to prefill a NEW lease's currentBaseRent
        │                     (changing it never touches existing leases)
        ▼
leases.currentBaseRent    →  this tenant's present-day rent, used to prefill the NEXT
        │                     draft rentCharge
        ▼                     (changing it never touches past or already-drafted rentCharges)
        ▼
rentCharges.lineItems[rent] → the immutable historical amount actually billed for that
                               month, once finalized
```

If a landlord raises the rent mid-tenancy: update `leases.currentBaseRent` only. Every already-created `rentCharge` (draft or finalized) keeps its original amount; only bills created *after* the change pick up the new figure.

---

## 6. `rentCharges` (monthly bills)

**Document ID:** composite — **`${leaseId}_${billingMonth}`** (e.g. `abc123_2026-11`)
Using a deterministic ID instead of an auto-ID prevents a landlord from accidentally creating two bills for the same lease/month — the write is naturally idempotent.

| Field | Type | Required | Notes |
|---|---|---|---|
| leaseId | string (ref → leases) | yes | |
| tenantId, landlordId, propertyId, unitId | string | yes | denormalized from the lease at creation time |
| billingMonth | string `YYYY-MM` | yes | duplicate of the ID's month part, for querying |
| lineItems | array of `{ type, label, amount }` | yes | `type` ∈ `rent`\|`electricity`\|`maintenance`\|`other`; `amount` in paise. Multiple `other` entries allowed. |
| subtotal | integer (paise) | yes | sum of `lineItems` at finalize time. **Immutable once finalized** — this is the original bill, never touched by fines or adjustments. |
| lateFineTotal | integer (paise) | yes | sum of applied fines (see §6.2); defaults to 0; updated only by `applyManualFine()` / the scheduled auto-fine job |
| adjustmentTotal | integer (paise) | yes | sum of applied adjustments, can be negative (see §6.3); defaults to 0; updated only by `applyAdjustment()` |
| total | integer (paise) | yes | **`subtotal + lateFineTotal + adjustmentTotal`** — the current amount payable. Recomputed transactionally by whichever function (`applyManualFine()`, the auto-fine job, or `applyAdjustment()`) touches `lateFineTotal` or `adjustmentTotal`; never written directly by a client. |
| status | enum: `draft` \| `finalized` \| `due` \| `overdue` \| `payment_pending` \| `paid` | yes | see transition table below |
| dueDate | string `YYYY-MM-DD` | yes | precomputed on the draft as the 10th of the billing month; revalidated and written again at finalization (per PRD §9) |
| finalizedAt / finalizedBy | Timestamp / string | no | set once, then immutable |
| paidAt | Timestamp | no | |
| createdAt / updatedAt | Timestamp | yes | |

### 6.1 Bill status transitions

```
draft ──finalize──▶ finalized ──(dueDate reached)──▶ due ──(unpaid past dueDate)──▶ overdue
                                                        │                              │
                                                        └──(payment submitted)─────────┘
                                                                  ▼
                                                          payment_pending
                                                                  ▼
                                                     (landlord accepts proof, or
                                                      gateway server-verifies)
                                                                  ▼
                                                                paid
```

- `draft` → `finalized`: 🔒 `finalizeRentCharge()` only — not a direct field edit. The function validates lease is active, landlord owns it, billing month is valid, `subtotal` matches `lineItems`, and no charge already exists for that lease/month (the composite ID makes this last check nearly free) before locking `lineItems`/`subtotal`.
- `finalized`/`due`/`overdue` → `lineItems`/`subtotal` are permanently locked. `lateFineTotal`/`adjustmentTotal`/`total` can still move, but only via 🔒 `applyManualFine()` / the scheduled auto-fine job / `applyAdjustment()` — never a direct field write. This satisfies the "no silent rewrite of finalized bills" rule while still allowing the *current amount due* to change.
- **`applyAdjustment()` is only callable while status is `finalized`, `due`, or `overdue`.** It is blocked once a bill reaches `payment_pending` (a payment attempt — UPI proof submitted, or a gateway attempt initiated — represents a claim against a specific total, which must not shift underneath it) and blocked at `paid` (use a future refund/credit mechanism instead, never rewrite a paid bill's history). `draft` doesn't need adjustments — just edit the draft directly.
- `due` → `overdue` and `finalized` → `due`: transitioned by scheduled backend job (Phase 10), not the client.
- `payment_pending` → `paid` or back to `overdue`/`due` (on rejection) is driven by 🔒 `verifyUpiPayment()` / `verifyGatewayPayment()` (§7), not set directly by the client.

### 6.2 Subcollection: `rentCharges/{id}/fineApplications/{fineId}`

| Field | Type | Notes |
|---|---|---|
| amount | integer (paise) | |
| sequenceNumber | integer | 1st, 2nd, 3rd repetition, etc. |
| ruleSource | enum: `manual` \| `configured` | manual one-off vs. the property/lease's `lateFineConfig` |
| reason | string | required if `manual` |
| appliedAt | Timestamp | |
| appliedBy | string: landlordId or `"system"` | scheduled job applies configured repeats |
| idempotencyKey | string | **required for `ruleSource: 'manual'`** (client-generated UUID, checked for uniqueness by `applyManualFine()` before creating); absent/not applicable for `ruleSource: 'configured'`, which has its own natural idempotency guard (the `maxRepetitions`/interval check itself) |

`lateFineConfig` shape (stored on `properties` and optionally overridden per-lease):
```
{
  type: 'fixed' | 'percentage',
  amount: integer,          // paise, or basis points if percentage
  startAfterDays: integer,  // days after dueDate before first fine
  repeatIntervalDays: integer,
  maxRepetitions: integer
}
```
**Flagged (per PRD §20 / architecture.md §10):** the exact repeat semantics (e.g. does hitting `maxRepetitions` stop further fines entirely, or cap the *count* while the bill stays overdue indefinitely?) are explicitly left open in the source docs and must be confirmed before Phase 6 implementation — this schema stores what's needed for either interpretation but doesn't decide it.

### 6.3 Subcollection: `rentCharges/{id}/adjustments/{adjustmentId}`

For corrections to a finalized bill (architecture.md §10, design.md §10). Never mutates `lineItems`/`subtotal` — the original bill stays intact for audit purposes; corrections layer on top via `adjustmentTotal`.

| Field | Type | Notes |
|---|---|---|
| type | enum: `correction` | |
| amount | integer (paise) | can be negative |
| reason | string | required |
| createdBy | string (ref → users) | landlord only |
| idempotencyKey | string | required, client-generated UUID, checked for uniqueness by `applyAdjustment()` before creating |
| createdAt | Timestamp | |

**Write path:** 🔒 `applyAdjustment()` only — a single transaction creates this document **and** updates `rentCharges.adjustmentTotal` + `rentCharges.total` on the parent. Never a direct client `create` on this subcollection, for the same reason `fineApplications` isn't: an adjustment record with no corresponding rollup update would make the bill's displayed total silently wrong. Allowed only when the parent bill's `status` is `finalized`, `due`, or `overdue` — see §6.1.

**Example:**
```
subtotal            ₹11,750   (rent + electricity + maintenance, immutable)
lateFineTotal          ₹500
adjustmentTotal        -₹150   (electricity correction)
─────────────────────────
total               ₹12,100   ← current amount payable
```

---

## 7. `payments`

**Document ID:** auto-generated

| Field | Type | Required | Notes |
|---|---|---|---|
| rentChargeId | string (ref → rentCharges) | yes | |
| leaseId, tenantId, landlordId, propertyId, unitId | string | yes | denormalized |
| method | enum: `gateway` \| `upi_qr` | yes | |
| amountDue | integer (paise) | yes | the rent-charge amount owed, excluding any gateway fee — always equals the `rentCharges.total` at time of payment |
| gatewayFee | integer (paise) | yes | **0 for `upi_qr`**, provider fee for `gateway`; shown to tenant before confirmation per design.md §7 |
| totalPaid | integer (paise) | yes | `amountDue + gatewayFee` — the actual amount that left the tenant's account. Stored explicitly (not left to be re-derived) so reports never need to reconstruct it. |
| status | enum: `pending_verification` \| `verified` \| `rejected` \| `failed` | yes | |
| proof | map | no | **UPI only** — Cloudinary reference: `{ provider: "cloudinary", publicId: "...", secureUrl: "...", resourceType: "image", uploadedAt: Timestamp }` |
| transactionRef | string | no | gateway transaction ID or UPI reference number |
| submittedAt | Timestamp | yes | |
| verifiedAt | Timestamp | no | |
| verifiedBy | string (ref → users) | no | landlord for UPI; `"system"` for gateway server-side verification |
| rejectionReason | string | no | required if `status == rejected` |
| createdAt / updatedAt | Timestamp | yes | |

**Critical rule (architecture.md §11):** `status: 'verified'` must never be set from a client-reported "success" alone.
- UPI path: only a landlord action (`verifiedBy` = a landlord UID) can set `verified`.
- Gateway path: only a backend function that has confirmed with the provider can set `verified`.
A Security Rule should reject any client write that sets `status: 'verified'` directly.

**Side effect:** a `payments` doc reaching `verified` is what flips the linked `rentCharges.status` to `paid` (via backend function/transaction) — the two documents are never updated inconsistently.

---

## 8. `expenses`

**Document ID:** auto-generated

| Field | Type | Required | Notes |
|---|---|---|---|
| propertyId | string (ref → properties) | yes | |
| landlordId | string | yes | denormalized |
| category | string | yes | e.g. `repair`, `staff`, `utility` |
| description | string | no | |
| amount | integer (paise) | yes | |
| date | string `YYYY-MM-DD` | yes | |
| status | enum: `active` \| `archived` | yes | soft-delete, consistent with §0's "nothing is ever hard-deleted" rule and matching the pattern already used by `properties`/`leases` |
| createdAt / updatedAt | Timestamp | yes | |

Kept deliberately simple/flat otherwise — nothing in the source docs asks for anything more structured here.

---

## 9. `notifications`

**Document ID:** auto-generated

| Field | Type | Required | Notes |
|---|---|---|---|
| recipientId | string (ref → users) | yes | |
| role | enum: `landlord` \| `tenant` | yes | denormalized, for query convenience |
| type | string enum, see below | yes | |
| relatedEntity | map `{ type, id }` | no | e.g. `{type: 'rentCharge', id: '...'}` for deep-linking |
| title | string | yes | |
| body | string | yes | |
| read | boolean | yes | default `false` |
| createdAt | Timestamp | yes | |
| scheduledFor | Timestamp | no | for reminders generated ahead of send time |

`type` values (from PRD §16 / design.md §14):
`prepare_bill_reminder`, `payment_proof_submitted`, `overdue_rent`, `rent_due`, `payment_accepted`, `payment_rejected`, `late_fine_update`.

All rows are written by scheduled backend functions or by the accept/reject/submit actions server-side — never directly by a client claiming "notify this user."

---

## 10. Cross-cutting relationships (summary)

```
users (landlord) ──1:N── properties ──1:N── units ──1:1(current)── leases ──N:1── users (tenant)
                                                                       │
                                                                       ├──1:N── rentCharges ──1:N── payments
                                                                       │              └──subcol── fineApplications, adjustments
                                                                       │
properties ──1:N── joinRequests ──N:1── users (tenant)
properties ──1:N── expenses
users ──1:N── notifications
```

---

## 11. Decisions (resolved) and remaining open item

Three of the four items originally flagged here are now resolved:

1. **Late-fine repeat semantics** — RESOLVED. `maxRepetitions = N` means the configured fine is auto-applied at most `N` times for that bill. After the `N`th application, no further automatic fine is added even if the bill remains unpaid (the landlord can still apply a `manual` fine separately, per §6.2's `ruleSource` field). `fineApplications.sequenceNumber` is what the scheduled job checks against `maxRepetitions` before applying another.

2. **Multiple pending join requests / one active lease per tenant** — RESOLVED. A tenant may hold several `joinRequests` with `status: 'pending'` across different properties simultaneously. Once any one is accepted and a `leases` document is created, `users.activeLeaseId` becomes non-null — a tenant with a non-null `activeLeaseId` cannot be the subject of another *lease creation* (enforced transactionally at accept-time, see the implementation note below). Still open as a small app-logic (not schema) decision: whether a tenant's *other* pending requests should auto-reject the moment one is accepted, or remain pending for each landlord to decline individually. Doesn't affect the schema either way.

   *Implementation note for Phase 2:* the "accept request → create lease → set `activeLeaseId`" sequence must run as a single transaction that re-reads `users.activeLeaseId` immediately before writing, to close the race condition where two landlords accept the same tenant near-simultaneously.

3. **Payment gateway provider** — still correctly UNRESOLVED. `payments.gatewayFee`/`totalPaid`/`transactionRef` are provider-agnostic by design; provider selection and the real fee calculation are deferred to Phase 7 per PRD §20. Do not let implementation choose a provider ahead of that.

4. **Lease-level `lateFineConfig` override** — RESOLVED at the schema level: the capability stays (a lease can carry its own `lateFineConfig` that takes precedence over the property's). This is a **UI-scope** decision, not a schema one: Phase 5/6 UI should only expose configuring the fine at the property level; the lease-level override field exists but stays unused by the UI until a concrete need appears.

Only item 3 remains genuinely open, which is expected — it's explicitly out of scope until Phase 7 (PRD §20). Everything else in this schema is implementable without guessing, satisfying Phase 1's exit criteria.

## 12. Changelog

**v1.3** (this revision, per architecture audit):
- Added `joinRequests.autoRejected`; resolved the pending-request question definitively: accepting one request auto-rejects a tenant's other pending ones (§4).
- Added `fineApplications.idempotencyKey` (required for manual fines) and `adjustments.idempotencyKey` (required) — these fields were referenced by `cloud-functions.md`'s idempotency contracts but had never actually been added to the schema; fixed here so the uniqueness check has somewhere to check against (§6.2, §6.3).
- Added `expenses.status` (`active`/`archived`); expenses now follow the same soft-delete pattern as every other collection instead of contradicting §0's "nothing is ever hard-deleted" rule.

**v1.2** (per Om's review):
- Added `rentCharges.adjustmentTotal`; finalized the total formula as `total = subtotal + lateFineTotal + adjustmentTotal` (§6).
- `applyAdjustment()` confirmed as a Cloud Function only (creates the `adjustments` record and updates `adjustmentTotal`/`total` in one transaction), matching the treatment already given to `finalizeRentCharge()` and fine application — no direct client writes to any financial rollup field (§6.1, §6.3).
- Adjustments restricted to `finalized`/`due`/`overdue` bills; explicitly blocked at `payment_pending` (a pending payment claims a specific total) and `paid` (§6.1, §6.3).
- Considered and explicitly declined adding a `cancelled` bill status — no confirmed product requirement yet; revisit only alongside a designed `cancelRentCharge()` if one emerges.

**v1.1**:
- Removed `users.joiningDate`; `activeLeaseId` is now the only tenant-lease pointer on `users` (§1).
- Added explicit rent-value hierarchy documentation (§5.1).
- Renamed `payments.amount` → `amountDue`; added `payments.totalPaid` as an explicit, stored field rather than a derived one (§7).
- Resolved late-fine repeat semantics, join-request cardinality, and lease-level fine-override scoping (§11).

**v1.0**: initial frozen draft.
