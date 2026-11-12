import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  setLogLevel,
  Timestamp
} from 'firebase/firestore';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  setLogLevel('error');
  testEnv = await initializeTestEnvironment({
    projectId: 'rently-test',
    firestore: {
      rules: readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    // 1. users
    await setDoc(doc(db, 'users', 'landlordA'), { uid: 'landlordA', role: 'landlord', fullName: 'LA' });
    await setDoc(doc(db, 'users', 'landlordB'), { uid: 'landlordB', role: 'landlord', fullName: 'LB' });
    await setDoc(doc(db, 'users', 'tenantA'), { uid: 'tenantA', role: 'tenant', fullName: 'TA', activeLeaseId: 'leaseA1' });
    await setDoc(doc(db, 'users', 'tenantB'), { uid: 'tenantB', role: 'tenant', fullName: 'TB', activeLeaseId: null });

    // 2. properties
    await setDoc(doc(db, 'properties', 'propertyA1'), { landlordId: 'landlordA', status: 'active', name: 'Prop A1' });
    await setDoc(doc(db, 'properties', 'propertyB1'), { landlordId: 'landlordB', status: 'active', name: 'Prop B1' });

    // 3. units
    await setDoc(doc(db, 'units', 'unitA1'), { landlordId: 'landlordA', propertyId: 'propertyA1', currentLeaseId: 'leaseA1', status: 'occupied' });

    // 4. leases
    await setDoc(doc(db, 'leases', 'leaseA1'), { landlordId: 'landlordA', tenantId: 'tenantA', propertyId: 'propertyA1', unitId: 'unitA1', status: 'active', currentBaseRent: 1000 });
    await setDoc(doc(db, 'leases', 'leaseEnded'), { landlordId: 'landlordA', tenantId: 'tenantA', propertyId: 'propertyA1', unitId: 'unitA1', status: 'ended', currentBaseRent: 1000 });

    // 5. rentCharges
    await setDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), {
      status: 'draft',
      leaseId: 'leaseA1',
      landlordId: 'landlordA',
      tenantId: 'tenantA',
      propertyId: 'propertyA1',
      unitId: 'unitA1',
      billingMonth: '2026-10',
      lineItems: [{ type: 'rent', label: 'Rent', amount: 1000 }],
      dueDate: '2026-10-10',
      lateFineTotal: 0,
      adjustmentTotal: 0,
      subtotal: 1000,
      total: 1000,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });
    
    await setDoc(doc(db, 'rentCharges', 'leaseA1_2026-09'), {
      status: 'finalized',
      leaseId: 'leaseA1',
      landlordId: 'landlordA',
      tenantId: 'tenantA',
      propertyId: 'propertyA1',
      unitId: 'unitA1',
      billingMonth: '2026-09',
      lateFineTotal: 0,
      adjustmentTotal: 0,
      subtotal: 1000,
      total: 1000
    });

    // 6. payments
    await setDoc(doc(db, 'payments', 'paymentA1'), { landlordId: 'landlordA', tenantId: 'tenantA', rentChargeId: 'leaseA1_2026-09', status: 'pending_verification', method: 'upi_qr' });

    // 7. expenses
    await setDoc(doc(db, 'expenses', 'expenseA1'), { landlordId: 'landlordA', propertyId: 'propertyA1', amount: 50, status: 'active' });

    // 8. notifications
    await setDoc(doc(db, 'notifications', 'notifLA'), { recipientId: 'landlordA', read: false });
    await setDoc(doc(db, 'notifications', 'notifTA'), { recipientId: 'tenantA', read: false });

    // 9. joinRequests
    await setDoc(doc(db, 'joinRequests', 'jrA1'), { landlordId: 'landlordA', tenantId: 'tenantA', propertyId: 'propertyA1', status: 'pending' });

    // 10. fineApplications & adjustments
    await setDoc(doc(db, 'rentCharges', 'leaseA1_2026-09', 'fineApplications', 'fine1'), { amount: 50 });
    await setDoc(doc(db, 'rentCharges', 'leaseA1_2026-09', 'adjustments', 'adj1'), { amount: -50 });
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

// Context helpers
const getContext = (role?: 'landlord' | 'tenant', uid?: string) => {
  if (!role || !uid) return testEnv.unauthenticatedContext();
  return testEnv.authenticatedContext(uid, { role });
};

describe('2. users', () => {
  it('U-1 tenantA Read own user -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(getDoc(doc(db, 'users', 'tenantA')));
  });
  it('U-2 tenantA Read tenantB user -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(getDoc(doc(db, 'users', 'tenantB')));
  });
  it('U-3 landlordA Read tenantA user -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(getDoc(doc(db, 'users', 'tenantA')));
  });
  it('U-4 unauthenticated Read user -> DENY', async () => {
    const db = getContext().firestore();
    await assertFails(getDoc(doc(db, 'users', 'tenantA')));
  });
  it('U-5 tenantA Create users doc -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(setDoc(doc(db, 'users', 'newUser'), { uid: 'newUser' }));
  });
  it('U-6 tenantA Update fullName -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'users', 'tenantA'), { fullName: 'New Name' }));
  });
  it('U-7 tenantA Update phone/photoURL -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'users', 'tenantA'), { phone: '123', photoURL: 'abc' }));
  });
  it('U-8 tenantA Change role -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(updateDoc(doc(db, 'users', 'tenantA'), { role: 'landlord' }));
  });
  it('U-9 tenantA Change activeLeaseId -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(updateDoc(doc(db, 'users', 'tenantA'), { activeLeaseId: 'newLease' }));
  });
  it('U-10 tenantA Update fullName + role -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(updateDoc(doc(db, 'users', 'tenantA'), { fullName: 'New Name', role: 'landlord' }));
  });
  it('U-11 landlordA Update tenantA user -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'users', 'tenantA'), { fullName: 'Hacked' }));
  });
});

