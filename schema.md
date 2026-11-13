# Rently 2.0 — Firestore Schema (Phase 1, Frozen)

**Status:** Frozen for implementation
**Version:** 1.5 — approved UPI payment defaults and upload lifecycle claims
**Date:** 12 November 2026
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
| upiId | string | yes | Property-specific UPI VPA, validated against the supported `name@handle` format. |
| upiQrImageUrl | string | yes | HTTPS URL of the property's UPI QR image. |
| upiDisplayName | string | yes | Configured recipient name tenants compare with the name shown in their UPI app; Rently does not independently verify identity. |
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
                                                     (owning landlord accepts)
                                                                  ▼
                                                                paid
```

- `draft` → `finalized`: 🔒 `finalizeRentCharge()` only — not a direct field edit. The function validates lease is active, landlord owns it, billing month is valid, `subtotal` matches `lineItems`, and no charge already exists for that lease/month (the composite ID makes this last check nearly free) before locking `lineItems`/`subtotal`.
- `finalized`/`due`/`overdue` → `lineItems`/`subtotal` are permanently locked. `lateFineTotal`/`adjustmentTotal`/`total` can still move, but only via 🔒 `applyManualFine()` / the scheduled auto-fine job / `applyAdjustment()` — never a direct field write. This satisfies the "no silent rewrite of finalized bills" rule while still allowing the *current amount due* to change.
- **`applyAdjustment()` is only callable while status is `finalized`, `due`, or `overdue`.** It is blocked once a UPI proof is submitted and the bill reaches `payment_pending` (the payment attempt claims a specific total, which must not shift underneath it) and blocked at `paid` (use a future refund/credit mechanism instead, never rewrite a paid bill's history). `draft` doesn't need adjustments — just edit the draft directly.
- `due` → `overdue` and `finalized` → `due`: transitioned by scheduled backend job (Phase 10), not the client.
- `payment_pending` → `paid` or back to `overdue`/`due` (on rejection) is driven by 🔒 `verifyUpiPayment()` (§7), not set directly by the client.

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

**Document ID:** lowercase client-generated UUID `idempotencyKey`. A retry
with the same key addresses the same payment; each new attempt uses a new key
and creates a new immutable history record.

| Field | Type | Required | Notes |
|---|---|---|---|
| rentChargeId | string (ref → rentCharges) | yes | |
| leaseId, tenantId, landlordId, propertyId, unitId | string | yes | denormalized from the bill/lease |
| method | enum: `upi_qr` | yes | Payment gateway is out of scope. |
| amountDue | integer (paise) | yes | Server-derived from `rentCharges.total` at submission. |
| gatewayFee | integer (paise) | yes | Always `0` for this UPI-only contract. |
| totalPaid | integer (paise) | yes | Equals `amountDue`; tenant-reported and not proof of settlement. |
| status | enum: `pending_verification` \| `verified` \| `rejected` | yes | Initial status is `pending_verification`. |
| proof | map | yes | Immutable Cloudinary metadata: `{ provider: "cloudinary", publicId: string, secureUrl: HTTPS string, resourceType: "image", format: "jpg" \| "jpeg" \| "png" \| "webp", bytes: integer, uploadedAt: Timestamp }`. The backend verifies it against the intent and Cloudinary asset. Formats are case-normalized to lowercase; `bytes` must be 1–5,000,000 (5 MB). |
| transactionRef | string | yes | Required UTR/reference. Store the trimmed submitted value; it must contain 6–30 ASCII alphanumeric characters and is unique per bill after uppercase normalization. |
| upiIdSnapshot | string | yes | Immutable property UPI ID at submission time. |
| upiDisplayNameSnapshot | string | yes | Immutable configured recipient name at submission time. Rently does not independently verify identity. |
| idempotencyKey | string (UUID) | yes | Client-generated UUID and payment document ID; reused only to retry the same submission. |
| submittedAt | Timestamp | yes | Server timestamp. |
| reviewedAt | Timestamp | no | Server timestamp set on approval or rejection. |
| reviewedBy | string (ref → users) | no | Owning landlord who approved or rejected. |
| rejectionReasonCode | enum | no | Required when `status == rejected`: `old_or_used_screenshot`, `blurry_or_unreadable_screenshot`, `incomplete_amount`, `incorrect_utr`, `payment_not_received`, `screenshot_bill_mismatch`, or `other`. Their exact labels are respectively “Old or previously used screenshot”, “Blurry or unreadable screenshot”, “Payment amount is incomplete”, “Incorrect UTR/reference number”, “Payment not received in landlord's account”, “Screenshot does not match this rent bill”, and “Other”. |
| rejectionReason | string | no | Required when rejected; exact canonical label corresponding to `rejectionReasonCode`. |
| rejectionExplanation | string | no | Required only when `rejectionReasonCode == 'other'`; landlord's trimmed explanation must be 10–500 characters. For the six predefined reasons it must be absent; reject a supplied value, including a blank string. |
| proofCleanup | map | yes | `{ status: "not_requested" \| "retained" \| "pending" \| "processing" \| "deleted" \| "terminal_failure", requestedAt?: Timestamp, completedAt?: Timestamp }`. New payments start `not_requested`; approval sets `retained`; rejection sets `pending` and queues cleanup. |
| createdAt / updatedAt | Timestamp | yes | |

All monetary fields are safe integers in paise. The server requires
`amountDue == rentCharges.total`, `gatewayFee == 0`, and
`totalPaid == amountDue`; clients cannot supply or update these values.

**Lifecycle:** payment documents are created only by `createUpiPayment()`.
`pending_verification` transitions once to `verified` or `rejected` through
`verifyUpiPayment()`. Rejected records remain in Firestore; a later submission
creates a distinct payment with a new idempotency key and UTR. Approval retains
the proof. Rejection queues proof deletion. Cleanup must never delete an asset
referenced by a verified payment.

Before either decision, `verifyUpiPayment()` independently validates the linked
records: the payment's rent-charge, tenant, and landlord references match the
rent charge; the rent charge's tenant, landlord, lease, property, and unit
references match the corresponding lease, property, and unit; the lease has
the same tenant, landlord, property, and unit; the property belongs to the
landlord; and the unit belongs to the property and landlord with its
`currentLeaseId` and status consistent with the linked lease under §§3 and 5
(ending a lease clears its `currentLeaseId`). Missing or inconsistent linked
records are rejected; denormalized payment IDs alone are not authoritative.

### 7.1 `paymentUploadIntents`

**Document ID:** deterministic SHA-256 of the UTF-8 bytes of
`lowercase(idempotencyKey)`. The globally unique key allows the function to
reject reuse across tenants or bills; the stored tenant/bill fields bind the
intent to its authorized scope. Documents are server-only.

| Field | Type | Required | Notes |
|---|---|---|---|
| tenantId | string (ref → users) | yes | Authenticated tenant who requested the upload. |
| rentChargeId | string (ref → rentCharges) | yes | Bill the proof is exclusively for. |
| idempotencyKey | string (UUID) | yes | Client-generated key for retrying the same intent request. |
| publicId | string | yes | Random immutable Cloudinary asset ID under the Rently proof folder. |
| folder | string | yes | Fixed server-controlled Cloudinary folder; not client-selected. |
| resourceType | enum: `image` | yes | |
| expectedFormat | enum: `jpg` \| `jpeg` \| `png` \| `webp` | yes | Client-declared format checked before issuing upload authorization, then compared with Cloudinary metadata. |
| expectedBytes | integer | yes | Client-declared size, 1–5,000,000 inclusive; checked before issuing upload authorization, then compared with Cloudinary metadata. |
| status | enum: `issued` \| `consumed` \| `cleanup_pending` \| `cleaned` \| `terminal_failure` | yes | `issued` is single-use; `consumed` binds to one payment. |
| uploadPermissionExpiresAt | Timestamp | yes | Server-set expiry for the latest scoped Rently upload token; no later than token issuance + 10 minutes or `expiresAt`, whichever is earlier. |
| expiresAt | Timestamp | yes | Server-set intent expiry, exactly `createdAt + 15 minutes`; independently checked at payment submission. |
| uploadClaimId | string | no | Server-only transactional claim for an upload actively being forwarded to Cloudinary. |
| uploadClaimExpiresAt | Timestamp | no | Server-only upload claim lease, set to 7 minutes from claim acquisition; expired claims can be reclaimed and do not block cleanup indefinitely. |
| consumedByPaymentId | string (ref → payments) | no | Set atomically when consumed. |
| cleanedAt | Timestamp | no | Set after deletion succeeds or the asset is already absent. |
| createdAt / updatedAt | Timestamp | yes | Server timestamps. |

`preparePaymentProofUpload()` creates the intent before returning a scoped
upload permission. It is bound to the authenticated tenant and eligible bill.
For a retry with the same key and scope, the same unexpired `issued` intent is
returned with a permission that expires no later than the intent; reusing the
key for another bill or tenant, or reusing an intent after it is consumed, is
rejected. An expired key cannot be revived; the client starts a new intent
with a new key. Each upload permission's 10-minute expiry is checked independently of the
intent's 15-minute expiry. Cloudinary's standard signed upload signature lasts
one hour; use the required server-mediated endpoint rather than exposing that
signature to clients (cloud-functions.md §9 and §15).
`createUpiPayment()` may consume it only once, before expiry, for the same
tenant and bill, after verifying the uploaded Cloudinary asset. Clients cannot
read or write intent documents directly. An expired, unconsumed intent is
eligible for cleanup and cannot be consumed. The cleanup transaction changes
an expired `issued` intent to `cleanup_pending` before creating its task, but
defers while `uploadClaimId` has an unexpired lease. The upload handler clears
its claim after the Cloudinary result is validated. If the intent becomes
invalid while Cloudinary is creating the asset, the handler clears the claim
and transactionally queues compensating cleanup. An upload claim is server-only
and is not a payment or proof-consumption state.

### 7.2 UPI reference claims

`rentCharges/{rentChargeId}/upiReferences/{referenceHash}` is a server-only
uniqueness claim. `referenceHash` is SHA-256 of the trimmed UTR normalized to
uppercase. The document stores `{ paymentId, createdAt }` and is created in the
payment transaction. Claims remain after rejection, preventing reuse of that
bill's UTR for another attempt.

### 7.3 `paymentProofCleanupOutbox`

Server-only cleanup tasks are stored at
`paymentProofCleanupOutbox/{taskId}`, where `taskId` is the payment ID for a
rejected proof or `upload_<uploadIntentId>` for an expired, unconsumed intent.
Each task has exactly one source:

| Field | Type | Required | Notes |
|---|---|---|---|
| sourceType | enum: `rejected_payment` \| `expired_upload_intent` | yes | |
| paymentId | string (ref → payments) | conditional | Present only for rejected payment cleanup. |
| uploadIntentId | string (ref → paymentUploadIntents) | conditional | Present only for expired intent cleanup. |
| publicId | string | yes | For rejected-payment cleanup, exactly the rejected payment's immutable `proof.publicId`; for expired-intent cleanup, exactly the intent's `publicId`. |
| folder | string | yes | Fixed server-controlled Cloudinary folder. |
| resourceType | enum: `image` | yes | |
| status | enum: `pending` \| `processing` \| `completed` \| `terminal_failure` | yes | |
| attempts | integer | yes | Failed deletion attempts in the current automatic retry cycle; starts at 0 and is incremented for each actual deletion attempt, up to 5. |
| manualRetryCount | integer | yes | Starts at 0; increments when an administrator requeues a terminal task. |
| errorHistory | array of `{ attemptedAt: Timestamp, attempt: integer, error: string }` | yes | Append-only safe-to-log failure details; retained across manual retries. |
| nextAttemptAt | Timestamp | yes | Earliest retry time. |
| claimedBy | string | no | Worker claim identifier. |
| claimExpiresAt | Timestamp | no | Lease expiry for recovery of abandoned processing claims. |
| lastError | string | no | Last safe-to-log failure details. |
| completedAt | Timestamp | no | |
| createdAt / updatedAt | Timestamp | yes | Server timestamps. |

A task may reference a rejected payment or expired, unconsumed upload intent,
never a verified payment. For rejected-payment cleanup, `paymentId` identifies
the rejected source record and `publicId` must match that record's immutable
`proof.publicId`; the worker must validate this binding and verify that no
verified payment references the proof before deletion.

Automatic deletion is limited to five failed attempts per retry cycle, with
exponential backoff (`baseDelay × 2^(attempts - 1)`). A failure on attempt five
sets task and linked cleanup state to `terminal_failure`; preserve the task,
`lastError`, and `errorHistory` for administrative review. An administrator may
requeue the task, reset only the current-cycle `attempts`, and increment
`manualRetryCount`; do not clear prior error history. Successful deletion
(including an already-absent asset) completes the task and updates payment
`proofCleanup.status` to `deleted` or the intent status to `cleaned`.
Before deletion, workers must
re-check that no verified payment references the asset.

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

**Document ID:** auto-generated for action notifications; scheduled billing notifications use deterministic IDs so scheduler retries do not duplicate them.

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

For UPI payment events, `relatedEntity` is `{ type: "payment", id:
paymentId }`; notification IDs are deterministic from payment ID and event
type. `payment_proof_submitted` goes to the owning landlord, `payment_accepted`
goes to the tenant, and `payment_rejected` goes to the tenant. The rejection
notification includes the selected `rejectionReason` label and, for `other`,
the `rejectionExplanation`. Do not include the full UTR or proof URL in push
text. A rejected payment is not by itself a fraud finding or tenant fraud label.

### Device-token and delivery records

FCM tokens are stored under `users/{uid}/deviceTokens/{tokenHash}`. The hash is
SHA-256 of the token; the document stores the token, platform, and server
timestamps. Only authenticated `registerDeviceToken()` and
`unregisterDeviceToken()` calls may modify these records; direct client reads
and writes are denied. Multiple devices are represented by separate token-hash
documents.

`notificationDeliveries/{notificationId}` is a server-only transactional
outbox associated with a durable notification document. It records the
recipient and fan-out status. Per-device retry records live at
`notificationDeliveries/{notificationId}/devices/{tokenHash}` and track
delivery status, attempts, a short claim lease, the next retry time, and
inspectable terminal failure details. These operational records are separate
from `notifications`, whose frozen fields are unchanged. Delivery attempts are
bounded to five with exponential backoff from one minute up to six hours. A
five-minute UTC recovery worker retries due records and reclaims expired
processing leases. Delivery remains at-least-once: a duplicate push is
possible if FCM accepts a push but its acknowledgment is lost before success is
recorded; exactly-once push delivery is not claimed.

---

## 10. Cross-cutting relationships (summary)

```
users (landlord) ──1:N── properties ──1:N── units ──1:1(current)── leases ──N:1── users (tenant)
                                                                       │
                                                                       └──1:N── rentCharges ──1:N── payments
                                                                                      ├──subcol── upiReferences
                                                                                      ├──subcol── fineApplications, adjustments
                                                                                      └──1:N── paymentUploadIntents
