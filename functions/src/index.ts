import {logger, setGlobalOptions} from "firebase-functions";
import {
  onCall,
  onRequest,
  HttpsError,
  type CallableRequest,
} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {defineSecret} from "firebase-functions/params";
import {initializeApp, getApps} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getAuth} from "firebase-admin/auth";
import {getMessaging} from "firebase-admin/messaging";
import {
  deliverNotificationToDevice,
  deviceTokenDocumentId,
  expandNotificationDeliveries,
  recoverNotificationDeliveries as recoverNotificationDeliveryTasks,
  run1stTenantNotifications,
  run25thLandlordReminder,
} from "./billing_notifications";
import {
  createCloudinaryGateway,
  createPaymentUploadHttpHandler,
  createPaymentUploadService,
  type CreateUpiPaymentInput,
  type PreparePaymentUploadInput,
  type VerifyUpiPaymentInput,
} from "./payment_upload";

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const auth = getAuth();

setGlobalOptions({maxInstances: 10});

const cloudinaryCloudName = defineSecret("CLOUDINARY_CLOUD_NAME");
const cloudinaryApiKey = defineSecret("CLOUDINARY_API_KEY");
const cloudinaryApiSecret = defineSecret("CLOUDINARY_API_SECRET");
const paymentUploadTokenSecret = defineSecret("PAYMENT_UPLOAD_TOKEN_SECRET");
const functionsRegion = "us-central1";

/**
 * Returns the fixed upload endpoint URL for the active project or emulator.
 * @param {CallableRequest<PreparePaymentUploadInput>} request Callable request
 * @return {string} HTTPS production URL or local emulator URL
 */
function paymentProofUploadUrl(
  request: CallableRequest<PreparePaymentUploadInput>,
): string {
  const projectId = getApps()[0]?.options.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new Error("Firebase project ID is unavailable.");
  }
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    const origin = `${request.rawRequest.protocol}://${request.rawRequest.get("host")}`;
    const requestUrl = new URL(request.rawRequest.originalUrl, origin);
    if (!requestUrl.pathname.endsWith("/preparePaymentProofUpload")) {
      throw new Error("Callable upload preparation URL is invalid.");
    }
    requestUrl.pathname = requestUrl.pathname.replace(
      /preparePaymentProofUpload$/,
      "uploadPaymentProof",
    );
    return requestUrl.toString();
  }
  return `https://${functionsRegion}-${projectId}.cloudfunctions.net/uploadPaymentProof`;
}

type UserRole = "landlord" | "tenant";

/**
 * Throws when an authenticated caller does not have the required role claim.
 * @param {unknown} role Firebase custom role claim
 * @param {UserRole} expectedRole Required role for the callable
 * @return {void}
 */
function requireRole(role: unknown, expectedRole: UserRole): void {
  if (role !== expectedRole) {
    throw new HttpsError(
      "permission-denied",
      `Only ${expectedRole}s can perform this action.`,
    );
  }
}

interface CompleteOnboardingInput {
  role: "landlord" | "tenant";
  fullName: string;
  phone: string;
}

/**
 * Callable function to complete initial user onboarding.
 * Sets the user's role custom claim and creates the Firestore user document.
 */
export const completeOnboarding = onCall<CompleteOnboardingInput>(
  async (request) => {
    // 1. Auth check: caller must be authenticated
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "User must be authenticated to complete onboarding.",
      );
    }

    const uid = request.auth.uid;
    const {role, fullName, phone} = request.data || {};

    // 2. Input validation
    if (role !== "landlord" && role !== "tenant") {
      throw new HttpsError(
        "invalid-argument",
        "Role must be either 'landlord' or 'tenant'.",
      );
    }

    if (!fullName || typeof fullName !== "string" || !fullName.trim()) {
      throw new HttpsError(
        "invalid-argument",
        "Full name is required and must be a non-empty string.",
      );
    }

    if (!phone || typeof phone !== "string" || !phone.trim()) {
      throw new HttpsError(
        "invalid-argument",
        "Phone number is required and must be a non-empty string.",
      );
    }

    const userDocRef = db.collection("users").doc(uid);
    const userDoc = await userDocRef.get();

    // Check existing document and custom claims
    const userRecord = await auth.getUser(uid);
    const existingRole = userRecord.customClaims?.role;

    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData?.onboardingCompleted) {
        if (userData.role === role && existingRole === role) {
          // Idempotent retry: return clean response
          return {
            success: true,
            uid,
            role,
          };
        }
        throw new HttpsError(
          "already-exists",
          "User has already completed onboarding.",
        );
      }
    }

    if (existingRole && existingRole !== role) {
      throw new HttpsError(
        "already-exists",
        "User already has an assigned role claim.",
      );
    }

    // 3. Step 1: Set custom claims
    await auth.setCustomUserClaims(uid, {role});

    // 4. Step 2: Create user profile document in Firestore
    const email = request.auth.token.email || userRecord.email || "";

    await userDocRef.set({
      uid,
      role,
      fullName: fullName.trim(),
      phone: phone.trim(),
      email,
      onboardingCompleted: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      uid,
      role,
    };
  },
);