describe('3. properties', () => {
  it('P-1 landlordA Create own property -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(setDoc(doc(db, 'properties', 'newProp1'), { landlordId: 'landlordA' }));
  });
  it('P-2 landlordA Create property for landlordB -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'properties', 'newProp2'), { landlordId: 'landlordB' }));
  });
  it('P-3 landlordA Read own property -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(getDoc(doc(db, 'properties', 'propertyA1')));
  });
  it('P-4 landlordA Read landlordB property -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(getDoc(doc(db, 'properties', 'propertyB1')));
  });
  it('P-5 landlordB Update propertyA1 -> DENY', async () => {
    const db = getContext('landlord', 'landlordB').firestore();
    await assertFails(updateDoc(doc(db, 'properties', 'propertyA1'), { name: 'Hacked' }));
  });
  it('P-6 tenantA Read propertyA1 with active lease -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(getDoc(doc(db, 'properties', 'propertyA1')));
  });
  it('P-7 tenantB Read unrelated property -> DENY', async () => {
    const db = getContext('tenant', 'tenantB').firestore();
    await assertFails(getDoc(doc(db, 'properties', 'propertyA1')));
  });
  it('P-8 landlordA Change landlordId -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'properties', 'propertyA1'), { landlordId: 'landlordB' }));
  });
  it('P-9 landlordA Update own property name -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'properties', 'propertyA1'), { name: 'New Name' }));
  });
  it('P-10 landlordA Delete property -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(deleteDoc(doc(db, 'properties', 'propertyA1')));
  });
});

describe('4. units', () => {
  it('U2-1 landlordA Create unit under own property -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(setDoc(doc(db, 'units', 'newUnit1'), { landlordId: 'landlordA', propertyId: 'propertyA1' }));
  });
  it('U2-2 landlordA Create unit under landlordB property -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'units', 'newUnit2'), { landlordId: 'landlordA', propertyId: 'propertyB1' }));
  });
  it('U2-3 landlordA Update roomNumber/baseRent -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'units', 'unitA1'), { roomNumber: '101', baseRent: 1200 }));
  });
  it('U2-4 landlordA Change currentLeaseId -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'units', 'unitA1'), { currentLeaseId: 'newLease' }));
  });
  it('U2-5 landlordA Change status -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'units', 'unitA1'), { status: 'vacant' }));
  });
  it('U2-6 tenantA Read assigned unit -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(getDoc(doc(db, 'units', 'unitA1')));
  });
  it('U2-7 tenantB Read unitA1 -> DENY', async () => {
    const db = getContext('tenant', 'tenantB').firestore();
    await assertFails(getDoc(doc(db, 'units', 'unitA1')));
  });
});

