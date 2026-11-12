const projectId = "demo-rently";
const authEmulatorPort =
  process.env.PHASE3_AUTH_EMULATOR_PORT ?? "9099";
const firestoreEmulatorPort =
  process.env.PHASE3_FIRESTORE_EMULATOR_PORT ?? "8080";
const functionsEmulatorPort =
  process.env.PHASE3_FUNCTIONS_EMULATOR_PORT ?? "5001";

process.env.GCLOUD_PROJECT = projectId;
process.env.FIREBASE_CONFIG = JSON.stringify({projectId});
process.env.FIREBASE_AUTH_EMULATOR_HOST =
  `127.0.0.1:${authEmulatorPort}`;
process.env.FIRESTORE_EMULATOR_HOST =
  `127.0.0.1:${firestoreEmulatorPort}`;

import type {DocumentReference} from "firebase-admin/firestore";
import {randomUUID} from "crypto";

jest.setTimeout(30000);

let admin: typeof import("firebase-admin");
const authEmulatorUrl =
  `http://127.0.0.1:${authEmulatorPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`;
const functionsEmulatorUrl =
  `http://127.0.0.1:${functionsEmulatorPort}/${projectId}/us-central1`;

type Role = "landlord" | "tenant";

interface TestUser {
  uid: string;
  role: Role;
  idToken: string;
}

interface CallableResponse {
  result?: Record<string, unknown>;
  error?: {
    status: string;
    message: string;
  };
}

interface Fixture {
  landlord: TestUser;
  otherLandlord: TestUser;
  tenant: TestUser;
  propertyId: string;
  otherPropertyId: string;
  vacantUnitId: string;
  occupiedUnitId: string;
  authUids: string[];
  propertyIds: string[];
  tenantIds: string[];
  leaseIds: string[];
  rentChargeIds: string[];
}

let fixture: Fixture;

const firestore = () => admin.firestore();
const auth = () => admin.auth();

/**
 * Creates an Auth emulator account and returns a role-claimed emulator token.
 * @param {Role} role Custom role claim for this test account
 * @return {Promise<TestUser>} Authenticated test user
 */
async function createUser(role: Role): Promise<TestUser> {
  const uid = `phase3-${role}-${randomUUID()}`;
  await auth().createUser({uid});
  await auth().setCustomUserClaims(uid, {role});

  const customToken = await auth().createCustomToken(uid);
  const response = await fetch(authEmulatorUrl, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({token: customToken, returnSecureToken: true}),
  });
  const signInResult = await response.json() as {
    idToken?: string;
    error?: unknown;
  };
  if (!response.ok || !signInResult.idToken) {
    throw new Error(
      `Could not obtain an emulator ID token: ${JSON.stringify(signInResult)}`
    );
  }

  return {uid, role, idToken: signInResult.idToken};
}

/**
 * Invokes a callable through the Functions emulator HTTP endpoint.
 * @param {string} name Callable function name
 * @param {TestUser} caller Authenticated emulator user
 * @param {Record<string, unknown>} data Callable input
 * @return {Promise<CallableResponse>} Callable protocol response
 */
async function callFunction(
  name: string,
  caller: TestUser,
  data: Record<string, unknown>
): Promise<CallableResponse> {
  const response = await fetch(`${functionsEmulatorUrl}/${name}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${caller.idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({data}),
  });
  return await response.json() as CallableResponse;
}

/**
 * Invokes a callable through the Functions emulator without an auth token.
 * @param {string} name Callable function name
 * @param {Record<string, unknown>} data Callable input
 * @return {Promise<CallableResponse>} Callable protocol response
 */
async function callUnauthenticatedFunction(
  name: string,
  data: Record<string, unknown>
): Promise<CallableResponse> {
  const response = await fetch(`${functionsEmulatorUrl}/${name}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({data}),
  });
  return await response.json() as CallableResponse;
}

/**
 * Seeds a pending join request for an acceptance test.
 * @param {string} tenantId Requesting tenant UID
 * @param {string} propertyId Target property ID
 * @param {string} landlordId Owning landlord UID
 * @param {string} propertyName Property name stored on the request
 * @return {Promise<string>} New join request ID
 */