interface ResolveJoinCodeInput {
  joinCode: string;
}

/**
 * Callable function for tenants to look up basic property details by joinCode.
 * Deliberately withholds landlordId and private details.
 */
export const resolveJoinCode = onCall<ResolveJoinCodeInput>(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  requireRole(request.auth.token.role, "tenant");

  const {joinCode} = request.data || {};
  if (!joinCode || typeof joinCode !== "string" || !joinCode.trim()) {
    throw new HttpsError("invalid-argument", "A valid join code is required.");
  }

  const trimmedCode = joinCode.trim().toUpperCase();
  const querySnapshot = await db
    .collection("properties")
    .where("joinCode", "==", trimmedCode)
    .where("status", "==", "active")
    .limit(1)
    .get();

  if (querySnapshot.empty) {
    throw new HttpsError(
      "not-found",
      "No active property found matching this join code.",
    );
  }

  const propertyDoc = querySnapshot.docs[0];
  const data = propertyDoc.data();

  return {
    propertyId: propertyDoc.id,
    name: data.name,
    address: data.address,
  };
});

interface CreateJoinRequestInput {
  propertyId: string;
  message?: string;
}

/**
 * Callable function for tenants to submit a join request to an active property.
 * Derives landlordId securely on the server.
 */
export const createJoinRequest = onCall<CreateJoinRequestInput>(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    requireRole(request.auth.token.role, "tenant");
    const uid = request.auth.uid;

    const {propertyId, message} = request.data || {};
    if (!propertyId || typeof propertyId !== "string" || !propertyId.trim()) {
      throw new HttpsError("invalid-argument", "propertyId is required.");
    }

    const propertyRef = db.collection("properties").doc(propertyId.trim());
    const propertyDoc = await propertyRef.get();
    if (!propertyDoc.exists || propertyDoc.data()?.status !== "active") {
      throw new HttpsError(
        "failed-precondition",
        "Property not found or is not currently active.",
      );
    }

    const userDocRef = db.collection("users").doc(uid);
    const userDoc = await userDocRef.get();
    if (!userDoc.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Tenant profile must be onboarded first.",
      );
    }

    if (userDoc.data()?.activeLeaseId) {
      throw new HttpsError(
        "failed-precondition",
        "Tenant already has an active tenancy and cannot apply.",
      );
    }

    // Check for existing pending request (idempotency guard)
    const existingSnapshot = await db
      .collection("joinRequests")
      .where("tenantId", "==", uid)
      .where("propertyId", "==", propertyId.trim())
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (!existingSnapshot.empty) {
      return {
        success: true,
        joinRequestId: existingSnapshot.docs[0].id,
      };
    }

    const landlordId = propertyDoc.data()?.landlordId;
    if (!landlordId) {
      throw new HttpsError(
        "failed-precondition",
        "Target property has no assigned landlord.",
      );
    }

    const newRequestRef = db.collection("joinRequests").doc();
    const now = FieldValue.serverTimestamp();
    const tenantData = userDoc.data();
    const propertyData = propertyDoc.data();

    await newRequestRef.set({
      tenantId: uid,
      tenantName: tenantData?.fullName || "",
      tenantPhone: tenantData?.phone || "",
      tenantEmail: tenantData?.email || "",
      propertyId: propertyId.trim(),
      propertyName: propertyData?.name || "",
      landlordId,
      status: "pending",
      message: typeof message === "string" ? message.trim() : "",
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      joinRequestId: newRequestRef.id,
    };
  },
);