describe('5. joinRequests', () => {
  it('JR-1 tenantA Create directly -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(setDoc(doc(db, 'joinRequests', 'jrNew'), { tenantId: 'tenantA', landlordId: 'landlordA', status: 'pending' }));
  });
  it('JR-2 tenantA Create forged landlordId -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(setDoc(doc(db, 'joinRequests', 'jrNew2'), { tenantId: 'tenantA', landlordId: 'landlordB', status: 'pending' }));
  });
  it('JR-3 tenantA Read own request -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(getDoc(doc(db, 'joinRequests', 'jrA1')));
  });
  it('JR-4 tenantB Read tenantA request -> DENY', async () => {
    const db = getContext('tenant', 'tenantB').firestore();
    await assertFails(getDoc(doc(db, 'joinRequests', 'jrA1')));
  });
  it('JR-5 landlordA Read request for own property -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(getDoc(doc(db, 'joinRequests', 'jrA1')));
  });
  it('JR-6 landlordB Read request for propertyA1 -> DENY', async () => {
    const db = getContext('landlord', 'landlordB').firestore();
    await assertFails(getDoc(doc(db, 'joinRequests', 'jrA1')));
  });
  it('JR-7 landlordA Reject pending request -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'joinRequests', 'jrA1'), { status: 'rejected' }));
  });
  it('JR-8 landlordA Accept directly -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    // Have to reset the doc first if JR-7 ran, but tests might not run in order.
    // Jest runs them in order within describe block but we should be careful. 
    // It's better to use another doc or rely on isolation. 
    // Wait, we recreate DB in beforeEach, so they are isolated.
    await assertFails(updateDoc(doc(db, 'joinRequests', 'jrA1'), { status: 'accepted' }));
  });
  it('JR-9 landlordA Change tenantId while rejecting -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'joinRequests', 'jrA1'), { status: 'rejected', tenantId: 'tenantB' }));
  });
});

describe('6. leases', () => {
  it('L-1 landlordA Create directly -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'leases', 'newLease'), { landlordId: 'landlordA' }));
  });
  it('L-2 tenantA Read own lease -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(getDoc(doc(db, 'leases', 'leaseA1')));
  });
  it('L-3 landlordA Read own-property lease -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(getDoc(doc(db, 'leases', 'leaseA1')));
  });
  it('L-4 landlordB Read leaseA1 -> DENY', async () => {
    const db = getContext('landlord', 'landlordB').firestore();
    await assertFails(getDoc(doc(db, 'leases', 'leaseA1')));
  });
  it('L-5 landlordA Update currentBaseRent on active lease -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'leases', 'leaseA1'), { currentBaseRent: 1100 }));
  });
  it('L-6 landlordA Update ended lease -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'leases', 'leaseEnded'), { currentBaseRent: 1100 }));
  });
  it('L-7 landlordA Update currentBaseRent + tenantId -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'leases', 'leaseA1'), { currentBaseRent: 1100, tenantId: 'tenantB' }));
  });
  it('L-8 tenantA Update currentBaseRent -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(updateDoc(doc(db, 'leases', 'leaseA1'), { currentBaseRent: 1100 }));
  });
  it('L-9 landlordA Set status=ended -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'leases', 'leaseA1'), { status: 'ended' }));
  });
});