async function addJoinRequest(
  tenantId: string,
  propertyId: string,
  landlordId: string,
  propertyName: string
): Promise<string> {
  const ref = firestore().collection("joinRequests").doc();
  await ref.set({
    tenantId,
    propertyId,
    landlordId,
    propertyName,
    status: "pending",
    requestedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/**
 * Creates a tenant profile in the Firestore emulator for a scenario.
 * @param {TestUser} tenant Authenticated tenant
 * @return {Promise<void>} Resolves after the tenant profile is saved
 */
async function createTenantProfile(tenant: TestUser): Promise<void> {
  await firestore().collection("users").doc(tenant.uid).set({
    uid: tenant.uid,
    role: "tenant",
    fullName: "Phase 3 Tenant",
    phone: "555-0100",
    email: "phase3@example.test",
    activeLeaseId: null,
  });
}

/**
 * Creates a consistent active lease fixture for billing tests.
 * @return {Promise<string>} New lease ID
 */
async function createBillingLease(): Promise<string> {
  const leaseId = `phase5-lease-${randomUUID()}`;
  const now = admin.firestore.FieldValue.serverTimestamp();
  await Promise.all([
    firestore().collection("leases").doc(leaseId).set({
      tenantId: fixture.tenant.uid,
      landlordId: fixture.landlord.uid,
      propertyId: fixture.propertyId,
      unitId: fixture.occupiedUnitId,
      joiningDate: "2026-01-01",
      currentBaseRent: 125000,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
    firestore().collection("units").doc(fixture.occupiedUnitId).update({
      status: "occupied",
      currentLeaseId: leaseId,
    }),
    firestore().collection("users").doc(fixture.tenant.uid).update({
      activeLeaseId: leaseId,
    }),
  ]);
  fixture.leaseIds.push(leaseId);
  return leaseId;
}

/**
 * Seeds a draft bill with the schema's deterministic lease/month ID.
 * @param {string} leaseId Lease referenced by the bill
 * @param {Record<string, unknown>} overrides Test-only field overrides
 * @return {Promise<string>} New rent charge ID
 */
async function addRentChargeDraft(
  leaseId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const billingMonth = (overrides.billingMonth as string | undefined) ??
    "2026-11";
  const rentChargeId = `${leaseId}_${billingMonth}`;
  const lineItems = [
    {type: "rent", label: "Rent", amount: 125000},
    {type: "electricity", label: "Electricity", amount: 12345},
    {type: "maintenance", label: "Maintenance", amount: 5000},
    {type: "other", label: "Other", amount: 250},
  ];
  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await firestore().collection("rentCharges").doc(rentChargeId).set({
    leaseId,
    tenantId: fixture.tenant.uid,
    landlordId: fixture.landlord.uid,
    propertyId: fixture.propertyId,
    unitId: fixture.occupiedUnitId,
    billingMonth,
    lineItems,
    subtotal,
    lateFineTotal: 0,
    adjustmentTotal: 0,
    total: subtotal,
    dueDate: `${billingMonth}-10`,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  fixture.rentChargeIds.push(rentChargeId);
  return rentChargeId;
}

/**
 * Deletes all documents matching one field value at a time.
 * @param {string} collectionName Firestore collection to clean
 * @param {string} field Query field
 * @param {string[]} values Values to query and delete
 * @return {Promise<void>} Resolves after all matching documents are deleted
 */
async function deleteMatching(
  collectionName: string,
  field: string,
  values: string[]
): Promise<void> {
  const refs: DocumentReference[] = [];
  for (const value of values) {
    const snapshot = await firestore()
      .collection(collectionName)
      .where(field, "==", value)
      .get();
    refs.push(...snapshot.docs.map((doc) => doc.ref));
  }

  for (let offset = 0; offset < refs.length; offset += 400) {
    const batch = firestore().batch();
    refs.slice(offset, offset + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

/**
 * Removes documents and Auth accounts created for the current test.
 * @return {Promise<void>} Resolves after cleanup
 */
async function cleanupFixture(): Promise<void> {
  if (!fixture) return;

  for (const rentChargeId of fixture.rentChargeIds) {
    const adjustments = await firestore()
      .collection("rentCharges")
      .doc(rentChargeId)
      .collection("adjustments")
      .get();
    const batch = firestore().batch();
    adjustments.docs.forEach((doc) => batch.delete(doc.ref));
    if (!adjustments.empty) await batch.commit();
    await firestore().collection("rentCharges").doc(rentChargeId).delete();
  }
  await deleteMatching("joinRequests", "tenantId", fixture.tenantIds);
  await deleteMatching("leases", "tenantId", fixture.tenantIds);
  await deleteMatching("units", "propertyId", fixture.propertyIds);
  await deleteMatching("properties", "landlordId", [
    fixture.landlord.uid,
    fixture.otherLandlord.uid,
  ]);
  for (const uid of fixture.authUids) {
    await firestore().collection("users").doc(uid).delete();
    await auth().deleteUser(uid);
  }
}

beforeAll(() => {
  return import("firebase-admin").then((firebaseAdminModule) => {
    admin = firebaseAdminModule.default;
    if (admin.apps.length) return;
    admin.initializeApp({projectId});
  });
});

beforeEach(async () => {
  const landlord = await createUser("landlord");
  const otherLandlord = await createUser("landlord");
  const tenant = await createUser("tenant");
  const propertyId = `phase3-property-${randomUUID()}`;
  const otherPropertyId = `phase3-property-${randomUUID()}`;
  const vacantUnitId = `phase3-unit-${randomUUID()}`;
  const occupiedUnitId = `phase3-unit-${randomUUID()}`;

  fixture = {
    landlord,
    otherLandlord,
    tenant,
    propertyId,
    otherPropertyId,
    vacantUnitId,
    occupiedUnitId,
    authUids: [landlord.uid, otherLandlord.uid, tenant.uid],
    propertyIds: [propertyId, otherPropertyId],
    tenantIds: [tenant.uid],
    leaseIds: [],
    rentChargeIds: [],
  };

  const db = firestore();
  const now = admin.firestore.FieldValue.serverTimestamp();
  await Promise.all([
    db.collection("users").doc(landlord.uid).set({
      uid: landlord.uid,
      role: "landlord",
      fullName: "Phase 3 Landlord",
      activeLeaseId: null,
    }),
    db.collection("users").doc(otherLandlord.uid).set({
      uid: otherLandlord.uid,
      role: "landlord",
      fullName: "Other Phase 3 Landlord",
      activeLeaseId: null,
    }),
    db.collection("users").doc(tenant.uid).set({
      uid: tenant.uid,
      role: "tenant",
      fullName: "Phase 3 Tenant",
      phone: "555-0100",
      email: "phase3@example.test",
      activeLeaseId: null,
    }),
    db.collection("properties").doc(propertyId).set({
      landlordId: landlord.uid,
      name: "Phase 3 Property",
      address: "100 Emulator Lane",
      joinCode: `P3${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
    db.collection("properties").doc(otherPropertyId).set({
      landlordId: otherLandlord.uid,
      name: "Other Phase 3 Property",
      address: "200 Emulator Lane",
      joinCode: `P3${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
    db.collection("units").doc(vacantUnitId).set({
      propertyId,
      landlordId: landlord.uid,
      roomNumber: "302",
      baseRent: 125000,
      status: "vacant",
      currentLeaseId: null,
      createdAt: now,
      updatedAt: now,
    }),
    db.collection("units").doc(occupiedUnitId).set({
      propertyId,
      landlordId: landlord.uid,
      roomNumber: "303",
      baseRent: 130000,
      status: "occupied",
      currentLeaseId: "existing-lease",
      createdAt: now,
      updatedAt: now,
    }),
  ]);
});

afterEach(async () => {
  await cleanupFixture();
});

afterAll(async () => {
  await admin.app().delete();
});

describe("resolveJoinCode emulator integration", () => {
  it(
    "resolves an active property for a tenant without exposing private fields",
    async () => {
      const property = await firestore()
        .collection("properties")
        .doc(fixture.propertyId)
        .get();
      const response = await callFunction("resolveJoinCode", fixture.tenant, {
        joinCode: property.data()?.joinCode.toLowerCase(),
      }
      );

      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({
        propertyId: fixture.propertyId,
        name: "Phase 3 Property",
        address: "100 Emulator Lane",
      });
    });

  it("rejects an invalid code", async () => {
    const response = await callFunction("resolveJoinCode", fixture.tenant, {
      joinCode: "NO-MATCH",
    });

    expect(response.error?.status).toBe("NOT_FOUND");
  });

  it("rejects a landlord caller", async () => {
    const response = await callFunction(
      "resolveJoinCode",
      fixture.landlord,
      {joinCode: "NO-MATCH"}
    );

    expect(response.error?.status).toBe("PERMISSION_DENIED");
  });
});

describe("createJoinRequest emulator integration", () => {
  it(
    "creates a valid request with server-derived landlord and property data",
    async () => {
      const response = await callFunction(
        "createJoinRequest",
        fixture.tenant,
        {propertyId: fixture.propertyId, message: "Interested in room"}
      );

      expect(response.error).toBeUndefined();
      expect(response.result?.success).toBe(true);
      const request = await firestore()
        .collection("joinRequests")
        .doc(response.result?.joinRequestId as string)
        .get();
      expect(request.data()).toMatchObject({
        tenantId: fixture.tenant.uid,
        landlordId: fixture.landlord.uid,
        propertyId: fixture.propertyId,
        propertyName: "Phase 3 Property",
        status: "pending",
        message: "Interested in room",
      }
      );
    });

  it(
    "returns the existing request for a duplicate pending application",
    async () => {
      const first = await callFunction(
        "createJoinRequest",
        fixture.tenant,
        {propertyId: fixture.propertyId}
      );
      const second = await callFunction(
        "createJoinRequest",
        fixture.tenant,
        {propertyId: fixture.propertyId}
      );

      expect(first.error).toBeUndefined();
      expect(second.error).toBeUndefined();
      expect(second.result?.joinRequestId).toBe(first.result?.joinRequestId);
      const requests = await firestore()
        .collection("joinRequests")
        .where("tenantId", "==", fixture.tenant.uid)
        .where("propertyId", "==", fixture.propertyId)
        .where("status", "==", "pending")
        .get();
      expect(requests.size).toBe(1);
    }
  );

  it("rejects a tenant with an active lease", async () => {
    await firestore().collection("users").doc(fixture.tenant.uid).update({
      activeLeaseId: "existing-lease",
    });

    const response = await callFunction(
      "createJoinRequest",
      fixture.tenant,
      {propertyId: fixture.propertyId}
    );

    expect(response.error?.status).toBe("FAILED_PRECONDITION");
  });

  it("rejects a landlord caller", async () => {
    const response = await callFunction(
      "createJoinRequest",
      fixture.landlord,
      {propertyId: fixture.propertyId}
    );

    expect(response.error?.status).toBe("PERMISSION_DENIED");
  });
});

describe("acceptJoinRequest emulator integration", () => {
  it(
    "creates an active lease, occupies the unit, links the tenant, " +
      "and rejects requests",
    async () => {
      const requestId = await addJoinRequest(
        fixture.tenant.uid,
        fixture.propertyId,
        fixture.landlord.uid,
        "Phase 3 Property"
      );
      const otherRequestId = await addJoinRequest(
        fixture.tenant.uid,
        fixture.otherPropertyId,
        fixture.otherLandlord.uid,
        "Other Phase 3 Property"
      );

      const response = await callFunction(
        "acceptJoinRequest",
        fixture.landlord,
        {joinRequestId: requestId, unitId: fixture.vacantUnitId}
      );

      expect(response.error).toBeUndefined();
      expect(response.result?.success).toBe(true);
      expect(response.result?.autoRejectedCount).toBe(1);

      const leaseId = response.result?.leaseId as string;
      const [lease, unit, tenant, acceptedRequest, rejectedRequest] =
      await Promise.all([
        firestore().collection("leases").doc(leaseId).get(),
        firestore().collection("units").doc(fixture.vacantUnitId).get(),
        firestore().collection("users").doc(fixture.tenant.uid).get(),
        firestore().collection("joinRequests").doc(requestId).get(),
        firestore().collection("joinRequests").doc(otherRequestId).get(),
      ]);

      expect(lease.data()).toMatchObject({
        tenantId: fixture.tenant.uid,
        landlordId: fixture.landlord.uid,
        propertyId: fixture.propertyId,
        unitId: fixture.vacantUnitId,
        roomNumber: "302",
        joiningDate: expect.any(String),
        currentBaseRent: 125000,
        status: "active",
      }
      );
      expect(unit.data()).toMatchObject({
        status: "occupied",
        currentLeaseId: leaseId,
      });
      expect(tenant.data()?.activeLeaseId).toBe(leaseId);
      expect(acceptedRequest.data()?.status).toBe("accepted");
      expect(rejectedRequest.data()).toMatchObject({
        status: "rejected",
        autoRejected: true,
      });
      expect(rejectedRequest.data()?.respondedBy).toBeUndefined();
    });

  it("rejects a landlord who does not own the request", async () => {
    const requestId = await addJoinRequest(
      fixture.tenant.uid,
      fixture.propertyId,
      fixture.landlord.uid,
      "Phase 3 Property"
    );

    const response = await callFunction(
      "acceptJoinRequest",
      fixture.otherLandlord,
      {joinRequestId: requestId, unitId: fixture.vacantUnitId}
    );

    expect(response.error?.status).toBe("PERMISSION_DENIED");
  });

  it("rejects assignment to an occupied unit", async () => {
    const requestId = await addJoinRequest(
      fixture.tenant.uid,
      fixture.propertyId,
      fixture.landlord.uid,
      "Phase 3 Property"
    );

    const response = await callFunction(
      "acceptJoinRequest",
      fixture.landlord,
      {joinRequestId: requestId, unitId: fixture.occupiedUnitId}
    );

    expect(response.error?.status).toBe("FAILED_PRECONDITION");
  });

  it("rejects a tenant caller", async () => {
    const requestId = await addJoinRequest(
      fixture.tenant.uid,
      fixture.propertyId,
      fixture.landlord.uid,
      "Phase 3 Property"
    );

    const response = await callFunction(
      "acceptJoinRequest",
      fixture.tenant,
      {joinRequestId: requestId, unitId: fixture.vacantUnitId}
    );

    expect(response.error?.status).toBe("PERMISSION_DENIED");
  });

  it(
    "keeps the third of three requests pending until a unit becomes vacant",
    async () => {
      const secondTenant = await createUser("tenant");
      const thirdTenant = await createUser("tenant");
      fixture.authUids.push(secondTenant.uid, thirdTenant.uid);
      fixture.tenantIds.push(secondTenant.uid, thirdTenant.uid);
      await Promise.all([
        createTenantProfile(secondTenant),
        createTenantProfile(thirdTenant),
        firestore().collection("units").doc(fixture.occupiedUnitId).update({
          status: "vacant",
          currentLeaseId: null,
        }),
      ]);

      const [firstRequestId, secondRequestId, thirdRequestId] =
        await Promise.all([
          addJoinRequest(
            fixture.tenant.uid,
            fixture.propertyId,
            fixture.landlord.uid,
            "Phase 3 Property"
          ),
          addJoinRequest(
            secondTenant.uid,
            fixture.propertyId,
            fixture.landlord.uid,
            "Phase 3 Property"
          ),
          addJoinRequest(
            thirdTenant.uid,
            fixture.propertyId,
            fixture.landlord.uid,
            "Phase 3 Property"
          ),
        ]);

      const firstAcceptance = await callFunction(
        "acceptJoinRequest",
        fixture.landlord,
        {joinRequestId: firstRequestId, unitId: fixture.vacantUnitId}
      );
      const secondAcceptance = await callFunction(
        "acceptJoinRequest",
        fixture.landlord,
        {joinRequestId: secondRequestId, unitId: fixture.occupiedUnitId}
      );

      expect(firstAcceptance.error).toBeUndefined();
      expect(secondAcceptance.error).toBeUndefined();

      const unavailableAttempt = await callFunction(
        "acceptJoinRequest",
        fixture.landlord,
        {joinRequestId: thirdRequestId, unitId: fixture.vacantUnitId}
      );
      expect(unavailableAttempt.error?.status).toBe("FAILED_PRECONDITION");
      let thirdRequest = await firestore()
        .collection("joinRequests")
        .doc(thirdRequestId)
        .get();
      expect(thirdRequest.data()?.status).toBe("pending");

      const releasedLease = await callFunction(
        "endLease",
        fixture.landlord,
        {
          leaseId: firstAcceptance.result?.leaseId,
          endDate: new Date().toISOString().slice(0, 10),
        }
      );
      expect(releasedLease.error).toBeUndefined();

      const finalAcceptance = await callFunction(
        "acceptJoinRequest",
        fixture.landlord,
        {joinRequestId: thirdRequestId, unitId: fixture.vacantUnitId}
      );
      expect(finalAcceptance.error).toBeUndefined();
      expect(finalAcceptance.result?.success).toBe(true);

      thirdRequest = await firestore()
        .collection("joinRequests")
        .doc(thirdRequestId)
        .get();
      const assignedUnit = await firestore()
        .collection("units")
        .doc(fixture.vacantUnitId)
        .get();
      expect(thirdRequest.data()?.status).toBe("accepted");
      expect(assignedUnit.data()?.status).toBe("occupied");
      expect(assignedUnit.data()?.currentLeaseId).toBe(
        finalAcceptance.result?.leaseId
      );
    }
  );
});

describe("monthly rent-charge emulator integration", () => {
  it(
    "finalizes a bill using integer paise and the tenth as its due date",
    async () => {
      const leaseId = await createBillingLease();
      const rentChargeId = await addRentChargeDraft(leaseId);

      const response = await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId}
      );

      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({
        success: true,
        rentChargeId,
        dueDate: "2026-11-10",
        total: 142595,
      });

      const finalized = await firestore()
        .collection("rentCharges")
        .doc(rentChargeId)
        .get();
      expect(finalized.data()).toMatchObject({
        status: "finalized",
        subtotal: 142595,
        total: 142595,
        dueDate: "2026-11-10",
        finalizedBy: fixture.landlord.uid,
        lineItems: [
          {type: "rent", amount: 125000},
          {type: "electricity", amount: 12345},
          {type: "maintenance", amount: 5000},
          {type: "other", amount: 250},
        ],
      });
      expect(finalized.data()?.finalizedAt).toBeInstanceOf(
        admin.firestore.Timestamp
      );
    }
  );

  it(
    "rejects tenant and unauthenticated callers without changing the draft",
    async () => {
      const leaseId = await createBillingLease();
      const rentChargeId = await addRentChargeDraft(leaseId);

      const tenantResponse = await callFunction(
        "finalizeRentCharge",
        fixture.tenant,
        {rentChargeId}
      );
      const unauthenticatedResponse = await callUnauthenticatedFunction(
        "finalizeRentCharge",
        {rentChargeId}
      );

      expect(tenantResponse.error?.status).toBe("PERMISSION_DENIED");
      expect(unauthenticatedResponse.error?.status).toBe("UNAUTHENTICATED");
      expect(
        (await firestore().collection("rentCharges").doc(rentChargeId).get())
          .data()?.status
      ).toBe("draft");
    }
  );

  it(
    "rejects a landlord who does not own the bill",
    async () => {
      const leaseId = await createBillingLease();
      const rentChargeId = await addRentChargeDraft(leaseId);

      const response = await callFunction(
        "finalizeRentCharge",
        fixture.otherLandlord,
        {rentChargeId}
      );

      expect(response.error?.status).toBe("PERMISSION_DENIED");
      expect(
        (await firestore().collection("rentCharges").doc(rentChargeId).get())
          .data()?.status
      ).toBe("draft");
    }
  );

  it(
    "rejects malformed billing months and missing referenced leases",
    async () => {
      const leaseId = await createBillingLease();
      const invalidMonthId = await addRentChargeDraft(leaseId, {
        billingMonth: "2026-13",
      });
      const invalidMonthResponse = await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId: invalidMonthId}
      );

      expect(invalidMonthResponse.error?.status).toBe("INVALID_ARGUMENT");

      const missingLeaseId = await addRentChargeDraft(
        `missing-lease-${randomUUID()}`
      );
      const missingLeaseResponse = await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId: missingLeaseId}
      );

      expect(missingLeaseResponse.error?.status).toBe("NOT_FOUND");
      expect(
        (await firestore().collection("rentCharges").doc(invalidMonthId).get())
          .data()?.status
      ).toBe("draft");
      expect(
        (await firestore().collection("rentCharges").doc(missingLeaseId).get())
          .data()?.status
      ).toBe("draft");
    }
  );

  it.each(["tenantId", "propertyId", "unitId"])(
    "rejects a draft with a mismatched %s reference",
    async (field) => {
      const leaseId = await createBillingLease();
      const value = field === "tenantId" ?
        fixture.otherLandlord.uid :
        field === "propertyId" ?
          fixture.otherPropertyId :
          fixture.vacantUnitId;
      const rentChargeId = await addRentChargeDraft(
        leaseId,
        {[field]: value}
      );

      const response = await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId}
      );

      expect(response.error?.status).toBe("FAILED_PRECONDITION");
      expect(
        (await firestore().collection("rentCharges").doc(rentChargeId).get())
          .data()?.status
      ).toBe("draft");
    }
  );

  it.each(["tenantId", "propertyId", "unitId"])(
    "rejects a draft with a missing %s document",
    async (field) => {
      const leaseId = await createBillingLease();
      const value = `phase5-missing-${field}-${randomUUID()}`;
      const rentChargeId = await addRentChargeDraft(leaseId, {[field]: value});

      const response = await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId}
      );

      expect(response.error?.status).toBe("NOT_FOUND");
      expect(
        (await firestore().collection("rentCharges").doc(rentChargeId).get())
          .data()?.status
      ).toBe("draft");
    }
  );

  it(
    "rejects ended leases and subtotal mismatches without partial writes",
    async () => {
      const endedLeaseId = await createBillingLease();
      const endedRentChargeId = await addRentChargeDraft(endedLeaseId);
      await firestore().collection("leases").doc(endedLeaseId).update({
        status: "ended",
      });
      const endedLeaseResponse = await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId: endedRentChargeId}
      );
      expect(endedLeaseResponse.error?.status).toBe("FAILED_PRECONDITION");

      const activeLeaseId = await createBillingLease();
      const mismatchedRentChargeId = await addRentChargeDraft(activeLeaseId, {
        subtotal: 1,
      });
      const subtotalResponse = await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId: mismatchedRentChargeId}
      );

      expect(subtotalResponse.error?.status).toBe("FAILED_PRECONDITION");
      const [endedBill, mismatchedBill] = await Promise.all([
        firestore().collection("rentCharges").doc(endedRentChargeId).get(),
        firestore().collection("rentCharges").doc(mismatchedRentChargeId).get(),
      ]);
      expect(endedBill.data()?.status).toBe("draft");
      expect(mismatchedBill.data()?.status).toBe("draft");
      expect(mismatchedBill.data()?.dueDate).toBe("2026-11-10");
      expect(mismatchedBill.data()?.finalizedAt).toBeUndefined();
    }
  );

  it.each(["missing", "duplicate"])(
    "rejects a draft with a %s rent line item",
    async (rentCase) => {
      const leaseId = await createBillingLease();
      const lineItems = rentCase === "missing" ?
        [
          {type: "electricity", label: "Electricity", amount: 12345},
          {type: "maintenance", label: "Maintenance", amount: 5000},
          {type: "other", label: "Other", amount: 250},
        ] :
        [
          {type: "rent", label: "Rent", amount: 125000},
          {type: "rent", label: "Second rent", amount: 1},
          {type: "electricity", label: "Electricity", amount: 12345},
          {type: "maintenance", label: "Maintenance", amount: 5000},
          {type: "other", label: "Other", amount: 250},
        ];
      const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
      const rentChargeId = await addRentChargeDraft(leaseId, {
        lineItems,
        subtotal,
        total: subtotal,
      });

      const response = await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId}
      );

      expect(response.error?.status).toBe("FAILED_PRECONDITION");
      expect(response.error?.message).toContain(
        "exactly one rent line item"
      );
      expect(
        (await firestore().collection("rentCharges").doc(rentChargeId).get())
          .data()?.status
      ).toBe("draft");
    }
  );

  it("rejects a draft with more than ten line items", async () => {
    const leaseId = await createBillingLease();
    const lineItems = [
      {type: "rent", label: "Rent", amount: 125000},
      ...Array.from({length: 10}, (_, index) => ({
        type: "other",
        label: `Other ${index + 1}`,
        amount: 1,
      })),
    ];
    const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
    const rentChargeId = await addRentChargeDraft(leaseId, {
      lineItems,
      subtotal,
      total: subtotal,
    });

    const response = await callFunction(
      "finalizeRentCharge",
      fixture.landlord,
      {rentChargeId}
    );

    expect(response.error?.status).toBe("FAILED_PRECONDITION");
    expect(response.error?.message).toContain(
      "between one and ten valid line items"
    );
    expect(
      (await firestore().collection("rentCharges").doc(rentChargeId).get())
        .data()?.status
    ).toBe("draft");
  });

  it("rejects a draft with a due date other than the tenth", async () => {
    const leaseId = await createBillingLease();
    const rentChargeId = await addRentChargeDraft(leaseId, {
      dueDate: "2026-11-11",
    });

    const response = await callFunction(
      "finalizeRentCharge",
      fixture.landlord,
      {rentChargeId}
    );

    expect(response.error?.status).toBe("FAILED_PRECONDITION");
    const bill = await firestore()
      .collection("rentCharges")
      .doc(rentChargeId)
      .get();
    expect(bill.data()?.status).toBe("draft");
    expect(bill.data()?.dueDate).toBe("2026-11-11");
  });

  it("rejects negative line-item amounts during finalization", async () => {
    const leaseId = await createBillingLease();
    const lineItems = [
      {type: "rent", label: "Rent", amount: 125000},
      {type: "electricity", label: "Electricity", amount: -1},
      {type: "maintenance", label: "Maintenance", amount: 5000},
    ];
    const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
    const rentChargeId = await addRentChargeDraft(leaseId, {
      lineItems,
      subtotal,
      total: subtotal,
    });

    const response = await callFunction(
      "finalizeRentCharge",
      fixture.landlord,
      {rentChargeId}
    );

    expect(response.error?.status).toBe("FAILED_PRECONDITION");
    expect(
      (await firestore().collection("rentCharges").doc(rentChargeId).get())
        .data()?.status
    ).toBe("draft");
  });

  it("does not finalize a bill twice", async () => {
    const leaseId = await createBillingLease();
    const rentChargeId = await addRentChargeDraft(leaseId);
    const first = await callFunction(
      "finalizeRentCharge",
      fixture.landlord,
      {rentChargeId}
    );
    const beforeRetry = await firestore()
      .collection("rentCharges")
      .doc(rentChargeId)
      .get();
    const retry = await callFunction(
      "finalizeRentCharge",
      fixture.landlord,
      {rentChargeId}
    );
    const afterRetry = await firestore()
      .collection("rentCharges")
      .doc(rentChargeId)
      .get();

    expect(first.error).toBeUndefined();
    expect(retry.error?.status).toBe("FAILED_PRECONDITION");
    expect(afterRetry.data()).toEqual(beforeRetry.data());
  });

  it(
    "writes an adjustment and transactionally updates both bill rollups",
    async () => {
      const leaseId = await createBillingLease();
      const rentChargeId = await addRentChargeDraft(leaseId);
      const finalized = await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId}
      );
      expect(finalized.error).toBeUndefined();
      await firestore().collection("rentCharges").doc(rentChargeId).update({
        lateFineTotal: 100,
        total: 142695,
        status: "due",
      });

      const idempotencyKey = randomUUID();
      const response = await callFunction(
        "applyAdjustment",
        fixture.landlord,
        {
          rentChargeId,
          amount: -250,
          reason: "Corrected electricity amount",
          idempotencyKey,
        }
      );

      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({
        success: true,
        adjustmentId: idempotencyKey,
        newAdjustmentTotal: -250,
        newTotal: 142445,
      });
      const [bill, adjustment] = await Promise.all([
        firestore().collection("rentCharges").doc(rentChargeId).get(),
        firestore()
          .collection("rentCharges")
          .doc(rentChargeId)
          .collection("adjustments")
          .doc(idempotencyKey)
          .get(),
      ]);
      expect(bill.data()).toMatchObject({
        subtotal: 142595,
        lateFineTotal: 100,
        adjustmentTotal: -250,
        total: 142445,
      });
      expect(adjustment.data()).toMatchObject({
        type: "correction",
        amount: -250,
        reason: "Corrected electricity amount",
        createdBy: fixture.landlord.uid,
        idempotencyKey,
        createdAt: expect.any(admin.firestore.Timestamp),
      });
    }
  );

  it("makes concurrent adjustment retries idempotent", async () => {
    const leaseId = await createBillingLease();
    const rentChargeId = await addRentChargeDraft(leaseId);
    await callFunction(
      "finalizeRentCharge",
      fixture.landlord,
      {rentChargeId}
    );
    const idempotencyKey = "abcdef12-3456-7890-abcd-ef1234567890";
    const input = {
      rentChargeId,
      amount: 500,
      reason: "Verified additional utility charge",
      idempotencyKey,
    };

    const [first, retry] = await Promise.all([
      callFunction("applyAdjustment", fixture.landlord, input),
      callFunction("applyAdjustment", fixture.landlord, {
        ...input,
        idempotencyKey: idempotencyKey.toUpperCase(),
      }),
    ]);

    expect(first.error).toBeUndefined();
    expect(retry.error).toBeUndefined();
    expect(first.result?.adjustmentId).toBe(idempotencyKey);
    expect(retry.result?.adjustmentId).toBe(idempotencyKey);
    const [canonicalAdjustment, uppercaseAdjustment] = await Promise.all([
      firestore()
        .collection("rentCharges")
        .doc(rentChargeId)
        .collection("adjustments")
        .doc(idempotencyKey)
        .get(),
      firestore()
        .collection("rentCharges")
        .doc(rentChargeId)
        .collection("adjustments")
        .doc(idempotencyKey.toUpperCase())
        .get(),
    ]);
    expect(canonicalAdjustment.data()?.idempotencyKey).toBe(idempotencyKey);
    expect(uppercaseAdjustment.exists).toBe(false);
    const conflictingRetry = await callFunction(
      "applyAdjustment",
      fixture.landlord,
      {...input, amount: 501}
    );
    expect(conflictingRetry.error?.status).toBe("ALREADY_EXISTS");
    const [bill, adjustments] = await Promise.all([
      firestore().collection("rentCharges").doc(rentChargeId).get(),
      firestore()
        .collection("rentCharges")
        .doc(rentChargeId)
        .collection("adjustments")
        .get(),
    ]);
    expect(bill.data()?.adjustmentTotal).toBe(500);
    expect(bill.data()?.total).toBe(143095);
    expect(adjustments.size).toBe(1);
  });

  it("rejects adjustment callers without landlord ownership", async () => {
    const leaseId = await createBillingLease();
    const rentChargeId = await addRentChargeDraft(leaseId);
    await callFunction("finalizeRentCharge", fixture.landlord, {rentChargeId});
    const input = {
      rentChargeId,
      amount: 100,
      reason: "Correction",
      idempotencyKey: randomUUID(),
    };

    const [tenantResponse, otherLandlordResponse, unauthenticatedResponse] =
      await Promise.all([
        callFunction("applyAdjustment", fixture.tenant, input),
        callFunction("applyAdjustment", fixture.otherLandlord, input),
        callUnauthenticatedFunction("applyAdjustment", input),
      ]);

    expect(tenantResponse.error?.status).toBe("PERMISSION_DENIED");
    expect(otherLandlordResponse.error?.status).toBe("PERMISSION_DENIED");
    expect(unauthenticatedResponse.error?.status).toBe("UNAUTHENTICATED");
    const [bill, adjustments] = await Promise.all([
      firestore().collection("rentCharges").doc(rentChargeId).get(),
      firestore()
        .collection("rentCharges")
        .doc(rentChargeId)
        .collection("adjustments")
        .get(),
    ]);
    expect(bill.data()?.total).toBe(142595);
    expect(adjustments.empty).toBe(true);
  });

  it.each(["payment_pending", "paid"])(
    "does not adjust a bill in %s status",
    async (status) => {
      const leaseId = await createBillingLease();
      const rentChargeId = await addRentChargeDraft(leaseId);
      await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId}
      );
      await firestore().collection("rentCharges").doc(rentChargeId).update({
        status,
      });
      const before = await firestore()
        .collection("rentCharges")
        .doc(rentChargeId)
        .get();

      const response = await callFunction(
        "applyAdjustment",
        fixture.landlord,
        {
          rentChargeId,
          amount: 100,
          reason: "Correction",
          idempotencyKey: randomUUID(),
        }
      );

      expect(response.error?.status).toBe("FAILED_PRECONDITION");
      const [after, adjustments] = await Promise.all([
        firestore().collection("rentCharges").doc(rentChargeId).get(),
        firestore()
          .collection("rentCharges")
          .doc(rentChargeId)
          .collection("adjustments")
          .get(),
      ]);
      expect(after.data()).toEqual(before.data());
      expect(adjustments.empty).toBe(true);
    }
  );

  it(
    "rejects malformed adjustment inputs and inconsistent bill totals",
    async () => {
      const leaseId = await createBillingLease();
      const rentChargeId = await addRentChargeDraft(leaseId);
      await callFunction(
        "finalizeRentCharge",
        fixture.landlord,
        {rentChargeId}
      );
      const invalidAmount = await callFunction(
        "applyAdjustment",
        fixture.landlord,
        {
          rentChargeId,
          amount: 1.5,
          reason: "Correction",
          idempotencyKey: randomUUID(),
        }
      );
      expect(invalidAmount.error?.status).toBe("INVALID_ARGUMENT");

      await firestore().collection("rentCharges").doc(rentChargeId).update({
        total: 1,
      });
      const response = await callFunction(
        "applyAdjustment",
        fixture.landlord,
        {
          rentChargeId,
          amount: -10,
          reason: "Correction",
          idempotencyKey: randomUUID(),
        }
      );
      expect(response.error?.status).toBe("FAILED_PRECONDITION");
      const adjustments = await firestore()
        .collection("rentCharges")
        .doc(rentChargeId)
        .collection("adjustments")
        .get();
      expect(adjustments.empty).toBe(true);
    }
  );
});
