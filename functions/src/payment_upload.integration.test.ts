const projectId = `demo-rently-upload-${process.pid}`;
const firestoreEmulatorPort =
  process.env.PHASE3_FIRESTORE_EMULATOR_PORT ?? "8080";

process.env.GCLOUD_PROJECT = projectId;
process.env.FIREBASE_CONFIG = JSON.stringify({projectId});
process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${firestoreEmulatorPort}`;

import {deflateSync} from "zlib";
import {createHash, randomUUID} from "crypto";
import type {DocumentReference, Firestore} from "firebase-admin/firestore";
import {
  createCloudinaryGateway,
  createPaymentUploadHttpHandler,
  createPaymentUploadService,
  paymentProofCleanupBaseBackoffMs,
  paymentProofCleanupMaxAttempts,
  paymentUploadIntentMs,
  paymentUploadClaimLeaseMs,
  paymentUploadPermissionMs,
  type CreateUpiPaymentInput,
  type CloudinaryAsset,
  type CloudinaryGateway,
  type PreparePaymentUploadInput,
  type VerifyUpiPaymentInput,
} from "./payment_upload";

jest.setTimeout(30000);

const tokenSecret = "test-payment-upload-token-secret-32-characters";
const validUpiConfiguration = {
  upiId: "owner@bank",
  upiQrImageUrl: "https://images.example.test/property-qr.png",
  upiDisplayName: "Property Owner",
};

interface Fixture {
  uid: string;
  landlordId: string;
  billId: string;
  leaseId: string;
  propertyId: string;
  unitId: string;
}

interface MockCloudinaryState {
  assets: Map<string, CloudinaryAsset>;
  uploadCalls: number;
  deleteCalls: number;
  uploadError?: Error;
  deleteError?: Error;
  uploadGate?: Promise<void>;
  uploadStarted?: () => void;
}

interface CapturedHttpResponse {
  set(name: string, value: string): unknown;
  status(code: number): CapturedHttpResponse;
  json(body: unknown): unknown;
}

let admin: typeof import("firebase-admin");
let db: Firestore;
let nowMs: number;
let cleanupRefs: DocumentReference[];
let cloudinaryState: MockCloudinaryState;
let cloudinary: CloudinaryGateway;
let service: ReturnType<typeof createPaymentUploadService>;

/**
 * Builds a small PNG with valid chunk checksums for upload tests.
 * @return {Buffer} One-pixel PNG file
 */
function createPng(): Buffer {
  const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBytes = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = deflateSync(Buffer.from([0, 0x11, 0x22, 0x33, 0xff]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Creates an in-memory Cloudinary adapter with controllable failures.
 * @return {CloudinaryGateway} Test Cloudinary adapter
 */
function createMockCloudinary(): CloudinaryGateway {
  return {
    async upload(bytes, format, publicId, folder) {
      cloudinaryState.uploadCalls += 1;
      cloudinaryState.uploadStarted?.();
      await cloudinaryState.uploadGate;
      if (cloudinaryState.uploadError) throw cloudinaryState.uploadError;
      if (cloudinaryState.assets.has(publicId)) {
        throw new Error("Asset already exists.");
      }
      const asset: CloudinaryAsset = {
        publicId,
        folder,
        resourceType: "image",
        format,
        bytes: bytes.length,
        secureUrl: `https://res.cloudinary.test/${folder}/${publicId}`,
        createdAt: new Date(nowMs).toISOString(),
      };
      cloudinaryState.assets.set(publicId, asset);
      return asset;
    },
    async get(publicId, folder) {
      const asset = cloudinaryState.assets.get(publicId);
      return asset?.folder === folder ? asset : null;
    },
    async delete(publicId) {
      cloudinaryState.deleteCalls += 1;
      if (cloudinaryState.deleteError) throw cloudinaryState.deleteError;
      cloudinaryState.assets.delete(publicId);
    },
  };
}

/**
 * Tracks a Firestore document for isolated test cleanup.
 * @param {DocumentReference} reference Firestore document reference
 * @return {void} No return value
 */
function trackRef(reference: DocumentReference): void {
  if (!cleanupRefs.some((existing) => existing.path === reference.path)) {
    cleanupRefs.push(reference);
  }
}

/**
 * Seeds a tenant, landlord, property, lease, and bill in the emulator.
 * @param {object} options Fixture variations
 * @return {Promise<Fixture>} Seeded document identifiers
 */
async function seedFixture(
  options: {
    billStatus?: string;
    leaseStatus?: string;
    upiConfigured?: boolean;
  } = {},
): Promise<Fixture> {
  const uid = `payment-tenant-${randomUUID()}`;
  const landlordId = `payment-landlord-${randomUUID()}`;
  const billId = `payment-bill-${randomUUID()}`;
  const leaseId = `payment-lease-${randomUUID()}`;
  const propertyId = `payment-property-${randomUUID()}`;
  const unitId = `payment-unit-${randomUUID()}`;
  const fixture = {uid, landlordId, billId, leaseId, propertyId, unitId};
  const userRef = db.collection("users").doc(uid);
  const landlordRef = db.collection("users").doc(landlordId);
  const propertyRef = db.collection("properties").doc(propertyId);
  const unitRef = db.collection("units").doc(unitId);
  const leaseRef = db.collection("leases").doc(leaseId);
  const billRef = db.collection("rentCharges").doc(billId);
  [userRef, landlordRef, propertyRef, unitRef, leaseRef, billRef].forEach(
    trackRef,
  );
  await Promise.all([
    userRef.set({uid, role: "tenant"}),
    landlordRef.set({uid: landlordId, role: "landlord"}),
    propertyRef.set({
      landlordId,
      ...(options.upiConfigured === false ? {} : validUpiConfiguration),
    }),
    unitRef.set({
      propertyId,
      landlordId,
      status: options.leaseStatus === "ended" ? "vacant" : "occupied",
      ...(options.leaseStatus === "ended" ? {} : {currentLeaseId: leaseId}),
    }),
    leaseRef.set({
      tenantId: uid,
      landlordId,
      propertyId,
      unitId,
      status: options.leaseStatus ?? "active",
    }),
    billRef.set({
      tenantId: uid,
      landlordId,
      propertyId,
      leaseId,
      unitId,
      subtotal: 12_000,
      lateFineTotal: 500,
      adjustmentTotal: -250,
      total: 12_250,
      dueDate: new Date(nowMs).toISOString().slice(0, 10),
      status: options.billStatus ?? "due",
    }),
  ]);
  return fixture;
}

/**
 * Adds another payable rent charge for an existing tenant and lease.
 * @param {Fixture} fixture Existing tenant and lease
 * @return {Promise<string>} New rent charge document ID
 */
async function seedAnotherBill(fixture: Fixture): Promise<string> {
  const billId = `payment-bill-${randomUUID()}`;
  const billRef = db.collection("rentCharges").doc(billId);
  trackRef(billRef);
  await billRef.set({
    tenantId: fixture.uid,
    landlordId: fixture.landlordId,
    propertyId: fixture.propertyId,
    leaseId: fixture.leaseId,
    unitId: fixture.unitId,
    subtotal: 12_000,
    lateFineTotal: 500,
    adjustmentTotal: -250,
    total: 12_250,
    status: "due",
  });
  return billId;
}

/**
 * Builds a valid upload-preparation payload for a fixture.
 * @param {Fixture} fixture Seeded document identifiers
 * @param {Partial<PreparePaymentUploadInput>} overrides Payload overrides
 * @return {PreparePaymentUploadInput} Callable payload
 */
function prepareInput(
  fixture: Fixture,
  overrides: Partial<PreparePaymentUploadInput> = {},
): PreparePaymentUploadInput {
  const proof = createPng();
  return {
    rentChargeId: fixture.billId,
    idempotencyKey: randomUUID(),
    recipientNameConfirmed: true,
    format: "png",
    bytes: proof.length,
    ...overrides,
  };
}

/**
 * Registers deterministic records created by payment-submission tests.
 * @param {Fixture} fixture Seeded bill identifiers
 * @param {CreateUpiPaymentInput} input Payment payload
 * @return {void} No return value
 */
function trackSubmissionDocs(
  fixture: Fixture,
  input: CreateUpiPaymentInput,
): void {
  const paymentId = input.idempotencyKey.toLowerCase();
  const notificationId = `payment_proof_submitted_${createHash("sha256")
    .update(paymentId + "")
    .digest("hex")}`;
  const referenceHash = createHash("sha256")
    .update(input.transactionRef.trim().toUpperCase(), "utf8")
    .digest("hex");
  trackRef(db.collection("payments").doc(paymentId));
  trackRef(
    db
      .collection("rentCharges")
      .doc(fixture.billId)
      .collection("upiReferences")
      .doc(referenceHash),
  );
  trackRef(db.collection("notifications").doc(notificationId));
  trackRef(db.collection("notificationDeliveries").doc(notificationId));
}