interface AcceptJoinRequestInput {
  joinRequestId: string;
  unitId: string;
  joiningDate?: string;
}

/**
 * Callable function for landlords to accept a join request,
 * assign a vacant unit, create an active lease, and auto-reject other requests.
 */
export const acceptJoinRequest = onCall<AcceptJoinRequestInput>(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    requireRole(request.auth.token.role, "landlord");
    const uid = request.auth.uid;

    const {joinRequestId, unitId, joiningDate} = request.data || {};
    if (!joinRequestId || typeof joinRequestId !== "string") {
      throw new HttpsError("invalid-argument", "joinRequestId is required.");
    }
    if (!unitId || typeof unitId !== "string") {
      throw new HttpsError("invalid-argument", "unitId is required.");
    }

    let resolvedJoiningDate = new Date().toISOString().split("T")[0];
    if (
      joiningDate &&
      typeof joiningDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(joiningDate)
    ) {
      resolvedJoiningDate = joiningDate;
    }

    return await db.runTransaction(async (transaction) => {
      const requestRef = db
        .collection("joinRequests")
        .doc(joinRequestId.trim());
      const requestDoc = await transaction.get(requestRef);

      if (!requestDoc.exists) {
        throw new HttpsError("not-found", "Join request not found.");
      }

      const requestData = requestDoc.data();
      if (requestData?.landlordId !== uid) {
        throw new HttpsError(
          "permission-denied",
          "You do not own the property for this request.",
        );
      }
      if (requestData?.status !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Join request is no longer pending.",
        );
      }

      const tenantId = requestData.tenantId;
      const propertyId = requestData.propertyId;

      const unitRef = db.collection("units").doc(unitId.trim());
      const unitDoc = await transaction.get(unitRef);
      if (!unitDoc.exists) {
        throw new HttpsError("not-found", "Unit not found.");
      }
      const unitData = unitDoc.data();
      if (unitData?.propertyId !== propertyId || unitData?.landlordId !== uid) {
        throw new HttpsError(
          "failed-precondition",
          "Unit does not belong to this property.",
        );
      }
      if (unitData?.status !== "vacant") {
        throw new HttpsError("failed-precondition", "Unit is not vacant.");
      }

      // Check tenant's activeLeaseId inside transaction
      const tenantRef = db.collection("users").doc(tenantId);
      const tenantDoc = await transaction.get(tenantRef);
      if (!tenantDoc.exists) {
        throw new HttpsError("not-found", "Tenant profile not found.");
      }
      if (tenantDoc.data()?.activeLeaseId) {
        throw new HttpsError(
          "failed-precondition",
          "Tenant already has an active lease.",
        );
      }

      // Read other pending requests before starting transaction writes.
      const otherRequestsQuery = db
        .collection("joinRequests")
        .where("tenantId", "==", tenantId)
        .where("status", "==", "pending");
      const otherRequestsSnap = await transaction.get(otherRequestsQuery);

      // Step 1: Update join request
      const now = FieldValue.serverTimestamp();
      transaction.update(requestRef, {
        status: "accepted",
        respondedAt: now,
        respondedBy: uid,
        updatedAt: now,
      });

      // Step 2: Create lease
      const newLeaseRef = db.collection("leases").doc();
      const tenantData = tenantDoc.data();
      transaction.set(newLeaseRef, {
        tenantId,
        tenantName: tenantData?.fullName || "",
        tenantPhone: tenantData?.phone || "",
        landlordId: uid,
        propertyId,
        propertyName: requestData.propertyName || "",
        unitId: unitId.trim(),
        roomNumber: unitData.roomNumber || "",
        joiningDate: resolvedJoiningDate,
        currentBaseRent: unitData.baseRent || 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      // Step 3: Update unit
      transaction.update(unitRef, {
        currentLeaseId: newLeaseRef.id,
        status: "occupied",
        updatedAt: now,
      });

      // Step 4: Update tenant activeLeaseId
      transaction.update(tenantRef, {
        activeLeaseId: newLeaseRef.id,
        updatedAt: now,
      });

      // Step 5: Auto-reject other pending joinRequests of this tenant
      let autoRejectedCount = 0;

      otherRequestsSnap.docs.forEach((doc) => {
        if (doc.id !== joinRequestId.trim()) {
          transaction.update(doc.ref, {
            status: "rejected",
            autoRejected: true,
            respondedAt: now,
            updatedAt: now,
          });
          autoRejectedCount++;
        }
      });

      return {
        success: true,
        leaseId: newLeaseRef.id,
        autoRejectedCount,
      };
    });
  },
);

