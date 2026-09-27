# Rently — Product Requirements Document

**Product:** Rently  
**Version:** 2.0 Planning Specification  
**Date:** 25 September 2026  
**Status:** Pre-implementation

## 1. Product Overview

Rently is a rental-management application for landlords and tenants.

The current Rently application primarily provides landlord-side property, tenant, rent, expense, and reporting functionality.

Rently 2.0 expands this into a two-role system where tenants can apply to join a landlord's property, receive an assigned room/unit, view monthly bills, make payments, submit UPI payment proof, and retain a complete payment history.

## 2. Product Goals

Rently should:
- simplify landlord rental management
- give tenants transparent rent information
- reduce manual payment tracking
- preserve lifetime tenant/payment history
- provide clear monthly billing
- support variable electricity and maintenance costs
- support late-payment penalties
- provide auditable payment verification

## 3. User Roles

### Landlord

Landlords:
- create and manage properties
- create/manage rooms/units
- review tenant join requests
- accept/reject tenants
- assign rooms
- manage leases
- prepare monthly bills
- enter electricity and other variable costs
- apply late fines
- verify UPI payment proofs
- view tenant/payment history
- manage expenses and reports

### Tenant

Tenants:
- create/manage their own profile where allowed
- apply to join a landlord's property
- view application status
- view assigned property and room
- view joining date
- view monthly rent
- view bill breakdown
- pay rent
- upload UPI payment screenshot
- view payment status
- view lifetime payment history
- view late-fine/repetition information

Tenants cannot create rental properties.

## 4. User Profile Requirements

### Landlord
Store:
- full name
- phone number
- profile data

### Tenant
Store:
- full name
- phone number
- profile data
- joining date

The joining date is managed/edited by the landlord and is read-only for the tenant.

## 5. Property Requirements

A landlord can create rental properties.

A property contains:
- property information
- physical address
- Google Maps link
- rooms/units

Example room numbers:
- 201
- 302
- 403

A tenant cannot create a rental property.

## 6. Tenant Join Workflow

```text
Tenant
  ↓
Find/enter property
  ↓
Apply to join
  ↓
Landlord receives request
  ↓
Landlord accepts/rejects
  ↓
If accepted:
Landlord assigns room/unit
  ↓
Lease becomes active
```

The tenant cannot select or assign their own room.

## 7. Lease Requirements

A lease connects:
- tenant
- landlord
- property
- unit/room

The lease records:
- joining/start information
- assigned room
- monthly rent
- status

When a tenant leaves, the lease becomes historical/ended.

Historical lease data is retained.

## 8. Monthly Billing Cycle

### 25th — Landlord Reminder

On the 25th, the landlord receives a notification reminding them to prepare the upcoming month's rent.

**The system does not automatically generate the final bill.**

The landlord must manually check the electricity bill, including the Mahavitaran bill in the current workflow, and enter the actual electricity amount.

The landlord then prepares the bill.

### Bill Components

A monthly bill can contain:

```text
October 2026

Rent             ₹10,000
Electricity       ₹1,250
Maintenance         ₹500
Late fine             ₹0
------------------------
Total             ₹11,750
```

Additional approved charges may be supported by the final schema.

### 1st — Tenant Reminder

Once the landlord has finalized the upcoming bill, the tenant receives a notification on the 1st showing the amount due.

The tenant can open the bill and see the full breakdown.

## 9. Rent Due Date

Tenants should complete payment before the 10th of the month.

After the due date, an unpaid bill can become overdue.

## 10. Late Fine Requirements

The landlord can manually apply a late fine to a specific overdue tenant/bill.

The landlord can also configure a predefined fine.

The fine must support:
- fixed amount or percentage
- repeat behavior
- repeat interval
- maximum repeat count where configured

The exact fine repetition behavior must be explicit.

Example:

```text
Late fine: ₹500
Repeat: every 7 days
Maximum: 3 applications
```

The tenant must see the applicable repeat information when viewing the updated bill.

Historical fine applications must remain auditable.

## 11. Payment Methods

Rently supports two planned payment methods.

### Option 1 — Integrated Payment Gateway

The tenant pays through an integrated payment gateway.