/**
 * Registers deterministic records created by payment-decision tests.
 * @param {string} paymentId Payment document ID
 * @param {"accept" | "reject"} decision Landlord decision
 * @return {void} No return value
 */
function trackDecisionDocs(
  paymentId: string,
  decision: "accept" | "reject",
): void {
  const notificationType =
    decision === "accept" ? "payment_accepted" : "payment_rejected";
  const notificationId = `${notificationType}_${createHash("sha256")
    .update(paymentId)
    .digest("hex")}`;
  trackRef(db.collection("notifications").doc(notificationId));
  trackRef(db.collection("notificationDeliveries").doc(notificationId));
  if (decision === "reject") {
    trackRef(db.collection("paymentProofCleanupOutbox").doc(paymentId));
  }
}

/**
 * Creates a valid uploaded proof and callable payload for a fixture.
 * @param {Fixture} fixture Seeded tenant and rent charge
 * @param {Partial<CreateUpiPaymentInput>} overrides Submission overrides
 * @return {Promise<object>} Callable payload and upload intent
 */
async function uploadedPayment(
  fixture: Fixture,
  overrides: Partial<CreateUpiPaymentInput> = {},
): Promise<{ input: CreateUpiPaymentInput; uploadIntentId: string }> {
  const image = createPng();
  const prepared = await service.prepare(
    fixture.uid,
    "tenant",
    prepareInput(fixture, {bytes: image.length}),
  );
  await service.upload(prepared.uploadToken, image);
  const input: CreateUpiPaymentInput = {
    rentChargeId: fixture.billId,
    uploadIntentId: prepared.uploadIntentId,
    idempotencyKey: randomUUID(),
    transactionRef: "ABC12345",
    ...overrides,
  };
  trackSubmissionDocs(fixture, input);
  return {input, uploadIntentId: prepared.uploadIntentId};
}

/**
 * Submits a valid proof and tracks records used by verification tests.
 * @param {Fixture} fixture Seeded tenant and rent charge
 * @return {Promise<object>} Created payment and proof identifiers
 */
async function pendingPayment(
  fixture: Fixture,
): Promise<{
  paymentId: string;
  input: CreateUpiPaymentInput;
  proofPublicId: string;
}> {
  const uploaded = await uploadedPayment(fixture);
  const created = await service.create(fixture.uid, "tenant", uploaded.input);
  trackDecisionDocs(created.paymentId, "accept");
  trackDecisionDocs(created.paymentId, "reject");
  const intent = await db
    .collection("paymentUploadIntents")
    .doc(uploaded.uploadIntentId)
    .get();
  return {
    paymentId: created.paymentId,
    input: uploaded.input,
    proofPublicId: intent.get("publicId") as string,
  };
}

/**
 * Creates a service bound to the emulator and current test clock.
 * @return {object} Configured upload service
 */
function newService(): ReturnType<typeof createPaymentUploadService> {
  return createPaymentUploadService({
    db,
    uploadUrl:
      "https://us-central1-demo-rently." +
      "cloudfunctions.net/uploadPaymentProof",
    tokenSecret,
    cloudinary,
    now: () => nowMs,
  });
}

beforeAll(async () => {
  admin = (await import("firebase-admin")).default;
  if (!admin.apps.length) admin.initializeApp({projectId});
  db = admin.firestore();
});

beforeEach(() => {
  nowMs = Date.now();
  cleanupRefs = [];
  cloudinaryState = {
    assets: new Map(),
    uploadCalls: 0,
    deleteCalls: 0,
  };
  cloudinary = createMockCloudinary();
  service = newService();
  const prepare = service.prepare.bind(service);
  service.prepare = async (...args) => {
    const result = await prepare(...args);
    trackRef(db.collection("paymentUploadIntents").doc(result.uploadIntentId));
    return result;
  };
});

afterEach(async () => {
  await Promise.all(cleanupRefs.map((reference) => reference.delete()));
});

afterAll(async () => {
  await admin.app().delete();
});

describe("payment proof upload preparation", () => {
  it("rejects unauthenticated and non-tenant callers", async () => {
    const fixture = await seedFixture();
    const input = prepareInput(fixture);
    await expect(
      service.prepare(undefined, "tenant", input),
    ).rejects.toMatchObject({code: "unauthenticated"});
    await expect(
      service.prepare(fixture.uid, "landlord", input),
    ).rejects.toMatchObject({code: "permission-denied"});
  });

  it("denies a tenant uploading for another tenant's bill", async () => {
    const owner = await seedFixture();
    const otherTenant = await seedFixture();
    await expect(
      service.prepare(
        owner.uid,
        "tenant",
        prepareInput(owner, {rentChargeId: otherTenant.billId}),
      ),
    ).rejects.toMatchObject({code: "permission-denied"});
  });

  it("rejects an invalid bill state or missing UPI configuration", async () => {
    for (const status of ["draft", "finalized"]) {
      const ineligibleBill = await seedFixture({billStatus: status});
      await expect(
        service.prepare(
          ineligibleBill.uid,
          "tenant",
          prepareInput(ineligibleBill),
        ),
      ).rejects.toMatchObject({code: "failed-precondition"});
    }

    const unconfigured = await seedFixture({upiConfigured: false});
    await expect(
      service.prepare(unconfigured.uid, "tenant", prepareInput(unconfigured)),
    ).rejects.toMatchObject({code: "failed-precondition"});
  });

  it("reuses the same intent and rejects cross-scope key reuse", async () => {
    const fixture = await seedFixture();
    const input = prepareInput(fixture);
    const first = await service.prepare(fixture.uid, "tenant", input);
    const second = await service.prepare(fixture.uid, "tenant", input);
    expect(second.uploadIntentId).toBe(first.uploadIntentId);
    expect(second.uploadToken).not.toBe(first.uploadToken);
    expect(Object.keys(first).sort()).toEqual([
      "intentExpiresAt",
      "success",
      "uploadIntentId",
      "uploadPermissionExpiresAt",
      "uploadToken",
      "uploadUrl",
    ]);
    expect(first.uploadUrl).toContain("/uploadPaymentProof");
    expect(first.intentExpiresAt - nowMs).toBe(paymentUploadIntentMs);
    expect(first.uploadPermissionExpiresAt - nowMs).toBe(
      paymentUploadPermissionMs,
    );

    const otherBillId = `payment-bill-${randomUUID()}`;
    const otherBillRef = db.collection("rentCharges").doc(otherBillId);
    trackRef(otherBillRef);
    await otherBillRef.set({
      tenantId: fixture.uid,
      landlordId: fixture.landlordId,
      propertyId: fixture.propertyId,
      leaseId: fixture.leaseId,
      status: "due",
    });
    await expect(
      service.prepare(
        fixture.uid,
        "tenant",
        prepareInput(fixture, {
          rentChargeId: otherBillId,
          idempotencyKey: input.idempotencyKey,
        }),
      ),
    ).rejects.toMatchObject({code: "already-exists"});
  });
});

