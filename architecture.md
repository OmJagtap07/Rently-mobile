# Rently — Architecture Specification

**Status:** Draft / Pre-implementation  
**Version:** 1.0  
**Date:** 25 September 2026

## 1. Product Context

Rently is a rental-management system.

The existing Rently repository is primarily a landlord-side React/Firebase application. The next version expands the system to support both landlords and tenants, with the tenant participating in onboarding, monthly rent viewing, payment, and payment-proof submission.

The new mobile application is planned with Flutter/Dart and will use the same Firebase backend architecture where appropriate.

## 2. High-Level Architecture

```text
Flutter
→ Firebase Auth
→ Firestore
→ Cloud Functions
→ Cloudinary for payment proofs
```

The final deployment may include backend/scheduled processing for monthly notifications and automated penalty processing.

## 3. Technology Direction

### Client
- Flutter
- Dart

### Existing client
- React/Vite landlord web application

### Backend/platform
- Firebase Authentication
- Cloud Firestore
- Firebase Cloud Messaging for push notifications
- Cloudinary for payment-proof image storage

### Maps
- Property records contain a Google Maps link for the physical property address.

### Payment
Two payment paths are planned:
1. Integrated payment gateway.
2. UPI QR payment followed by screenshot submission.

The gateway provider is not selected yet and must not be invented by the agent.

## 4. Core Domain Model

```text
User
 |
 +-- Landlord
 |      |
 |      +-- Properties
 |             |
 |             +-- Units/Rooms
 |                    |
 |                    +-- Leases
 |                           |
 |                           +-- Tenant
 |                           +-- Rent Charges
 |                           +-- Payments
 |
 +-- Tenant
        |
        +-- Join Requests
        +-- Active Lease
        +-- Historical Leases
```

Primary entities:
- users
- properties
- units
- joinRequests
- leases
- rentCharges
- payments
- expenses
- notifications

## 5. Ownership Model

### Landlord
A landlord owns and manages properties.

### Tenant
A tenant does not create or own rental properties.

A tenant:
1. Applies to join a property.
2. Waits for landlord approval.
3. After approval, the landlord assigns a room/unit number.
4. A lease is created.
5. The tenant can access their own rental information.

## 6. Property Model

A property contains:
- landlord/owner identity
- property information
- physical address
- Google Maps link
- units/rooms

Example room numbers:
- 201
- 302
- 403

Tenants cannot create rental properties.

## 7. Lease Model

A lease represents the relationship between:
- tenant
- landlord/property
- unit/room

It contains the tenant joining date and lease lifecycle.

A lease can become ended/archived without deleting its historical records.

Historical leases remain available for record-keeping.

## 8. Monthly Billing Architecture

The monthly cycle is deliberately not fully automatic.

### 25th
The landlord receives a reminder to prepare the upcoming month's bill.

No rent bill is automatically generated at this point.

The landlord checks the actual electricity bill, such as the Mahavitaran bill, and manually enters the variable electricity amount.

The landlord can also enter:
- base rent
- electricity
- maintenance
- other charges
- configured late-fine amount when applicable

### Bill example

```text
October 2026

Rent             ₹10,000
Electricity       ₹1,250
Maintenance         ₹500
Late fine             ₹0
------------------------
Total             ₹11,750
```

### Bill lifecycle

```text
draft
  |
  v
finalized
  |
  v
due
  |
  +--> overdue
  |
  v
payment_pending
  |
  v
paid
```

The exact implementation may combine or rename states only after the schema is finalized.

## 9. Rent Charge Principle

Each month's rent is a separate historical record.

Changing a tenant's future rent must not rewrite previous finalized rent charges.

Example:
- October rent remains the October historical amount.
- November can have a different amount.

## 10. Late-Fine Architecture

The landlord can manually apply a late fine after the payment due date.

The landlord can also configure a predefined fine.

The fine configuration must support:
- amount or percentage
- start condition/date
- repetition interval
- maximum number of repetitions where applicable

The tenant must be able to see the applicable repetition information when viewing the updated rent.

The system must explicitly distinguish:
- a fine added once
- a fine repeated against an overdue bill

The final exact repeat options and maximum-repeat semantics must be captured in the finalized schema before implementation.

## 11. Payment Architecture

### Payment method A — Gateway

The tenant pays through an integrated payment gateway.

The gateway may charge an additional provider fee. The app must show the tenant the additional amount clearly before payment.

The exact provider and fee calculation are not selected yet.

The client must not mark a gateway payment as verified solely because a client-side payment screen reports success. Server-side/provider verification is required.

### Payment method B — UPI QR + proof

```text
Tenant
  |
  v
Scan UPI QR
  |
  v
Pay externally
  |
  v
Upload screenshot
  |
  v
Payment = pending verification
  |
  v
Landlord reviews proof
  |
  +--> Reject
  |
  +--> Accept
          |
          v
        Paid
```

The screenshot is stored externally from the Firestore document itself. Firestore stores a reference such as `proofUrl`.

## 12. Payment Proof Storage

- Cloudinary.

Uploads are executed securely using a signed direct-upload architecture: Flutter requests an upload signature from a Cloud Function, uploads directly to Cloudinary, and then submits the resulting metadata back to a payment Cloud Function. The Cloudinary API secret is never stored on the client.

The payment model should store a provider-neutral proof reference so storage can be changed without redesigning the payment entity.

Images should be compressed/resized appropriately before storage.

## 13. Payment History

Payment records are permanent historical records.

Important fields should preserve:
- amount
- payment method
- status
- submission time
- verification time
- verifier
- transaction/reference ID where applicable
- proof reference where applicable

## 14. Tenant Archive

When a tenant leaves:
- tenant profile remains
- historical lease remains
- room history remains
- rent charges remain
- payment history remains
- relevant payment proofs remain subject to retention/storage policy

The tenant's active lease becomes ended/archived.

Historical records must not be destructively deleted simply because occupancy ended.

## 15. Notifications

### Landlord
- 25th: prepare upcoming rent reminder
- tenant payment-proof submission
- overdue-payment information
- other approved operational notifications

### Tenant
- 1st: finalized monthly rent due notification
- payment accepted
- payment rejected
- updated rent due to applicable late fine
- other approved operational notifications

Notifications must be generated by reliable backend/scheduled processing where timing must not depend on the app being open.

## 16. Authorization

Authentication identifies the user.

Authorization determines what that user can access.

The two primary roles are:
- landlord
- tenant

Authorization must be enforced by Firebase Security Rules/backend controls, not merely by hiding UI controls.

### Landlord
Can manage their own properties, units, tenant requests, leases, rent charges, expenses, and payment verification within their authorized scope.

### Tenant
Can access only their own tenant/lease/billing/payment information and can submit an application/payment/proof where allowed.

A tenant cannot:
- create a landlord property
- assign themselves a room
- edit landlord-owned property data
- modify finalized rent charges
- verify their own payment
- access another tenant's records

## 17. Security Principles

- Never place service-account credentials in Flutter.
- Never trust client-side role checks.
- Validate ownership and relationships in Security Rules/backend.
- Protect payment-proof storage.
- Protect tenant-to-lease relationships.
- Preserve historical financial data.
- Test Firestore Rules before production use.

## 18. Environment Strategy

Development and production Firebase environments should be kept separate before production launch.

No secrets should be committed to the repository.

## 19. Architectural Constraint

The web and Flutter clients should share the same business/data model rather than maintaining separate incompatible schemas.

The backend is the source of truth for:
- authorization
- payment verification
- financial state
- historical records
- scheduled events