properties ──1:N── joinRequests ──N:1── users (tenant)
properties ──1:N── expenses
users ──1:N── notifications
paymentProofCleanupOutbox (server-only)
```

---

## 11. Prior decisions and remaining open items

The prior architecture decisions remain:

1. **Late-fine repeat semantics** — RESOLVED. `maxRepetitions = N` means the configured fine is auto-applied at most `N` times for that bill. After the `N`th application, no further automatic fine is added even if the bill remains unpaid (the landlord can still apply a `manual` fine separately, per §6.2's `ruleSource` field). `fineApplications.sequenceNumber` is what the scheduled job checks against `maxRepetitions` before applying another.

2. **Multiple pending join requests / one active lease per tenant** — RESOLVED. A tenant may hold several `joinRequests` with `status: 'pending'` across different properties simultaneously. Once any one is accepted and a `leases` document is created, `users.activeLeaseId` becomes non-null — a tenant with a non-null `activeLeaseId` cannot be the subject of another *lease creation* (enforced transactionally at accept-time, see the implementation note below). Acceptance also auto-rejects the tenant's other pending requests, per §4.

   *Implementation note for Phase 2:* the "accept request → create lease → set `activeLeaseId`" sequence must run as a single transaction that re-reads `users.activeLeaseId` immediately before writing, to close the race condition where two landlords accept the same tenant near-simultaneously. The chosen behavior is auto-rejection of the tenant's other pending requests, per §4.

3. **Payment gateway provider** — still correctly UNRESOLVED and out of scope. The current §7 schema is UPI-only; do not add gateway payment methods, states, fees, or settlement behavior until provider selection in Phase 7 per PRD §20.

4. **Lease-level `lateFineConfig` override** — RESOLVED at the schema level: the capability stays (a lease can carry its own `lateFineConfig` that takes precedence over the property's). This is a **UI-scope** decision, not a schema one: Phase 5/6 UI should only expose configuring the fine at the property level; the lease-level override field exists but stays unused by the UI until a concrete need appears.

Payment implementation still requires the operational choices listed in
`cloud-functions.md` §15. Standard Cloudinary signed-upload signatures remain
valid for one hour, so the 10-minute permission must be enforced by the
server-mediated upload endpoint; direct client-to-Cloudinary signatures are
prohibited.

## 12. Changelog

**v1.5** (approved UPI payment defaults):
- Set proof formats and 5 MB maximum, separate 10-minute upload permission and 15-minute intent expiries, and five-attempt exponential cleanup retry policy (§7–§7.3).
- Froze 6–30 character alphanumeric UTR validation and predefined rejection choices with a required 10–500 character explanation for `other`.
- Required tenant rejection notifications to include the selected reason and explanation; rejected payments do not imply fraud.
- Added optional server-only upload claim ID and expiry fields to coordinate upload and cleanup.

**v1.4** (UPI payment submission contract):
- Froze UPI-only payment fields, mandatory UTR, immutable UPI snapshots, payment idempotency key, review state, and proof cleanup state (§7).
- Added server-only, short-lived, single-use `paymentUploadIntents`, per-bill UTR uniqueness claims, and a server-only proof-cleanup outbox (§7.1–§7.3).
- Specified deterministic UPI payment notification events using the existing notification fields (§9).
- Payment gateway fields and transitions are no longer part of the active contract; gateway integration remains out of scope.

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