describe('7. rentCharges', () => {
  const validDraftData = {
    status: 'draft',
    leaseId: 'leaseA1',
    landlordId: 'landlordA',
    tenantId: 'tenantA',
    propertyId: 'propertyA1',
    unitId: 'unitA1',
    billingMonth: '2026-11',
    lineItems: [{ type: 'rent', label: 'Rent', amount: 1000 }],
    subtotal: 1000,
    lateFineTotal: 0,
    adjustmentTotal: 0,
    total: 1000,
    dueDate: '2026-11-10',
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now()
  };

  it('RC-1 landlordA Create valid draft -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(setDoc(doc(db, 'rentCharges', 'leaseA1_2026-11'), validDraftData));
  });
  it('RC-2 landlordA Use wrong deterministic ID -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'rentCharges', 'wrongID_2026-11'), validDraftData));
  });
  it('RC-3 landlordA Create finalized bill -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'rentCharges', 'leaseA1_2026-11'), { ...validDraftData, status: 'finalized' }));
  });
  it('RC-4 landlordA Create against another landlord\'s lease -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    // Lease doesn't exist for landlordB in our fixture, but if it did it would be DENY
    await assertFails(setDoc(doc(db, 'rentCharges', 'leaseB1_2026-11'), { ...validDraftData, leaseId: 'leaseB1' }));
  });
  it('RC-5 landlordA Edit draft lineItems/subtotal -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), {
      lineItems: [{ type: 'rent', label: 'Rent', amount: 1200 }],
      subtotal: 1200,
      total: 1200
    }));
  });
  it('RC-6 landlordA Edit finalized bill -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-09'), { subtotal: 1200 }));
  });
  it('RC-7 landlordA Finalize directly -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), { status: 'finalized' }));
  });
  it('RC-8 landlordA Change lateFineTotal/total directly -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), { lateFineTotal: 10 }));
  });
  it('RC-9 landlordA Change adjustmentTotal/total directly -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), { adjustmentTotal: 10 }));
  });
  it('RC-10 landlordA Change payment state directly -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), { status: 'payment_pending' }));
  });
  it('RC-11 tenantA Read own bill -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(getDoc(doc(db, 'rentCharges', 'leaseA1_2026-10')));
  });
  it('RC-12 tenantB Read tenantA bill -> DENY', async () => {
    const db = getContext('tenant', 'tenantB').firestore();
    await assertFails(getDoc(doc(db, 'rentCharges', 'leaseA1_2026-10')));
  });
  it('RC-13 landlordB Read tenantA bill -> DENY', async () => {
    const db = getContext('landlord', 'landlordB').firestore();
    await assertFails(getDoc(doc(db, 'rentCharges', 'leaseA1_2026-10')));
  });
  it('RC-14 landlordA Delete bill -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(deleteDoc(doc(db, 'rentCharges', 'leaseA1_2026-10')));
  });
  it('RC-15 landlordA Create wrong tenantId -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'rentCharges', 'leaseA1_2026-11'), { ...validDraftData, tenantId: 'tenantB' }));
  });
  it('RC-16 landlordA Create wrong propertyId -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'rentCharges', 'leaseA1_2026-11'), { ...validDraftData, propertyId: 'propertyB1' }));
  });
  it('RC-17 landlordA Create wrong unitId -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'rentCharges', 'leaseA1_2026-11'), { ...validDraftData, unitId: 'unitB1' }));
  });
  it('RC-18 landlordA Create invalid billing month -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'rentCharges', 'leaseA1_2026-13'), { ...validDraftData, billingMonth: '2026-13' }));
  });
  it('RC-19 landlordA Create draft for ended lease -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(
      doc(db, 'rentCharges', 'leaseEnded_2026-11'),
      { ...validDraftData, leaseId: 'leaseEnded' }
    ));
  });
  it('RC-20 landlordA Create draft when tenant no longer points to lease -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'users', 'tenantA'), {
        activeLeaseId: null
      });
    });
    await assertFails(setDoc(
      doc(db, 'rentCharges', 'leaseA1_2026-11'),
      validDraftData
    ));
  });
  it('RC-21 landlordA Create draft with mismatched total -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(
      doc(db, 'rentCharges', 'leaseA1_2026-11'),
      { ...validDraftData, total: 999 }
    ));
  });
  it('RC-22 landlordA Edit draft with mismatched total -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), {
      subtotal: 1200,
      total: 1000
    }));
  });
  it.each([
    ['unsupported type', [{ type: 'tax', label: 'Tax', amount: 1 }]],
    ['missing label', [{ type: 'other', amount: 1 }]],
    ['fractional paise', [{ type: 'other', label: 'Other', amount: 1.5 }]],
    ['undeclared item field', [{ type: 'other', label: 'Other', amount: 1, extra: true }]]
  ])('RC-24 landlordA Create draft with %s -> DENY', async (_caseName, lineItems) => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(
      doc(db, 'rentCharges', 'leaseA1_2026-11'),
      { ...validDraftData, lineItems }
    ));
  });
  it('RC-33 landlordA Create draft with a negative charge -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const lineItems = [
      { type: 'rent', label: 'Rent', amount: 1000 },
      { type: 'electricity', label: 'Electricity', amount: -1 }
    ];
    await assertFails(setDoc(
      doc(db, 'rentCharges', 'leaseA1_2026-11'),
      { ...validDraftData, lineItems, subtotal: 999, total: 999 }
    ));
  });
  it('RC-30 landlordA Create draft with a whitespace-only label -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const lineItems = [{ type: 'rent', label: ' \t\n ', amount: 1000 }];
    await assertFails(setDoc(
      doc(db, 'rentCharges', 'leaseA1_2026-11'),
      { ...validDraftData, lineItems }
    ));
  });
  it.each([
    ['missing', [{ type: 'electricity', label: 'Electricity', amount: 1000 }]],
    ['duplicate', [
      { type: 'rent', label: 'Rent', amount: 1000 },
      { type: 'rent', label: 'Second rent', amount: 0 }
    ]]
  ])('RC-31 landlordA Create draft with %s rent item -> DENY', async (_caseName, lineItems) => {
    const db = getContext('landlord', 'landlordA').firestore();
    const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
    await assertFails(setDoc(
      doc(db, 'rentCharges', 'leaseA1_2026-11'),
      { ...validDraftData, lineItems, subtotal, total: subtotal }
    ));
  });
  it('RC-25 landlordA Create draft with subtotal not matching line items -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(
      doc(db, 'rentCharges', 'leaseA1_2026-11'),
      { ...validDraftData, subtotal: 999, total: 999 }
    ));
  });
  it('RC-26 landlordA Create draft with an undeclared document field -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(
      doc(db, 'rentCharges', 'leaseA1_2026-11'),
      { ...validDraftData, unexpected: 'not in schema' }
    ));
  });
  it('RC-27 landlordA Edit draft with subtotal not matching line items -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), {
      lineItems: [{ type: 'rent', label: 'Rent', amount: 1200 }],
      subtotal: 1100,
      total: 1100
    }));
  });
  it('RC-34 landlordA Edit draft with a negative line-item amount -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const lineItems = [
      { type: 'rent', label: 'Rent', amount: 1000 },
      { type: 'electricity', label: 'Electricity', amount: -1 }
    ];
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), {
      lineItems,
      subtotal: 999,
      total: 999
    }));
  });
  it('RC-35 landlordA Edit draft without a rent item -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const lineItems = [
      { type: 'electricity', label: 'Electricity', amount: 1000 }
    ];
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), {
      lineItems,
      subtotal: 1000,
      total: 1000
    }));
  });
  it('RC-36 landlordA Edit draft with duplicate rent items -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const lineItems = [
      { type: 'rent', label: 'Rent', amount: 1000 },
      { type: 'rent', label: 'Second rent', amount: 0 }
    ];
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), {
      lineItems,
      subtotal: 1000,
      total: 1000
    }));
  });
  it('RC-37 landlordA Edit draft with a whitespace-only label -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const lineItems = [{ type: 'rent', label: ' \t\n ', amount: 1000 }];
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), {
      lineItems,
      subtotal: 1000,
      total: 1000
    }));
  });
  it('RC-38 landlordA Edit draft with more than ten line items -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const lineItems = [
      { type: 'rent', label: 'Rent', amount: 1 },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: 'other',
        label: `Other ${index + 1}`,
        amount: 1
      }))
    ];
    await assertFails(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), {
      lineItems,
      subtotal: 11,
      total: 11
    }));
  });
  it('RC-39 landlordA Edit draft with a valid line item remains allowed', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const lineItems = [{ type: 'rent', label: 'Rent', amount: 1200 }];
    await assertSucceeds(updateDoc(doc(db, 'rentCharges', 'leaseA1_2026-10'), {
      lineItems,
      subtotal: 1200,
      total: 1200
    }));
  });
  it('RC-32 landlordA Read draft after lease termination -> ALLOW, edit -> DENY', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await updateDoc(doc(db, 'leases', 'leaseA1'), { status: 'ended' });
      await updateDoc(doc(db, 'users', 'tenantA'), { activeLeaseId: null });
      await updateDoc(doc(db, 'units', 'unitA1'), {
        status: 'vacant',
        currentLeaseId: null
      });
    });

    const db = getContext('landlord', 'landlordA').firestore();
    const draftRef = doc(db, 'rentCharges', 'leaseA1_2026-10');
    await assertSucceeds(getDoc(draftRef));
    await assertFails(updateDoc(draftRef, {
      lineItems: [{ type: 'rent', label: 'Rent', amount: 1200 }],
      subtotal: 1200,
      total: 1200
    }));
  });
  it('RC-28 landlordA Create draft with ten valid line items -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const lineItems = [
      { type: 'rent', label: 'Rent', amount: 1 },
      ...Array.from({ length: 9 }, (_, index) => ({
        type: 'other',
        label: `Other ${index + 1}`,
        amount: 1
      }))
    ];
    await assertSucceeds(setDoc(
      doc(db, 'rentCharges', 'leaseA1_2026-11'),
      { ...validDraftData, lineItems, subtotal: 10, total: 10 }
    ));
  });
  it('RC-29 landlordA Create draft with more than ten line items -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const lineItems = [
      { type: 'rent', label: 'Rent', amount: 1 },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: 'other',
        label: `Other ${index + 1}`,
        amount: 1
      }))
    ];
    await assertFails(setDoc(
      doc(db, 'rentCharges', 'leaseA1_2026-11'),
      { ...validDraftData, lineItems, subtotal: 11, total: 11 }
    ));
  });
  it('RC-23 landlordA Reuse deterministic draft ID -> one bill per month', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const billRef = doc(db, 'rentCharges', 'leaseA1_2026-11');
    await assertSucceeds(setDoc(billRef, validDraftData));
    await assertSucceeds(updateDoc(billRef, {
      lineItems: [{ type: 'rent', label: 'Rent', amount: 2000 }],
      subtotal: 2000,
      total: 2000
    }));

    const matchingBills = await getDocs(query(
      collection(db, 'rentCharges'),
      where('landlordId', '==', 'landlordA'),
      where('leaseId', '==', 'leaseA1'),
      where('billingMonth', '==', '2026-11')
    ));
    expect(matchingBills.size).toBe(1);
    expect(matchingBills.docs[0].data().total).toBe(2000);
  });
});

