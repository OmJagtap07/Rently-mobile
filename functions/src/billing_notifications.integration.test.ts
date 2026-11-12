const projectId = "demo-rently";
const firestoreEmulatorPort =
  process.env.PHASE3_FIRESTORE_EMULATOR_PORT ?? "8080";

process.env.GCLOUD_PROJECT = projectId;
process.env.FIREBASE_CONFIG = JSON.stringify({projectId});
process.env.FIRESTORE_EMULATOR_HOST =
  `127.0.0.1:${firestoreEmulatorPort}`;

import {createHash, randomUUID} from "crypto";
import {
  deleteApp,
  getApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import {Firestore, getFirestore} from "firebase-admin/firestore";
import {
  deliverNotificationToDevice,
  deliveryMaxAttempts,
  deliveryRetryDelayMs,
  expandNotificationDeliveries,
  recoverNotificationDeliveries,
  run1stTenantNotifications,
  run25thLandlordReminder,
} from "./billing_notifications.js";

jest.setTimeout(30000);

let db: Firestore;

const landlordIds: string[] = [];
const leaseIds: string[] = [];
const rentChargeIds: string[] = [];
const notificationIds: string[] = [];
const userIds: string[] = [];

/**
 * Mirrors the workflow's deterministic notification ID construction.
 * @param {string} prefix Notification type
 * @param {...string} parts Notification identity fields
 * @return {string} Stable document ID
 */
function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${prefix}_${digest}`;
}

/**
 * Computes the device-token document key used by the delivery helper.
 * @param {string} token Raw test token
 * @return {string} SHA-256 token hash
 */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Removes documents created by these emulator integration tests.
 * @return {Promise<void>} Resolves after all fixtures are removed
 */
async function clearTestDocuments(): Promise<void> {
  for (const notificationId of notificationIds.splice(0)) {
    const deliveryRef = db.collection("notificationDeliveries")
      .doc(notificationId);
    const deviceDocs = await deliveryRef.collection("devices").get();
    const batch = db.batch();
    deviceDocs.docs.forEach((doc) => batch.delete(doc.ref));
    if (!deviceDocs.empty) await batch.commit();
    await deliveryRef.delete();
    await db.collection("notifications").doc(notificationId).delete();
  }
  for (const rentChargeId of rentChargeIds.splice(0)) {
    await db.collection("rentCharges").doc(rentChargeId).delete();
  }
  for (const leaseId of leaseIds.splice(0)) {
    await db.collection("leases").doc(leaseId).delete();
  }
  for (const landlordId of landlordIds.splice(0)) {
    await db.collection("users").doc(landlordId).delete();
  }
  for (const userId of userIds.splice(0)) {
    const tokens = await db.collection("users").doc(userId)
      .collection("deviceTokens").get();
    const batch = db.batch();
    tokens.docs.forEach((doc) => batch.delete(doc.ref));
    if (!tokens.empty) await batch.commit();
    await db.collection("users").doc(userId).delete();
  }
}

beforeAll(async () => {
  if (getApps().length === 0) initializeApp({projectId});
  db = getFirestore();
});

beforeEach(async () => {
  await clearTestDocuments();
});

afterAll(async () => {
  await clearTestDocuments();
  await deleteApp(getApp());
});

describe("25th landlord billing reminder", () => {
  it(
    "groups active leases and retries idempotently",
    async () => {
      const landlordId = `billing-landlord-${randomUUID()}`;
      const noActiveLandlordId = `billing-landlord-${randomUUID()}`;
      landlordIds.push(landlordId, noActiveLandlordId);
      const activeLeaseA = `billing-lease-${randomUUID()}`;
      const activeLeaseB = `billing-lease-${randomUUID()}`;
      const endedLease = `billing-lease-${randomUUID()}`;
      leaseIds.push(activeLeaseA, activeLeaseB, endedLease);

      await Promise.all([
        db.collection("leases").doc(activeLeaseA).set({
          landlordId,
          status: "active",
        }),
        db.collection("leases").doc(activeLeaseB).set({
          landlordId,
          status: "active",
        }),
        db.collection("leases").doc(endedLease).set({
          landlordId: noActiveLandlordId,
          status: "ended",
        }),
      ]);

      const rentChargeId = `untouched-${randomUUID()}`;
      rentChargeIds.push(rentChargeId);
      const sentinel = {status: "draft", marker: "must-not-change"};
      await db.collection("rentCharges").doc(rentChargeId).set(sentinel);
      const rentChargesBefore = await db.collection("rentCharges").get();

      const scheduleTime = "2026-03-25T23:59:59Z";
      await Promise.all([
        run25thLandlordReminder(db, scheduleTime),
        run25thLandlordReminder(db, scheduleTime),
      ]);

      const notificationId = stableId(
        "prepare_bill_reminder",
        landlordId,
        "prepare_bill_reminder",
        "2026-04"
      );
      notificationIds.push(notificationId);
      const notification = await db.collection("notifications")
        .doc(notificationId).get();
      expect(notification.data()).toMatchObject({
        recipientId: landlordId,
        role: "landlord",
        type: "prepare_bill_reminder",
        title: "Prepare next month's bills",
        body: "Please prepare rent bills for 2026-04.",
        read: false,
      });
      expect(await db.collection("notificationDeliveries")
        .doc(notificationId).get().then((doc) => doc.exists)).toBe(true);

      const absentNotificationId = stableId(
        "prepare_bill_reminder",
        noActiveLandlordId,
        "prepare_bill_reminder",
        "2026-04"
      );
      expect(await db.collection("notifications")
        .doc(absentNotificationId).get().then((doc) => doc.exists)).toBe(false);
      const landlordReminders = (await db.collection("notifications").get())
        .docs.filter((doc) =>
          doc.get("recipientId") === landlordId &&
          doc.get("type") === "prepare_bill_reminder"
        );
      expect(landlordReminders).toHaveLength(1);
      const actualNotificationId = (await db.collection("notifications")
        .doc(notificationId).get()).id;
      expect(actualNotificationId).toBe(notificationId);
      const rentChargesAfter = await db.collection("rentCharges").get();
      expect(rentChargesAfter.docs.map((doc) => [doc.id, doc.data()]))
        .toEqual(rentChargesBefore.docs.map((doc) => [doc.id, doc.data()]));
    }
  );

  it("selects the upcoming month using UTC schedule time", async () => {
    const landlordId = `billing-landlord-${randomUUID()}`;
    const leaseId = `billing-lease-${randomUUID()}`;
    landlordIds.push(landlordId);
    leaseIds.push(leaseId);
    await db.collection("leases").doc(leaseId).set({
      landlordId,
      status: "active",
    });

    await run25thLandlordReminder(
      db,
      "2026-12-25T23:59:59Z"
    );

    const decemberReminder = stableId(
      "prepare_bill_reminder",
      landlordId,
      "prepare_bill_reminder",
      "2027-01"
    );
    notificationIds.push(decemberReminder);
    expect(await db.collection("notifications")
      .doc(decemberReminder).get().then((doc) => doc.exists)).toBe(true);
  });
});

describe("1st tenant bill notification", () => {
  it(
    "transitions current-month finalized bills and notifies once",
    async () => {
      const tenantId = `billing-tenant-${randomUUID()}`;
      userIds.push(tenantId);
      const currentBillId = `billing-charge-${randomUUID()}`;
      const priorMonthBillId = `billing-charge-${randomUUID()}`;
      const draftBillId = `billing-charge-${randomUUID()}`;
      rentChargeIds.push(currentBillId, priorMonthBillId, draftBillId);
      await db.collection("users").doc(tenantId).set({role: "tenant"});
      await Promise.all([
        db.collection("rentCharges").doc(currentBillId).set({
          status: "finalized",
          billingMonth: "2026-11",
          tenantId,
          total: 123450,
        }),
        db.collection("rentCharges").doc(priorMonthBillId).set({
          status: "finalized",
          billingMonth: "2026-10",
          tenantId,
          total: 90000,
        }),
        db.collection("rentCharges").doc(draftBillId).set({
          status: "draft",
          billingMonth: "2026-11",
          tenantId,
          total: 100000,
        }),
      ]);

      await Promise.all([
        run1stTenantNotifications(db, "2026-11-01T00:00:00Z"),
        run1stTenantNotifications(db, "2026-11-01T00:00:00Z"),
      ]);

      const notificationId = stableId("rent_due", currentBillId);
      notificationIds.push(notificationId);
      const [currentBill, priorMonthBill, draftBill, notification, delivery] =
      await Promise.all([
        db.collection("rentCharges").doc(currentBillId).get(),
        db.collection("rentCharges").doc(priorMonthBillId).get(),
        db.collection("rentCharges").doc(draftBillId).get(),
        db.collection("notifications").doc(notificationId).get(),
        db.collection("notificationDeliveries").doc(notificationId).get(),
      ]);
      expect(currentBill.get("status")).toBe("due");
      expect(priorMonthBill.get("status")).toBe("finalized");
      expect(draftBill.get("status")).toBe("draft");
      const priorMonthNotificationId = stableId("rent_due", priorMonthBillId);
      const draftNotificationId = stableId("rent_due", draftBillId);
      const [priorMonthNotification, draftNotification] = await Promise.all([
        db.collection("notifications").doc(priorMonthNotificationId).get(),
        db.collection("notifications").doc(draftNotificationId).get(),
      ]);
      expect(priorMonthNotification.exists).toBe(false);
      expect(draftNotification.exists).toBe(false);
      expect(notification.data()).toMatchObject({
        recipientId: tenantId,
        role: "tenant",
        type: "rent_due",
        relatedEntity: {type: "rentCharge", id: currentBillId},
        body: "Your 2026-11 rent bill is ₹1234.50.",
        read: false,
      }
      );
      expect(delivery.exists).toBe(true);
      expect((await db.collection("rentCharges").get()).docs)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({id: currentBillId}),
          expect.objectContaining({id: priorMonthBillId}),
          expect.objectContaining({id: draftBillId}),
        ]));
    });

  it("selects the scheduled billing month in UTC", async () => {
    const tenantId = `billing-tenant-${randomUUID()}`;
    userIds.push(tenantId);
    const utcMarchBillId = `billing-charge-${randomUUID()}`;
    const utcAprilBillId = `billing-charge-${randomUUID()}`;
    rentChargeIds.push(utcMarchBillId, utcAprilBillId);
    await Promise.all([
      db.collection("rentCharges").doc(utcMarchBillId).set({
        status: "finalized",
        billingMonth: "2026-03",
        tenantId,
        total: 100,
      }),
      db.collection("rentCharges").doc(utcAprilBillId).set({
        status: "finalized",
        billingMonth: "2026-04",
        tenantId,
        total: 200,
      }),
    ]);

    await run1stTenantNotifications(db, "2026-04-01T00:00:00Z");

    expect((await db.collection("rentCharges").doc(utcMarchBillId).get())
      .get("status")).toBe("finalized");
    expect((await db.collection("rentCharges").doc(utcAprilBillId).get())
      .get("status")).toBe("due");
    const aprilNotificationId = stableId("rent_due", utcAprilBillId);
    notificationIds.push(aprilNotificationId);
    expect(await db.collection("notifications")
      .doc(aprilNotificationId).get().then((doc) => doc.exists)).toBe(true);
  });
});

describe("FCM notification delivery outbox", () => {
  it("expands a notification idempotently per device", async () => {
    const userId = `billing-user-${randomUUID()}`;
    userIds.push(userId);
    const notificationId = `notification-${randomUUID()}`;
    notificationIds.push(notificationId);
    const token = `device-token-${randomUUID()}`;
    const secondToken = `device-token-${randomUUID()}`;
    const hash = tokenHash(token);
    const secondHash = tokenHash(secondToken);
    await Promise.all([
      db.collection("users").doc(userId).set({role: "tenant"}),
      db.collection("users").doc(userId)
        .collection("deviceTokens").doc(hash).set({token}),
      db.collection("users").doc(userId)
        .collection("deviceTokens").doc(secondHash).set({token: secondToken}),
      db.collection("notifications").doc(notificationId).set({
        recipientId: userId,
        role: "tenant",
        type: "rent_due",
        title: "Bill",
        body: "Due",
        read: false,
      }),
      db.collection("notificationDeliveries").doc(notificationId).set({
        notificationId,
        recipientId: userId,
        status: "pending",
      }),
    ]);

    await expandNotificationDeliveries(db, notificationId);
    await expandNotificationDeliveries(db, notificationId);

    const deviceTasks = await db.collection("notificationDeliveries")
      .doc(notificationId)
      .collection("devices")
      .get();
    expect(deviceTasks.docs.map((doc) => doc.id).sort())
      .toEqual([hash, secondHash].sort());
    expect(deviceTasks.docs.every((doc) => doc.get("status") === "pending"))
      .toBe(true);
  });

  it("sends once when a successful delivery event is retried", async () => {
    const userId = `billing-user-${randomUUID()}`;
    userIds.push(userId);
    const notificationId = `notification-${randomUUID()}`;
    notificationIds.push(notificationId);
    const token = `device-token-${randomUUID()}`;
    const hash = tokenHash(token);
    await db.collection("users").doc(userId)
      .collection("deviceTokens").doc(hash).set({token});
    await db.collection("notifications").doc(notificationId).set({
      recipientId: userId,
      role: "tenant",
      type: "rent_due",
      title: "Bill",
      body: "Due",
      read: false,
    });
    await db.collection("notificationDeliveries").doc(notificationId)
      .collection("devices").doc(hash).set({
        notificationId,
        recipientId: userId,
        tokenHash: hash,
        status: "pending",
        attempts: 0,
      });

    const send = jest.fn(async () => "fcm-message-id");
    await deliverNotificationToDevice(
      db,
      {notificationId, tokenHash: hash},
      send
    );
    await deliverNotificationToDevice(
      db,
      {notificationId, tokenHash: hash},
      send
    );

    expect(send).toHaveBeenCalledTimes(1);
    const savedDelivery = await db.collection("notificationDeliveries")
      .doc(notificationId).collection("devices").doc(hash).get();
    expect(savedDelivery.get("status"))
      .toBe("sent");
  });

  it("removes invalid tokens and marks their delivery invalid", async () => {
    const userId = `billing-user-${randomUUID()}`;
    const otherUserId = `billing-user-${randomUUID()}`;
    userIds.push(userId);
    userIds.push(otherUserId);
    const notificationId = `notification-${randomUUID()}`;
    notificationIds.push(notificationId);
    const token = `device-token-${randomUUID()}`;
    const hash = tokenHash(token);
    const tokenRef = db.collection("users").doc(userId)
      .collection("deviceTokens").doc(hash);
    const deliveryRef = db.collection("notificationDeliveries")
      .doc(notificationId)
      .collection("devices").doc(hash);
    await Promise.all([
      tokenRef.set({token}),
      db.collection("users").doc(otherUserId)
        .collection("deviceTokens").doc(hash).set({token}),
      db.collection("notifications").doc(notificationId).set({
        recipientId: userId,
        role: "tenant",
        type: "rent_due",
        title: "Bill",
        body: "Due",
        read: false,
      }),
      deliveryRef.set({
        notificationId,
        recipientId: userId,
        tokenHash: hash,
        status: "pending",
        attempts: 0,
      }),
    ]);

    const invalidToken = Object.assign(
      new Error("Unregistered token"),
      {code: "messaging/registration-token-not-registered"}
    );
    await deliverNotificationToDevice(
      db,
      {notificationId, tokenHash: hash},
      async () => {
        throw invalidToken;
      }
    );

    expect((await tokenRef.get()).exists).toBe(false);
    expect(await db.collection("users").doc(otherUserId)
      .collection("deviceTokens").doc(hash).get().then((doc) => doc.exists))
      .toBe(true);
    expect((await deliveryRef.get()).get("status")).toBe("invalid");
  });

  it("backs off transient FCM failures with exponential delay", async () => {
    const userId = `billing-user-${randomUUID()}`;
    userIds.push(userId);
    const notificationId = `notification-${randomUUID()}`;
    notificationIds.push(notificationId);
    const token = `device-token-${randomUUID()}`;
    const hash = tokenHash(token);
    const deliveryRef = db.collection("notificationDeliveries")
      .doc(notificationId)
      .collection("devices").doc(hash);
    await Promise.all([
      db.collection("users").doc(userId)
        .collection("deviceTokens").doc(hash).set({token}),
      db.collection("notifications").doc(notificationId).set({
        recipientId: userId,
        role: "tenant",
        type: "rent_due",
        title: "Bill",
        body: "Due",
        read: false,
      }),
      deliveryRef.set({
        notificationId,
        recipientId: userId,
        tokenHash: hash,
        status: "pending",
        attempts: 0,
      }),
    ]);

    const now = Date.now();
    await deliverNotificationToDevice(
      db,
      {notificationId, tokenHash: hash},
      async () => {
        throw new Error("temporary FCM failure");
      },
      now
    );
    const firstFailure = await deliveryRef.get();
    expect(firstFailure.get("status")).toBe("pending");
    expect(firstFailure.get("attempts")).toBe(1);
    expect(firstFailure.get("nextAttemptAt").toMillis())
      .toBe(now + deliveryRetryDelayMs(1));

    await deliverNotificationToDevice(
      db,
      {notificationId, tokenHash: hash},
      async () => "too-early",
      now + deliveryRetryDelayMs(1) - 1
    );
    expect((await deliveryRef.get()).get("attempts")).toBe(1);

    await deliverNotificationToDevice(
      db,
      {notificationId, tokenHash: hash},
      async () => "fcm-message-id",
      now + deliveryRetryDelayMs(1)
    );
    expect((await deliveryRef.get()).get("status")).toBe("sent");
    expect((await deliveryRef.get()).get("attempts")).toBe(2);
  });

  it("records permanent FCM failures as terminal", async () => {
    const userId = `billing-user-${randomUUID()}`;
    userIds.push(userId);
    const notificationId = `notification-${randomUUID()}`;
    notificationIds.push(notificationId);
    const token = `device-token-${randomUUID()}`;
    const hash = tokenHash(token);
    const deliveryRef = db.collection("notificationDeliveries")
      .doc(notificationId).collection("devices").doc(hash);
    await Promise.all([
      db.collection("users").doc(userId)
        .collection("deviceTokens").doc(hash).set({token}),
      db.collection("notifications").doc(notificationId).set({
        recipientId: userId,
        role: "tenant",
        type: "rent_due",
        title: "Bill",
        body: "Due",
        read: false,
      }),
      deliveryRef.set({
        notificationId,
        recipientId: userId,
        tokenHash: hash,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(0),
      }),
    ]);

    const send = jest.fn(async () => {
      throw Object.assign(new Error("Bad message"), {
        code: "messaging/invalid-argument",
      });
    });
    await deliverNotificationToDevice(
      db,
      {notificationId, tokenHash: hash},
      send
    );
    await deliverNotificationToDevice(
      db,
      {notificationId, tokenHash: hash},
      send,
      Date.now() + 60 * 60 * 1000
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect((await deliveryRef.get()).get("status")).toBe("failed");
    expect((await deliveryRef.get()).get("lastErrorCode"))
      .toBe("messaging/invalid-argument");
  });

  it("marks retry exhaustion terminal and never exceeds the attempt limit",
    async () => {
      const userId = `billing-user-${randomUUID()}`;
      userIds.push(userId);
      const notificationId = `notification-${randomUUID()}`;
      notificationIds.push(notificationId);
      const token = `device-token-${randomUUID()}`;
      const hash = tokenHash(token);
      const deliveryRef = db.collection("notificationDeliveries")
        .doc(notificationId).collection("devices").doc(hash);
      await Promise.all([
        db.collection("users").doc(userId)
          .collection("deviceTokens").doc(hash).set({token}),
        db.collection("notifications").doc(notificationId).set({
          recipientId: userId,
          role: "tenant",
          type: "rent_due",
          title: "Bill",
          body: "Due",
          read: false,
        }),
        deliveryRef.set({
          notificationId,
          recipientId: userId,
          tokenHash: hash,
          status: "pending",
          attempts: deliveryMaxAttempts - 1,
          nextAttemptAt: new Date(0),
        }),
      ]);

      const send = jest.fn(async () => {
        throw new Error("temporary FCM failure");
      });
      await deliverNotificationToDevice(
        db,
        {notificationId, tokenHash: hash},
        send
      );
      await deliverNotificationToDevice(
        db,
        {notificationId, tokenHash: hash},
        send,
        Date.now() + 12 * 60 * 60 * 1000
      );

      const delivery = await deliveryRef.get();
      expect(send).toHaveBeenCalledTimes(1);
      expect(delivery.get("attempts")).toBe(deliveryMaxAttempts);
      expect(delivery.get("status")).toBe("failed");
      expect(delivery.get("lastErrorCode")).toBe("retry-exhausted");
    });

  it("recovers legacy pending deliveries without nextAttemptAt", async () => {
    const userId = `billing-user-${randomUUID()}`;
    userIds.push(userId);
    const notificationId = `notification-${randomUUID()}`;
    notificationIds.push(notificationId);
    const token = `device-token-${randomUUID()}`;
    const hash = tokenHash(token);
    const now = Date.now();
    const deliveryRef = db.collection("notificationDeliveries")
      .doc(notificationId).collection("devices").doc(hash);
    await Promise.all([
      db.collection("users").doc(userId)
        .collection("deviceTokens").doc(hash).set({token}),
      db.collection("notifications").doc(notificationId).set({
        recipientId: userId,
        role: "tenant",
        type: "rent_due",
        title: "Bill",
        body: "Due",
        read: false,
      }),
      deliveryRef.set({
        notificationId,
        recipientId: userId,
        tokenHash: hash,
        status: "pending",
        attempts: 2,
      }),
    ]);

    const send = jest.fn(async () => {
      throw new Error("temporary FCM failure");
    });
    await recoverNotificationDeliveries(db, send, now);

    const delivery = await deliveryRef.get();
    expect(send).toHaveBeenCalledTimes(1);
    expect(delivery.get("status")).toBe("pending");
    expect(delivery.get("attempts")).toBe(3);
    expect(delivery.get("nextAttemptAt").toMillis())
      .toBe(now + deliveryRetryDelayMs(3));
  });

  it("recovers stale processing claims and serializes concurrent workers",
    async () => {
      const userId = `billing-user-${randomUUID()}`;
      userIds.push(userId);
      const notificationId = `notification-${randomUUID()}`;
      notificationIds.push(notificationId);
      const token = `device-token-${randomUUID()}`;
      const hash = tokenHash(token);
      const now = Date.now();
      const deliveryRef = db.collection("notificationDeliveries")
        .doc(notificationId).collection("devices").doc(hash);
      await Promise.all([
        db.collection("users").doc(userId)
          .collection("deviceTokens").doc(hash).set({token}),
        db.collection("notifications").doc(notificationId).set({
          recipientId: userId,
          role: "tenant",
          type: "rent_due",
          title: "Bill",
          body: "Due",
          read: false,
        }),
        deliveryRef.set({
          notificationId,
          recipientId: userId,
          tokenHash: hash,
          status: "sending",
          attempts: 1,
          leaseExpiresAt: new Date(now - 1000),
        }),
      ]);
      const send = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "fcm-message-id";
      });
      await Promise.all([
        recoverNotificationDeliveries(db, send, now),
        recoverNotificationDeliveries(db, send, now),
      ]);

      expect(send).toHaveBeenCalledTimes(1);
      expect((await deliveryRef.get()).get("status")).toBe("sent");
    });

  it("retries an ambiguous FCM acknowledgment with at-least-once semantics",
    async () => {
      const userId = `billing-user-${randomUUID()}`;
      userIds.push(userId);
      const notificationId = `notification-${randomUUID()}`;
      notificationIds.push(notificationId);
      const token = `device-token-${randomUUID()}`;
      const hash = tokenHash(token);
      const deliveryRef = db.collection("notificationDeliveries")
        .doc(notificationId).collection("devices").doc(hash);
      await Promise.all([
        db.collection("users").doc(userId)
          .collection("deviceTokens").doc(hash).set({token}),
        db.collection("notifications").doc(notificationId).set({
          recipientId: userId,
          role: "tenant",
          type: "rent_due",
          title: "Bill",
          body: "Due",
          read: false,
        }),
        deliveryRef.set({
          notificationId,
          recipientId: userId,
          tokenHash: hash,
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date(0),
        }),
      ]);

      let acceptedByFcm = 0;
      const ambiguousSend = async () => {
        acceptedByFcm++;
        if (acceptedByFcm === 1) throw new Error("acknowledgment lost");
        return "fcm-message-id";
      };
      const now = Date.now();
      await deliverNotificationToDevice(
        db,
        {notificationId, tokenHash: hash},
        ambiguousSend,
        now
      );
      await deliverNotificationToDevice(
        db,
        {notificationId, tokenHash: hash},
        ambiguousSend,
        now + deliveryRetryDelayMs(1)
      );

      expect(acceptedByFcm).toBe(2);
      expect((await deliveryRef.get()).get("status")).toBe("sent");
    });

  it("caps exponential backoff at the configured maximum", () => {
    expect(deliveryRetryDelayMs(1)).toBe(60 * 1000);
    expect(deliveryRetryDelayMs(2)).toBe(2 * 60 * 1000);
    expect(deliveryRetryDelayMs(20)).toBe(6 * 60 * 60 * 1000);
  });
});
