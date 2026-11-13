import {createHash} from "crypto";
import {
  FieldPath,
  FieldValue,
  Firestore,
  Timestamp,
} from "firebase-admin/firestore";
import {Message} from "firebase-admin/messaging";

const pageSize = 300;
const notificationCollection = "notifications";
const deliveryCollection = "notificationDeliveries";
export const deliveryMaxAttempts = 5;
export const deliveryBaseBackoffMs = 60 * 1000;
export const deliveryMaxBackoffMs = 6 * 60 * 60 * 1000;
const deliveryLeaseMs = 5 * 60 * 1000;
const recoveryPageSize = 100;
const recoveryConcurrency = 20;

interface NotificationData {
  recipientId: string;
  role: "landlord" | "tenant";
  type:
    | "prepare_bill_reminder"
    | "payment_proof_submitted"
    | "overdue_rent"
    | "rent_due"
    | "payment_accepted"
    | "payment_rejected"
    | "late_fine_update";
  relatedEntity?: {type: string; id: string};
  title: string;
  body: string;
  read: false;
  createdAt: FieldValue;
}

interface DeliveryData {
  notificationId: string;
  recipientId: string;
  status: "pending";
  createdAt: FieldValue;
}

interface DeliveryAddress {
  notificationId: string;
  tokenHash: string;
}

export type PushSender = (message: Message) => Promise<string>;

/**
 * Produces a deterministic document ID from a prefix and identity components.
 * @param {string} prefix ID namespace
 * @param {...string} parts Identity components
 * @return {string} Stable document ID
 */
function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${prefix}_${digest}`;
}

/**
 * Formats a date using its UTC year and month.
 * @param {Date} date Date to format
 * @return {string} YYYY-MM billing month
 */
function utcMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}`;
}

/**
 * Parses and validates a Cloud Scheduler timestamp.
 * @param {string} scheduleTime Scheduler event timestamp
 * @return {Date} Parsed timestamp
 */
