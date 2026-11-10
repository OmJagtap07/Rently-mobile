import {setGlobalOptions} from "firebase-functions";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {initializeApp, getApps} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getAuth} from "firebase-admin/auth";

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const auth = getAuth();

setGlobalOptions({maxInstances: 10});

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
      `Only ${expectedRole}s can perform this action.`
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
        "User must be authenticated to complete onboarding."
      );
    }

    const uid = request.auth.uid;
    const {role, fullName, phone} = request.data || {};

    // 2. Input validation
    if (role !== "landlord" && role !== "tenant") {
      throw new HttpsError(
        "invalid-argument",
        "Role must be either 'landlord' or 'tenant'."
      );
    }

    if (!fullName || typeof fullName !== "string" || !fullName.trim()) {
      throw new HttpsError(
        "invalid-argument",
        "Full name is required and must be a non-empty string."
      );
    }

    if (!phone || typeof phone !== "string" || !phone.trim()) {
      throw new HttpsError(
        "invalid-argument",
        "Phone number is required and must be a non-empty string."
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
          "User has already completed onboarding."
        );
      }
    }

    if (existingRole && existingRole !== role) {
      throw new HttpsError(
        "already-exists",
        "User already has an assigned role claim."
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
  }
);

interface ResolveJoinCodeInput {
  joinCode: string;
}

/**
 * Callable function for tenants to look up basic property details by joinCode.
 * Deliberately withholds landlordId and private details.
 */
export const resolveJoinCode = onCall<ResolveJoinCodeInput>(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "User must be authenticated."
      );
    }
    requireRole(request.auth.token.role, "tenant");

    const {joinCode} = request.data || {};
    if (!joinCode || typeof joinCode !== "string" || !joinCode.trim()) {
      throw new HttpsError(
        "invalid-argument",
        "A valid join code is required."
      );
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
        "No active property found matching this join code."
      );
    }

    const propertyDoc = querySnapshot.docs[0];
    const data = propertyDoc.data();

    return {
      propertyId: propertyDoc.id,
      name: data.name,
      address: data.address,
    };
  }
);

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
      throw new HttpsError(
        "unauthenticated",
        "User must be authenticated."
      );
    }
    requireRole(request.auth.token.role, "tenant");
    const uid = request.auth.uid;

    const {propertyId, message} = request.data || {};
    if (!propertyId || typeof propertyId !== "string" || !propertyId.trim()) {
      throw new HttpsError(
        "invalid-argument",
        "propertyId is required."
      );
    }

    const propertyRef = db.collection("properties").doc(propertyId.trim());
    const propertyDoc = await propertyRef.get();
    if (!propertyDoc.exists || propertyDoc.data()?.status !== "active") {
      throw new HttpsError(
        "failed-precondition",
        "Property not found or is not currently active."
      );
    }

    const userDocRef = db.collection("users").doc(uid);
    const userDoc = await userDocRef.get();
    if (!userDoc.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Tenant profile must be onboarded first."
      );
    }

    if (userDoc.data()?.activeLeaseId) {
      throw new HttpsError(
        "failed-precondition",
        "Tenant already has an active tenancy and cannot apply."
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
        "Target property has no assigned landlord."
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
  }
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
      throw new HttpsError(
        "unauthenticated",
        "User must be authenticated."
      );
    }
    requireRole(request.auth.token.role, "landlord");
    const uid = request.auth.uid;

    const {joinRequestId, unitId, joiningDate} = request.data || {};
    if (!joinRequestId || typeof joinRequestId !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "joinRequestId is required."
      );
    }
    if (!unitId || typeof unitId !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "unitId is required."
      );
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
          "You do not own the property for this request."
        );
      }
      if (requestData?.status !== "pending") {
        throw new HttpsError(
          "failed-precondition",
          "Join request is no longer pending."
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
      if (
        unitData?.propertyId !== propertyId ||
        unitData?.landlordId !== uid
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Unit does not belong to this property."
        );
      }
      if (unitData?.status !== "vacant") {
        throw new HttpsError(
          "failed-precondition",
          "Unit is not vacant."
        );
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
          "Tenant already has an active lease."
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
  }
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
export const endLease = onCall<EndLeaseInput>(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "User must be authenticated."
      );
    }
    const uid = request.auth.uid;

    const {leaseId, endDate, endReason} = request.data || {};
    if (!leaseId || typeof leaseId !== "string" || !leaseId.trim()) {
      throw new HttpsError(
        "invalid-argument",
        "leaseId is required."
      );
    }
    if (
      !endDate ||
      typeof endDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())
    ) {
      throw new HttpsError(
        "invalid-argument",
        "endDate must be a valid YYYY-MM-DD string."
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
          "Only the owning landlord can end this lease."
        );
      }

      if (leaseData?.status !== "active") {
        throw new HttpsError(
          "failed-precondition",
          "Lease is already ended or not active."
        );
      }

      const joiningDate = leaseData?.joiningDate;
      const formattedEndDate = endDate.trim();
      if (joiningDate && formattedEndDate < joiningDate) {
        throw new HttpsError(
          "invalid-argument",
          "endDate cannot be before joiningDate."
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
  }
);
