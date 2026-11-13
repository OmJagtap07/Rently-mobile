import testEnvFactory from "firebase-functions-test";
import {
  applyAdjustment,
  acceptJoinRequest,
  createJoinRequest,
  createUpiPayment,
  finalizeRentCharge,
  preparePaymentProofUpload,
  resolveJoinCode,
  verifyUpiPayment,
} from "./index";
import type {CallableRequest} from "firebase-functions/v2/https";

const testEnv = testEnvFactory({projectId: "demo-rently"});
const wrapped = {
  acceptJoinRequest: testEnv.wrap(acceptJoinRequest),
  applyAdjustment: testEnv.wrap(applyAdjustment),
  createJoinRequest: testEnv.wrap(createJoinRequest),
  createUpiPayment: testEnv.wrap(createUpiPayment),
  finalizeRentCharge: testEnv.wrap(finalizeRentCharge),
  preparePaymentProofUpload: testEnv.wrap(preparePaymentProofUpload),
  resolveJoinCode: testEnv.wrap(resolveJoinCode),
  verifyUpiPayment: testEnv.wrap(verifyUpiPayment),
};

type UserRole = "landlord" | "tenant";

/**
 * Builds an authenticated callable request for the given role.
 * @param {UserRole} role Firebase custom role claim
 * @return {CallableRequest<Record<string, never>>} Callable test request
 */
function request(role: UserRole): CallableRequest<Record<string, never>> {
  const uid = `${role}_user`;

  return {
    auth: {
      uid,
      token: {
        aud: "demo-rently",
        auth_time: 0,
        exp: 0,
        firebase: {identities: {}, sign_in_provider: "custom"},
        iat: 0,
        iss: "https://securetoken.google.com/demo-rently",
        role,
        sub: uid,
        uid,
      },
      rawToken: "role-test-token",
    },
    data: {},
    rawRequest: {} as CallableRequest<Record<string, never>>["rawRequest"],
    acceptsStreaming: false,
  };
}

describe("callable role authorization", () => {
  afterAll(() => {
    testEnv.cleanup();
  });

  it("allows tenants to resolve join codes", async () => {
    await expect(wrapped.resolveJoinCode(request("tenant"))).rejects.toThrow(
      "A valid join code is required.",
    );
  });

  it("denies landlords from resolving join codes", async () => {
    await expect(wrapped.resolveJoinCode(request("landlord"))).rejects.toThrow(
      "Only tenants can perform this action.",
    );
  });

  it("allows tenants to create join requests", async () => {
    await expect(wrapped.createJoinRequest(request("tenant"))).rejects.toThrow(
      "propertyId is required.",
    );
  });

  it("denies landlords from creating join requests", async () => {
    await expect(
      wrapped.createJoinRequest(request("landlord")),
    ).rejects.toThrow("Only tenants can perform this action.");
  });

  it("allows landlords to accept join requests", async () => {
    await expect(
      wrapped.acceptJoinRequest(request("landlord")),
    ).rejects.toThrow("joinRequestId is required.");
  });

  it("denies tenants from accepting join requests", async () => {
    await expect(wrapped.acceptJoinRequest(request("tenant"))).rejects.toThrow(
      "Only landlords can perform this action.",
    );
  });

  it(
    "allows landlords to reach rent-charge finalization validation",
    async () => {
      await expect(
        wrapped.finalizeRentCharge(request("landlord")),
      ).rejects.toThrow("rentChargeId is required.");
    },
  );

  it("denies tenants from finalizing rent charges", async () => {
    await expect(wrapped.finalizeRentCharge(request("tenant"))).rejects.toThrow(
      "Only landlords can perform this action.",
    );
  });

  it("rejects unauthenticated rent-charge finalization", async () => {
    await expect(
      wrapped.finalizeRentCharge({...request("landlord"), auth: undefined}),
    ).rejects.toThrow("User must be authenticated.");
  });

  it("allows landlords to reach adjustment validation", async () => {
    await expect(wrapped.applyAdjustment(request("landlord"))).rejects.toThrow(
      "rentChargeId is required.",
    );
  });

  it("denies tenants from applying rent-charge adjustments", async () => {
    await expect(wrapped.applyAdjustment(request("tenant"))).rejects.toThrow(
      "Only landlords can perform this action.",
    );
  });

  it("rejects unauthenticated rent-charge adjustments", async () => {
    await expect(
      wrapped.applyAdjustment({...request("landlord"), auth: undefined}),
    ).rejects.toThrow("User must be authenticated.");
  });

  it("rejects unauthenticated payment upload preparation", async () => {
    await expect(
      wrapped.preparePaymentProofUpload({
        ...request("tenant"),
        auth: undefined,
      }),
    ).rejects.toThrow("User must be authenticated.");
  });

  it("denies landlords from preparing tenant payment uploads", async () => {
    await expect(
      wrapped.preparePaymentProofUpload(request("landlord")),
    ).rejects.toThrow("Only tenants can perform this action.");
  });

  it("rejects unauthenticated UPI payment submission", async () => {
    await expect(
      wrapped.createUpiPayment({...request("tenant"), auth: undefined}),
    ).rejects.toThrow("User must be authenticated.");
  });

  it("denies landlords from creating tenant UPI payments", async () => {
    await expect(wrapped.createUpiPayment(request("landlord"))).rejects.toThrow(
      "Only tenants can perform this action.",
    );
  });

  it("rejects unauthenticated UPI payment verification", async () => {
    await expect(
      wrapped.verifyUpiPayment({
        ...request("landlord"),
        auth: undefined,
      }),
    ).rejects.toThrow("User must be authenticated.");
  });

  it("denies tenants from verifying UPI payments", async () => {
    await expect(wrapped.verifyUpiPayment(request("tenant"))).rejects.toThrow(
      "Only landlords can perform this action.",
    );
  });

  it("allows landlords to reach payment decision validation", async () => {
    await expect(wrapped.verifyUpiPayment(request("landlord"))).rejects.toThrow(
      "A valid paymentId is required.",
    );
  });
});
