# Rently — Design Specification

**Status:** Draft / Pre-implementation  
**Version:** 1.0  
**Date:** 25 September 2026

## 1. Design Goal

Rently should feel like a practical rental-management application rather than a generic finance dashboard.

The design must make:
- rent due information
- payment status
- tenant/landlord responsibilities
- room assignment
- billing breakdown
- overdue fines

easy to understand.

## 2. Roles

The application has two primary experiences.

### Landlord
Focused on:
- properties
- rooms
- tenant applications
- leases
- monthly billing
- electricity/maintenance entry
- payment verification
- expenses
- reports
- tenant history

### Tenant
Focused on:
- current property/room
- joining information
- monthly bill
- payment
- payment proof
- payment history
- notifications

## 3. Tenant Onboarding UX

```text
Tenant
  |
  v
Find/enter property
  |
  v
Apply to join
  |
  v
Waiting for landlord
  |
  v
Accepted
  |
  v
Landlord assigns room
  |
  v
Active tenancy
```

The tenant must never see an interface that implies they can create a rental property.

## 4. Landlord Join Request UX

The landlord should see pending applications.

Example:

```text
Rahul Sharma
Phone: **********
Requested property: Om Residency

[Reject] [Accept]
```

After accepting:

```text
Assign Room
[302 v]

Joining Date
[01/10/2026]

[Confirm]
```

## 5. Tenant Home

The primary information should be the current month's rent.

Example:

```text
October 2026

₹11,750
Due by 10 October

Rent             ₹10,000
Electricity       ₹1,250
Maintenance         ₹500
Late fine             ₹0

[Pay Rent]
```

The exact visual design will be implemented after the architecture is finalized.

## 6. Rent Details

When a late fine is active, the tenant should clearly understand why the amount changed.

Example:

```text
Current bill       ₹11,750

Late fine
₹500 every 7 days
Maximum 3 applications

Next fine:
18 October

Updated total      ₹12,250
```

Avoid hiding penalty behavior in a secondary screen.

## 7. Payment Selection

The tenant should be presented with clear payment options.

### Gateway

Show:
```text
Rent                  ₹11,750
Gateway fee             ₹XXX
-----------------------------
Total payable          ₹XX,XXX
```

The fee must be clearly disclosed.

### UPI

Show:
```text
Rent                  ₹11,750
Additional gateway fee     ₹0
-----------------------------
Total                  ₹11,750

[Show UPI QR]

[Upload Payment Screenshot]
```

## 8. Payment Proof UX

After screenshot submission:

```text
Payment submitted

Status:
Pending verification

The landlord will review your payment proof.
```

After approval:

```text
Payment verified
₹11,750
October 2026
```

After rejection:

```text
Payment proof rejected

Please review the reason and submit a valid proof.
```

A rejection reason should be supported in the data model.

## 9. Landlord Billing UX

The 25th reminder should open a billing-preparation workflow.

```text
Prepare November Rent

Room 201
Rent             ₹10,000
Electricity       [₹____]
Maintenance       [₹____]
Other             [₹____]
Late fine         [₹____]

Total             ₹____

[Save Draft]
[Finalize Bill]
```

The landlord must manually obtain the electricity amount from the relevant electricity provider/bill before finalizing.

## 10. Bill Draft vs Finalized

Draft bills can be edited by authorized landlords.

Finalized bills should be protected from arbitrary changes.

If a correction is needed, the system should use an explicit correction/adjustment process rather than silently rewriting financial history.

## 11. Landlord Payment Verification

When a UPI proof is submitted:

```text
Payment Verification

Tenant: Rahul Sharma
Room: 302
Amount: ₹11,750

[View Screenshot]

[Reject] [Accept]
```

Accepting the payment should create the appropriate audit information.

## 12. Property and Room UX

Landlords manage:

```text
Om Residency

101   Vacant
102   Occupied
201   Occupied
202   Vacant
302   Occupied
```

A tenant sees their assigned room, not a room-assignment control.

## 13. Tenant History

The tenant should be able to see:
- current lease
- joining date
- room
- historical bills
- payment history

A landlord should be able to access archived tenant history for their properties.

## 14. Notifications UX

Notifications should be actionable.

Example:

```text
25 Sep
Prepare next month's rent
[Prepare Bills]

8 Oct
Rahul submitted payment proof
[Review Payment]

11 Oct
Rahul's rent is overdue
[View Bill]
```

## 15. Financial Clarity

Every bill should provide a breakdown rather than showing only a final number.

The UI should distinguish:
- base rent
- electricity
- maintenance
- other charges
- late fine
- payment-provider fee

Payment-provider fees must not be confused with landlord charges.

## 16. Responsive Design

The existing Rently product is web-based and responsive. The new Flutter application should be optimized for mobile first.

Layouts must remain usable on:
- small Android phones
- larger Android phones
- tablets where applicable

## 17. UX Rules

- Do not hide important financial information.
- Do not use ambiguous payment statuses.
- Clearly distinguish pending, verified, rejected, overdue, and paid states.
- Confirmation is required for consequential actions.
- Destructive actions require confirmation.
- Financial actions should show the amount before confirmation.
- Historical records should look distinct from active records.
- Tenant permissions should be reflected in the UI, but security must still be enforced by backend rules.