interface EndLeaseInput {
  leaseId: string;
  endDate: string;
  endReason?: string;
}

/**
 * Callable function for landlords to end an active tenancy.
 * Preserves historical records, frees the unit, and clears activeLeaseId.
 */
export const endLease = onCall<EndLeaseInput>(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  const uid = request.auth.uid;

  const {leaseId, endDate, endReason} = request.data || {};
  if (!leaseId || typeof leaseId !== "string" || !leaseId.trim()) {
    throw new HttpsError("invalid-argument", "leaseId is required.");
  }
  if (
    !endDate ||
      typeof endDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())
  ) {
    throw new HttpsError(
      "invalid-argument",
      "endDate must be a valid YYYY-MM-DD string.",
    );
  }

  return await db.runTransaction(async (transaction) => {
    const leaseRef = db.collection("leases").doc(leaseId.trim());
    const leaseDoc = await transaction.get(leaseRef);

    if (!leaseDoc.exists) {
      throw new HttpsError("not-found", "Lease document not found.");
    }

    const leaseData = leaseDoc.data();
    if (leaseData?.landlordId !== uid) {
      throw new HttpsError(
        "permission-denied",
        "Only the owning landlord can end this lease.",
      );
    }

    if (leaseData?.status !== "active") {
      throw new HttpsError(
        "failed-precondition",
        "Lease is already ended or not active.",
      );
    }

    const joiningDate = leaseData?.joiningDate;
    const formattedEndDate = endDate.trim();
    if (joiningDate && formattedEndDate < joiningDate) {
      throw new HttpsError(
        "invalid-argument",
        "endDate cannot be before joiningDate.",
      );
    }

    const now = FieldValue.serverTimestamp();

    // Step 1: Update lease status to 'ended'
    transaction.update(leaseRef, {
      status: "ended",
      endDate: formattedEndDate,
      endReason: typeof endReason === "string" ? endReason.trim() : "",
      endedBy: uid,
      updatedAt: now,
    });

    // Step 2: Mark unit vacant and clear currentLeaseId
    if (leaseData?.unitId) {
      const unitRef = db.collection("units").doc(leaseData.unitId);
      transaction.update(unitRef, {
        status: "vacant",
        currentLeaseId: null,
        updatedAt: now,
      });
    }

    // Step 3: Clear tenant activeLeaseId
    if (leaseData?.tenantId) {
      const tenantRef = db.collection("users").doc(leaseData.tenantId);
      transaction.update(tenantRef, {
        activeLeaseId: null,
        updatedAt: now,
      });
    }

    return {
      success: true,
      leaseId: leaseRef.id,
      status: "ended",
    };
  });
});

interface FinalizeRentChargeInput {
  rentChargeId: string;
}

/**
 * Checks whether a Firestore value is a non-array object.
 * @param {unknown} value Value to check
 * @return {boolean} Whether the value is a record
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the canonical billing-month representation.
 * @param {unknown} value Candidate billing month
 * @return {boolean} Whether the value is a valid YYYY-MM month
 */
function isBillingMonth(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0[0-9]{3}|[1-9][0-9]{3})-(0[1-9]|1[0-2])$/.test(value)
  );
}

/**
 * Validates bill line items and totals their integer paise amounts.
 * @param {unknown} value Draft line items
 * @return {number} Sum of line-item amounts
 */
function calculateLineItemsSubtotal(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new HttpsError(
      "failed-precondition",
      "Draft bill must contain between one and ten valid line items.",
    );
  }

  let subtotal = 0;
  let rentLineItemCount = 0;
  const allowedTypes = new Set(["rent", "electricity", "maintenance", "other"]);
  for (const item of value) {
    if (
      !isRecord(item) ||
      Object.keys(item).length !== 3 ||
      !allowedTypes.has(item.type as string) ||
      typeof item.label !== "string" ||
      !item.label.trim() ||
      !Number.isSafeInteger(item.amount) ||
      (item.amount as number) < 0
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Draft bill contains an invalid line item.",
      );
    }

    if (item.type === "rent") {
      rentLineItemCount += 1;
    }

    subtotal += item.amount as number;
    if (!Number.isSafeInteger(subtotal)) {
      throw new HttpsError(
        "failed-precondition",
        "Draft bill total exceeds the supported integer range.",
      );
    }
  }

  if (rentLineItemCount !== 1) {
    throw new HttpsError(
      "failed-precondition",
      "Draft bill must contain exactly one rent line item.",
    );
  }

  return subtotal;
}