describe("payment proof upload endpoint service", () => {
  it("validates actual image bytes and does not change the bill", async () => {
    const fixture = await seedFixture();
    const image = createPng();
    const input = prepareInput(fixture, {bytes: image.length});
    const prepared = await service.prepare(fixture.uid, "tenant", input);
    const result = await service.upload(prepared.uploadToken, image);
    expect(result).toEqual({
      success: true,
      uploadIntentId: prepared.uploadIntentId,
    });
    expect(
      (await db.collection("rentCharges").doc(fixture.billId).get()).get(
        "status",
      ),
    ).toBe("due");
  });

  it("rejects unsupported, oversized, or invalid image data", async () => {
    const fixture = await seedFixture();
    const image = createPng();
    await expect(
      service.prepare(
        fixture.uid,
        "tenant",
        prepareInput(fixture, {format: "gif"}),
      ),
    ).rejects.toMatchObject({code: "invalid-argument"});
    await expect(
      service.prepare(
        fixture.uid,
        "tenant",
        prepareInput(fixture, {bytes: 5_000_001}),
      ),
    ).rejects.toMatchObject({code: "invalid-argument"});

    const malformedIntent = await service.prepare(
      fixture.uid,
      "tenant",
      prepareInput(fixture, {bytes: image.length}),
    );
    await expect(
      service.upload(malformedIntent.uploadToken, Buffer.from("not an image")),
    ).rejects.toMatchObject({status: 415});
    const fakePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("invalid image chunks"),
    ]);
    await expect(
      service.upload(malformedIntent.uploadToken, fakePng),
    ).rejects.toMatchObject({status: 415});

    const oversizedIntent = await service.prepare(
      fixture.uid,
      "tenant",
      prepareInput(fixture, {
        idempotencyKey: randomUUID(),
        bytes: image.length,
      }),
    );
    await expect(
      service.upload(oversizedIntent.uploadToken, Buffer.alloc(5_000_001)),
    ).rejects.toMatchObject({status: 413});

    const mismatchedIntent = await service.prepare(
      fixture.uid,
      "tenant",
      prepareInput(fixture, {idempotencyKey: randomUUID(), format: "jpg"}),
    );
    await expect(
      service.upload(mismatchedIntent.uploadToken, image),
    ).rejects.toMatchObject({status: 415});
  });

  it(
    "rejects oversized and unsupported HTTP requests before reading the body",
    async () => {
      let bodyReads = 0;
      let statusCode = 0;
      const responseBody: { value?: unknown } = {};
      const response: CapturedHttpResponse = {
        set: () => undefined,
        status(code) {
          statusCode = code;
          return response;
        },
        json(body) {
          responseBody.value = body;
        },
      };
      const handler = createPaymentUploadHttpHandler(() => service, jest.fn());
      const makeRequest = (headers: Record<string, string>, body: Buffer) => ({
        method: "POST",
        header: (name: string) => headers[name.toLowerCase()],
        get rawBody() {
          bodyReads += 1;
          return body;
        },
      });

      await handler(
        makeRequest(
          {
            "content-length": "5000001",
            "content-type": "image/png",
          },
          createPng(),
        ),
        response,
      );
      expect(statusCode).toBe(413);
      expect(bodyReads).toBe(0);

      await handler(
        makeRequest(
          {
            "content-type": "text/plain",
          },
          Buffer.from("not an image"),
        ),
        response,
      );
      expect(statusCode).toBe(415);
      expect(bodyReads).toBe(0);
      expect(responseBody.value).toEqual({
        error: "Content-Type must be JPEG, PNG, or WebP.",
      });

      await handler(
        makeRequest(
          {
            "content-type": "image/png",
          },
          Buffer.alloc(5_000_001),
        ),
        response,
      );
      expect(statusCode).toBe(413);
      expect(bodyReads).toBe(1);
    },
  );

  it("rejects expired tokens and independently expired intents", async () => {
    const fixture = await seedFixture();
    const image = createPng();
    const expiredToken = await service.prepare(
      fixture.uid,
      "tenant",
      prepareInput(fixture, {bytes: image.length}),
    );
    const invalidTokenBytes = Buffer.from(
      expiredToken.uploadToken,
      "base64url",
    );
    invalidTokenBytes[12] ^= 0x01;
    const invalidToken = invalidTokenBytes.toString("base64url");
    await expect(service.upload(invalidToken, image)).rejects.toMatchObject({
      status: 401,
    });
    nowMs += paymentUploadPermissionMs + 1;
    await expect(
      service.upload(expiredToken.uploadToken, image),
    ).rejects.toMatchObject({status: 401});

    nowMs = Date.now();
    const expiredIntent = await service.prepare(
      fixture.uid,
      "tenant",
      prepareInput(fixture, {
        idempotencyKey: randomUUID(),
        bytes: image.length,
      }),
    );
    await db
      .collection("paymentUploadIntents")
      .doc(expiredIntent.uploadIntentId)
      .update({
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs - 1),
      });
    await expect(
      service.upload(expiredIntent.uploadToken, image),
    ).rejects.toMatchObject({status: 410});
  });

  it(
    "lets Cloudinary reject replay against the immutable asset ID",
    async () => {
      const fixture = await seedFixture();
      const image = createPng();
      const prepared = await service.prepare(
        fixture.uid,
        "tenant",
        prepareInput(fixture, {bytes: image.length}),
      );
      const results = await Promise.allSettled([
        service.upload(prepared.uploadToken, image),
        service.upload(prepared.uploadToken, image),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        (await db.collection("rentCharges").doc(fixture.billId).get()).get(
          "status",
        ),
      ).toBe("due");
    },
  );

  it(
    "defers cleanup during upload and compensates an expired late upload",
    async () => {
      const fixture = await seedFixture();
      const image = createPng();
      const prepared = await service.prepare(
        fixture.uid,
        "tenant",
        prepareInput(fixture, {bytes: image.length}),
      );
      nowMs += paymentUploadPermissionMs - 60_000;

      let markUploadStarted: () => void = () => undefined;
      let releaseUpload: () => void = () => undefined;
      const uploadStarted = new Promise<void>((resolve) => {
        markUploadStarted = resolve;
      },
      );
      cloudinaryState.uploadGate = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      cloudinaryState.uploadStarted = markUploadStarted;

      const uploadPromise = service.upload(prepared.uploadToken, image);
      await uploadStarted;
      await expect(
        service.upload(prepared.uploadToken, image),
      ).rejects.toMatchObject({status: 409});
      expect(cloudinaryState.uploadCalls).toBe(1);
      expect(paymentUploadClaimLeaseMs).toBeGreaterThan(
        paymentUploadIntentMs - paymentUploadPermissionMs + 60_000,
      );
      nowMs = prepared.intentExpiresAt + 1;
      await service.recoverCleanup();

      const intentRef = db
        .collection("paymentUploadIntents")
        .doc(prepared.uploadIntentId);
      expect((await intentRef.get()).get("status")).toBe("issued");
      const cleanupRef = db
        .collection("paymentProofCleanupOutbox")
        .doc(`upload_${prepared.uploadIntentId}`);
      trackRef(cleanupRef);
      expect((await cleanupRef.get()).exists).toBe(false);
      expect(cloudinaryState.deleteCalls).toBe(0);

      releaseUpload();
      await expect(uploadPromise).rejects.toMatchObject({status: 410});
      expect((await intentRef.get()).get("status")).toBe("cleanup_pending");
      expect((await cleanupRef.get()).get("status")).toBe("pending");
      expect(cloudinaryState.assets.size).toBe(1);

      cloudinaryState.uploadGate = undefined;
      cloudinaryState.uploadStarted = undefined;
      await service.recoverCleanup();
      expect((await intentRef.get()).get("status")).toBe("cleaned");
      expect(cloudinaryState.assets.size).toBe(0);
      expect(cloudinaryState.deleteCalls).toBe(1);
    });

  it("surfaces Cloudinary errors without creating a payment", async () => {
    const fixture = await seedFixture();
    const image = createPng();
    const prepared = await service.prepare(
      fixture.uid,
      "tenant",
      prepareInput(fixture, {bytes: image.length}),
    );
    cloudinaryState.uploadError = new Error("Cloudinary unavailable");
    await expect(
      service.upload(prepared.uploadToken, image),
    ).rejects.toMatchObject({status: 502});
    const payments = await db
      .collection("payments")
      .where("tenantId", "==", fixture.uid)
      .get();
    expect(payments.empty).toBe(true);
  });
});

