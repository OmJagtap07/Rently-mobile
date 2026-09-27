# Rently 2.0 — Firestore Rules Test Specification

**Version:** 1.2  
**Rules:** `firestore.rules` v1.1  
**Tooling:** `@firebase/rules-unit-testing` + Firebase Emulator Suite

These tests verify DIRECT CLIENT Firestore access. Cloud Functions are tested separately because Admin SDK operations bypass Firestore Security Rules.

## 0. Important query rule

Firestore Security Rules are not filters. Any Flutter query must itself be constrained so every document it could return satisfies the rule.

Examples:

```dart
FirebaseFirestore.instance
    .collection('properties')
    .where('landlordId', isEqualTo: uid);
```

and:

```dart
FirebaseFirestore.instance
    .collection('rentCharges')
    .where('tenantId', isEqualTo: uid);
```

A broad collection query that could return unauthorized documents must not be used.

## 1. Fixtures

Create:

- landlordA, landlordB
- tenantA, tenantB
- propertyA1 owned by landlordA
- propertyB1 owned by landlordB
- unitA1 under propertyA1
- active leaseA1 for tenantA on unitA1
- draft/finalized rentChargeA1
- paymentA1
- expenseA1
- notifications for landlordA and tenantA

Auth claims:

```js
{ role: 'landlord' }
{ role: 'tenant' }
```

## 2. users

| ID | Actor | Action | Expect |
|---|---|---|---|
| U-1 | tenantA | Read own user | ALLOW |
| U-2 | tenantA | Read tenantB user | DENY |
| U-3 | landlordA | Read tenantA user | DENY |
| U-4 | unauthenticated | Read user | DENY |
| U-5 | tenantA | Create users doc | DENY |
| U-6 | tenantA | Update fullName | ALLOW |
| U-7 | tenantA | Update phone/photoURL | ALLOW |
| U-8 | tenantA | Change role | DENY |
| U-9 | tenantA | Change activeLeaseId | DENY |
| U-10 | tenantA | Update fullName + role | DENY |
| U-11 | landlordA | Update tenantA user | DENY |

## 3. properties

| ID | Actor | Action | Expect |
|---|---|---|---|
| P-1 | landlordA | Create own property | ALLOW |
| P-2 | landlordA | Create property for landlordB | DENY |
| P-3 | landlordA | Read own property | ALLOW |
| P-4 | landlordA | Read landlordB property | DENY |
| P-5 | landlordB | Update propertyA1 | DENY |
| P-6 | tenantA | Read propertyA1 with active lease | ALLOW |
| P-7 | tenantB | Read unrelated property | DENY |
| P-8 | landlordA | Change landlordId | DENY |
| P-9 | landlordA | Update own property name | ALLOW |
| P-10 | landlordA | Delete property | DENY |

## 4. units

| ID | Actor | Action | Expect |
|---|---|---|---|
| U2-1 | landlordA | Create unit under own property | ALLOW |
| U2-2 | landlordA | Create unit under landlordB property | DENY |
| U2-3 | landlordA | Update roomNumber/baseRent | ALLOW |
| U2-4 | landlordA | Change currentLeaseId | DENY |
| U2-5 | landlordA | Change status | DENY |
| U2-6 | tenantA | Read assigned unit | ALLOW |
| U2-7 | tenantB | Read unitA1 | DENY |

## 5. joinRequests

| ID | Actor | Action | Expect |
|---|---|---|---|
| JR-1 | tenantA | Create directly | DENY |
| JR-2 | tenantA | Create forged landlordId | DENY |
| JR-3 | tenantA | Read own request | ALLOW |
| JR-4 | tenantB | Read tenantA request | DENY |
| JR-5 | landlordA | Read request for own property | ALLOW |
| JR-6 | landlordB | Read request for propertyA1 | DENY |
| JR-7 | landlordA | Reject pending request | ALLOW |
| JR-8 | landlordA | Accept directly | DENY |
| JR-9 | landlordA | Change tenantId while rejecting | DENY |

## 6. leases

| ID | Actor | Action | Expect |
|---|---|---|---|
| L-1 | landlordA | Create directly | DENY |
| L-2 | tenantA | Read own lease | ALLOW |
| L-3 | landlordA | Read own-property lease | ALLOW |
| L-4 | landlordB | Read leaseA1 | DENY |
| L-5 | landlordA | Update currentBaseRent on active lease | ALLOW |
| L-6 | landlordA | Update ended lease | DENY |
| L-7 | landlordA | Update currentBaseRent + tenantId | DENY |
| L-8 | tenantA | Update currentBaseRent | DENY |
| L-9 | landlordA | Set status=ended | DENY |

## 7. rentCharges

