# Rently — Implementation Phases

**Status:** Planning  
**Version:** 1.0  
**Date:** 25 September 2026

## Implementation Rule

Work sequentially.

Do not begin a later phase until the current phase is implemented and verified.

Antigravity must:
1. Read `.cursorrules`, `PRD.md`, `architecture.md`, and `design.md`.
2. Implement only the current phase.
3. Run relevant checks.
4. Report exact changes.
5. Stop if a requirement is ambiguous.

---

## Phase 0 — Specification and Repository Audit

### Goal
Understand the existing Rently application before modifying it.

### Tasks
- Inspect current repository structure.
- Inspect existing Firebase integration.
- Inspect existing Firestore usage.
- Inspect authentication.
- Inspect current landlord features.
- Identify current collections and document shapes.
- Identify current security rules.
- Record conflicts between existing implementation and Rently 2.0 requirements.

### Exit criteria
- Existing behavior is documented.
- Current schema is known.
- Migration risks are identified.
- No implementation changes are made merely from assumptions.

---

## Phase 1 — Final Data Model

### Goal
Freeze the Firestore data model.

### Entities
- users
- properties
- units
- joinRequests
- leases
- rentCharges
- payments
- expenses
- notifications

### Tasks
- Define every field and data type.
- Define required/optional fields.
- Define document IDs.
- Define relationships.
- Define historical-record behavior.
- Define payment status transitions.
- Define late-fine representation.
- Define billing states.
- Define timestamps and audit fields.

### Exit criteria
The schema can be implemented without guessing.

---

## Phase 2 — Authentication and Authorization

### Goal
Implement secure landlord/tenant access.

### Tasks
- Firebase Authentication.
- User profile creation.
- Landlord role.
- Tenant role.
- Firestore Security Rules.
- Ownership checks.
- Tenant-to-lease authorization.
- Join-request authorization.

### Exit criteria
Unauthorized users cannot read or modify protected records.

Security Rules are tested.

---

## Phase 3 — Property, Units, and Tenant Join Requests

### Goal
Create the landlord-controlled property and onboarding workflow.

### Tasks
- Landlord creates property.
- Landlord creates/manages units.
- Tenant searches/enters a property join mechanism.
- Tenant submits join request.
- Landlord accepts/rejects.
- Landlord assigns unit/room.
- Lease is created after acceptance.

### Exit criteria
A tenant cannot create a property or assign themselves a room.

---

## Phase 4 — Lease and Tenant History

### Goal
Implement active and historical tenancy.

### Tasks
- Joining date.
- Active lease.
- End lease.
- Historical lease.
- Tenant archive.
- Room history.

### Exit criteria
Ending a tenancy preserves historical records.

---

## Phase 5 — Monthly Billing

### Goal
Implement the landlord-controlled monthly bill workflow.

### Tasks
- 25th landlord reminder.
- Billing draft.
- Manual electricity amount.
- Maintenance amount.
- Other charges.
- Base rent.
- Bill total calculation.
- Finalize bill.
- 1st tenant notification.
- Tenant bill view.

### Critical rule
The 25th reminder does NOT automatically generate the final bill.

### Exit criteria
A landlord can prepare and finalize a monthly bill and the tenant can view it.

---

## Phase 6 — Late Fine Engine

### Goal
Implement overdue fines.

### Tasks
- Detect overdue bill.
- Manual fine.
- Predefined fine.
- Fixed amount.
- Percentage.
- Repeat interval.
- Maximum repeat count.
- Tenant-visible repeat information.
- Historical fine records.

### Exit criteria
The same overdue bill cannot accidentally receive duplicate fines outside the configured rules.

---

## Phase 7 — Payment Gateway

### Goal
Implement integrated payment processing.

### Tasks
- Select payment provider.
- Implement provider integration.
- Display provider fee.
- Payment initiation.
- Server-side verification.
- Payment state updates.
- Failure handling.
- Duplicate-payment protection.

### Exit criteria
The system does not mark a payment paid based solely on unverified client input.

---

## Phase 8 — UPI QR and Payment Proof

### Goal
Implement no-gateway-fee UPI payment workflow.

### Tasks
- Display UPI QR.
- Tenant pays externally.
- Screenshot upload.
- Image compression.
- Storage provider integration.
- Pending verification.
- Landlord review.
- Accept/reject.
- Rejection reason.
- Audit trail.

### Storage
Integrate Cloudinary for payment proof storage. (Do NOT implement code yet).

### Exit criteria
Landlord can reliably verify or reject a submitted payment proof.

---

## Phase 9 — Payment History and Reports

### Goal
Expose financial history.

### Tasks
- Tenant payment history.
- Landlord tenant history.
- Property financial history.
- Monthly reports.
- Expense integration.
- Historical tenant archive views.

### Exit criteria
Historical records remain intact and can be queried accurately.

---

## Phase 10 — Notifications

### Goal
Implement reliable push notifications.

### Notifications
- 25th billing reminder.
- 1st rent due.
- Payment submitted.
- Payment accepted.
- Payment rejected.
- Overdue notification.
- Late-fine update.

### Exit criteria
Scheduled notifications do not depend on the client app being open.

---

## Phase 11 — Flutter Application

### Goal
Build the mobile application after backend contracts are stable.

### Areas
- Authentication.
- Landlord experience.
- Tenant experience.
- Navigation.
- Dashboard.
- Properties.
- Units.
- Join requests.
- Lease.
- Billing.
- Payments.
- Notifications.
- History.

### Exit criteria
Flutter consumes the approved backend model without introducing a second incompatible data model.

---

## Phase 12 — Testing and Hardening

### Goal
Prepare for real use.

### Tasks
- Unit tests.
- Widget tests.
- Integration tests.
- Firestore Rules tests.
- Payment flow tests.
- Billing edge cases.
- Late-fine edge cases.
- Tenant archival tests.
- Notification tests.
- Offline/error-state testing.

### Exit criteria
Critical workflows have automated or repeatable verification.

---

## Phase 13 — Production Readiness

### Goal
Prepare production deployment.

### Tasks
- Production Firebase project.
- Environment configuration.
- Security review.
- Cloudinary integration review.
- Notification configuration.
- Payment provider production configuration.
- Logging/monitoring.
- Backup/retention strategy.
- Release build.
- Final documentation.

### Exit criteria
Production deployment can be performed without exposing secrets or relying on undocumented manual steps.