The payment gateway may add a provider fee.

The app must clearly show the fee before the tenant confirms payment.

The expected fee may be around 2–4%, but the actual amount must come from the selected provider's pricing/integration and must not be hard-coded without verification.

### Option 2 — UPI QR + Screenshot

The tenant can:
1. scan the landlord/property UPI QR
2. complete payment externally
3. upload a screenshot as proof

This path does not add a Rently payment-gateway fee.

## 12. Payment Verification

For UPI screenshot payments:

```text
Tenant submits proof
       ↓
Payment pending verification
       ↓
Landlord receives notification
       ↓
Landlord reviews screenshot
       ↓
Accept OR Reject
       ↓
Payment becomes verified/paid or rejected
```

The landlord must be the party who verifies the payment.

The tenant cannot verify their own payment.

## 13. Payment Proof Storage

Payment screenshots require persistent storage.

The system will use Cloudinary for payment proof storage.

The Firestore payment record should reference the proof metadata rather than embed image data.

Images should be compressed/resized before storage where appropriate.
Uploads must use a secure signed-upload architecture directly from the client.
Payment proofs must be image resources only (JPEG/JPG, PNG, WebP), limited in size, uploaded into a Rently-specific Cloudinary folder/prefix, and associated with the intended payment/rent charge.

## 14. Payment History

Rently must permanently retain tenant payment history.

The history should show:
- billing month
- amount
- payment method
- payment status
- submission date
- verification date
- relevant transaction/reference ID
- proof where applicable

## 15. Past Tenant Archive

When a tenant leaves:
- their profile remains
- historical room information remains
- joining information remains
- lease history remains
- billing history remains
- payment history remains
- relevant proof references remain according to retention policy

The tenant must not disappear from the landlord's historical records.

## 16. Notifications

### Landlord notifications
- 25th: prepare upcoming rent
- payment proof submitted
- overdue rent
- other approved billing events

### Tenant notifications
- 1st: rent due
- payment accepted
- payment rejected
- late-fine update
- other approved billing events

Scheduled notifications must not depend on the application being open.

## 17. Security Requirements

- Firebase Authentication is used for identity.
- Firebase Security Rules/backend controls enforce authorization.
- Client-side role checks are not sufficient.
- Tenants cannot access other tenants' records.
- Tenants cannot access unrelated properties.
- Landlords cannot access unrelated landlords' properties.
- Tenants cannot alter finalized rent bills.
- Tenants cannot verify payments.
- Privileged Firebase credentials must never be shipped in the client application.
- Payment proofs must have access controls.
- Financial history must not be silently overwritten.

## 18. Financial Integrity

Finalized bills are historical financial records.

Changing a future rent amount must not rewrite previous finalized bills.

Corrections to financial records should use explicit adjustment/correction mechanisms rather than silent overwrites.

## 19. Core Success Criteria

A complete Rently workflow should allow:

### Landlord
```text
Create property
   ↓
Create rooms
   ↓
Receive tenant request
   ↓
Accept tenant
   ↓
Assign room
   ↓
Prepare monthly bill
   ↓
Enter electricity/maintenance
   ↓
Finalize bill
   ↓
Receive payment/proof
   ↓
Verify payment
   ↓
View history
```

### Tenant
```text
Apply to property
   ↓
Get accepted
   ↓
Receive assigned room
   ↓
View joining date
   ↓
Receive monthly bill
   ↓
Pay
   ↓
Submit proof if using UPI
   ↓
Track verification
   ↓
View lifetime history
```

## 20. Out of Scope Until Explicitly Approved

The agent must not invent or implement the following without an explicit requirement:
- a specific payment gateway provider
- automatic electricity-bill integration
- tenant-created properties
- tenant-controlled room assignment
- automatic final bill generation on the 25th
- deletion of historical tenant records
- unrelated social/chat features
- additional roles beyond landlord and tenant
- unapproved third-party services

## 21. Current Product Principle

Rently is not simply a landlord dashboard.

The target product is a shared rental-management system where:

```text
Landlord controls the rental relationship
             +
Tenant participates in the rental workflow
             +
Rently maintains the authoritative history
```