/**
 * Finalizes a landlord-owned draft after validating its linked active tenancy.
 */
export const finalizeRentCharge = onCall<FinalizeRentChargeInput>(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    requireRole(request.auth.token.role, "landlord");

    const uid = request.auth.uid;
    const {rentChargeId} = request.data || {};
    if (
      typeof rentChargeId !== "string" ||
      !rentChargeId.trim() ||
      rentChargeId.includes("/")
    ) {
      throw new HttpsError("invalid-argument", "rentChargeId is required.");
    }

    const rentChargeRef = db.collection("rentCharges").doc(rentChargeId.trim());
    return await db.runTransaction(async (transaction) => {
      const rentChargeDoc = await transaction.get(rentChargeRef);
      if (!rentChargeDoc.exists) {
        throw new HttpsError("not-found", "Rent charge not found.");
      }

      const rentCharge = rentChargeDoc.data()!;
      if (rentCharge.landlordId !== uid) {
        throw new HttpsError(
          "permission-denied",
          "Only the owning landlord can finalize this rent charge.",
        );
      }
      if (rentCharge.status !== "draft") {
        throw new HttpsError(
          "failed-precondition",
          "Rent charge is not a draft.",
        );
      }

      const {leaseId, tenantId, propertyId, unitId, billingMonth} =
        rentCharge;
      if (
        typeof leaseId !== "string" ||
        !leaseId ||
        typeof tenantId !== "string" ||
        !tenantId ||
        typeof propertyId !== "string" ||
        !propertyId ||
        typeof unitId !== "string" ||
        !unitId
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Draft bill is missing a valid lease relationship.",
        );
      }
      if (!isBillingMonth(billingMonth)) {
        throw new HttpsError(
          "invalid-argument",
          "billingMonth must be a valid YYYY-MM value.",
        );
      }
      if (rentChargeRef.id !== `${leaseId}_${billingMonth}`) {
        throw new HttpsError(
          "invalid-argument",
          "Rent charge ID must match its lease and billing month.",
        );
      }

      const [leaseDoc, tenantDoc, propertyDoc, unitDoc] = await Promise.all([
        transaction.get(db.collection("leases").doc(leaseId)),
        transaction.get(db.collection("users").doc(tenantId)),
        transaction.get(db.collection("properties").doc(propertyId)),
        transaction.get(db.collection("units").doc(unitId)),
      ]);
      if (!leaseDoc.exists) {
        throw new HttpsError("not-found", "Referenced lease not found.");
      }
      if (!tenantDoc.exists) {
        throw new HttpsError("not-found", "Referenced tenant not found.");
      }
      if (!propertyDoc.exists) {
        throw new HttpsError("not-found", "Referenced property not found.");
      }
      if (!unitDoc.exists) {
        throw new HttpsError("not-found", "Referenced unit not found.");
      }

      const lease = leaseDoc.data()!;
      const tenant = tenantDoc.data()!;
      const property = propertyDoc.data()!;
      const unit = unitDoc.data()!;
      if (
        lease.status !== "active" ||
        lease.landlordId !== uid ||
        lease.tenantId !== tenantId ||
        lease.propertyId !== propertyId ||
        lease.unitId !== unitId ||
        tenant.role !== "tenant" ||
        tenant.activeLeaseId !== leaseDoc.id ||
        property.landlordId !== uid ||
        unit.landlordId !== uid ||
        unit.propertyId !== propertyId ||
        unit.status !== "occupied" ||
        unit.currentLeaseId !== leaseDoc.id
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Draft bill references do not match an active lease.",
        );
      }

      const subtotal = calculateLineItemsSubtotal(rentCharge.lineItems);
      if (
        !Number.isSafeInteger(rentCharge.subtotal) ||
        rentCharge.subtotal !== subtotal ||
        !Number.isSafeInteger(rentCharge.total) ||
        rentCharge.total !== subtotal ||
        rentCharge.lateFineTotal !== 0 ||
        rentCharge.adjustmentTotal !== 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Draft bill totals do not match its line items.",
        );
      }

      const dueDate = `${billingMonth}-10`;
      if (rentCharge.dueDate !== dueDate) {
        throw new HttpsError(
          "failed-precondition",
          "Draft dueDate must be the 10th of its billing month.",
        );
      }

      const now = FieldValue.serverTimestamp();
      transaction.update(rentChargeRef, {
        status: "finalized",
        finalizedAt: now,
        finalizedBy: uid,
        dueDate,
        total: subtotal,
        updatedAt: now,
      });

      return {
        success: true,
        rentChargeId: rentChargeRef.id,
        dueDate,
        total: subtotal,
      };
    });
  },
);

