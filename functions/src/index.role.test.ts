import testEnvFactory from "firebase-functions-test";
import {
  acceptJoinRequest,
  createJoinRequest,
  resolveJoinCode,
} from "./index";
import type {CallableRequest} from "firebase-functions/v2/https";

const testEnv = testEnvFactory({projectId: "demo-rently"});
const wrapped = {
  acceptJoinRequest: testEnv.wrap(acceptJoinRequest),
  createJoinRequest: testEnv.wrap(createJoinRequest),
  resolveJoinCode: testEnv.wrap(resolveJoinCode),
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
    await expect(
      wrapped.resolveJoinCode(request("tenant"))
    ).rejects.toThrow("A valid join code is required.");
  });

  it("denies landlords from resolving join codes", async () => {
    await expect(
      wrapped.resolveJoinCode(request("landlord"))
    ).rejects.toThrow("Only tenants can perform this action.");
  });

  it("allows tenants to create join requests", async () => {
    await expect(
      wrapped.createJoinRequest(request("tenant"))
    ).rejects.toThrow("propertyId is required.");
  });

  it("denies landlords from creating join requests", async () => {
    await expect(
      wrapped.createJoinRequest(request("landlord"))
    ).rejects.toThrow("Only tenants can perform this action.");
  });

  it("allows landlords to accept join requests", async () => {
    await expect(
      wrapped.acceptJoinRequest(request("landlord"))
    ).rejects.toThrow("joinRequestId is required.");
  });

  it("denies tenants from accepting join requests", async () => {
    await expect(
      wrapped.acceptJoinRequest(request("tenant"))
    ).rejects.toThrow("Only landlords can perform this action.");
  });
});