describe("UPI payment submission", () => {
  it(
    "enforces tenant authorization, ownership, and UTR validation",
    async () => {
      const fixture = await seedFixture();
      const otherTenant = await seedFixture();
      const uploaded = await uploadedPayment(fixture);

      await expect(
        service.create(undefined, "tenant", uploaded.input),
      ).rejects.toMatchObject({code: "unauthenticated"});
      await expect(
        service.create(fixture.uid, "landlord", uploaded.input),
      ).rejects.toMatchObject({code: "permission-denied"});
      await expect(
        service.create(otherTenant.uid, "tenant", uploaded.input),
      ).rejects.toMatchObject({code: "permission-denied"});

      const anotherBillId = await seedAnotherBill(fixture);
      await expect(
        service.create(fixture.uid, "tenant", {
          ...uploaded.input,
          rentChargeId: anotherBillId,
        }),
      ).rejects.toMatchObject({code: "permission-denied"});
      await expect(
        service.create(fixture.uid, "tenant", {
          rentChargeId: fixture.billId,
          uploadIntentId: uploaded.uploadIntentId,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({code: "invalid-argument"});
      await expect(
        service.create(fixture.uid, "tenant", {
          ...uploaded.input,
          transactionRef: "ABC-123",
        }),
      ).rejects.toMatchObject({code: "invalid-argument"});
      await expect(
        service.create(fixture.uid, "tenant", {
          ...uploaded.input,
          transactionRef: "A".repeat(31),
        }),
      ).rejects.toMatchObject({code: "invalid-argument"});
    },
  );

  it.each(["expired", "consumed", "wrong-tenant"] as const)(
    "rejects an %s upload intent",
    async (intentState) => {
      const fixture = await seedFixture();
      const uploaded = await uploadedPayment(fixture);
      const intentRef = db
        .collection("paymentUploadIntents")
        .doc(uploaded.uploadIntentId);
      if (intentState === "expired") {
        await intentRef.update({
          expiresAt: admin.firestore.Timestamp.fromMillis(nowMs - 1),
        });
      } else if (intentState === "consumed") {
        await intentRef.update({status: "consumed"});
      } else {
        await intentRef.update({tenantId: `other-${fixture.uid}`});
      }

      await expect(
        service.create(fixture.uid, "tenant", uploaded.input),
      ).rejects.toMatchObject({
        code:
          intentState === "wrong-tenant" ?
            "permission-denied" :
            "failed-precondition",
      });
      expect(
        (
          await db
            .collection("payments")
            .doc(uploaded.input.idempotencyKey)
            .get()
        ).exists,
      ).toBe(false);
    },
  );

  it("accepts six- and thirty-character UTR boundaries", async () => {
    const sixCharacterBill = await seedFixture();
    const sixCharacterInput = await uploadedPayment(sixCharacterBill, {
      transactionRef: "A1B2C3",
    });
    await expect(
      service.create(
        sixCharacterBill.uid,
        "tenant",
        sixCharacterInput.input,
      ),
    ).resolves.toMatchObject({status: "pending_verification"});

    const thirtyCharacterBill = await seedFixture();
    const thirtyCharacterInput = await uploadedPayment(thirtyCharacterBill, {
      transactionRef: "A".repeat(30),
    });
    await expect(
      service.create(
        thirtyCharacterBill.uid,
        "tenant",
        thirtyCharacterInput.input,
      ),
    ).resolves.toMatchObject({status: "pending_verification"});
  });

  it("rejects a missing, invalid, or ineligible proof or bill", async () => {
    const missingIntent = await seedFixture();
    const input: CreateUpiPaymentInput = {
      rentChargeId: missingIntent.billId,
      uploadIntentId: "a".repeat(64),
      idempotencyKey: randomUUID(),
      transactionRef: "ABC12345",
    };
    trackSubmissionDocs(missingIntent, input);
    await expect(
      service.create(missingIntent.uid, "tenant", input),
    ).rejects.toMatchObject({code: "not-found"});

    const missingAsset = await seedFixture();
    const missingAssetUpload = await uploadedPayment(missingAsset);
    cloudinaryState.assets.clear();
    await expect(
      service.create(missingAsset.uid, "tenant", missingAssetUpload.input),
    ).rejects.toMatchObject({code: "failed-precondition"});

    for (const status of ["finalized", "payment_pending", "paid"]) {
      const invalidStatus = await seedFixture();
      const invalidStatusUpload = await uploadedPayment(invalidStatus);
      await db
        .collection("rentCharges")
        .doc(invalidStatus.billId)
        .update({status});
      await expect(
        service.create(
          invalidStatus.uid,
          "tenant",
          invalidStatusUpload.input,
        ),
      ).rejects.toMatchObject({code: "failed-precondition"});
    }

    const unconfigured = await seedFixture();
    const unconfiguredUpload = await uploadedPayment(unconfigured);
    await db
      .collection("properties")
      .doc(unconfigured.propertyId)
      .update({upiId: admin.firestore.FieldValue.delete()});
    await expect(
      service.create(unconfigured.uid, "tenant", unconfiguredUpload.input),
    ).rejects.toMatchObject({code: "failed-precondition"});
  });

  it("creates one payment and atomically claims the UTR and bill", async () => {
    const fixture = await seedFixture({leaseStatus: "ended"});
    const uploaded = await uploadedPayment(fixture, {
      transactionRef: "  abc12345  ",
    });
    const result = await service.create(fixture.uid, "tenant", uploaded.input);
    expect(result).toEqual({
      success: true,
      paymentId: uploaded.input.idempotencyKey,
      status: "pending_verification",
    });

    const payment = await db
      .collection("payments")
      .doc(uploaded.input.idempotencyKey)
      .get();
    expect(payment.data()).toMatchObject({
      rentChargeId: fixture.billId,
      leaseId: fixture.leaseId,
      tenantId: fixture.uid,
      landlordId: fixture.landlordId,
      propertyId: fixture.propertyId,
      unitId: fixture.unitId,
      method: "upi_qr",
      amountDue: 12_250,
      gatewayFee: 0,
      totalPaid: 12_250,
      status: "pending_verification",
      transactionRef: "abc12345",
      upiIdSnapshot: validUpiConfiguration.upiId,
      upiDisplayNameSnapshot: validUpiConfiguration.upiDisplayName,
      idempotencyKey: uploaded.input.idempotencyKey,
      proof: {
        provider: "cloudinary",
        publicId: expect.any(String),
        secureUrl: expect.stringMatching(/^https:\/\//),
        resourceType: "image",
        format: "png",
        bytes: createPng().length,
        uploadedAt: expect.any(admin.firestore.Timestamp),
      },
      proofCleanup: {status: "not_requested"},
    });
    const bill = await db.collection("rentCharges").doc(fixture.billId).get();
    expect(bill.get("status")).toBe("payment_pending");
    const referenceHash = createHash("sha256")
      .update("ABC12345", "utf8")
      .digest("hex");
    const claim = await db
      .collection("rentCharges")
      .doc(fixture.billId)
      .collection("upiReferences")
      .doc(referenceHash)
      .get();
    expect(claim.get("paymentId")).toBe(uploaded.input.idempotencyKey);
    const notificationId = `payment_proof_submitted_${createHash("sha256")
      .update(uploaded.input.idempotencyKey)
      .digest("hex")}`;
    const [notification, delivery] = await Promise.all([
      db.collection("notifications").doc(notificationId).get(),
      db.collection("notificationDeliveries").doc(notificationId).get(),
    ]);
    expect(notification.data()).toMatchObject({
      recipientId: fixture.landlordId,
      role: "landlord",
      type: "payment_proof_submitted",
      relatedEntity: {type: "payment", id: uploaded.input.idempotencyKey},
      read: false,
    });
    expect(delivery.data()).toMatchObject({
      notificationId,
      recipientId: fixture.landlordId,
      status: "pending",
    });
    expect(
      (
        await db
          .collection("payments")
          .where("rentChargeId", "==", fixture.billId)
          .get()
      ).size,
    ).toBe(1);
    expect(cloudinaryState.assets.size).toBe(1);
  });

  it.each([0, -1])(
    "rejects payment submission for a non-positive bill total (%i)",
    async (total) => {
      const fixture = await seedFixture();
      const uploaded = await uploadedPayment(fixture);
      await db.collection("rentCharges").doc(fixture.billId).update({
        subtotal: total,
        lateFineTotal: 0,
        adjustmentTotal: 0,
        total,
      });

      await expect(
        service.create(fixture.uid, "tenant", uploaded.input),
      ).rejects.toMatchObject({code: "failed-precondition"});

      const [payment, intent, bill] = await Promise.all([
        db.collection("payments").doc(uploaded.input.idempotencyKey).get(),
        db.collection("paymentUploadIntents")
          .doc(uploaded.uploadIntentId)
          .get(),
        db.collection("rentCharges").doc(fixture.billId).get(),
      ]);
      expect(payment.exists).toBe(false);
      expect(intent.get("status")).toBe("issued");
      expect(bill.get("status")).toBe("due");
    },
  );

  it("returns an idempotent result and rejects changed payloads", async () => {
    const fixture = await seedFixture();
    const uploaded = await uploadedPayment(fixture);
    const first = await service.create(fixture.uid, "tenant", uploaded.input);
    cloudinaryState.assets.clear();
    const retry = await service.create(fixture.uid, "tenant", uploaded.input);
    expect(retry).toEqual(first);
    await expect(
      service.create(fixture.uid, "tenant", {
        ...uploaded.input,
        transactionRef: "DIFFERENT1",
      }),
    ).rejects.toMatchObject({code: "already-exists"});
    expect(
      (
        await db
          .collection("payments")
          .where("rentChargeId", "==", fixture.billId)
          .get()
      ).size,
    ).toBe(1);
  });

  it("rejects a normalized duplicate UTR after a prior attempt", async () => {
    const fixture = await seedFixture();
    const first = await uploadedPayment(fixture, {
      transactionRef: "abc12345",
    });
    await service.create(fixture.uid, "tenant", first.input);
    await db
      .collection("payments")
      .doc(first.input.idempotencyKey)
      .update({status: "rejected"});
    await db
      .collection("rentCharges")
      .doc(fixture.billId)
      .update({status: "due"});

    const second = await uploadedPayment(fixture, {
      transactionRef: "ABC12345",
    });
    await expect(
      service.create(fixture.uid, "tenant", second.input),
    ).rejects.toMatchObject({code: "already-exists"});
    expect(
      (await db.collection("rentCharges").doc(fixture.billId).get()).get(
        "status",
      ),
    ).toBe("due");
    expect(
      (
        await db
          .collection("payments")
          .where("rentChargeId", "==", fixture.billId)
          .get()
      ).size,
    ).toBe(1);
  });

  it(
    "serializes concurrent same-key and different-key submissions",
    async () => {
      const sameKeyFixture = await seedFixture();
      const sameKey = await uploadedPayment(sameKeyFixture);
      const sameKeyResults = await Promise.all([
        service.create(sameKeyFixture.uid, "tenant", sameKey.input),
        service.create(sameKeyFixture.uid, "tenant", sameKey.input),
      ]);
      expect(sameKeyResults[0]).toEqual(sameKeyResults[1]);
      expect(
        (
          await db
            .collection("payments")
            .where("rentChargeId", "==", sameKeyFixture.billId)
            .get()
        ).size,
      ).toBe(1);

      const differentKeysFixture = await seedFixture();
      const first = await uploadedPayment(differentKeysFixture);
      const second = await uploadedPayment(differentKeysFixture, {
        transactionRef: "XYZ98765",
      });
      const differentKeyResults = await Promise.allSettled([
        service.create(differentKeysFixture.uid, "tenant", first.input),
        service.create(differentKeysFixture.uid, "tenant", second.input),
      ]);
      expect(
        differentKeyResults.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        (
          await db
            .collection("payments")
            .where("rentChargeId", "==", differentKeysFixture.billId)
            .get()
        ).size,
      ).toBe(1);
      expect(
        (
          await db
            .collection("rentCharges")
            .doc(differentKeysFixture.billId)
            .get()
        ).get("status"),
      ).toBe("payment_pending");
    },
  );

  it(
    "rolls back every write when a transactional precondition fails",
    async () => {
      const fixture = await seedFixture();
      const uploaded = await uploadedPayment(fixture);
      await db
        .collection("rentCharges")
        .doc(fixture.billId)
        .update({total: 999});
      await expect(
        service.create(fixture.uid, "tenant", uploaded.input),
      ).rejects.toMatchObject({code: "failed-precondition"});

      const payment = await db
        .collection("payments")
        .doc(uploaded.input.idempotencyKey)
        .get();
      const intent = await db
        .collection("paymentUploadIntents")
        .doc(uploaded.uploadIntentId)
        .get();
      const bill = await db.collection("rentCharges").doc(fixture.billId).get();
      const referenceHash = createHash("sha256")
        .update("ABC12345", "utf8")
        .digest("hex");
      const claim = await db
        .collection("rentCharges")
        .doc(fixture.billId)
        .collection("upiReferences")
        .doc(referenceHash)
        .get();
      const notificationId = `payment_proof_submitted_${createHash("sha256")
        .update(uploaded.input.idempotencyKey)
        .digest("hex")}`;
      const [notification, delivery] = await Promise.all([
        db.collection("notifications").doc(notificationId).get(),
        db.collection("notificationDeliveries").doc(notificationId).get(),
      ]);
      expect(payment.exists).toBe(false);
      expect(intent.get("status")).toBe("issued");
      expect(bill.get("status")).toBe("due");
      expect(claim.exists).toBe(false);
      expect(notification.exists).toBe(false);
      expect(delivery.exists).toBe(false);
    },
  );
});

describe("landlord UPI payment verification", () => {
  const reasonCases = [
    ["old_or_used_screenshot", "Old or previously used screenshot"],
    ["blurry_or_unreadable_screenshot", "Blurry or unreadable screenshot"],
    ["incomplete_amount", "Payment amount is incomplete"],
    ["incorrect_utr", "Incorrect UTR/reference number"],
    ["payment_not_received", "Payment not received in landlord's account"],
    ["screenshot_bill_mismatch", "Screenshot does not match this rent bill"],
  ] as const;

  it(
    "approves atomically, is idempotent, and rejects conflicting decisions",
    async () => {
      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      const proofBefore = (
        await db.collection("payments").doc(pending.paymentId).get()
      ).get("proof");

      const result = await service.verify(
        fixture.landlordId,
        "landlord",
      {paymentId: pending.paymentId, decision: "accept"} satisfies
        VerifyUpiPaymentInput,
      );
      expect(result).toEqual({
        success: true,
        paymentId: pending.paymentId,
        decision: "accept",
        rentChargeStatus: "paid",
      },
      );

      const [payment, bill] = await Promise.all([
        db.collection("payments").doc(pending.paymentId).get(),
        db.collection("rentCharges").doc(fixture.billId).get(),
      ]);
      expect(payment.data()).toMatchObject({
        status: "verified",
        reviewedBy: fixture.landlordId,
        proof: proofBefore,
        proofCleanup: {status: "retained"},
      });
      expect(payment.get("reviewedAt")).toBeInstanceOf(
        admin.firestore.Timestamp,
      );
      expect(bill.get("status")).toBe("paid");
      expect(bill.get("paidAt")).toBeInstanceOf(admin.firestore.Timestamp);
      expect(cloudinaryState.assets.has(pending.proofPublicId)).toBe(true);

      const notificationId = `payment_accepted_${createHash("sha256")
        .update(pending.paymentId)
        .digest("hex")}`;
      const [notification, delivery] = await Promise.all([
        db.collection("notifications").doc(notificationId).get(),
        db.collection("notificationDeliveries").doc(notificationId).get(),
      ]);
      expect(notification.data()).toMatchObject({
        recipientId: fixture.uid,
        role: "tenant",
        type: "payment_accepted",
        relatedEntity: {type: "payment", id: pending.paymentId},
        read: false,
      });
      expect(delivery.data()).toMatchObject({
        notificationId,
        recipientId: fixture.uid,
        status: "pending",
      });
      expect(
        await service.verify(fixture.landlordId, "landlord", {
          paymentId: pending.paymentId,
          decision: "accept",
        }),
      ).toEqual(result);
      await expect(
        service.verify(fixture.landlordId, "landlord", {
          paymentId: pending.paymentId,
          decision: "reject",
          rejectionReasonCode: "other",
          rejectionExplanation: "Conflicting decision",
        }),
      ).rejects.toMatchObject({code: "failed-precondition"});
      expect(
        (
          await db
            .collection("notifications")
            .where("relatedEntity.id", "==", pending.paymentId)
            .get()
        ).size,
      ).toBe(2);
    });

  it.each(reasonCases)(
    "rejects a payment for %s and enqueues exact-proof cleanup",
    async (reasonCode, reasonLabel) => {
      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      const result = await service.verify(
        fixture.landlordId,
        "landlord",
        {
          paymentId: pending.paymentId,
          decision: "reject",
          rejectionReasonCode: reasonCode,
        },
      );
      expect(result).toMatchObject({
        success: true,
        decision: "reject",
        rentChargeStatus: "due",
      });

      const [payment, bill, cleanup] = await Promise.all([
        db.collection("payments").doc(pending.paymentId).get(),
        db.collection("rentCharges").doc(fixture.billId).get(),
        db
          .collection("paymentProofCleanupOutbox")
          .doc(pending.paymentId)
          .get(),
      ]);
      expect(payment.data()).toMatchObject({
        status: "rejected",
        reviewedBy: fixture.landlordId,
        rejectionReasonCode: reasonCode,
        rejectionReason: reasonLabel,
        proof: {publicId: pending.proofPublicId},
        proofCleanup: {status: "pending"},
      });
      expect(payment.get("rejectionExplanation")).toBeUndefined();
      expect(bill.get("status")).toBe("due");
      expect(cleanup.data()).toMatchObject({
        sourceType: "rejected_payment",
        paymentId: pending.paymentId,
        publicId: pending.proofPublicId,
        folder: "rently/payment-proofs",
        resourceType: "image",
        status: "pending",
      });

      const notificationId = `payment_rejected_${createHash("sha256")
        .update(pending.paymentId)
        .digest("hex")}`;
      const [notification, delivery] = await Promise.all([
        db.collection("notifications").doc(notificationId).get(),
        db.collection("notificationDeliveries").doc(notificationId).get(),
      ]);
      expect(notification.data()).toMatchObject({
        recipientId: fixture.uid,
        role: "tenant",
        type: "payment_rejected",
        relatedEntity: {type: "payment", id: pending.paymentId},
      });
      expect(notification.get("body")).toContain(reasonLabel);
      expect(delivery.data()).toMatchObject({
        notificationId,
        recipientId: fixture.uid,
        status: "pending",
      });
    },
  );

  it(
    "accepts Other with a trimmed explanation and preserves the audit record",
    async () => {
      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      await service.verify(fixture.landlordId, "landlord", {
        paymentId: pending.paymentId,
        decision: "reject",
        rejectionReasonCode: "other",
        rejectionExplanation: "  Please provide a clearer receipt.  ",
      },
      );
      const payment = await db
        .collection("payments")
        .doc(pending.paymentId)
        .get();
      expect(payment.data()).toMatchObject({
        status: "rejected",
        rejectionReasonCode: "other",
        rejectionReason: "Other",
        rejectionExplanation: "Please provide a clearer receipt.",
        proof: {publicId: pending.proofPublicId},
      });
      expect(
        (
          await db
            .collection("payments")
            .where("rentChargeId", "==", fixture.billId)
            .get()
        ).size,
      ).toBe(1);
    });

  it.each([
    ["shorter than 10 characters", "x".repeat(9)],
    ["exactly 10 characters", "x".repeat(10)],
    ["exactly 500 characters", "x".repeat(500)],
    ["longer than 500 characters", "x".repeat(501)],
  ])("validates Other explanation boundary: %s", async (label, explanation) => {
    const input = {
      paymentId: randomUUID(),
      decision: "reject",
      rejectionReasonCode: "other",
      rejectionExplanation: explanation,
    };
    if (
      label === "exactly 10 characters" ||
      label === "exactly 500 characters"
    ) {
      await expect(
        service.verify("landlord", "landlord", input),
      ).rejects.toMatchObject({code: "not-found"});
    } else {
      await expect(
        service.verify("landlord", "landlord", input),
      ).rejects.toMatchObject({code: "invalid-argument"});
    }
  });

  it.each(reasonCases)(
    "rejects any explanation for predefined reason %s",
    async (reasonCode) => {
      const input = {
        paymentId: randomUUID(),
        decision: "reject",
        rejectionReasonCode: reasonCode,
        rejectionExplanation: "",
      };
      await expect(
        service.verify("landlord", "landlord", input),
      ).rejects.toMatchObject({code: "invalid-argument"});
      await expect(
        service.verify("landlord", "landlord", {
          ...input,
          rejectionExplanation: " ",
        }),
      ).rejects.toMatchObject({code: "invalid-argument"});
    },
  );

  it(
    "rejects malformed, unsupported, missing, and non-pending decisions",
    async () => {
      const paymentId = randomUUID();
      await expect(
        service.verify("landlord", "landlord", {
          paymentId,
          decision: "approve",
        }),
      ).rejects.toMatchObject({code: "invalid-argument"});
      await expect(
        service.verify("landlord", "landlord", {
          paymentId,
          decision: "accept",
          tenantId: "untrusted",
        }),
      ).rejects.toMatchObject({code: "invalid-argument"});
      await expect(
        service.verify("landlord", "landlord", {
          paymentId,
          decision: "reject",
          rejectionReasonCode: "not_a_reason",
        }),
      ).rejects.toMatchObject({code: "invalid-argument"});
      await expect(
        service.verify("landlord", "landlord", {
          paymentId,
          decision: "accept",
        }),
      ).rejects.toMatchObject({code: "not-found"});

      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      await db.collection("payments").doc(pending.paymentId).update({
        status: "created",
      },
      );
      await expect(
        service.verify(fixture.landlordId, "landlord", {
          paymentId: pending.paymentId,
          decision: "accept",
        }),
      ).rejects.toMatchObject({code: "failed-precondition"});
      expect(
        (await db.collection("rentCharges").doc(fixture.billId).get()).get(
          "status",
        ),
      ).toBe("payment_pending");
    });

  it("rejects a landlord who does not own the linked property", async () => {
    const fixture = await seedFixture();
    const otherLandlord = await seedFixture();
    const pending = await pendingPayment(fixture);
    await expect(
      service.verify(otherLandlord.landlordId, "landlord", {
        paymentId: pending.paymentId,
        decision: "accept",
      }),
    ).rejects.toMatchObject({code: "permission-denied"});
  });

  it.each(["vacant", "reassigned"] as const)(
    "verifies an ended-lease payment with a %s unit without changing occupancy",
    async (unitState) => {
      const fixture = await seedFixture({leaseStatus: "ended"});
      const pending = await pendingPayment(fixture);
      if (unitState === "reassigned") {
        const newTenantId = `payment-tenant-${randomUUID()}`;
        const newLeaseId = `payment-lease-${randomUUID()}`;
        const tenantRef = db.collection("users").doc(newTenantId);
        const leaseRef = db.collection("leases").doc(newLeaseId);
        trackRef(tenantRef);
        trackRef(leaseRef);
        await Promise.all([
          tenantRef.set({uid: newTenantId, role: "tenant"}),
          leaseRef.set({
            tenantId: newTenantId,
            landlordId: fixture.landlordId,
            propertyId: fixture.propertyId,
            unitId: fixture.unitId,
            status: "active",
          }),
          db.collection("units").doc(fixture.unitId).update({
            status: "occupied",
            currentLeaseId: newLeaseId,
          }),
        ]);
      }
      const unitRef = db.collection("units").doc(fixture.unitId);
      const unitBefore = (await unitRef.get()).data();

      await service.verify(fixture.landlordId, "landlord", {
        paymentId: pending.paymentId,
        decision: "accept",
      });

      expect((await unitRef.get()).data()).toEqual(unitBefore);
    },
  );

  it.each([
    [
      "payment tenant reference",
      "payments",
      "tenantId",
      "other-tenant",
      "failed-precondition",
    ],
    [
      "payment landlord ownership",
      "payments",
      "landlordId",
      "other-landlord",
      "permission-denied",
    ],
    [
      "payment unit reference",
      "payments",
      "unitId",
      "other-unit",
      "failed-precondition",
    ],
    [
      "bill tenant relationship",
      "rentCharges",
      "tenantId",
      "other-tenant",
      "failed-precondition",
    ],
    [
      "bill lease relationship",
      "rentCharges",
      "leaseId",
      "other-lease",
      "failed-precondition",
    ],
    [
      "lease tenant relationship",
      "leases",
      "tenantId",
      "other-tenant",
      "failed-precondition",
    ],
    [
      "lease property relationship",
      "leases",
      "propertyId",
      "other-property",
      "failed-precondition",
    ],
    [
      "property landlord ownership",
      "properties",
      "landlordId",
      "other-landlord",
      "permission-denied",
    ],
    [
      "unit property relationship",
      "units",
      "propertyId",
      "other-property",
      "failed-precondition",
    ],
    [
      "unit landlord relationship",
      "units",
      "landlordId",
      "other-landlord",
      "failed-precondition",
    ],
    ["tenant role", "users", "role", "landlord", "failed-precondition"],
    ["landlord role", "users", "role", "tenant", "permission-denied"],
    [
      "active unit lease",
      "units",
      "currentLeaseId",
      "other-lease",
      "failed-precondition",
    ],
  ] as const)(
    "rejects inconsistent %s",
    async (_name, collection, field, value, expectedCode) => {
      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      const documentId = collection === "payments" ?
        pending.paymentId :
        collection === "rentCharges" ?
          fixture.billId :
          collection === "leases" ?
            fixture.leaseId :
            collection === "properties" ?
              fixture.propertyId :
              collection === "units" ?
                fixture.unitId :
                field === "role" && value === "tenant" ?
                  fixture.landlordId :
                  fixture.uid;
      await db.collection(collection).doc(documentId).update({
        [field]: value,
      });
      await expect(
        service.verify(fixture.landlordId, "landlord", {
          paymentId: pending.paymentId,
          decision: "accept",
        }),
      ).rejects.toMatchObject({code: expectedCode});
      expect(
        (await db.collection("payments").doc(pending.paymentId).get()).get(
          "status",
        ),
      ).toBe("pending_verification");
    },
  );

  it(
    "rejects missing linked records without changing payment or bill",
    async () => {
      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      await db.collection("units").doc(fixture.unitId).delete();
      await expect(
        service.verify(fixture.landlordId, "landlord", {
          paymentId: pending.paymentId,
          decision: "accept",
        }),
      ).rejects.toMatchObject({code: "failed-precondition"});
      expect(
        (await db.collection("payments").doc(pending.paymentId).get()).get(
          "status",
        ),
      ).toBe("pending_verification");
      expect(
        (await db.collection("rentCharges").doc(fixture.billId).get()).get(
          "status",
        ),
      ).toBe("payment_pending");
    },
  );

  it(
    "restores due versus overdue using the current UTC calendar date",
    async () => {
      nowMs = Date.parse("2026-11-10T23:59:59.999Z");
      const dueFixture = await seedFixture();
      const duePayment = await pendingPayment(dueFixture);
      await service.verify(dueFixture.landlordId, "landlord", {
        paymentId: duePayment.paymentId,
        decision: "reject",
        rejectionReasonCode: "incorrect_utr",
      });
      expect(
        (await db.collection("rentCharges").doc(dueFixture.billId).get()).get(
          "status",
        ),
      ).toBe("due");

      nowMs = Date.parse("2026-11-11T00:00:00.000Z");
      const overdueFixture = await seedFixture();
      await db
        .collection("rentCharges")
        .doc(overdueFixture.billId)
        .update({dueDate: "2026-11-10"});
      const overduePayment = await pendingPayment(overdueFixture);
      await service.verify(overdueFixture.landlordId, "landlord", {
        paymentId: overduePayment.paymentId,
        decision: "reject",
        rejectionReasonCode: "incorrect_utr",
      });
      expect(
        (
          await db
            .collection("rentCharges")
            .doc(overdueFixture.billId)
            .get()
        ).get("status"),
      ).toBe("overdue");
    },
  );

  it(
    "returns identical rejection retries without duplicate side effects",
    async () => {
      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      const input = {
        paymentId: pending.paymentId,
        decision: "reject",
        rejectionReasonCode: "other",
        rejectionExplanation: "Please upload a readable image.",
      } satisfies VerifyUpiPaymentInput;
      const first = await service.verify(fixture.landlordId, "landlord", input);
      await service.recoverCleanup();
      expect(
        await service.verify(fixture.landlordId, "landlord", input),
      ).toEqual(first);
      await expect(
        service.verify(fixture.landlordId, "landlord", {
          ...input,
          rejectionExplanation: "A different explanation.",
        }),
      ).rejects.toMatchObject({code: "failed-precondition"});
      expect(
        (
          await db
            .collection("notifications")
            .where("relatedEntity.id", "==", pending.paymentId)
            .get()
        ).size,
      ).toBe(2);
      expect(
        (
          await db
            .collection("paymentProofCleanupOutbox")
            .where("paymentId", "==", pending.paymentId)
            .get()
        ).size,
      ).toBe(1);
      expect(
        (
          await db
            .collection("paymentProofCleanupOutbox")
            .doc(pending.paymentId)
            .get()
        ).get("status"),
      ).toBe("completed");
      expect(cloudinaryState.assets.has(pending.proofPublicId)).toBe(false);
      const payment = await db
        .collection("payments")
        .doc(pending.paymentId)
        .get();
      expect(payment.get("status")).toBe("rejected");
      expect(payment.get("proofCleanup.status")).toBe("deleted");
    },
  );

  it(
    "allows only one outcome for concurrent conflicting decisions",
    async () => {
      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      const results = await Promise.allSettled([
        service.verify(fixture.landlordId, "landlord", {
          paymentId: pending.paymentId,
          decision: "accept",
        }),
        service.verify(fixture.landlordId, "landlord", {
          paymentId: pending.paymentId,
          decision: "reject",
          rejectionReasonCode: "incorrect_utr",
        }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);

      const [payment, bill, notifications] = await Promise.all([
        db.collection("payments").doc(pending.paymentId).get(),
        db.collection("rentCharges").doc(fixture.billId).get(),
        db
          .collection("notifications")
          .where("relatedEntity.id", "==", pending.paymentId)
          .get(),
      ]);
      expect(notifications.size).toBe(2);
      if (payment.get("status") === "verified") {
        expect(bill.get("status")).toBe("paid");
        expect(payment.get("proofCleanup.status")).toBe("retained");
        expect(
          (
            await db
              .collection("paymentProofCleanupOutbox")
              .doc(pending.paymentId)
              .get()
          ).exists,
        ).toBe(false);
      } else {
        expect(payment.get("status")).toBe("rejected");
        expect(["due", "overdue"]).toContain(bill.get("status"));
        expect(payment.get("proofCleanup.status")).toBe("pending");
        expect(
          (
            await db
              .collection("paymentProofCleanupOutbox")
              .doc(pending.paymentId)
              .get()
          ).get("publicId"),
        ).toBe(pending.proofPublicId);
      }
    },
  );

  it.each(["verified", "pending_verification"] as const)(
    "refuses to delete a proof referenced by another %s payment",
    async (otherPaymentStatus) => {
      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      await service.verify(fixture.landlordId, "landlord", {
        paymentId: pending.paymentId,
        decision: "reject",
        rejectionReasonCode: "incorrect_utr",
      });
      const otherPaymentId = randomUUID();
      const otherPaymentRef = db.collection("payments").doc(otherPaymentId);
      trackRef(otherPaymentRef);
      await otherPaymentRef.set({
        status: otherPaymentStatus,
        proof: {
          provider: "cloudinary",
          publicId: pending.proofPublicId,
          resourceType: "image",
        },
      });

      await service.recoverCleanup();

      const [cleanup, payment] = await Promise.all([
        db
          .collection("paymentProofCleanupOutbox")
          .doc(pending.paymentId)
          .get(),
        db.collection("payments").doc(pending.paymentId).get(),
      ]);
      expect(cleanup.get("status")).toBe("terminal_failure");
      expect(payment.get("proofCleanup.status")).toBe("terminal_failure");
      expect(cloudinaryState.assets.has(pending.proofPublicId)).toBe(true);
      expect(cloudinaryState.deleteCalls).toBe(0);
    },
  );

  it(
    "binds cleanup to the rejected payment's exact immutable proof",
    async () => {
      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      await service.verify(fixture.landlordId, "landlord", {
        paymentId: pending.paymentId,
        decision: "reject",
        rejectionReasonCode: "incorrect_utr",
      });
      await db
        .collection("paymentProofCleanupOutbox")
        .doc(pending.paymentId)
        .update({publicId: "another-payment-proof"});

      await service.recoverCleanup();

      const cleanup = await db
        .collection("paymentProofCleanupOutbox")
        .doc(pending.paymentId)
        .get();
      expect(cleanup.get("status")).toBe("terminal_failure");
      expect(cloudinaryState.assets.has(pending.proofPublicId)).toBe(true);
      expect(cloudinaryState.deleteCalls).toBe(0);
    },
  );

  it(
    "rejects a cleanup task bound to another payment " +
      "without changing either payment",
    async () => {
      const rejectedFixture = await seedFixture();
      const rejected = await pendingPayment(rejectedFixture);
      await service.verify(rejectedFixture.landlordId, "landlord", {
        paymentId: rejected.paymentId,
        decision: "reject",
        rejectionReasonCode: "incorrect_utr",
      });

      const otherFixture = await seedFixture();
      const other = await pendingPayment(otherFixture);
      await db
        .collection("paymentProofCleanupOutbox")
        .doc(rejected.paymentId)
        .update({
          paymentId: other.paymentId,
          publicId: other.proofPublicId,
        });

      await service.recoverCleanup();

      const [cleanup, rejectedPayment, otherPayment] = await Promise.all([
        db
          .collection("paymentProofCleanupOutbox")
          .doc(rejected.paymentId)
          .get(),
        db.collection("payments").doc(rejected.paymentId).get(),
        db.collection("payments").doc(other.paymentId).get(),
      ]);
      expect(cleanup.get("status")).toBe("terminal_failure");
      expect(rejectedPayment.get("status")).toBe("rejected");
      expect(rejectedPayment.get("proofCleanup.status")).toBe("pending");
      expect(otherPayment.get("status")).toBe("pending_verification");
      expect(otherPayment.get("proofCleanup.status")).toBe("not_requested");
      expect(cloudinaryState.assets.has(rejected.proofPublicId)).toBe(true);
      expect(cloudinaryState.assets.has(other.proofPublicId)).toBe(true);
      expect(cloudinaryState.deleteCalls).toBe(0);
    },
  );

  it(
    "retries rejected-proof cleanup and records terminal failure",
    async () => {
      const fixture = await seedFixture();
      const pending = await pendingPayment(fixture);
      await service.verify(fixture.landlordId, "landlord", {
        paymentId: pending.paymentId,
        decision: "reject",
        rejectionReasonCode: "incorrect_utr",
      });
      cloudinaryState.deleteError = new Error("Cloudinary unavailable");
      const cleanupRef = db
        .collection("paymentProofCleanupOutbox")
        .doc(pending.paymentId);

      for (
        let attempt = 1;
        attempt <= paymentProofCleanupMaxAttempts;
        attempt++
      ) {
        await service.recoverCleanup();
        const cleanup = await cleanupRef.get();
        expect(cleanup.get("attempts")).toBe(attempt);
        if (attempt < paymentProofCleanupMaxAttempts) {
          expect(cleanup.get("status")).toBe("pending");
          nowMs = cleanup.get("nextAttemptAt").toMillis();
        } else {
          expect(cleanup.get("status")).toBe("terminal_failure");
          expect(
            (await db.collection("payments").doc(pending.paymentId).get()).get(
              "proofCleanup.status",
            ),
          ).toBe("terminal_failure");
        }
      }
      expect(cloudinaryState.assets.has(pending.proofPublicId)).toBe(true);
    },
  );
});

describe("Cloudinary adapter", () => {
  it("verifies the exact Cloudinary asset and configured account", async () => {
    const asset = {
      public_id: "proof-id",
      asset_folder: "rently/payment-proofs",
      resource_type: "image",
      format: "png",
      bytes: 42,
      secure_url:
        "https://res.cloudinary.com/demo/image/upload/v123/proof-id.png",
      created_at: new Date().toISOString(),
    };
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(asset), {status: 200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...asset,
        secure_url:
          "https://res.cloudinary.com/other/image/upload/proof-id.png",
      }), {status: 200}));
    try {
      const gateway = createCloudinaryGateway({
        cloudName: "demo",
        apiKey: "server-api-key",
        apiSecret: "server-api-secret",
      });
      await expect(
        gateway.get("proof-id", "rently/payment-proofs"),
      ).resolves.toMatchObject({
        publicId: "proof-id",
        folder: "rently/payment-proofs",
        resourceType: "image",
        format: "png",
        bytes: 42,
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.cloudinary.com/v1_1/demo/resources/" +
          "image/upload/proof-id",
      );
      await expect(
        gateway.get("proof-id", "rently/payment-proofs"),
      ).rejects.toThrow("Cloudinary asset does not match the requested proof.");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it(
    "uses server Basic Auth and the fixed asset folder and public ID",
    async () => {
      const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            public_id: "unguessable-id",
            asset_folder: "rently/payment-proofs",
            resource_type: "image",
            format: "png",
            bytes: 42,
            secure_url:
            "https://res.cloudinary.com/demo/image/upload/" + "unguessable-id",
            created_at: new Date().toISOString(),
          }),
          {status: 200},
        ),
      );
      try {
        const gateway = createCloudinaryGateway({
          cloudName: "demo",
          apiKey: "server-api-key",
          apiSecret: "server-api-secret",
        },
        );
        await gateway.upload(
          Buffer.from("proof"),
          "png",
          "unguessable-id",
          "rently/payment-proofs",
        );
        const [url, request] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.cloudinary.com/v1_1/demo/image/upload");
        expect(new Headers(request?.headers).get("authorization")).toBe(
          `Basic ${Buffer.from("server-api-key:server-api-secret").toString(
            "base64",
          )}`,
        );
        const body = request?.body;
        expect(body).toBeInstanceOf(FormData);
        if (!(body instanceof FormData)) {
          throw new Error(
            "Cloudinary upload body must be multipart form data.",
          );
        }
        expect(body.get("asset_folder")).toBe("rently/payment-proofs");
        expect(body.get("public_id")).toBe("unguessable-id");
        expect(body.get("overwrite")).toBe("false");
        expect(body.get("folder")).toBeNull();
        expect(body.get("api_secret")).toBeNull();
        expect(body.get("signature")).toBeNull();
      } finally {
        fetchMock.mockRestore();
      }
    });

  it(
    "treats a missing Cloudinary asset as an already-completed deletion",
    async () => {
      const fetchMock = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", {status: 404}));
      try {
        const gateway = createCloudinaryGateway({
          cloudName: "demo",
          apiKey: "server-api-key",
          apiSecret: "server-api-secret",
        },
        );
        await expect(
          gateway.delete("unguessable-id", "rently/payment-proofs"),
        ).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        fetchMock.mockRestore();
      }
    });
});

describe("expired upload cleanup", () => {
  /**
   * Creates and expires one unconsumed upload intent.
   * @return {Promise<object>} Fixture and expired intent ID
   */
  async function createExpiredIntent(): Promise<{
    fixture: Fixture;
    intentId: string;
  }> {
    const fixture = await seedFixture();
    const image = createPng();
    const prepared = await service.prepare(
      fixture.uid,
      "tenant",
      prepareInput(fixture, {bytes: image.length}),
    );
    const intentRef = db
      .collection("paymentUploadIntents")
      .doc(prepared.uploadIntentId);
    trackRef(intentRef);
    trackRef(
      db
        .collection("paymentProofCleanupOutbox")
        .doc(`upload_${prepared.uploadIntentId}`),
    );
    nowMs += paymentUploadIntentMs + 1;
    return {fixture, intentId: prepared.uploadIntentId};
  }

  it("treats an absent Cloudinary asset as cleaned", async () => {
    const {intentId} = await createExpiredIntent();
    await service.recoverCleanup();
    const task = await db
      .collection("paymentProofCleanupOutbox")
      .doc(`upload_${intentId}`)
      .get();
    const intent = await db
      .collection("paymentUploadIntents")
      .doc(intentId)
      .get();
    expect(task.get("status")).toBe("completed");
    expect(intent.get("status")).toBe("cleaned");
    expect(cloudinaryState.deleteCalls).toBe(1);
  });

  it("backs off, terminates, and preserves manual retry history", async () => {
    const {intentId} = await createExpiredIntent();
    cloudinaryState.deleteError = new Error("temporary Cloudinary failure");
    const taskRef = db
      .collection("paymentProofCleanupOutbox")
      .doc(`upload_${intentId}`);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const attemptStartedAt = nowMs;
      await service.recoverCleanup();
      const task = await taskRef.get();
      if (attempt < 5) {
        expect(task.get("status")).toBe("pending");
        const nextAttemptAt = task.get(
          "nextAttemptAt",
        ) as import("firebase-admin/firestore").Timestamp;
        const delay = paymentProofCleanupBaseBackoffMs * 2 ** (attempt - 1);
        expect(nextAttemptAt.toMillis()).toBe(attemptStartedAt + delay);
        nowMs = nextAttemptAt.toMillis();
      }
    }

    const terminalTask = await taskRef.get();
    expect(terminalTask.get("status")).toBe("terminal_failure");
    expect(terminalTask.get("attempts")).toBe(5);
    expect(terminalTask.get("errorHistory")).toHaveLength(5);
    expect(
      (await db.collection("paymentUploadIntents").doc(intentId).get()).get(
        "status",
      ),
    ).toBe("terminal_failure");

    const history = terminalTask.get("errorHistory");
    cloudinaryState.deleteError = undefined;
    await taskRef.update({
      status: "pending",
      attempts: 0,
      manualRetryCount: 1,
      nextAttemptAt: admin.firestore.Timestamp.fromMillis(nowMs),
    });
    await service.recoverCleanup();
    const retriedTask = await taskRef.get();
    expect(retriedTask.get("status")).toBe("completed");
    expect(retriedTask.get("errorHistory")).toEqual(history);
  });

  it(
    "terminalizes a reclaimed exhausted intent task and its source",
    async () => {
      const {intentId} = await createExpiredIntent();
      const intentRef = db.collection("paymentUploadIntents").doc(intentId);
      const taskRef = db
        .collection("paymentProofCleanupOutbox")
        .doc(`upload_${intentId}`);
      const history = [
        {
          attempt: 5,
          attemptedAt: admin.firestore.Timestamp.fromMillis(nowMs - 1000),
          error: "Cloudinary unavailable",
        },
      ];
      await intentRef.update({status: "cleanup_pending"});
      await taskRef.set({
        sourceType: "expired_upload_intent",
        uploadIntentId: intentId,
        publicId: `proof-${randomUUID()}`,
        folder: "rently/payment-proofs",
        resourceType: "image",
        status: "processing",
        attempts: 5,
        manualRetryCount: 0,
        errorHistory: history,
        claimedBy: "expired-worker",
        claimExpiresAt: admin.firestore.Timestamp.fromMillis(nowMs - 1),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      );

      await service.recoverCleanup();
      const task = await taskRef.get();
      expect(task.get("status")).toBe("terminal_failure");
      expect(task.get("errorHistory")).toEqual(history);
      expect((await intentRef.get()).get("status")).toBe("terminal_failure");
      expect(cloudinaryState.deleteCalls).toBe(0);
    });

  it(
    "terminalizes payment cleanup state for an exhausted reclaimed task",
    async () => {
      const fixture = await seedFixture();
      const paymentId = `rejected-${randomUUID()}`;
      const paymentRef = db.collection("payments").doc(paymentId);
      const taskRef = db.collection("paymentProofCleanupOutbox").doc(paymentId);
      const publicId = `proof-${randomUUID()}`;
      trackRef(paymentRef);
      trackRef(taskRef);
      const history = [
        {
          attempt: 5,
          attemptedAt: admin.firestore.Timestamp.fromMillis(nowMs - 1000),
          error: "Cloudinary unavailable",
        },
      ];
      await paymentRef.set({
        tenantId: fixture.uid,
        status: "rejected",
        proof: {publicId},
        proofCleanup: {status: "pending"},
      },
      );
      await taskRef.set({
        sourceType: "rejected_payment",
        paymentId,
        publicId,
        folder: "rently/payment-proofs",
        resourceType: "image",
        status: "processing",
        attempts: 5,
        manualRetryCount: 0,
        errorHistory: history,
        claimedBy: "expired-worker",
        claimExpiresAt: admin.firestore.Timestamp.fromMillis(nowMs - 1),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await service.recoverCleanup();
      const task = await taskRef.get();
      expect(task.get("status")).toBe("terminal_failure");
      expect(task.get("errorHistory")).toEqual(history);
      expect((await paymentRef.get()).get("proofCleanup.status")).toBe(
        "terminal_failure",
      );
      expect(cloudinaryState.deleteCalls).toBe(0);
    });

  it("never deletes proof referenced by a verified payment", async () => {
    const {fixture, intentId} = await createExpiredIntent();
    const intent = await db
      .collection("paymentUploadIntents")
      .doc(intentId)
      .get();
    const paymentId = `verified-${randomUUID()}`;
    const paymentRef = db.collection("payments").doc(paymentId);
    trackRef(paymentRef);
    await paymentRef.set({
      tenantId: fixture.uid,
      status: "verified",
      proof: {publicId: intent.get("publicId")},
    });

    await service.recoverCleanup();
    const task = await db
      .collection("paymentProofCleanupOutbox")
      .doc(`upload_${intentId}`)
      .get();
    expect(task.get("status")).toBe("terminal_failure");
    expect(cloudinaryState.deleteCalls).toBe(0);
  });
});