interface ApplyAdjustmentInput {
  rentChargeId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
}

/**
 * Applies an auditable correction without changing the original bill items.
 */
export const applyAdjustment = onCall<ApplyAdjustmentInput>(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  requireRole(request.auth.token.role, "landlord");

  const uid = request.auth.uid;
  const {rentChargeId, amount, reason, idempotencyKey} = request.data || {};
  if (
    typeof rentChargeId !== "string" ||
      !rentChargeId.trim() ||
      rentChargeId.includes("/")
  ) {
    throw new HttpsError("invalid-argument", "rentChargeId is required.");
  }
  if (!Number.isSafeInteger(amount)) {
    throw new HttpsError(
      "invalid-argument",
      "amount must be an integer number of paise.",
    );
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new HttpsError("invalid-argument", "reason is required.");
  }
  if (
    typeof idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idempotencyKey,
    )
  ) {
    throw new HttpsError("invalid-argument", "idempotencyKey must be a UUID.");
  }

  const normalizedIdempotencyKey = idempotencyKey.toLowerCase();
  const rentChargeRef = db.collection("rentCharges").doc(rentChargeId.trim());
  const adjustmentRef = rentChargeRef
    .collection("adjustments")
    .doc(normalizedIdempotencyKey);
  const normalizedReason = reason.trim();

  return await db.runTransaction(async (transaction) => {
    const [rentChargeDoc, adjustmentDoc] = await Promise.all([
      transaction.get(rentChargeRef),
      transaction.get(adjustmentRef),
    ]);
    if (!rentChargeDoc.exists) {
      throw new HttpsError("not-found", "Rent charge not found.");
    }

    const rentCharge = rentChargeDoc.data()!;
    if (rentCharge.landlordId !== uid) {
      throw new HttpsError(
        "permission-denied",
        "Only the owning landlord can adjust this rent charge.",
      );
    }

    if (adjustmentDoc.exists) {
      const adjustment = adjustmentDoc.data()!;
      if (
        adjustment.amount !== amount ||
          adjustment.reason !== normalizedReason ||
          adjustment.createdBy !== uid
      ) {
        throw new HttpsError(
          "already-exists",
          "idempotencyKey was already used for a different adjustment.",
        );
      }
      return {
        success: true,
        adjustmentId: adjustmentDoc.id,
        newAdjustmentTotal: rentCharge.adjustmentTotal,
        newTotal: rentCharge.total,
      };
    }

    if (!["finalized", "due", "overdue"].includes(rentCharge.status)) {
      throw new HttpsError(
        "failed-precondition",
        rentCharge.status === "payment_pending" ?
          "Adjustments are not allowed while payment is pending." :
          rentCharge.status === "paid" ?
            "Paid rent charges cannot be adjusted." :
            "Rent charge must be finalized before it can be adjusted.",
      );
    }

    const {subtotal, lateFineTotal, adjustmentTotal, total} = rentCharge;
    if (
      !Number.isSafeInteger(subtotal) ||
        !Number.isSafeInteger(lateFineTotal) ||
        !Number.isSafeInteger(adjustmentTotal) ||
        !Number.isSafeInteger(total) ||
        !Number.isSafeInteger(subtotal + lateFineTotal + adjustmentTotal) ||
        subtotal + lateFineTotal + adjustmentTotal !== total
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Rent charge totals are inconsistent.",
      );
    }

    const newAdjustmentTotal = adjustmentTotal + amount;
    const newTotal = subtotal + lateFineTotal + newAdjustmentTotal;
    if (
      !Number.isSafeInteger(newAdjustmentTotal) ||
        !Number.isSafeInteger(newTotal)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Adjustment exceeds the supported integer range.",
      );
    }
    if (newTotal <= 0) {
      throw new HttpsError(
        "failed-precondition",
        "Rent charge total must remain positive after adjustment.",
      );
    }

    const now = FieldValue.serverTimestamp();
    transaction.create(adjustmentRef, {
      type: "correction",
      amount,
      reason: normalizedReason,
      createdBy: uid,
      idempotencyKey: normalizedIdempotencyKey,
      createdAt: now,
    });
    transaction.update(rentChargeRef, {
      adjustmentTotal: newAdjustmentTotal,
      total: newTotal,
      updatedAt: now,
    });

    return {
      success: true,
      adjustmentId: adjustmentRef.id,
      newAdjustmentTotal,
      newTotal,
    };
  });
});