function parseScheduleTime(scheduleTime: string): Date {
  const date = new Date(scheduleTime);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid Cloud Scheduler scheduleTime: ${scheduleTime}`);
  }
  return date;
}

/**
 * Selects the month following the UTC scheduler month.
 * @param {string} scheduleTime Scheduler event timestamp
 * @return {string} Upcoming YYYY-MM billing month
 */
function upcomingBillingMonth(scheduleTime: string): string {
  const scheduledAt = parseScheduleTime(scheduleTime);
  return utcMonth(
    new Date(
      Date.UTC(scheduledAt.getUTCFullYear(), scheduledAt.getUTCMonth() + 1, 1),
    ),
  );
}

/**
 * Selects the UTC billing month containing a scheduler timestamp.
 * @param {string} scheduleTime Scheduler event timestamp
 * @return {string} Current YYYY-MM billing month
 */
function currentBillingMonth(scheduleTime: string): string {
  return utcMonth(parseScheduleTime(scheduleTime));
}

/**
 * Builds a frozen-schema notification document.
 * @param {string} recipientId User receiving the notification
 * @param {string} role Recipient role
 * @param {string} type Notification type
 * @param {string} title Notification title
 * @param {string} body Notification body
 * @param {Object} [relatedEntity] Optional linked entity
 * @return {NotificationData} Notification fields
 */
function createNotification(
  recipientId: string,
  role: "landlord" | "tenant",
  type: NotificationData["type"],
  title: string,
  body: string,
  relatedEntity?: { type: string; id: string },
): NotificationData {
  return {
    recipientId,
    role,
    type,
    ...(relatedEntity ? {relatedEntity} : {}),
    title,
    body,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Builds a durable server-side push outbox document.
 * @param {string} notificationId Durable notification document ID
 * @param {string} recipientId User receiving the push
 * @return {DeliveryData} Outbox fields
 */
function createDelivery(
  notificationId: string,
  recipientId: string,
): DeliveryData {
  return {
    notificationId,
    recipientId,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Builds the durable landlord notification and delivery outbox for a payment.
 * @param {string} paymentId Submitted payment document ID
 * @param {string} landlordId Owning landlord
 * @return {object} Deterministic notification and delivery records
 */
export function createPaymentProofSubmittedNotification(
  paymentId: string,
  landlordId: string,
): {
  notificationId: string;
  notification: NotificationData;
  delivery: DeliveryData;
} {
  const notificationId = stableId("payment_proof_submitted", paymentId);
  return {
    notificationId,
    notification: createNotification(
      landlordId,
      "landlord",
      "payment_proof_submitted",
      "UPI payment proof submitted",
      "A tenant submitted rent payment proof for verification.",
      {type: "payment", id: paymentId},
    ),
    delivery: createDelivery(notificationId, landlordId),
  };
}

/**
 * Builds the deterministic tenant notification for an accepted UPI payment.
 * @param {string} paymentId Verified payment document ID
 * @param {string} tenantId Tenant receiving the notification
 * @return {object} Notification and delivery outbox records
 */
export function createPaymentAcceptedNotification(
  paymentId: string,
  tenantId: string,
): {
  notificationId: string;
  notification: NotificationData;
  delivery: DeliveryData;
} {
  const notificationId = stableId("payment_accepted", paymentId);
  return {
    notificationId,
    notification: createNotification(
      tenantId,
      "tenant",
      "payment_accepted",
      "UPI payment verified",
      "Your rent payment was verified and the bill is paid.",
      {type: "payment", id: paymentId},
    ),
    delivery: createDelivery(notificationId, tenantId),
  };
}

/**
 * Builds the deterministic tenant notification for a rejected UPI payment.
 * @param {string} paymentId Rejected payment document ID
 * @param {string} tenantId Tenant receiving the notification
 * @param {string} reason Canonical rejection reason
 * @param {?string} explanation Explanation for the `other` reason
 * @return {object} Notification and delivery outbox records
 */
export function createPaymentRejectedNotification(
  paymentId: string,
  tenantId: string,
  reason: string,
  explanation?: string,
): {
  notificationId: string;
  notification: NotificationData;
  delivery: DeliveryData;
} {
  const notificationId = stableId("payment_rejected", paymentId);
  const explanationText = explanation ? ` Details: ${explanation}` : "";
  return {
    notificationId,
    notification: createNotification(
      tenantId,
      "tenant",
      "payment_rejected",
      "UPI payment proof rejected",
      `Your rent payment proof was rejected: ${reason}.${explanationText} ` +
        "You may submit a new payment attempt.",
      {type: "payment", id: paymentId},
    ),
    delivery: createDelivery(notificationId, tenantId),
  };
}

/**
 * Visits a query in document-ID order without loading every result at once.
 * @param {Object} query Query to page
 * @param {Function} visit Page visitor
 * @return {Promise<void>} Resolves after all pages are processed
 */
async function forEachPage<T>(
  query: FirebaseFirestore.Query<T>,
  visit: (docs: FirebaseFirestore.QueryDocumentSnapshot<T>[]) => Promise<void>,
): Promise<void> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot<T> | undefined;
  let pageQuery = query.orderBy(FieldPath.documentId()).limit(pageSize);
  let snapshot = await pageQuery.get();
  while (!snapshot.empty) {
    await visit(snapshot.docs);
    if (snapshot.size < pageSize) return;
    cursor = snapshot.docs[snapshot.docs.length - 1];
    pageQuery = query
      .orderBy(FieldPath.documentId())
      .limit(pageSize)
      .startAfter(cursor);
    snapshot = await pageQuery.get();
  }
}

/**
 * Writes one deterministic reminder per landlord and upcoming UTC month.
 * This workflow never reads or writes rentCharges.
 * @param {Firestore} db Firestore Admin client
 * @param {string} scheduleTime Cloud Scheduler event timestamp
 * @return {Promise<void>} Resolves after reminders are persisted
 */
export async function run25thLandlordReminder(
  db: Firestore,
  scheduleTime: string,
): Promise<void> {
  const billingMonth = upcomingBillingMonth(scheduleTime);
  const landlords = new Set<string>();

  await forEachPage(
    db.collection("leases").where("status", "==", "active"),
    async (leases) => {
      for (const lease of leases) {
        const landlordId = lease.get("landlordId");
        if (typeof landlordId === "string" && landlordId.length > 0) {
          landlords.add(landlordId);
        }
      }
    },
  );

  for (const landlordId of landlords) {
    const notificationId = stableId(
      "prepare_bill_reminder",
      landlordId,
      "prepare_bill_reminder",
      billingMonth,
    );
    const notificationRef = db
      .collection(notificationCollection)
      .doc(notificationId);
    const deliveryRef = db.collection(deliveryCollection).doc(notificationId);

    await db.runTransaction(async (transaction) => {
      const notification = await transaction.get(notificationRef);
      const delivery = await transaction.get(deliveryRef);
      if (notification.exists) return;

      transaction.create(
        notificationRef,
        createNotification(
          landlordId,
          "landlord",
          "prepare_bill_reminder",
          "Prepare next month's bills",
          `Please prepare rent bills for ${billingMonth}.`,
        ),
      );
      if (!delivery.exists) {
        transaction.create(
          deliveryRef,
          createDelivery(notificationId, landlordId),
        );
      }
    });
  }
}

/**
 * Formats integer paise as a rupee amount for notification text.
 * @param {number} amount Amount in paise
 * @return {string} Display-formatted rupee amount
 */
function formatPaise(amount: number): string {
  const rupees = Math.floor(amount / 100);
  const paise = String(Math.abs(amount) % 100).padStart(2, "0");
  return `₹${rupees}.${paise}`;
}

/**
 * Transitions only current-UTC-month finalized bills to due and creates their
 * tenant notification and delivery record in the same transaction.
 * @param {Firestore} db Firestore Admin client
 * @param {string} scheduleTime Cloud Scheduler event timestamp
 * @return {Promise<void>} Resolves after matching bills are processed
 */
export async function run1stTenantNotifications(
  db: Firestore,
  scheduleTime: string,
): Promise<void> {
  const billingMonth = currentBillingMonth(scheduleTime);
  const query = db
    .collection("rentCharges")
    .where("status", "==", "finalized")
    .where("billingMonth", "==", billingMonth);

  await forEachPage(query, async (charges) => {
    for (const charge of charges) {
      const notificationId = stableId("rent_due", charge.id);
      const chargeRef = charge.ref;
      const notificationRef = db
        .collection(notificationCollection)
        .doc(notificationId);
      const deliveryRef = db.collection(deliveryCollection).doc(notificationId);

      await db.runTransaction(async (transaction) => {
        const [currentCharge, notification, delivery] = await Promise.all([
          transaction.get(chargeRef),
          transaction.get(notificationRef),
          transaction.get(deliveryRef),
        ]);
        if (!currentCharge.exists) return;

        const bill = currentCharge.data();
        if (
          bill?.status !== "finalized" ||
          bill.billingMonth !== billingMonth ||
          typeof bill.tenantId !== "string"
        ) {
          return;
        }

        const total = bill.total;
        if (typeof total !== "number" || !Number.isSafeInteger(total)) {
          throw new Error(`Rent charge ${charge.id} has an invalid total.`);
        }

        transaction.update(chargeRef, {
          status: "due",
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (!notification.exists) {
          transaction.create(
            notificationRef,
            createNotification(
              bill.tenantId,
              "tenant",
              "rent_due",
              "Rent bill available",
              `Your ${billingMonth} rent bill is ${formatPaise(total)}.`,
              {type: "rentCharge", id: charge.id},
            ),
          );
        }
        if (!delivery.exists) {
          transaction.create(
            deliveryRef,
            createDelivery(notificationId, bill.tenantId),
          );
        }
      });
    }
  });
}

/**
 * Creates a retryable per-device delivery task exactly once.
 * @param {Firestore} db Firestore Admin client
 * @param {FirebaseFirestore.DocumentReference} deliveryRef Parent outbox
 * @param {string} notificationId Durable notification document ID
 * @param {string} recipientId User receiving the push
 * @param {string} tokenHash Stable device-token document ID
 * @return {Promise<void>} Resolves after the task exists
 */
async function createDeviceDelivery(
  db: Firestore,
  deliveryRef: FirebaseFirestore.DocumentReference,
  notificationId: string,
  recipientId: string,
  tokenHash: string,
): Promise<void> {
  const deviceDeliveryRef = deliveryRef.collection("devices").doc(tokenHash);
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(deviceDeliveryRef);
    if (existing.exists) return;
    transaction.create(deviceDeliveryRef, {
      notificationId,
      recipientId,
      tokenHash,
      status: "pending",
      attempts: 0,
      nextAttemptAt: Timestamp.fromMillis(0),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

/**
 * Expands the durable notification outbox entry into one retryable delivery
 * task per registered device. Child IDs make expansion safe to retry.
 * @param {Firestore} db Firestore Admin client
 * @param {string} notificationId Durable notification document ID
 * @return {Promise<void>} Resolves after device tasks are created
 */
export async function expandNotificationDeliveries(
  db: Firestore,
  notificationId: string,
): Promise<void> {
  const deliveryRef = db.collection(deliveryCollection).doc(notificationId);
  const deliverySnapshot = await deliveryRef.get();
  if (!deliverySnapshot.exists) return;

  const recipientId = deliverySnapshot.get("recipientId");
  if (typeof recipientId !== "string" || recipientId.length === 0) {
    throw new Error(
      `Notification delivery ${notificationId} has no recipient.`,
    );
  }

  const tokenSnapshot = await db
    .collection("users")
    .doc(recipientId)
    .collection("deviceTokens")
    .get();
  if (tokenSnapshot.empty) {
    await deliveryRef.update({
      status: "no_tokens",
      completedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  for (let offset = 0; offset < tokenSnapshot.docs.length; offset += 20) {
    const group = tokenSnapshot.docs.slice(offset, offset + 20);
    await Promise.all(
      group.map((tokenDoc) =>
        createDeviceDelivery(
          db,
          deliveryRef,
          notificationId,
          recipientId,
          tokenDoc.id,
        ),
      ),
    );
  }

  await deliveryRef.update({
    status: "queued",
    queuedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Checks whether an FCM error confirms that a token is no longer valid.
 * @param {unknown} error FCM send error
 * @return {boolean} Whether the token should be removed
 */
function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

/**
 * Checks whether an FCM error permanently rejects this message or token.
 * Unknown errors remain transient so the durable retry path can recover them.
 * @param {unknown} error FCM send error
 * @return {boolean} Whether the error is permanent
 */
function isPermanentFcmError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "messaging/invalid-argument" ||
    code === "messaging/invalid-recipient" ||
    code === "messaging/sender-id-mismatch" ||
    code === "messaging/third-party-auth-error"
  );
}

/**
 * Checks whether a delivery's transaction claim has not expired.
 * @param {FirebaseFirestore.DocumentData} data Device delivery record
 * @param {number} nowMs Current time in epoch milliseconds
 * @return {boolean} Whether another worker currently owns the claim
 */
function deliveryLeaseIsActive(
  data: FirebaseFirestore.DocumentData,
  nowMs: number,
): boolean {
  const leaseExpiresAt = data.leaseExpiresAt;
  return (
    leaseExpiresAt instanceof Timestamp && leaseExpiresAt.toMillis() > nowMs
  );
}

/**
 * Computes the bounded exponential retry delay for a delivery attempt.
 * @param {number} attempt Attempt number, starting at one
 * @return {number} Backoff duration in milliseconds
 */
export function deliveryRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  return Math.min(deliveryBaseBackoffMs * 2 ** exponent, deliveryMaxBackoffMs);
}

/**
 * Marks a delivery as terminal and removes only its recipient-owned token.
 * @param {Firestore} db Firestore Admin client
 * @param {FirebaseFirestore.DocumentReference} deliveryRef Delivery task
 * @param {FirebaseFirestore.DocumentReference} tokenRef Recipient token
 * @param {boolean} removeToken Whether an invalid token should be deleted
 * @param {string} status Terminal status
 * @param {unknown} [error] Optional failure
 * @param {string} [failureCode] Optional terminal failure code
 * @return {Promise<void>} Resolves after the terminal state is persisted
 */
async function finishDelivery(
  db: Firestore,
  deliveryRef: FirebaseFirestore.DocumentReference,
  tokenRef: FirebaseFirestore.DocumentReference,
  removeToken: boolean,
  status: "invalid" | "failed",
  error?: unknown,
  failureCode?: string,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const update = {
    status,
    leaseExpiresAt: FieldValue.delete(),
    nextAttemptAt: FieldValue.delete(),
    ...(status === "failed" ?
      {
        failedAt: FieldValue.serverTimestamp(),
        lastError: errorMessage,
        lastErrorCode: failureCode ?? errorCode(error),
      } :
      {}),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  if (removeToken) batch.delete(tokenRef);
  batch.update(deliveryRef, update);
  await batch.commit();
}

/**
 * Sends one device delivery with a transaction-backed claim. Retryable errors
 * are persisted with exponential backoff for scheduled recovery.
 * @param {Firestore} db Firestore Admin client
 * @param {DeliveryAddress} address Target outbox task
 * @param {PushSender} send FCM message sender
 * @param {number} [nowMs] Current time for deterministic tests
 * @return {Promise<void>} Resolves after the push outcome is recorded
 */
export async function deliverNotificationToDevice(
  db: Firestore,
  address: DeliveryAddress,
  send: PushSender,
  nowMs = Date.now(),
): Promise<void> {
  const deliveryRef = db
    .collection(deliveryCollection)
    .doc(address.notificationId)
    .collection("devices")
    .doc(address.tokenHash);
  const claim = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(deliveryRef);
    if (!snapshot.exists) return null;
    const data = snapshot.data()!;
    if (
      data.status === "sent" ||
      data.status === "invalid" ||
      data.status === "failed"
    ) {
      return null;
    }
    if (
      data.status === "pending" &&
      data.nextAttemptAt instanceof Timestamp &&
      data.nextAttemptAt.toMillis() > nowMs
    ) {
      return null;
    }
    if (data.status === "sending" && deliveryLeaseIsActive(data, nowMs)) {
      return null;
    }

    const attempts = Number.isSafeInteger(data.attempts) ?
      (data.attempts as number) :
      0;
    if (attempts >= deliveryMaxAttempts) {
      transaction.update(deliveryRef, {
        status: "failed",
        failedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: FieldValue.delete(),
        nextAttemptAt: FieldValue.delete(),
        lastError: "Delivery retry limit exhausted.",
        lastErrorCode: "retry-exhausted",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return null;
    }

    transaction.update(deliveryRef, {
      status: "sending",
      attempts: attempts + 1,
      leaseExpiresAt: Timestamp.fromMillis(nowMs + deliveryLeaseMs),
      nextAttemptAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      recipientId: data.recipientId as string,
      notificationId: data.notificationId as string,
      tokenHash: data.tokenHash as string,
      attempts: attempts + 1,
    };
  });
  if (!claim) return;

  const tokenRef = db
    .collection("users")
    .doc(claim.recipientId)
    .collection("deviceTokens")
    .doc(claim.tokenHash);
  const [tokenSnapshot, notificationSnapshot] = await Promise.all([
    tokenRef.get(),
    db.collection(notificationCollection).doc(claim.notificationId).get(),
  ]);
  if (!tokenSnapshot.exists) {
    await finishDelivery(db, deliveryRef, tokenRef, false, "invalid");
    return;
  }
  if (!notificationSnapshot.exists) {
    await finishDelivery(
      db,
      deliveryRef,
      tokenRef,
      false,
      "failed",
      new Error("Durable notification document is missing."),
    );
    return;
  }

  const token = tokenSnapshot.get("token");
  if (typeof token !== "string" || token.length === 0) {
    await finishDelivery(db, deliveryRef, tokenRef, true, "invalid");
    return;
  }

  const notification = notificationSnapshot.data()!;
  const relatedEntity = notification.relatedEntity as
    {type?: unknown; id?: unknown} | undefined;
  const message: Message = {
    token,
    notification: {
      title: notification.title as string,
      body: notification.body as string,
    },
    data: {
      notificationId: claim.notificationId,
      type: notification.type as string,
      relatedEntityType:
        typeof relatedEntity?.type === "string" ? relatedEntity.type : "",
      relatedEntityId:
        typeof relatedEntity?.id === "string" ? relatedEntity.id : "",
    },
  };

  try {
    await send(message);
  } catch (error) {
    const code = errorCode(error);
    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token"
    ) {
      await finishDelivery(db, deliveryRef, tokenRef, true, "invalid");
      return;
    }

    if (isPermanentFcmError(error) || claim.attempts >= deliveryMaxAttempts) {
      await finishDelivery(
        db,
        deliveryRef,
        tokenRef,
        false,
        "failed",
        error,
        claim.attempts >= deliveryMaxAttempts ? "retry-exhausted" : undefined,
      );
      return;
    }

    await deliveryRef.update({
      status: "pending",
      leaseExpiresAt: FieldValue.delete(),
      nextAttemptAt: Timestamp.fromMillis(
        nowMs + deliveryRetryDelayMs(claim.attempts),
      ),
      lastError: error instanceof Error ? error.message : String(error),
      lastErrorCode: code,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  await deliveryRef.update({
    status: "sent",
    leaseExpiresAt: FieldValue.delete(),
    nextAttemptAt: FieldValue.delete(),
    sentAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Recovers due retries and abandoned claims. The delivery transaction remains
 * the concurrency gate, so overlapping sweeps cannot claim an active task.
 * @param {Firestore} db Firestore Admin client
 * @param {PushSender} send FCM message sender
 * @param {number} [nowMs] Current time for deterministic tests
 * @return {Promise<void>} Resolves after eligible tasks are attempted
 */
export async function recoverNotificationDeliveries(
  db: Firestore,
  send: PushSender,
  nowMs = Date.now(),
): Promise<void> {
  const now = Timestamp.fromMillis(nowMs);
  const pendingQuery = db
    .collectionGroup("devices")
    .where("status", "==", "pending");
  await forEachPage(pendingQuery, async (tasks) => {
    for (let offset = 0; offset < tasks.length; offset += recoveryConcurrency) {
      const group = tasks.slice(offset, offset + recoveryConcurrency);
      await Promise.all(
        group.map((task) => {
          const deliveryRef = task.ref.parent.parent;
          if (deliveryRef === null) return Promise.resolve();
          return deliverNotificationToDevice(
            db,
            {notificationId: deliveryRef.id, tokenHash: task.id},
            send,
            nowMs,
          );
        }),
      );
    }
  });

  const staleQuery = db
    .collectionGroup("devices")
    .where("status", "==", "sending")
    .where("leaseExpiresAt", "<=", now)
    .limit(recoveryPageSize);
  const stale = await staleQuery.get();
  for (
    let offset = 0;
    offset < stale.docs.length;
    offset += recoveryConcurrency
  ) {
    const group = stale.docs.slice(offset, offset + recoveryConcurrency);
    await Promise.all(
      group.map((task) => {
        const deliveryRef = task.ref.parent.parent;
        if (deliveryRef === null) return Promise.resolve();
        return deliverNotificationToDevice(
          db,
          {notificationId: deliveryRef.id, tokenHash: task.id},
          send,
          nowMs,
        );
      }),
    );
  }
}

/**
 * Hashes an FCM token for its user-scoped document ID.
 * @param {string} token Raw FCM registration token
 * @return {string} SHA-256 token hash
 */
export function deviceTokenDocumentId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
