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
  return import("firebase-admin").then((firebaseAdmin) => {
    admin = firebaseAdmin;
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

describe(
  "getPendingRequestAvailability emulator integration",
  () => {
    it(
      "reports when a pending request has vacant units",
      async () => {
        await addJoinRequest(
          fixture.tenant.uid,
          fixture.propertyId,
          fixture.landlord.uid,
          "Phase 3 Property"
        );

        const response = await callFunction(
          "getPendingRequestAvailability",
          fixture.tenant,
          {propertyId: fixture.propertyId}
        );

        expect(response.error).toBeUndefined();
        expect(response.result?.hasVacantUnits).toBe(true);
      }
    );

    it(
      "reports when every unit for a pending request is occupied",
      async () => {
        await addJoinRequest(
          fixture.tenant.uid,
          fixture.propertyId,
          fixture.landlord.uid,
          "Phase 3 Property"
        );
        await firestore().collection("units")
          .doc(fixture.vacantUnitId).update({
            status: "occupied",
          });

        const response = await callFunction(
          "getPendingRequestAvailability",
          fixture.tenant,
          {propertyId: fixture.propertyId}
        );

        expect(response.error).toBeUndefined();
        expect(response.result?.hasVacantUnits).toBe(false);
      }
    );

    it(
      "does not disclose availability without a pending request",
      async () => {
        const response = await callFunction(
          "getPendingRequestAvailability",
          fixture.tenant,
          {propertyId: fixture.propertyId}
        );

        expect(response.error?.status).toBe("FAILED_PRECONDITION");
      }
    );

    it("rejects a landlord caller", async () => {
      const response = await callFunction(
        "getPendingRequestAvailability",
        fixture.landlord,
        {propertyId: fixture.propertyId}
      );

      expect(response.error?.status).toBe("PERMISSION_DENIED");
    });
  }
);

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

      const noAvailability = await callFunction(
        "getPendingRequestAvailability",
        thirdTenant,
        {propertyId: fixture.propertyId}
      );
      expect(noAvailability.error).toBeUndefined();
      expect(noAvailability.result?.hasVacantUnits).toBe(false);

      const releasedLease = await callFunction(
        "endLease",
        fixture.landlord,
        {
          leaseId: firstAcceptance.result?.leaseId,
          endDate: new Date().toISOString().slice(0, 10),
        }
      );
      expect(releasedLease.error).toBeUndefined();

      const availabilityAfterMoveOut = await callFunction(
        "getPendingRequestAvailability",
        thirdTenant,
        {propertyId: fixture.propertyId}
      );
      expect(availabilityAfterMoveOut.error).toBeUndefined();
      expect(availabilityAfterMoveOut.result?.hasVacantUnits).toBe(true);

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
      const thirdTenantProfile = await firestore()
        .collection("users")
        .doc(thirdTenant.uid)
        .get();
      expect(thirdTenantProfile.data()?.activeLeaseId).toBe(
        finalAcceptance.result?.leaseId
      );

      const availabilityAfterAcceptance = await callFunction(
        "getPendingRequestAvailability",
        thirdTenant,
        {propertyId: fixture.propertyId}
      );
      expect(availabilityAfterAcceptance.error?.status)
        .toBe("FAILED_PRECONDITION");
    }
  );
});