/** Input accepted by authenticated device-token callables. */
interface DeviceTokenInput {
  expectedUid: string;
  token: string;
  platform: "android" | "ios" | "web";
}

/**
 * Validates token input before deriving a user-scoped document path.
 * @param {unknown} data Untrusted callable data
 * @return {DeviceTokenInput} Validated token and platform
 */
function validateDeviceTokenInput(data: unknown): DeviceTokenInput {
  const input = data as Partial<DeviceTokenInput> | null;
  if (
    typeof input?.expectedUid !== "string" ||
    input.expectedUid.trim().length === 0
  ) {
    throw new HttpsError(
      "invalid-argument",
      "An expected authenticated user is required.",
    );
  }
  if (
    typeof input?.token !== "string" ||
    input.token.trim().length < 20 ||
    input.token.length > 4096
  ) {
    throw new HttpsError("invalid-argument", "A valid FCM token is required.");
  }
  if (!["android", "ios", "web"].includes(input.platform as string)) {
    throw new HttpsError(
      "invalid-argument",
      "A supported platform is required.",
    );
  }
  return {
    expectedUid: input.expectedUid,
    token: input.token,
    platform: input.platform as DeviceTokenInput["platform"],
  };
}

/**
 * Stores an FCM token under the authenticated user's private device-token path.
 */
export const registerDeviceToken = onCall<DeviceTokenInput>(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  const {expectedUid, token, platform} = validateDeviceTokenInput(
    request.data,
  );
  if (expectedUid !== request.auth.uid) {
    throw new HttpsError(
      "permission-denied",
      "The authenticated user changed during token registration.",
    );
  }
  const userRef = db.collection("users").doc(request.auth.uid);
  const tokenRef = userRef
    .collection("deviceTokens")
    .doc(deviceTokenDocumentId(token));

  await db.runTransaction(async (transaction) => {
    const [user, existingToken] = await Promise.all([
      transaction.get(userRef),
      transaction.get(tokenRef),
    ]);
    if (!user.exists || !["landlord", "tenant"].includes(user.get("role"))) {
      throw new HttpsError(
        "failed-precondition",
        "Complete onboarding before registering notifications.",
      );
    }

    const now = FieldValue.serverTimestamp();
    transaction.set(tokenRef, {
      token,
      platform,
      createdAt: existingToken.exists ? existingToken.get("createdAt") : now,
      updatedAt: now,
    });
  });

  return {success: true};
});

/**
 * Removes only the current authenticated user's registered device token.
 */
export const unregisterDeviceToken = onCall<{
  expectedUid: string;
  token: string;
}>(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  const {expectedUid, token} = validateDeviceTokenInput({
    expectedUid: request.data?.expectedUid,
    token: request.data?.token,
    platform: "android",
  });
  if (expectedUid !== request.auth.uid) {
    throw new HttpsError(
      "permission-denied",
      "The authenticated user changed before token removal.",
    );
  }
  await db
    .collection("users")
    .doc(request.auth.uid)
    .collection("deviceTokens")
    .doc(deviceTokenDocumentId(token))
    .delete();
  return {success: true};
});