| ID | Actor | Action | Expect |
|---|---|---|---|
| RC-1 | landlordA | Create valid draft | ALLOW |
| RC-2 | landlordA | Use wrong deterministic ID | DENY |
| RC-3 | landlordA | Create finalized bill | DENY |
| RC-4 | landlordA | Create against another landlord's lease | DENY |
| RC-5 | landlordA | Edit draft lineItems/subtotal | ALLOW |
| RC-6 | landlordA | Edit finalized bill | DENY |
| RC-7 | landlordA | Finalize directly | DENY |
| RC-8 | landlordA | Change lateFineTotal/total directly | DENY |
| RC-9 | landlordA | Change adjustmentTotal/total directly | DENY |
| RC-10 | landlordA | Change payment state directly | DENY |
| RC-11 | tenantA | Read own bill | ALLOW |
| RC-12 | tenantB | Read tenantA bill | DENY |
| RC-13 | landlordB | Read tenantA bill | DENY |
| RC-14 | landlordA | Delete bill | DENY |
| RC-15 | landlordA | Create wrong tenantId | DENY |
| RC-16 | landlordA | Create wrong propertyId | DENY |
| RC-17 | landlordA | Create wrong unitId | DENY |

### Fine applications

| ID | Actor | Action | Expect |
|---|---|---|---|
| FA-1 | landlordA | Create directly | DENY |
| FA-2 | tenantA | Read own fine | ALLOW |
| FA-3 | tenantB | Read tenantA fine | DENY |

### Adjustments

| ID | Actor | Action | Expect |
|---|---|---|---|
| ADJ-1 | landlordA | Create directly | DENY |
| ADJ-2 | tenantA | Read own adjustment | ALLOW |
| ADJ-3 | tenantB | Read tenantA adjustment | DENY |

## 8. payments

Payment creation is Cloud-Function-only because it must atomically create the payment and move the rent charge to `payment_pending`.

| ID | Actor | Action | Expect |
|---|---|---|---|
| PAY-1 | tenantA | Create payment directly | DENY |
| PAY-2 | tenantA | Create verified payment | DENY |
| PAY-3 | tenantA | Create with verifiedBy | DENY |
| PAY-4 | tenantB | Create against tenantA bill | DENY |
| PAY-5 | tenantA | Read own payment | ALLOW |
| PAY-6 | landlordA | Read payment on own property | ALLOW |
| PAY-7 | landlordB | Read tenantA payment | DENY |
| PAY-8 | landlordA | Verify payment directly | DENY |
| PAY-9 | tenantA | Self-verify payment | DENY |
| PAY-10 | anyone | Verify gateway payment directly | DENY |
| PAY-11 | landlordA | Delete payment | DENY |

## 9. expenses

| ID | Actor | Action | Expect |
|---|---|---|---|
| E-1 | landlordA | Create own-property expense | ALLOW |
| E-2 | landlordA | Read own expense | ALLOW |
| E-3 | landlordA | Update own expense | ALLOW |
| E-4 | landlordA | Archive own expense | ALLOW |
| E-5 | landlordA | Hard-delete expense | DENY |
| E-6 | landlordB | Read/update landlordA expense | DENY |
| E-7 | tenantA | Read/write expense | DENY |

## 10. notifications

| ID | Actor | Action | Expect |
|---|---|---|---|
| N-1 | tenantA | Read own notification | ALLOW |
| N-2 | tenantA | Read landlord notification | DENY |
| N-3 | tenantA | Mark own notification read | ALLOW |
| N-4 | tenantA | Modify title/body | DENY |
| N-5 | tenantA | Create notification | DENY |
| N-6 | landlordA | Create notification | DENY |
| N-7 | tenantA | Delete notification | DENY |

## 11. Cloud-Function-only boundary

The following have NO direct client Firestore write path:

```text
completeOnboarding()
createJoinRequest()
acceptJoinRequest()
endLease()
finalizeRentCharge()
applyManualFine()
applyAdjustment()
createUpiPayment()
createGatewayPayment()
verifyUpiPayment()
verifyGatewayPayment()
scheduled bill transitions
notification creation
```

These require function-level tests.

## 12. Emulator acceptance criteria

Before Flutter depends on the backend:

1. Start Firebase Auth + Firestore + Functions emulators.
2. Seed the fixture documents.
3. Seed emulator Auth users with landlord/tenant claims.
4. Run every ALLOW/DENY test.
5. Test actual Flutter-style collection queries, not only document reads.
6. Confirm rule `get()`/`exists()` access-call limits are not exceeded.
7. Confirm all unauthorized queries fail rather than being partially filtered.
8. Cloudinary upload authorization and security will be tested separately when the Cloudinary integration is implemented.
9. Deploy the exact rules to the development Firebase project only after emulator tests pass.

Security Rules are not filters; query constraints must match the authorization model.