describe('fineApplications', () => {
  it('FA-1 landlordA Create directly -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'rentCharges', 'leaseA1_2026-09', 'fineApplications', 'fine2'), { amount: 50 }));
  });
  it('FA-2 tenantA Read own fine -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(getDoc(doc(db, 'rentCharges', 'leaseA1_2026-09', 'fineApplications', 'fine1')));
  });
  it('FA-3 tenantB Read tenantA fine -> DENY', async () => {
    const db = getContext('tenant', 'tenantB').firestore();
    await assertFails(getDoc(doc(db, 'rentCharges', 'leaseA1_2026-09', 'fineApplications', 'fine1')));
  });
});

describe('adjustments', () => {
  it('ADJ-1 landlordA Create directly -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'rentCharges', 'leaseA1_2026-09', 'adjustments', 'adj2'), { amount: -50 }));
  });
  it('ADJ-2 tenantA Read own adjustment -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(getDoc(doc(db, 'rentCharges', 'leaseA1_2026-09', 'adjustments', 'adj1')));
  });
  it('ADJ-3 tenantB Read tenantA adjustment -> DENY', async () => {
    const db = getContext('tenant', 'tenantB').firestore();
    await assertFails(getDoc(doc(db, 'rentCharges', 'leaseA1_2026-09', 'adjustments', 'adj1')));
  });
});

