import {createHash, randomUUID} from "crypto";
import {
  deleteApp,
  getApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {Firestore, getFirestore} from "firebase-admin/firestore";

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

jest.setTimeout(30000);

const authEmulatorUrl =
  `http://127.0.0.1:${authEmulatorPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`;
const functionsEmulatorUrl =
  `http://127.0.0.1:${functionsEmulatorPort}/${projectId}/us-central1`;

interface TestUser {
  uid: string;
  idToken: string;
}

interface CallableResponse {
  result?: Record<string, unknown>;
  error?: {
    status: string;
    message: string;
  };
}

let db: Firestore;
let createdUsers: string[] = [];

/**
 * Creates an Auth-emulator tenant with a completed Firestore profile.
 * @param {string} role Test account role
 * @return {Promise<TestUser>} Tenant UID and Auth emulator token
 */
async function createUser(
  role: "landlord" | "tenant" = "tenant"
): Promise<TestUser> {
  const uid = `notification-${role}-${randomUUID()}`;
  await getAuth().createUser({uid});
  await getAuth().setCustomUserClaims(uid, {role});
  const customToken = await getAuth().createCustomToken(uid);
  const response = await fetch(authEmulatorUrl, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({token: customToken, returnSecureToken: true}),
  });
  const body = await response.json() as {idToken?: string};
  if (!response.ok || !body.idToken) {
    throw new Error("Could not obtain an Auth emulator ID token.");
  }
  createdUsers.push(uid);
  await db.collection("users").doc(uid).set({
    uid,
    role,
    onboardingCompleted: true,
  });
  return {uid, idToken: body.idToken};
}

/**
 * Calls a deployed Functions-emulator callable over its HTTP protocol.
 * @param {string} name Callable export name
 * @param {TestUser|undefined} caller Optional authenticated caller
 * @param {Record<string, unknown>} data Callable input
 * @return {Promise<CallableResponse>} Callable result or error
 */
async function callFunction(
  name: string,
  caller: TestUser | undefined,
  data: Record<string, unknown>
): Promise<CallableResponse> {
  const response = await fetch(`${functionsEmulatorUrl}/${name}`, {
    method: "POST",
    headers: {
      ...(caller ? {Authorization: `Bearer ${caller.idToken}`} : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({data}),
  });
  return await response.json() as CallableResponse;
}

beforeAll(() => {
  if (getApps().length === 0) initializeApp({projectId});
  db = getFirestore();
});

beforeEach(() => {
  createdUsers = [];
});

afterEach(async () => {
  for (const uid of createdUsers) {
    const tokenDocs = await db.collection("users").doc(uid)
      .collection("deviceTokens").get();
    const batch = db.batch();
    tokenDocs.docs.forEach((doc) => batch.delete(doc.ref));
    if (!tokenDocs.empty) await batch.commit();
    await db.collection("users").doc(uid).delete();
    await getAuth().deleteUser(uid);
  }
});

afterAll(async () => {
  await deleteApp(getApp());
});

describe("device-token callables", () => {
  it("registers and refreshes the authenticated user's token", async () => {
    const tenant = await createUser();
    const token = `test-fcm-token-${randomUUID()}-${"x".repeat(32)}`;
    const tokenId = createHash("sha256").update(token).digest("hex");

    const first = await callFunction("registerDeviceToken", tenant, {
      expectedUid: tenant.uid,
      token,
      platform: "android",
    });
    const firstDoc = await db.collection("users").doc(tenant.uid)
      .collection("deviceTokens").doc(tokenId).get();
    const createdAt = firstDoc.get("createdAt");
    const second = await callFunction("registerDeviceToken", tenant, {
      expectedUid: tenant.uid,
      token,
      platform: "ios",
    });
    const refreshedDoc = await db.collection("users").doc(tenant.uid)
      .collection("deviceTokens").doc(tokenId).get();

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(refreshedDoc.data()).toMatchObject({token, platform: "ios"});
    expect(refreshedDoc.get("createdAt")).toEqual(createdAt);
    expect(refreshedDoc.get("updatedAt")).toBeDefined();
  });

  it("unregisters only from the caller's user-scoped collection", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const token = `test-fcm-token-${randomUUID()}-${"x".repeat(32)}`;
    const tokenId = createHash("sha256").update(token).digest("hex");
    await callFunction("registerDeviceToken", owner, {
      expectedUid: owner.uid,
      token,
      platform: "android",
    });

    const otherUserResult = await callFunction(
      "unregisterDeviceToken",
      otherUser,
      {expectedUid: otherUser.uid, token}
    );
    const ownerToken = db.collection("users").doc(owner.uid)
      .collection("deviceTokens").doc(tokenId);
    expect(otherUserResult.error).toBeUndefined();
    expect((await ownerToken.get()).exists).toBe(true);

    const ownerResult = await callFunction(
      "unregisterDeviceToken",
      owner,
      {expectedUid: owner.uid, token}
    );
    expect(ownerResult.error).toBeUndefined();
    expect((await ownerToken.get()).exists).toBe(false);
  });

  it("rejects unauthenticated and malformed registrations", async () => {
    const unauthenticated = await callFunction(
      "registerDeviceToken",
      undefined,
      {
        expectedUid: "no-user",
        token: "x".repeat(32),
        platform: "android",
      }
    );
    const tenant = await createUser();
    const malformed = await callFunction(
      "registerDeviceToken",
      tenant,
      {
        expectedUid: tenant.uid,
        token: "short",
        platform: "android",
      }
    );

    expect(unauthenticated.error?.status).toBe("UNAUTHENTICATED");
    expect(malformed.error?.status).toBe("INVALID_ARGUMENT");
  });

  it("allows landlords to register web devices", async () => {
    const landlord = await createUser("landlord");
    const token = `test-fcm-token-${randomUUID()}-${"x".repeat(32)}`;
    const tokenId = createHash("sha256").update(token).digest("hex");

    const response = await callFunction("registerDeviceToken", landlord, {
      expectedUid: landlord.uid,
      token,
      platform: "web",
    });

    expect(response.error).toBeUndefined();
    expect((await db.collection("users").doc(landlord.uid)
      .collection("deviceTokens").doc(tokenId).get()).get("platform"))
      .toBe("web");
  });

  it("rejects a token operation after an account switch", async () => {
    const caller = await createUser();
    const token = `test-fcm-token-${randomUUID()}-${"x".repeat(32)}`;
    const response = await callFunction("registerDeviceToken", caller, {
      expectedUid: "different-user",
      token,
      platform: "android",
    });

    expect(response.error?.status).toBe("PERMISSION_DENIED");
    const tokenId = createHash("sha256").update(token).digest("hex");
    expect(await db.collection("users").doc(caller.uid)
      .collection("deviceTokens").doc(tokenId).get().then((doc) => doc.exists))
      .toBe(false);
  });
});