export const preparePaymentProofUpload = onCall<PreparePaymentUploadInput>(
  {secrets: [paymentUploadTokenSecret]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    requireRole(request.auth.token.role, "tenant");
    const service = createPaymentUploadService({
      db,
      uploadUrl: paymentProofUploadUrl(request),
      tokenSecret: paymentUploadTokenSecret.value(),
    });
    return service.prepare(
      request.auth?.uid,
      request.auth?.token.role,
      request.data,
    );
  },
);

export const createUpiPayment = onCall<CreateUpiPaymentInput>(
  {
    secrets: [cloudinaryCloudName, cloudinaryApiKey, cloudinaryApiSecret],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    requireRole(request.auth.token.role, "tenant");
    const service = createPaymentUploadService({
      db,
      cloudinary: createCloudinaryGateway({
        cloudName: cloudinaryCloudName.value(),
        apiKey: cloudinaryApiKey.value(),
        apiSecret: cloudinaryApiSecret.value(),
      }),
    });
    return service.create(
      request.auth.uid,
      request.auth.token.role,
      request.data,
    );
  },
);

export const verifyUpiPayment = onCall<VerifyUpiPaymentInput>(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    requireRole(request.auth.token.role, "landlord");
    const service = createPaymentUploadService({db});
    return service.verify(
      request.auth.uid,
      request.auth.token.role,
      request.data,
    );
  },
);

export const uploadPaymentProof = onRequest(
  {
    secrets: [
      cloudinaryCloudName,
      cloudinaryApiKey,
      cloudinaryApiSecret,
      paymentUploadTokenSecret,
    ],
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (request, response) => {
    await createPaymentUploadHttpHandler(
      () =>
        createPaymentUploadService({
          db,
          tokenSecret: paymentUploadTokenSecret.value(),
          cloudinary: createCloudinaryGateway({
            cloudName: cloudinaryCloudName.value(),
            apiKey: cloudinaryApiKey.value(),
            apiSecret: cloudinaryApiSecret.value(),
          }),
        }),
      (error) => logger.error("Payment proof upload failed.", error),
    )(request, response);
  },
);

export const recoverPaymentProofCleanup = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Etc/UTC",
    retryCount: 1,
    maxRetrySeconds: 300,
    secrets: [cloudinaryCloudName, cloudinaryApiKey, cloudinaryApiSecret],
  },
  async () => {
    const service = createPaymentUploadService({
      db,
      cloudinary: createCloudinaryGateway({
        cloudName: cloudinaryCloudName.value(),
        apiKey: cloudinaryApiKey.value(),
        apiSecret: cloudinaryApiSecret.value(),
      }),
    });
    await service.recoverCleanup();
  },
);

export const send25thLandlordReminder = onSchedule(
  {
    schedule: "0 9 25 * *",
    timeZone: "Etc/UTC",
    retryCount: 3,
    maxRetrySeconds: 7200,
  },
  async (event) => {
    await run25thLandlordReminder(db, event.scheduleTime);
  },
);

export const send1stTenantNotifications = onSchedule(
  {
    schedule: "0 9 1 * *",
    timeZone: "Etc/UTC",
    retryCount: 3,
    maxRetrySeconds: 7200,
  },
  async (event) => {
    await run1stTenantNotifications(db, event.scheduleTime);
  },
);

export const expandNotificationDelivery = onDocumentCreated(
  {
    document: "notificationDeliveries/{notificationId}",
    retry: true,
  },
  async (event) => {
    const notificationId = event.params.notificationId;
    await expandNotificationDeliveries(db, notificationId);
  },
);

export const deliverNotificationToRegisteredDevice = onDocumentCreated(
  {
    document: "notificationDeliveries/{notificationId}/devices/{tokenHash}",
    retry: true,
  },
  async (event) => {
    await deliverNotificationToDevice(
      db,
      {
        notificationId: event.params.notificationId,
        tokenHash: event.params.tokenHash,
      },
      (message) => getMessaging().send(message),
    );
  },
);

export const recoverNotificationDeliveries = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Etc/UTC",
    retryCount: 1,
    maxRetrySeconds: 300,
  },
  async () => {
    await recoverNotificationDeliveryTasks(db, (message) =>
      getMessaging().send(message),
    );
  },
);

export {
  deviceTokenDocumentId,
  run1stTenantNotifications,
  run25thLandlordReminder,
};