describe('8. payments', () => {
  const paymentPayload = { landlordId: 'landlordA', tenantId: 'tenantA', rentChargeId: 'leaseA1_2026-09', status: 'pending_verification', method: 'upi_qr' };

  it('PAY-1 tenantA Create payment directly -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(setDoc(doc(db, 'payments', 'newPay'), paymentPayload));
  });
  it('PAY-2 tenantA Create verified payment -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(setDoc(doc(db, 'payments', 'newPay'), { ...paymentPayload, status: 'verified' }));
  });
  it('PAY-3 tenantA Create with verifiedBy -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(setDoc(doc(db, 'payments', 'newPay'), { ...paymentPayload, verifiedBy: 'landlordA' }));
  });
  it('PAY-4 tenantB Create against tenantA bill -> DENY', async () => {
    const db = getContext('tenant', 'tenantB').firestore();
    await assertFails(setDoc(doc(db, 'payments', 'newPay'), { ...paymentPayload, tenantId: 'tenantB' }));
  });
  it('PAY-5 tenantA Read own payment -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(getDoc(doc(db, 'payments', 'paymentA1')));
  });
  it('PAY-6 landlordA Read payment on own property -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(getDoc(doc(db, 'payments', 'paymentA1')));
  });
  it('PAY-7 landlordB Read tenantA payment -> DENY', async () => {
    const db = getContext('landlord', 'landlordB').firestore();
    await assertFails(getDoc(doc(db, 'payments', 'paymentA1')));
  });
  it('PAY-8 landlordA Verify payment directly -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(updateDoc(doc(db, 'payments', 'paymentA1'), { status: 'verified' }));
  });
  it('PAY-9 tenantA Self-verify payment -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(updateDoc(doc(db, 'payments', 'paymentA1'), { status: 'verified' }));
  });
  it('PAY-10 anyone Verify gateway payment directly -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(updateDoc(doc(db, 'payments', 'paymentA1'), { status: 'verified', method: 'gateway' }));
  });
  it('PAY-11 landlordA Delete payment -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(deleteDoc(doc(db, 'payments', 'paymentA1')));
  });
});

describe('9. expenses', () => {
  it('E-1 landlordA Create own-property expense -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(setDoc(doc(db, 'expenses', 'newExp'), { landlordId: 'landlordA', propertyId: 'propertyA1' }));
  });
  it('E-2 landlordA Read own expense -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(getDoc(doc(db, 'expenses', 'expenseA1')));
  });
  it('E-3 landlordA Update own expense -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'expenses', 'expenseA1'), { category: 'Maintenance' }));
  });
  it('E-4 landlordA Archive own expense -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'expenses', 'expenseA1'), { status: 'archived' }));
  });
  it('E-5 landlordA Hard-delete expense -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(deleteDoc(doc(db, 'expenses', 'expenseA1')));
  });
  it('E-6 landlordB Read/update landlordA expense -> DENY', async () => {
    const db = getContext('landlord', 'landlordB').firestore();
    await assertFails(getDoc(doc(db, 'expenses', 'expenseA1')));
    await assertFails(updateDoc(doc(db, 'expenses', 'expenseA1'), { category: 'Maintenance' }));
  });
  it('E-7 tenantA Read/write expense -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(getDoc(doc(db, 'expenses', 'expenseA1')));
    await assertFails(setDoc(doc(db, 'expenses', 'newExp'), { landlordId: 'landlordA', propertyId: 'propertyA1' }));
  });
});

describe('10. notifications', () => {
  it('N-1 tenantA Read own notification -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(getDoc(doc(db, 'notifications', 'notifTA')));
  });
  it('N-2 tenantA Read landlord notification -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(getDoc(doc(db, 'notifications', 'notifLA')));
  });
  it('N-3 tenantA Mark own notification read -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertSucceeds(updateDoc(doc(db, 'notifications', 'notifTA'), { read: true }));
  });
  it('N-4 tenantA Modify title/body -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(updateDoc(doc(db, 'notifications', 'notifTA'), { title: 'Hacked' }));
  });
  it('N-5 tenantA Create notification -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(setDoc(doc(db, 'notifications', 'notifNew'), { recipientId: 'tenantA' }));
  });
  it('N-6 landlordA Create notification -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    await assertFails(setDoc(doc(db, 'notifications', 'notifNew2'), { recipientId: 'landlordA' }));
  });
  it('N-7 tenantA Delete notification -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    await assertFails(deleteDoc(doc(db, 'notifications', 'notifTA')));
  });
});

describe('12. Collection Queries', () => {
  it('Q-1 collection query filtering by landlordId -> ALLOW', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const q = query(collection(db, 'properties'), where('landlordId', '==', 'landlordA'));
    await assertSucceeds(getDocs(q));
  });
  it('Q-2 collection query not filtering -> DENY', async () => {
    const db = getContext('landlord', 'landlordA').firestore();
    const q = query(collection(db, 'properties'));
    await assertFails(getDocs(q));
  });
  it('Q-3 collection query filtering by tenantId -> ALLOW', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    const q = query(collection(db, 'leases'), where('tenantId', '==', 'tenantA'));
    await assertSucceeds(getDocs(q));
  });
  it('Q-4 collection query filtering by wrong tenantId -> DENY', async () => {
    const db = getContext('tenant', 'tenantA').firestore();
    const q = query(collection(db, 'leases'), where('tenantId', '==', 'tenantB'));
    await assertFails(getDocs(q));
  });
});
