import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "crypto";
import {
  DocumentReference,
  FieldValue,
  Firestore,
  Timestamp,
} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";
import {
  createPaymentAcceptedNotification,
  createPaymentProofSubmittedNotification,
  createPaymentRejectedNotification,
} from "./billing_notifications";

export const paymentProofMaxBytes = 5_000_000;
export const paymentUploadPermissionMs = 10 * 60 * 1000;
export const paymentUploadIntentMs = 15 * 60 * 1000;
export const paymentUploadClaimLeaseMs = 7 * 60 * 1000;
export const paymentProofCleanupMaxAttempts = 5;
export const paymentProofCleanupBaseBackoffMs = 60 * 1000;
export const paymentProofFolder = "rently/payment-proofs";

const imageMimeTypes: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const uuidPattern = new RegExp(
  "^[0-9a-f]{8}-" +
    "[0-9a-f]{4}-" +
    "[1-8][0-9a-f]{3}-" +
    "[89ab][0-9a-f]{3}-" +
    "[0-9a-f]{12}$",
  "i",
);
const propertyQrUrlPattern = new RegExp(
  "^https://" +
    "([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)*" +
    "[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?" +
    "(:[0-9]{1,5})?/[^\\s]*$",
);
const pngCrcTable = Array.from({length: 256}, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});
const paymentCollection = "payments";
const intentCollection = "paymentUploadIntents";
const cleanupCollection = "paymentProofCleanupOutbox";

interface UploadTokenPayload {
  uid: string;
  intentId: string;
  expiresAt: number;
}

export interface PreparePaymentUploadInput {
  rentChargeId: string;
  idempotencyKey: string;
  recipientNameConfirmed: true;
  format: string;
  bytes: number;
}

export interface CloudinaryAsset {
  publicId: string;
  folder: string;
  resourceType: string;
  format: string;
  bytes: number;
  secureUrl: string;
  createdAt: string;
}

export interface CloudinaryGateway {
  upload(
    bytes: Buffer,
    format: string,
    publicId: string,
    folder: string,
  ): Promise<CloudinaryAsset>;
  get(publicId: string, folder: string): Promise<CloudinaryAsset | null>;
  delete(publicId: string, folder: string): Promise<void>;
}

export interface CreateUpiPaymentInput {
  rentChargeId: string;
  uploadIntentId: string;
  idempotencyKey: string;
  transactionRef: string;
}

export interface VerifyUpiPaymentInput {
  paymentId: string;
  decision: "accept" | "reject";
  rejectionReasonCode?:
    | "old_or_used_screenshot"
    | "blurry_or_unreadable_screenshot"
    | "incomplete_amount"
    | "incorrect_utr"
    | "payment_not_received"
    | "screenshot_bill_mismatch"
    | "other";
  rejectionExplanation?: string;
}

interface PaymentUploadServiceOptions {
  db: Firestore;
  uploadUrl?: string;
  tokenSecret?: string;
  cloudinary?: CloudinaryGateway;
  now?: () => number;
}

interface CleanupClaim {
  taskId: string;
  attempts: number;
  claimedBy: string;
  publicId: string;
  folder: string;
  resourceType: "image";
  sourceType: "expired_upload_intent" | "rejected_payment";
  uploadIntentId?: string;
  paymentId?: string;
}

export interface PaymentUploadService {
  prepare(
    uid: string | undefined,
    role: unknown,
    input: unknown,
  ): Promise<{
    success: true;
    uploadIntentId: string;
    uploadUrl: string;
    uploadToken: string;
    uploadPermissionExpiresAt: number;
    intentExpiresAt: number;
  }>;
  create(
    uid: string | undefined,
    role: unknown,
    input: unknown,
  ): Promise<{
    success: true;
    paymentId: string;
    status: "pending_verification";
  }>;
  verify(
    uid: string | undefined,
    role: unknown,
    input: unknown,
  ): Promise<{
    success: true;
    paymentId: string;
    decision: "accept" | "reject";
    rentChargeStatus: "paid" | "due" | "overdue";
  }>;
  upload(
    token: string | undefined,
    bytes: Buffer,
    contentType?: string,
  ): Promise<{ success: true; uploadIntentId: string }>;
  recoverCleanup(): Promise<void>;
}

interface PaymentUploadHttpRequest {
  method?: string;
  header(name: string): string | undefined;
  rawBody: Buffer;
}

interface PaymentUploadHttpResponse {
  set(name: string, value: string): unknown;
  status(code: number): PaymentUploadHttpResponse;
  json(body: unknown): unknown;
}

/**
 * Checks whether a value is a non-array object.
 * @param {unknown} value Candidate object
 * @return {boolean} Whether the value is a record
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalizes an allowed image extension.
 * @param {unknown} value Candidate format
 * @return {string} Normalized format or an empty string
 */
function normalizeFormat(value: unknown): string {
  if (typeof value !== "string") return "";
  const format = value.trim().toLowerCase().replace(/^\./, "");
  return Object.prototype.hasOwnProperty.call(imageMimeTypes, format) ?
    format :
    "";
}

/**
 * Compares image formats while treating JPG and JPEG as equivalent.
 * @param {string} expected Authorized format
 * @param {string} actual Detected format
 * @return {boolean} Whether the formats match
 */
function formatMatches(expected: string, actual: string): boolean {
  const expectedFormat = normalizeFormat(expected);
  const actualFormat = normalizeFormat(actual);
  return (
    expectedFormat === actualFormat ||
    (["jpg", "jpeg"].includes(expectedFormat) &&
      ["jpg", "jpeg"].includes(actualFormat))
  );
}

/**
 * Verifies JPEG marker and segment bounds, including an image frame and scan.
 * @param {Buffer} bytes Candidate JPEG image
 * @return {boolean} Whether the JPEG structure is valid
 */
function isStructurallyValidJpeg(bytes: Buffer): boolean {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    return false;
  }
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) {
      return hasFrame && hasScan && offset === bytes.length;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > bytes.length) return false;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || segmentLength > bytes.length - offset) {
      return false;
    }
    const frameMarker =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (frameMarker) {
      if (segmentLength < 8) return false;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (height === 0 || width === 0) return false;
      hasFrame = true;
    }
    if (marker === 0xda) {
      if (!hasFrame || segmentLength < 6) return false;
      hasScan = true;
      offset += segmentLength;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        let markerOffset = offset + 1;
        while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
          markerOffset += 1;
        }
        if (markerOffset >= bytes.length) return false;
        const scanMarker = bytes[markerOffset];
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
          offset = markerOffset + 1;
          continue;
        }
        break;
      }
      continue;
    }
    offset += segmentLength;
  }
  return false;
}

/**
 * Identifies an image from its binary structure, not its filename or MIME type.
 * @param {Buffer} bytes Candidate image data
 * @return {?string} Detected format, or null when unsupported or malformed
 */
function identifyImageFormat(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;

  if (isStructurallyValidJpeg(bytes)) {
    return "jpeg";
  }

  const isPng = bytes
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (isPng && isStructurallyValidPng(bytes)) {
    return "png";
  }

  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
    bytes.readUInt32LE(4) === bytes.length - 8
  ) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkType = bytes.subarray(offset, offset + 4).toString("ascii");
      const chunkSize = bytes.readUInt32LE(offset + 4);
      if (chunkSize > bytes.length - offset - 8) return null;
      if (["VP8 ", "VP8L", "VP8X"].includes(chunkType)) {
        return offset + 8 + chunkSize + (chunkSize % 2) === bytes.length ?
          "webp" :
          null;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
  }

  /**
   * Calculates a PNG chunk checksum.
   * @param {Buffer} bytes Chunk type and data
   * @return {number} CRC-32 checksum
   */
  function pngCrc32(bytes: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Verifies PNG chunk bounds, checksums, and required image chunks.
   * @param {Buffer} bytes Candidate PNG image
   * @return {boolean} Whether the PNG structure is valid
   */
  function isStructurallyValidPng(bytes: Buffer): boolean {
    let offset = 8;
    let hasHeader = false;
    let hasData = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) return false;
      const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
      const crcOffset = offset + 8 + length;
      if (
        pngCrc32(bytes.subarray(offset + 4, crcOffset)) !==
        bytes.readUInt32BE(crcOffset)
      ) {
        return false;
      }
      if (!hasHeader) {
        if (type !== "IHDR" || length !== 13) return false;
        if (
          bytes.readUInt32BE(offset + 8) === 0 ||
          bytes.readUInt32BE(offset + 12) === 0
        ) {
          return false;
        }
        hasHeader = true;
      } else if (type === "IHDR") {
        return false;
      }
      if (type === "IDAT" && length > 0) hasData = true;
      if (type === "IEND") {
        return (
          length === 0 && hasHeader && hasData && crcOffset + 4 === bytes.length
        );
      }
      offset = crcOffset + 4;
    }
    return false;
  }

  return null;
}

/**
 * Derives a fixed-size key for scoped upload tokens.
 * @param {string} secret Secret Manager value
 * @return {Buffer} AES-256 key
 */
function tokenKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Encrypts and authenticates a scoped upload-token payload.
 * @param {UploadTokenPayload} payload Scoped token claims
 * @param {string} secret Secret Manager value
 * @return {string} Opaque base64url token
 */
function encryptUploadToken(
  payload: UploadTokenPayload,
  secret: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
}

/**
 * Authenticates and decrypts an opaque upload token.
 * @param {?string} token Opaque bearer token
 * @param {string} secret Secret Manager value
 * @return {?UploadTokenPayload} Verified claims, or null for invalid tokens
 */
function decryptUploadToken(
  token: string | undefined,
  secret: string,
): UploadTokenPayload | null {
  if (!token || token.length > 2048) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      tokenKey(secret),
      raw.subarray(0, 12),
    );
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
    const payload: unknown = JSON.parse(plaintext);
    if (
      !isRecord(payload) ||
      typeof payload.uid !== "string" ||
      typeof payload.intentId !== "string" ||
      typeof payload.expiresAt !== "number" ||
      !Number.isSafeInteger(payload.expiresAt)
    ) {
      return null;
    }
    return {
      uid: payload.uid,
      intentId: payload.intentId,
      expiresAt: payload.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Validates callable authorization and untrusted upload metadata.
 * @param {?string} uid Authenticated tenant ID
 * @param {unknown} role Firebase role claim
 * @param {unknown} input Callable input
 * @return {object} Normalized upload scope and declarations
 */
function validateInput(
  uid: string | undefined,
  role: unknown,
  input: unknown,
): {
  uid: string;
  rentChargeId: string;
  key: string;
  format: string;
  bytes: number;
} {
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  if (role !== "tenant") {
    throw new HttpsError(
      "permission-denied",
      "Only tenants can upload payment proof.",
    );
  }
  if (!isRecord(input)) {
    throw new HttpsError(
      "invalid-argument",
      "A valid upload request is required.",
    );
  }
  const rentChargeId = input.rentChargeId;
  const rawKey = input.idempotencyKey;
  const format = normalizeFormat(input.format);
  const bytes = input.bytes;
  if (typeof rentChargeId !== "string" || rentChargeId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "rentChargeId is required.");
  }
  if (typeof rawKey !== "string" || !uuidPattern.test(rawKey)) {
    throw new HttpsError(
      "invalid-argument",
      "A valid UUID idempotency key is required.",
    );
  }
  if (input.recipientNameConfirmed !== true) {
    throw new HttpsError(
      "failed-precondition",
      "Confirm the recipient name before preparing the upload.",
    );
  }
  if (!format) {
    throw new HttpsError(
      "invalid-argument",
      "Proof must be a JPG, JPEG, PNG, or WebP image.",
    );
  }
  if (
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > paymentProofMaxBytes
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Proof size must be between 1 and 5,000,000 bytes.",
    );
  }
  return {
    uid,
    rentChargeId: rentChargeId.trim(),
    key: rawKey.toLowerCase(),
    format,
    bytes,
  };
}

/**
 * Validates the configured property UPI fields before authorizing an upload.
 * @param {Record<string, unknown>} property Property document data
 * @return {boolean} Whether the payment configuration is valid
 */
function isValidUpiConfiguration(property: Record<string, unknown>): boolean {
  const upiId = property.upiId;
  const qrUrl = property.upiQrImageUrl;
  const displayName = property.upiDisplayName;
  if (
    typeof upiId !== "string" ||
    !/^[A-Za-z0-9._-]{2,100}@[A-Za-z0-9.-]{2,100}$/.test(upiId) ||
    typeof qrUrl !== "string" ||
    qrUrl.length > 2048 ||
    !propertyQrUrlPattern.test(qrUrl) ||
    typeof displayName !== "string" ||
    displayName.length > 100 ||
    displayName.trim().length === 0
  ) {
    return false;
  }
  try {
    const url = new URL(qrUrl);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

/**
 * Derives a deterministic Firestore-safe ID from a client idempotency key.
 * @param {string} key Normalized UUID key
 * @return {string} SHA-256 hex digest
 */
function paymentIntentId(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

interface ValidatedCreatePaymentInput {
  uid: string;
  rentChargeId: string;
  uploadIntentId: string;
  idempotencyKey: string;
  transactionRef: string;
  normalizedTransactionRef: string;
}

/**
 * Validates identity, idempotency, and UTR fields for payment submission.
 * @param {?string} uid Authenticated tenant ID
 * @param {unknown} role Firebase role claim
 * @param {unknown} input Callable input
 * @return {ValidatedCreatePaymentInput} Normalized submission data
 */
function validateCreatePaymentInput(
  uid: string | undefined,
  role: unknown,
  input: unknown,
): ValidatedCreatePaymentInput {
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  if (role !== "tenant") {
    throw new HttpsError(
      "permission-denied",
      "Only tenants can submit UPI payments.",
    );
  }
  if (!isRecord(input)) {
    throw new HttpsError(
      "invalid-argument",
      "A valid UPI payment request is required.",
    );
  }
  const {rentChargeId, uploadIntentId, idempotencyKey, transactionRef} =
    input;
  if (typeof rentChargeId !== "string" || !rentChargeId.trim()) {
    throw new HttpsError("invalid-argument", "rentChargeId is required.");
  }
  if (
    typeof uploadIntentId !== "string" ||
    !/^[0-9a-f]{64}$/i.test(uploadIntentId)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "A valid uploadIntentId is required.",
    );
  }
  if (typeof idempotencyKey !== "string" || !uuidPattern.test(idempotencyKey)) {
    throw new HttpsError(
      "invalid-argument",
      "A valid UUID idempotency key is required.",
    );
  }
  if (
    typeof transactionRef !== "string" ||
    !/^[A-Za-z0-9]{6,30}$/.test(transactionRef.trim())
  ) {
    throw new HttpsError(
      "invalid-argument",
      "UTR/reference must contain 6-30 ASCII alphanumeric characters.",
    );
  }
  const trimmedTransactionRef = transactionRef.trim();
  return {
    uid,
    rentChargeId: rentChargeId.trim(),
    uploadIntentId: uploadIntentId.toLowerCase(),
    idempotencyKey: idempotencyKey.toLowerCase(),
    transactionRef: trimmedTransactionRef,
    normalizedTransactionRef: trimmedTransactionRef.toUpperCase(),
  };
}

const rejectionReasons = {
  old_or_used_screenshot: "Old or previously used screenshot",
  blurry_or_unreadable_screenshot: "Blurry or unreadable screenshot",
  incomplete_amount: "Payment amount is incomplete",
  incorrect_utr: "Incorrect UTR/reference number",
  payment_not_received: "Payment not received in landlord's account",
  screenshot_bill_mismatch: "Screenshot does not match this rent bill",
  other: "Other",
} as const;

type PaymentRejectionReasonCode = keyof typeof rejectionReasons;

/**
 * Checks whether a value is a supported rejection reason code.
 * @param {unknown} value Candidate reason code
 * @return {boolean} Whether the code is supported
 */
function isPaymentRejectionReasonCode(
  value: unknown,
): value is PaymentRejectionReasonCode {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(rejectionReasons, value);
}

interface ValidatedPaymentDecision {
  uid: string;
  paymentId: string;
  decision: "accept" | "reject";
  rejectionReasonCode?: PaymentRejectionReasonCode;
  rejectionReason?: string;
  rejectionExplanation?: string;
}

/**
 * Validates the exact decision payload without accepting unknown fields.
 * @param {?string} uid Authenticated landlord ID
 * @param {unknown} role Firebase role claim
 * @param {unknown} input Callable input
 * @return {ValidatedPaymentDecision} Normalized decision
 */
function validatePaymentDecision(
  uid: string | undefined,
  role: unknown,
  input: unknown,
): ValidatedPaymentDecision {
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  if (role !== "landlord") {
    throw new HttpsError(
      "permission-denied",
      "Only landlords can verify UPI payments.",
    );
  }
  if (!isRecord(input)) {
    throw new HttpsError(
      "invalid-argument",
      "A valid UPI payment decision is required.",
    );
  }
  const {paymentId, decision, rejectionReasonCode, rejectionExplanation} =
    input;
  if (
    typeof paymentId !== "string" ||
    paymentId !== paymentId.trim() ||
    !uuidPattern.test(paymentId)
  ) {
    throw new HttpsError("invalid-argument", "A valid paymentId is required.");
  }
  if (decision !== "accept" && decision !== "reject") {
    throw new HttpsError(
      "invalid-argument",
      "decision must be accept or reject.",
    );
  }

  const hasExplanation = Object.prototype.hasOwnProperty.call(
    input,
    "rejectionExplanation",
  );
  const allowedFields =
    decision === "accept" ?
      new Set(["paymentId", "decision"]) :
      new Set([
        "paymentId",
        "decision",
        "rejectionReasonCode",
        ...(rejectionReasonCode === "other" ? ["rejectionExplanation"] : []),
      ]);
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    throw new HttpsError(
      "invalid-argument",
      "The payment decision contains unsupported fields.",
    );
  }
  if (decision === "accept") {
    return {
      uid,
      paymentId: paymentId.toLowerCase(),
      decision,
    };
  }

  if (!isPaymentRejectionReasonCode(rejectionReasonCode)) {
    throw new HttpsError(
      "invalid-argument",
      "A valid rejectionReasonCode is required.",
    );
  }
  if (rejectionReasonCode !== "other" && hasExplanation) {
    throw new HttpsError(
      "invalid-argument",
      "rejectionExplanation is allowed only for the other reason.",
    );
  }
  if (rejectionReasonCode === "other") {
    if (
      !hasExplanation ||
      typeof rejectionExplanation !== "string" ||
      rejectionExplanation.trim().length < 10 ||
      rejectionExplanation.trim().length > 500
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Other rejection explanations must contain 10-500 characters.",
      );
    }
    return {
      uid,
      paymentId: paymentId.toLowerCase(),
      decision,
      rejectionReasonCode,
      rejectionReason: rejectionReasons[rejectionReasonCode],
      rejectionExplanation: rejectionExplanation.trim(),
    };
  }
  if (hasExplanation) {
    throw new HttpsError(
      "invalid-argument",
      "rejectionExplanation is allowed only for the other reason.",
    );
  }
  return {
    uid,
    paymentId: paymentId.toLowerCase(),
    decision,
    rejectionReasonCode,
    rejectionReason: rejectionReasons[rejectionReasonCode],
  };
}

/**
 * Creates an HTTP error with a response status.
 * @param {number} status HTTP status
 * @param {string} message Safe client-facing message
 * @return {Error} Error carrying the response status
 */
function uploadError(
  status: number,
  message: string,
): Error & { status: number } {
  return Object.assign(new Error(message), {status});
}

/**
 * Creates scoped upload and proof cleanup operations.
 * @param {PaymentUploadServiceOptions} options Service dependencies
 * @return {PaymentUploadService} Upload service operations
 */
export function createPaymentUploadService(
  options: PaymentUploadServiceOptions,
): PaymentUploadService {
  const {db, tokenSecret, cloudinary} = options;
  const now = options.now ?? Date.now;
  if (tokenSecret !== undefined && tokenSecret.length < 32) {
    throw new Error(
      "PAYMENT_UPLOAD_TOKEN_SECRET must be at least 32 characters.",
    );
  }

  /**
   * Creates or reuses a tenant- and bill-scoped upload intent.
   * @param {?string} uid Authenticated tenant ID
   * @param {unknown} role Firebase role claim
   * @param {unknown} input Callable payload
   * @return {Promise<object>} Scoped upload permission and expiry values
   */
  async function prepare(
    uid: string | undefined,
    role: unknown,
    input: unknown,
  ): Promise<{
    success: true;
    uploadIntentId: string;
    uploadUrl: string;
    uploadToken: string;
    uploadPermissionExpiresAt: number;
    intentExpiresAt: number;
  }> {
    if (!tokenSecret) {
      throw new Error("PAYMENT_UPLOAD_TOKEN_SECRET is not configured.");
    }
    if (!options.uploadUrl) {
      throw new Error("Payment proof upload endpoint URL is not configured.");
    }
    const validated = validateInput(uid, role, input);
    const intentId = paymentIntentId(validated.key);
    const intentRef = db.collection(intentCollection).doc(intentId);
    const billRef = db.collection("rentCharges").doc(validated.rentChargeId);
    const tenantRef = db.collection("users").doc(validated.uid);
    const currentTime = now();

    const result = await db.runTransaction(async (transaction) => {
      const [billSnapshot, tenantSnapshot, intentSnapshot] = await Promise.all([
        transaction.get(billRef),
        transaction.get(tenantRef),
        transaction.get(intentRef),
      ]);
      if (!tenantSnapshot.exists || tenantSnapshot.get("role") !== "tenant") {
        throw new HttpsError(
          "failed-precondition",
          "Tenant profile must be onboarded before uploading proof.",
        );
      }
      if (!billSnapshot.exists) {
        throw new HttpsError("not-found", "Rent charge not found.");
      }
      const bill = billSnapshot.data()!;
      if (bill.tenantId !== validated.uid) {
        throw new HttpsError(
          "permission-denied",
          "This rent charge does not belong to the authenticated tenant.",
        );
      }
      if (!["due", "overdue"].includes(bill.status)) {
        throw new HttpsError(
          "failed-precondition",
          "Only a due or overdue rent charge can accept payment proof.",
        );
      }
      if (
        typeof bill.leaseId !== "string" ||
        typeof bill.propertyId !== "string" ||
        typeof bill.landlordId !== "string"
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Rent charge ownership data is incomplete.",
        );
      }
      const leaseRef = db.collection("leases").doc(bill.leaseId);
      const propertyRef = db.collection("properties").doc(bill.propertyId);
      const [leaseSnapshot, propertySnapshot] = await Promise.all([
        transaction.get(leaseRef),
        transaction.get(propertyRef),
      ]);
      if (!leaseSnapshot.exists || !propertySnapshot.exists) {
        throw new HttpsError(
          "failed-precondition",
          "Rent charge lease or property is unavailable.",
        );
      }
      const lease = leaseSnapshot.data()!;
      const property = propertySnapshot.data()!;
      if (
        lease.tenantId !== validated.uid ||
        lease.landlordId !== bill.landlordId ||
        lease.propertyId !== bill.propertyId ||
        !["active", "ended"].includes(lease.status)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Rent charge lease ownership is inconsistent.",
        );
      }
      if (
        property.landlordId !== bill.landlordId ||
        !isValidUpiConfiguration(property)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "The property has no valid UPI payment configuration.",
        );
      }

      const intentExpiryMs = currentTime + paymentUploadIntentMs;
      if (intentSnapshot.exists) {
        const intent = intentSnapshot.data()!;
        if (
          intent.idempotencyKey !== validated.key ||
          intent.tenantId !== validated.uid ||
          intent.rentChargeId !== validated.rentChargeId ||
          intent.expectedFormat !== validated.format ||
          intent.expectedBytes !== validated.bytes
        ) {
          throw new HttpsError(
            "already-exists",
            "The idempotency key was used for a different upload " +
              "scope or file.",
          );
        }
        if (intent.status !== "issued") {
          throw new HttpsError(
            "already-exists",
            "This upload intent is no longer available.",
          );
        }
        const existingExpiry = intent.expiresAt;
        if (
          !(existingExpiry instanceof Timestamp) ||
          existingExpiry.toMillis() <= currentTime
        ) {
          throw new HttpsError(
            "failed-precondition",
            "The upload intent expired. Request a new upload intent.",
          );
        }
        const permissionExpiry = Math.min(
          currentTime + paymentUploadPermissionMs,
          existingExpiry.toMillis(),
        );
        transaction.update(intentRef, {
          uploadPermissionExpiresAt: Timestamp.fromMillis(permissionExpiry),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {
          permissionExpiry,
          intentExpiry: existingExpiry.toMillis(),
        };
      }

      const permissionExpiry = Math.min(
        currentTime + paymentUploadPermissionMs,
        intentExpiryMs,
      );
      transaction.create(intentRef, {
        tenantId: validated.uid,
        rentChargeId: validated.rentChargeId,
        idempotencyKey: validated.key,
        publicId: randomUUID(),
        folder: paymentProofFolder,
        resourceType: "image",
        expectedFormat: validated.format,
        expectedBytes: validated.bytes,
        status: "issued",
        uploadPermissionExpiresAt: Timestamp.fromMillis(permissionExpiry),
        expiresAt: Timestamp.fromMillis(intentExpiryMs),
        createdAt: Timestamp.fromMillis(currentTime),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {permissionExpiry, intentExpiry: intentExpiryMs};
    });

    const uploadToken = encryptUploadToken(
      {
        uid: validated.uid,
        intentId,
        expiresAt: result.permissionExpiry,
      },
      tokenSecret,
    );
    return {
      success: true,
      uploadIntentId: intentId,
      uploadUrl: options.uploadUrl,
      uploadToken,
      uploadPermissionExpiresAt: result.permissionExpiry,
      intentExpiresAt: result.intentExpiry,
    };
  }

  /**
   * Creates and consumes a validated proof intent in one payment transaction.
   * @param {?string} uid Authenticated tenant ID
   * @param {unknown} role Firebase role claim
   * @param {unknown} input Callable payload
   * @return {Promise<object>} Created or idempotently returned payment result
   */
  async function create(
    uid: string | undefined,
    role: unknown,
    input: unknown,
  ): Promise<{
    success: true;
    paymentId: string;
    status: "pending_verification";
  }> {
    const validated = validateCreatePaymentInput(uid, role, input);
    const paymentRef = db
      .collection(paymentCollection)
      .doc(validated.idempotencyKey);
    const billRef = db.collection("rentCharges").doc(validated.rentChargeId);
    const intentRef = db
      .collection(intentCollection)
      .doc(validated.uploadIntentId);

    /**
     * Checks whether a prior payment is the same submitted payload.
     * @param {Record<string, unknown>} payment Existing payment data
     * @param {Record<string, unknown>} intent Existing upload intent data
     * @return {boolean} Whether the retry matches the original submission
     */
    function retryMatches(
      payment: Record<string, unknown>,
      intent: Record<string, unknown>,
    ): boolean {
      const proof = payment.proof;
      return (
        payment.idempotencyKey === validated.idempotencyKey &&
        payment.tenantId === validated.uid &&
        payment.rentChargeId === validated.rentChargeId &&
        payment.transactionRef === validated.transactionRef &&
        isRecord(proof) &&
        intent.tenantId === validated.uid &&
        intent.rentChargeId === validated.rentChargeId &&
        intent.status === "consumed" &&
        intent.consumedByPaymentId === validated.idempotencyKey &&
        intent.publicId === proof.publicId
      );
    }

    const existingPayment = await paymentRef.get();
    if (existingPayment.exists) {
      const existingIntent = await intentRef.get();
      if (
        existingIntent.exists &&
        retryMatches(existingPayment.data()!, existingIntent.data()!)
      ) {
        return {
          success: true,
          paymentId: paymentRef.id,
          status: "pending_verification",
        };
      }
      throw new HttpsError(
        "already-exists",
        "The payment idempotency key was already used for " +
          "a different submission.",
      );
    }

    const [billBefore, intentBefore] = await Promise.all([
      billRef.get(),
      intentRef.get(),
    ]);
    if (!billBefore.exists) {
      throw new HttpsError("not-found", "Rent charge not found.");
    }
    if (!intentBefore.exists) {
      throw new HttpsError(
        "not-found",
        "Payment proof upload intent not found.",
      );
    }
    const preflightBill = billBefore.data()!;
    const preflightIntent = intentBefore.data()!;
    if (preflightBill.tenantId !== validated.uid) {
      throw new HttpsError(
        "permission-denied",
        "This rent charge does not belong to the authenticated tenant.",
      );
    }
    if (!["due", "overdue"].includes(preflightBill.status)) {
      throw new HttpsError(
        "failed-precondition",
        "Only a due or overdue rent charge can accept payment.",
      );
    }

    const currentTime = now();
    if (
      preflightIntent.tenantId !== validated.uid ||
      preflightIntent.rentChargeId !== validated.rentChargeId
    ) {
      throw new HttpsError(
        "permission-denied",
        "The upload intent does not belong to this tenant and rent charge.",
      );
    }
    if (
      preflightIntent.status !== "issued" ||
      !(preflightIntent.expiresAt instanceof Timestamp) ||
      preflightIntent.expiresAt.toMillis() <= currentTime
    ) {
      throw new HttpsError(
        "failed-precondition",
        "The payment proof upload intent is expired or unavailable.",
      );
    }
    if (!cloudinary) {
      throw new HttpsError(
        "unavailable",
        "Payment proof verification is not configured.",
      );
    }

    const foundAsset = await cloudinary.get(
      String(preflightIntent.publicId ?? ""),
      String(preflightIntent.folder ?? ""),
    );
    if (!foundAsset) {
      throw new HttpsError(
        "failed-precondition",
        "The uploaded payment proof is unavailable.",
      );
    }
    const asset: CloudinaryAsset = foundAsset;

    /**
     * Verifies Cloudinary metadata against the scoped upload intent.
     * @param {Record<string, unknown>} intent Persisted upload intent
     * @param {number} validationTime Current server time in milliseconds
     * @return {object} Canonical proof format and uploaded timestamp
     */
    function validateAsset(
      intent: Record<string, unknown>,
      validationTime: number,
    ): {
      format: string;
      uploadedAt: Timestamp;
    } {
      const expectedFormat = normalizeFormat(intent.expectedFormat);
      const permissionExpiry = intent.uploadPermissionExpiresAt;
      const intentExpiry = intent.expiresAt;
      const intentCreatedAt = intent.createdAt;
      const uploadedAtMs = Date.parse(asset.createdAt);
      if (
        !expectedFormat ||
        !Number.isSafeInteger(intent.expectedBytes) ||
        (intent.expectedBytes as number) < 1 ||
        (intent.expectedBytes as number) > paymentProofMaxBytes ||
        typeof intent.publicId !== "string" ||
        asset.publicId !== intent.publicId ||
        intent.folder !== paymentProofFolder ||
        asset.folder !== paymentProofFolder ||
        intent.resourceType !== "image" ||
        asset.resourceType !== "image" ||
        !formatMatches(expectedFormat, asset.format) ||
        asset.bytes !== intent.expectedBytes ||
        asset.bytes < 1 ||
        asset.bytes > paymentProofMaxBytes ||
        !asset.secureUrl.startsWith("https://") ||
        !(permissionExpiry instanceof Timestamp) ||
        !(intentExpiry instanceof Timestamp) ||
        !(intentCreatedAt instanceof Timestamp) ||
        intentExpiry.toMillis() <= validationTime ||
        permissionExpiry.toMillis() > intentExpiry.toMillis() ||
        permissionExpiry.toMillis() <= intentCreatedAt.toMillis() ||
        !Number.isFinite(uploadedAtMs) ||
        uploadedAtMs < intentCreatedAt.toMillis() ||
        uploadedAtMs > permissionExpiry.toMillis() ||
        uploadedAtMs > intentExpiry.toMillis() ||
        uploadedAtMs > validationTime
      ) {
        throw new HttpsError(
          "failed-precondition",
          "The uploaded payment proof does not match its valid upload intent.",
        );
      }
      return {
        format: normalizeFormat(asset.format),
        uploadedAt: Timestamp.fromMillis(uploadedAtMs),
      };
    }

    validateAsset(preflightIntent, currentTime);
    const utrHash = createHash("sha256")
      .update(validated.normalizedTransactionRef, "utf8")
      .digest("hex");
    const utrClaimRef = billRef.collection("upiReferences").doc(utrHash);
    const notification = createPaymentProofSubmittedNotification(
      paymentRef.id,
      String(preflightBill.landlordId ?? ""),
    );
    const notificationRef = db
      .collection("notifications")
      .doc(notification.notificationId);
    const deliveryRef = db
      .collection("notificationDeliveries")
      .doc(notification.notificationId);

    return db.runTransaction(async (transaction) => {
      const [
        paymentSnapshot,
        billSnapshot,
        intentSnapshot,
        utrClaimSnapshot,
        notificationSnapshot,
        deliverySnapshot,
      ] = await Promise.all([
        transaction.get(paymentRef),
        transaction.get(billRef),
        transaction.get(intentRef),
        transaction.get(utrClaimRef),
        transaction.get(notificationRef),
        transaction.get(deliveryRef),
      ]);

      if (paymentSnapshot.exists) {
        if (
          intentSnapshot.exists &&
          retryMatches(paymentSnapshot.data()!, intentSnapshot.data()!)
        ) {
          return {
            success: true,
            paymentId: paymentRef.id,
            status: "pending_verification" as const,
          };
        }
        throw new HttpsError(
          "already-exists",
          "The payment idempotency key was already used for " +
            "a different submission.",
        );
      }
      if (!billSnapshot.exists) {
        throw new HttpsError("not-found", "Rent charge not found.");
      }
      if (!intentSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "Payment proof upload intent not found.",
        );
      }

      const bill = billSnapshot.data()!;
      const intent = intentSnapshot.data()!;
      if (bill.tenantId !== validated.uid) {
        throw new HttpsError(
          "permission-denied",
          "This rent charge does not belong to the authenticated tenant.",
        );
      }
      if (!["due", "overdue"].includes(bill.status)) {
        throw new HttpsError(
          "failed-precondition",
          "Only a due or overdue rent charge can accept payment.",
        );
      }
      if (
        intent.tenantId !== validated.uid ||
        intent.rentChargeId !== validated.rentChargeId
      ) {
        throw new HttpsError(
          "permission-denied",
          "The upload intent does not belong to this tenant and rent charge.",
        );
      }
      if (intent.status !== "issued") {
        throw new HttpsError(
          "failed-precondition",
          "The payment proof upload intent is expired or unavailable.",
        );
      }
      const transactionTime = now();
      const finalAsset = validateAsset(intent, transactionTime);
      const activeUploadClaim =
        typeof intent.uploadClaimId === "string" &&
        intent.uploadClaimExpiresAt instanceof Timestamp &&
        intent.uploadClaimExpiresAt.toMillis() > transactionTime;
      if (activeUploadClaim) {
        throw new HttpsError(
          "failed-precondition",
          "Payment proof upload is still in progress.",
        );
      }
      if (utrClaimSnapshot.exists) {
        throw new HttpsError(
          "already-exists",
          "This UTR/reference has already been used for this rent charge.",
        );
      }
      if (notificationSnapshot.exists || deliverySnapshot.exists) {
        throw new HttpsError(
          "internal",
          "Payment notification records already exist without their payment.",
        );
      }

      const tenantRef = db.collection("users").doc(validated.uid);
      const [tenantSnapshot, leaseSnapshot, propertySnapshot] =
        await Promise.all([
          transaction.get(tenantRef),
          typeof bill.leaseId === "string" ?
            transaction.get(db.collection("leases").doc(bill.leaseId)) :
            Promise.resolve(null),
          typeof bill.propertyId === "string" ?
            transaction.get(db.collection("properties").doc(bill.propertyId)) :
            Promise.resolve(null),
        ]);
      if (!tenantSnapshot.exists || tenantSnapshot.get("role") !== "tenant") {
        throw new HttpsError(
          "failed-precondition",
          "Tenant profile must be onboarded before submitting payment.",
        );
      }
      if (
        !leaseSnapshot?.exists ||
        !propertySnapshot?.exists ||
        typeof bill.leaseId !== "string" ||
        typeof bill.propertyId !== "string" ||
        typeof bill.landlordId !== "string" ||
        typeof bill.unitId !== "string"
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Rent charge ownership data is incomplete.",
        );
      }
      const lease = leaseSnapshot.data()!;
      const property = propertySnapshot.data()!;
      if (
        lease.tenantId !== validated.uid ||
        lease.landlordId !== bill.landlordId ||
        lease.propertyId !== bill.propertyId ||
        lease.unitId !== bill.unitId ||
        !["active", "ended"].includes(lease.status)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Rent charge lease ownership is inconsistent.",
        );
      }
      if (
        property.landlordId !== bill.landlordId ||
        !isValidUpiConfiguration(property)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "The property has no valid UPI payment configuration.",
        );
      }
      const subtotal = bill.subtotal;
      const lateFineTotal = bill.lateFineTotal;
      const adjustmentTotal = bill.adjustmentTotal;
      const amountDue = bill.total;
      const calculatedTotal = subtotal + lateFineTotal + adjustmentTotal;
      if (
        !Number.isSafeInteger(subtotal) ||
        !Number.isSafeInteger(lateFineTotal) ||
        !Number.isSafeInteger(adjustmentTotal) ||
        !Number.isSafeInteger(amountDue) ||
        !Number.isSafeInteger(calculatedTotal) ||
        amountDue !== calculatedTotal
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Rent charge financial totals are invalid.",
        );
      }
      if (amountDue <= 0) {
        throw new HttpsError(
          "failed-precondition",
          "Rent charge total must be positive to accept payment.",
        );
      }

      const proof = {
        provider: "cloudinary",
        publicId: asset.publicId,
        secureUrl: asset.secureUrl,
        resourceType: "image",
        format: finalAsset.format,
        bytes: asset.bytes,
        uploadedAt: finalAsset.uploadedAt,
      };
      transaction.create(paymentRef, {
        rentChargeId: validated.rentChargeId,
        leaseId: bill.leaseId,
        tenantId: validated.uid,
        landlordId: bill.landlordId,
        propertyId: bill.propertyId,
        unitId: bill.unitId,
        method: "upi_qr",
        amountDue,
        gatewayFee: 0,
        totalPaid: amountDue,
        status: "pending_verification",
        proof,
        transactionRef: validated.transactionRef,
        upiIdSnapshot: property.upiId,
        upiDisplayNameSnapshot: property.upiDisplayName,
        idempotencyKey: validated.idempotencyKey,
        submittedAt: FieldValue.serverTimestamp(),
        proofCleanup: {status: "not_requested"},
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(intentRef, {
        status: "consumed",
        consumedByPaymentId: paymentRef.id,
        uploadClaimId: FieldValue.delete(),
        uploadClaimExpiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.create(utrClaimRef, {
        paymentId: paymentRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(billRef, {
        status: "payment_pending",
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.create(notificationRef, notification.notification);
      transaction.create(deliveryRef, notification.delivery);
      return {
        success: true,
        paymentId: paymentRef.id,
        status: "pending_verification" as const,
      };
    });
  }

  /**
   * Atomically approves or rejects a landlord-owned UPI payment.
   * @param {?string} uid Authenticated landlord ID
   * @param {unknown} role Firebase role claim
   * @param {unknown} input Callable decision payload
   * @return {Promise<object>} Decision result
   */
  async function verify(
    uid: string | undefined,
    role: unknown,
    input: unknown,
  ): Promise<{
    success: true;
    paymentId: string;
    decision: "accept" | "reject";
    rentChargeStatus: "paid" | "due" | "overdue";
  }> {
    const validated = validatePaymentDecision(uid, role, input);
    const paymentRef = db
      .collection(paymentCollection)
      .doc(validated.paymentId);

    return db.runTransaction(async (transaction) => {
      const paymentSnapshot = await transaction.get(paymentRef);
      if (!paymentSnapshot.exists) {
        throw new HttpsError("not-found", "Payment not found.");
      }
      const payment = paymentSnapshot.data()!;
      if (payment.landlordId !== validated.uid) {
        throw new HttpsError(
          "permission-denied",
          "Only the owning landlord can review this payment.",
        );
      }
      const rentChargeId = payment.rentChargeId;
      if (typeof rentChargeId !== "string" || !rentChargeId) {
        throw new HttpsError(
          "failed-precondition",
          "Payment ownership data is incomplete.",
        );
      }
      const billRef = db.collection("rentCharges").doc(rentChargeId);
      const billSnapshot = await transaction.get(billRef);
      if (!billSnapshot.exists) {
        throw new HttpsError(
          "failed-precondition",
          "The payment's linked rent charge is unavailable.",
        );
      }
      const bill = billSnapshot.data()!;
      const tenantId = bill.tenantId;
      const landlordId = bill.landlordId;
      const leaseId = bill.leaseId;
      const propertyId = bill.propertyId;
      const unitId = bill.unitId;
      if (
        typeof tenantId !== "string" ||
        typeof landlordId !== "string" ||
        typeof leaseId !== "string" ||
        typeof propertyId !== "string" ||
        typeof unitId !== "string"
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Rent charge ownership data is incomplete.",
        );
      }

      const leaseRef = db.collection("leases").doc(leaseId);
      const propertyRef = db.collection("properties").doc(propertyId);
      const unitRef = db.collection("units").doc(unitId);
      const tenantRef = db.collection("users").doc(tenantId);
      const landlordRef = db.collection("users").doc(landlordId);
      const notification = validated.decision === "accept" ?
        createPaymentAcceptedNotification(validated.paymentId, tenantId) :
        createPaymentRejectedNotification(
          validated.paymentId,
          tenantId,
          validated.rejectionReason!,
          validated.rejectionExplanation,
        );
      const notificationRef = db
        .collection("notifications")
        .doc(notification.notificationId);
      const deliveryRef = db
        .collection("notificationDeliveries")
        .doc(notification.notificationId);
      const cleanupRef = db
        .collection(cleanupCollection)
        .doc(validated.paymentId);
      const [
        leaseSnapshot,
        propertySnapshot,
        unitSnapshot,
        tenantSnapshot,
        landlordSnapshot,
        notificationSnapshot,
        deliverySnapshot,
        cleanupSnapshot,
      ] = await Promise.all([
        transaction.get(leaseRef),
        transaction.get(propertyRef),
        transaction.get(unitRef),
        transaction.get(tenantRef),
        transaction.get(landlordRef),
        transaction.get(notificationRef),
        transaction.get(deliveryRef),
        transaction.get(cleanupRef),
      ]);
      if (
        !leaseSnapshot.exists ||
        !propertySnapshot.exists ||
        !unitSnapshot.exists ||
        !tenantSnapshot.exists ||
        !landlordSnapshot.exists
      ) {
        throw new HttpsError(
          "failed-precondition",
          "A linked payment ownership record is unavailable.",
        );
      }

      const lease = leaseSnapshot.data()!;
      const property = propertySnapshot.data()!;
      const unit = unitSnapshot.data()!;
      const paymentIdsMatch =
        payment.idempotencyKey === paymentSnapshot.id &&
        payment.rentChargeId === rentChargeId &&
        payment.tenantId === tenantId &&
        payment.landlordId === landlordId &&
        payment.leaseId === leaseId &&
        payment.propertyId === propertyId &&
        payment.unitId === unitId;
      const billIdsMatch =
        bill.tenantId === tenantId &&
        bill.landlordId === landlordId &&
        bill.leaseId === leaseId &&
        bill.propertyId === propertyId &&
        bill.unitId === unitId;
      const leaseMatches =
        lease.tenantId === tenantId &&
        lease.landlordId === landlordId &&
        lease.propertyId === propertyId &&
        lease.unitId === unitId &&
        ["active", "ended"].includes(lease.status);
      const propertyMatches = property.landlordId === landlordId;
      const unitMatches =
        unit.propertyId === propertyId && unit.landlordId === landlordId;
      const callerOwnsProperty =
        landlordId === validated.uid &&
        property.landlordId === validated.uid &&
        landlordSnapshot.get("role") === "landlord";
      if (!callerOwnsProperty) {
        throw new HttpsError(
          "permission-denied",
          "Only the landlord who owns this property's payment can review it.",
        );
      }
      if (
        tenantSnapshot.get("role") !== "tenant" ||
        (tenantSnapshot.get("uid") !== undefined &&
          tenantSnapshot.get("uid") !== tenantId) ||
        (landlordSnapshot.get("uid") !== undefined &&
          landlordSnapshot.get("uid") !== landlordId) ||
        !paymentIdsMatch ||
        !billIdsMatch ||
        !leaseMatches ||
        !propertyMatches ||
        !unitMatches
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Payment, rent charge, lease, property, unit, or user ownership " +
            "records are inconsistent.",
        );
      }

      let currentUnitLease:
        | FirebaseFirestore.DocumentSnapshot
        | undefined;
      if (lease.status === "active") {
        if (
          unit.status !== "occupied" ||
          unit.currentLeaseId !== leaseId
        ) {
          throw new HttpsError(
            "failed-precondition",
            "The unit's current lease does not match the payment lease.",
          );
        }
      } else {
        if (unit.currentLeaseId === leaseId) {
          throw new HttpsError(
            "failed-precondition",
            "An ended lease cannot remain the unit's current lease.",
          );
        }
        if (unit.status === "vacant") {
          if (
            unit.currentLeaseId !== undefined &&
            unit.currentLeaseId !== null
          ) {
            throw new HttpsError(
              "failed-precondition",
              "Vacant unit has an inconsistent current lease.",
            );
          }
        } else if (
          unit.status === "occupied" &&
          typeof unit.currentLeaseId === "string" &&
          unit.currentLeaseId.length > 0
        ) {
          currentUnitLease = await transaction.get(
            db.collection("leases").doc(unit.currentLeaseId),
          );
          if (!currentUnitLease.exists) {
            throw new HttpsError(
              "failed-precondition",
              "The unit's current lease is unavailable.",
            );
          }
          const currentLease = currentUnitLease.data()!;
          if (
            currentLease.status !== "active" ||
            currentLease.propertyId !== propertyId ||
            currentLease.landlordId !== landlordId ||
            currentLease.unitId !== unitId ||
            typeof currentLease.tenantId !== "string"
          ) {
            throw new HttpsError(
              "failed-precondition",
              "The unit's current lease is inconsistent.",
            );
          }
        } else {
          throw new HttpsError(
            "failed-precondition",
            "The ended lease's unit state is inconsistent.",
          );
        }
      }

      const proof = payment.proof;
      if (
        payment.method !== "upi_qr" ||
        !isRecord(proof) ||
        proof.provider !== "cloudinary" ||
        typeof proof.publicId !== "string" ||
        proof.publicId.length === 0 ||
        typeof proof.secureUrl !== "string" ||
        !proof.secureUrl.startsWith("https://") ||
        proof.resourceType !== "image" ||
        !normalizeFormat(proof.format) ||
        !Number.isSafeInteger(proof.bytes) ||
        (proof.bytes as number) < 1 ||
        (proof.bytes as number) > paymentProofMaxBytes ||
        !(proof.uploadedAt instanceof Timestamp) ||
        !Number.isSafeInteger(payment.amountDue) ||
        payment.amountDue !== bill.total ||
        payment.gatewayFee !== 0 ||
        payment.totalPaid !== payment.amountDue
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Payment proof or amount metadata is invalid.",
        );
      }

      const status = payment.status;
      const resolved = status === "verified" || status === "rejected";
      if (status !== "pending_verification" && !resolved) {
        throw new HttpsError(
          "failed-precondition",
          "Only pending UPI payments can be reviewed.",
        );
      }
      if (
        (status === "pending_verification" &&
          (bill.status !== "payment_pending" ||
            payment.proofCleanup?.status !== "not_requested")) ||
        (status === "verified" &&
          (bill.status !== "paid" ||
            payment.proofCleanup?.status !== "retained")) ||
        (status === "rejected" &&
          !["due", "overdue"].includes(bill.status))
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Payment and rent charge statuses are inconsistent.",
        );
      }

      if (resolved) {
        const sameDecision =
          (status === "verified" && validated.decision === "accept") ||
          (status === "rejected" && validated.decision === "reject");
        if (!sameDecision || payment.reviewedBy !== validated.uid) {
          throw new HttpsError(
            "failed-precondition",
            "This payment has already received a conflicting decision.",
          );
        }
        if (
          status === "rejected" &&
          (payment.rejectionReasonCode !== validated.rejectionReasonCode ||
            payment.rejectionReason !== validated.rejectionReason ||
            payment.rejectionExplanation !== validated.rejectionExplanation)
        ) {
          throw new HttpsError(
            "failed-precondition",
            "The retry does not match the original rejection decision.",
          );
        }
        if (!notificationSnapshot.exists || !deliverySnapshot.exists) {
          throw new HttpsError(
            "internal",
            "Payment decision notification records are incomplete.",
          );
        }
        if (status === "verified" && cleanupSnapshot.exists) {
          throw new HttpsError(
            "internal",
            "Verified payment has an unexpected proof cleanup task.",
          );
        }
        if (status === "rejected") {
          const cleanup = cleanupSnapshot.data()!;
          if (
            !cleanupSnapshot.exists ||
            cleanup.sourceType !== "rejected_payment" ||
            cleanup.paymentId !== validated.paymentId ||
            cleanup.publicId !== proof.publicId ||
            cleanup.folder !== paymentProofFolder ||
            cleanup.resourceType !== "image"
          ) {
            throw new HttpsError(
              "internal",
              "Rejected payment proof cleanup is missing or inconsistent.",
            );
          }
        }
        return {
          success: true,
          paymentId: validated.paymentId,
          decision: validated.decision,
          rentChargeStatus: bill.status as "paid" | "due" | "overdue",
        };
      }

      if (
        payment.reviewedAt !== undefined ||
        payment.reviewedBy !== undefined ||
        payment.rejectionReasonCode !== undefined ||
        payment.rejectionReason !== undefined ||
        payment.rejectionExplanation !== undefined ||
        notificationSnapshot.exists ||
        deliverySnapshot.exists ||
        cleanupSnapshot.exists
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Pending payment contains prior decision records.",
        );
      }

      const currentTime = now();
      const rentChargeStatus = validated.decision === "accept" ?
        "paid" as const :
        (() => {
          if (
            typeof bill.dueDate !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(bill.dueDate)
          ) {
            throw new HttpsError(
              "failed-precondition",
              "Rent charge dueDate is invalid.",
            );
          }
          const parsedDueDate = new Date(`${bill.dueDate}T00:00:00.000Z`);
          if (
            !Number.isFinite(parsedDueDate.getTime()) ||
            parsedDueDate.toISOString().slice(0, 10) !== bill.dueDate
          ) {
            throw new HttpsError(
              "failed-precondition",
              "Rent charge dueDate is invalid.",
            );
          }
          const today = new Date(currentTime).toISOString().slice(0, 10);
          return bill.dueDate < today ? "overdue" as const : "due" as const;
        })();

      if (validated.decision === "accept") {
        const approvalUpdate: Record<string, unknown> = {
          status: "verified",
          reviewedAt: FieldValue.serverTimestamp(),
          reviewedBy: validated.uid,
          updatedAt: FieldValue.serverTimestamp(),
        };
        approvalUpdate["proofCleanup.status"] = "retained";
        transaction.update(paymentRef, approvalUpdate);
        transaction.update(billRef, {
          status: rentChargeStatus,
          paidAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        const rejectionUpdate: Record<string, unknown> = {
          status: "rejected",
          reviewedAt: FieldValue.serverTimestamp(),
          reviewedBy: validated.uid,
          rejectionReasonCode: validated.rejectionReasonCode,
          rejectionReason: validated.rejectionReason,
          updatedAt: FieldValue.serverTimestamp(),
        };
        rejectionUpdate["proofCleanup.status"] = "pending";
        rejectionUpdate["proofCleanup.requestedAt"] =
          FieldValue.serverTimestamp();
        if (validated.rejectionExplanation !== undefined) {
          rejectionUpdate.rejectionExplanation =
            validated.rejectionExplanation;
        } else {
          rejectionUpdate.rejectionExplanation = FieldValue.delete();
        }
        transaction.update(paymentRef, rejectionUpdate);
        transaction.update(billRef, {
          status: rentChargeStatus,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.create(cleanupRef, {
          sourceType: "rejected_payment",
          paymentId: validated.paymentId,
          publicId: proof.publicId,
          folder: paymentProofFolder,
          resourceType: "image",
          status: "pending",
          attempts: 0,
          manualRetryCount: 0,
          errorHistory: [],
          nextAttemptAt: Timestamp.fromMillis(currentTime),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      transaction.create(notificationRef, notification.notification);
      transaction.create(deliveryRef, notification.delivery);
      return {
        success: true,
        paymentId: validated.paymentId,
        decision: validated.decision,
        rentChargeStatus,
      };
    });
  }

  /**
   * Validates the opaque bearer token and stores the image in Cloudinary.
   * @param {?string} token Scoped upload token
   * @param {Buffer} bytes Raw uploaded image bytes
   * @param {?string} contentType Declared HTTP image MIME type
   * @return {Promise<object>} Upload completion acknowledgement
   */
  async function upload(
    token: string | undefined,
    bytes: Buffer,
    contentType?: string,
  ): Promise<{ success: true; uploadIntentId: string }> {
    if (!tokenSecret) {
      throw uploadError(503, "Proof upload is not configured.");
    }
    if (!cloudinary) {
      throw uploadError(503, "Proof upload is not configured.");
    }
    const payload = decryptUploadToken(token, tokenSecret);
    const currentTime = now();
    if (!payload || payload.expiresAt <= currentTime) {
      throw uploadError(401, "The upload token is invalid or expired.");
    }
    if (!Buffer.isBuffer(bytes) || bytes.length < 1) {
      throw uploadError(400, "A non-empty image body is required.");
    }
    if (bytes.length > paymentProofMaxBytes) {
      throw uploadError(413, "Proof image exceeds 5,000,000 bytes.");
    }
    const actualFormat = identifyImageFormat(bytes);
    if (!actualFormat) {
      throw uploadError(415, "Proof content is not a supported image format.");
    }
    if (
      contentType !== undefined &&
      contentType.trim().toLowerCase().split(";")[0] !==
        imageMimeTypes[actualFormat]
    ) {
      throw uploadError(415, "Content-Type does not match the uploaded image.");
    }

    const intentRef = db.collection(intentCollection).doc(payload.intentId);
    const uploadClaimId = randomUUID();
    const intent = await db.runTransaction(async (transaction) => {
      const intentSnapshot = await transaction.get(intentRef);
      if (!intentSnapshot.exists) {
        throw uploadError(404, "Upload intent not found.");
      }
      const currentIntent = intentSnapshot.data()!;
      const claimTime = now();
      if (
        currentIntent.tenantId !== payload.uid ||
        currentIntent.status !== "issued" ||
        currentIntent.folder !== paymentProofFolder ||
        currentIntent.resourceType !== "image"
      ) {
        throw uploadError(
          409,
          "Upload intent is invalid or no longer available.",
        );
      }
      if (
        !(currentIntent.expiresAt instanceof Timestamp) ||
        currentIntent.expiresAt.toMillis() <= claimTime
      ) {
        throw uploadError(410, "The upload intent expired.");
      }
      if (
        !(currentIntent.uploadPermissionExpiresAt instanceof Timestamp) ||
        currentIntent.uploadPermissionExpiresAt.toMillis() !==
          payload.expiresAt ||
        currentIntent.uploadPermissionExpiresAt.toMillis() <= claimTime
      ) {
        throw uploadError(
          401,
          "The upload permission expired or was replaced.",
        );
      }
      if (!formatMatches(String(currentIntent.expectedFormat), actualFormat)) {
        throw uploadError(
          415,
          "Image content does not match the authorized format.",
        );
      }
      if (currentIntent.expectedBytes !== bytes.length) {
        throw uploadError(
          400,
          "Image size does not match the authorized size.",
        );
      }
      if (
        typeof currentIntent.publicId !== "string" ||
        currentIntent.folder !== paymentProofFolder
      ) {
        throw uploadError(
          409,
          "Upload intent has invalid asset configuration.",
        );
      }
      const activeClaim =
        currentIntent.uploadClaimId !== undefined &&
        currentIntent.uploadClaimExpiresAt instanceof Timestamp &&
        currentIntent.uploadClaimExpiresAt.toMillis() > claimTime;
      if (activeClaim) {
        throw uploadError(409, "An upload is already in progress.");
      }
      transaction.update(intentRef, {
        uploadClaimId,
        uploadClaimExpiresAt: Timestamp.fromMillis(
          claimTime + paymentUploadClaimLeaseMs,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return currentIntent;
    });

    let asset: CloudinaryAsset;
    try {
      asset = await cloudinary.upload(
        bytes,
        actualFormat,
        intent.publicId,
        intent.folder,
      );
    } catch (error) {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(intentRef);
        if (
          snapshot.exists &&
          snapshot.get("uploadClaimId") === uploadClaimId
        ) {
          transaction.update(intentRef, {
            uploadClaimId: FieldValue.delete(),
            uploadClaimExpiresAt: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      });
      if (error instanceof Error && "status" in error) throw error;
      throw uploadError(502, "Cloudinary could not store the proof image.");
    }
    const createdAtMs = Date.parse(asset.createdAt);
    if (
      asset.publicId !== intent.publicId ||
      asset.folder !== intent.folder ||
      asset.resourceType !== "image" ||
      !formatMatches(actualFormat, asset.format) ||
      asset.bytes !== bytes.length ||
      !asset.secureUrl.startsWith("https://") ||
      !Number.isFinite(createdAtMs)
    ) {
      await enqueueCompensatingCleanup(
        intentRef,
        payload.intentId,
        uploadClaimId,
        intent,
      );
      throw uploadError(
        502,
        "Cloudinary returned inconsistent proof metadata.",
      );
    }
    if (
      createdAtMs > payload.expiresAt ||
      createdAtMs > intent.expiresAt.toMillis()
    ) {
      await enqueueCompensatingCleanup(
        intentRef,
        payload.intentId,
        uploadClaimId,
        intent,
      );
      throw uploadError(410, "The upload intent expired during upload.");
    }

    const completed = await db.runTransaction(async (transaction) => {
      const current = await transaction.get(intentRef);
      if (!current.exists) return "invalid";
      const currentIntent = current.data()!;
      if (currentIntent.consumedByPaymentId) {
        if (currentIntent.uploadClaimId === uploadClaimId) {
          transaction.update(intentRef, {
            uploadClaimId: FieldValue.delete(),
            uploadClaimExpiresAt: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        return "consumed";
      }
      const claimMatches = currentIntent.uploadClaimId === uploadClaimId;
      const expiry = currentIntent.expiresAt;
      const permissionExpiry = currentIntent.uploadPermissionExpiresAt;
      if (
        claimMatches &&
        currentIntent.status === "issued" &&
        expiry instanceof Timestamp &&
        expiry.toMillis() > now() &&
        permissionExpiry instanceof Timestamp &&
        permissionExpiry.toMillis() === payload.expiresAt &&
        createdAtMs <= expiry.toMillis()
      ) {
        transaction.update(intentRef, {
          uploadClaimId: FieldValue.delete(),
          uploadClaimExpiresAt: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return "completed";
      }
      return "invalid";
    });
    if (completed === "invalid") {
      await enqueueCompensatingCleanup(
        intentRef,
        payload.intentId,
        uploadClaimId,
        intent,
      );
      throw uploadError(410, "The upload intent expired during upload.");
    }
    return {success: true, uploadIntentId: payload.intentId};
  }

  /**
   * Queues deletion if an uploaded asset cannot remain attached to its intent.
   * @param {DocumentReference} intentRef Intent document reference
   * @param {string} intentId Upload intent ID
   * @param {string} uploadClaimId Active upload claim ID
   * @param {Record<string, unknown>} originalIntent Claimed intent data
   * @return {Promise<void>} Resolves after the claim and cleanup task commit
   */
  async function enqueueCompensatingCleanup(
    intentRef: DocumentReference,
    intentId: string,
    uploadClaimId: string,
    originalIntent: Record<string, unknown>,
  ): Promise<void> {
    const taskRef = db.collection(cleanupCollection).doc(`upload_${intentId}`);
    await db.runTransaction(async (transaction) => {
      const [intentSnapshot, taskSnapshot] = await Promise.all([
        transaction.get(intentRef),
        transaction.get(taskRef),
      ]);
      if (!intentSnapshot.exists) return;
      const currentIntent = intentSnapshot.data()!;
      if (
        currentIntent.consumedByPaymentId ||
        currentIntent.status === "consumed"
      ) {
        if (currentIntent.uploadClaimId === uploadClaimId) {
          transaction.update(intentRef, {
            uploadClaimId: FieldValue.delete(),
            uploadClaimExpiresAt: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        return;
      }
      if (
        typeof originalIntent.publicId !== "string" ||
        originalIntent.folder !== paymentProofFolder
      ) {
        throw new Error("Cannot queue cleanup for invalid proof metadata.");
      }
      const taskData = {
        sourceType: "expired_upload_intent",
        uploadIntentId: intentId,
        publicId: originalIntent.publicId,
        folder: paymentProofFolder,
        resourceType: "image",
        status: "pending",
        attempts: 0,
        manualRetryCount: Number.isSafeInteger(
          taskSnapshot.get("manualRetryCount"),
        ) ?
          taskSnapshot.get("manualRetryCount") :
          0,
        errorHistory: Array.isArray(taskSnapshot.get("errorHistory")) ?
          taskSnapshot.get("errorHistory") :
          [],
        nextAttemptAt: Timestamp.fromMillis(now()),
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.update(intentRef, {
        status: "cleanup_pending",
        uploadClaimId: FieldValue.delete(),
        uploadClaimExpiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (taskSnapshot.exists) {
        transaction.update(taskRef, {
          ...taskData,
          completedAt: FieldValue.delete(),
          claimedBy: FieldValue.delete(),
          claimExpiresAt: FieldValue.delete(),
        });
      } else {
        transaction.create(taskRef, {
          ...taskData,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    });
  }

  /**
   * Enqueues expired intents after transactionally moving them to cleanup.
   * @return {Promise<void>} Resolves after all selected intents are processed
   */
  async function createExpiredIntentCleanupTasks(): Promise<void> {
    const current = Timestamp.fromMillis(now());
    const expired = await db
      .collection(intentCollection)
      .where("status", "==", "issued")
      .where("expiresAt", "<=", current)
      .limit(100)
      .get();
    for (const candidate of expired.docs) {
      const intentRef = candidate.ref;
      const taskRef = db
        .collection(cleanupCollection)
        .doc(`upload_${candidate.id}`);
      await db.runTransaction(async (transaction) => {
        const [intentSnapshot, taskSnapshot] = await Promise.all([
          transaction.get(intentRef),
          transaction.get(taskRef),
        ]);
        if (!intentSnapshot.exists || taskSnapshot.exists) return;
        const intent = intentSnapshot.data()!;
        const expiry = intent.expiresAt;
        if (
          intent.status !== "issued" ||
          !(expiry instanceof Timestamp) ||
          expiry.toMillis() > now()
        ) {
          return;
        }
        if (
          intent.uploadClaimExpiresAt instanceof Timestamp &&
          intent.uploadClaimExpiresAt.toMillis() > now()
        ) {
          return;
        }
        if (
          typeof intent.publicId !== "string" ||
          typeof intent.folder !== "string"
        ) {
          throw new Error(
            `Upload intent ${candidate.id} has invalid asset metadata.`,
          );
        }
        transaction.update(intentRef, {
          status: "cleanup_pending",
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.create(taskRef, {
          sourceType: "expired_upload_intent",
          uploadIntentId: candidate.id,
          publicId: intent.publicId,
          folder: intent.folder,
          resourceType: "image",
          status: "pending",
          attempts: 0,
          manualRetryCount: 0,
          errorHistory: [],
          nextAttemptAt: Timestamp.fromMillis(now()),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
    }
  }

  /**
   * Claims one due task and validates its source record transactionally.
   * @param {string} taskId Cleanup outbox document ID
   * @return {Promise<?CleanupClaim>} Claim details, or null if not due
   */
  async function claimCleanupTask(
    taskId: string,
  ): Promise<CleanupClaim | null> {
    const taskRef = db.collection(cleanupCollection).doc(taskId);
    const currentTime = now();
    return db.runTransaction(async (transaction) => {
      const taskSnapshot = await transaction.get(taskRef);
      if (!taskSnapshot.exists) return null;
      const task = taskSnapshot.data()!;
      const isDue =
        task.status === "pending" &&
        task.nextAttemptAt instanceof Timestamp &&
        task.nextAttemptAt.toMillis() <= currentTime;
      const leaseExpired =
        task.status === "processing" &&
        task.claimExpiresAt instanceof Timestamp &&
        task.claimExpiresAt.toMillis() <= currentTime;
      if (!isDue && !leaseExpired) return null;
      const attempts = Number.isSafeInteger(task.attempts) ?
        (task.attempts as number) :
        0;
      const sourceType = task.sourceType;
      if (
        sourceType !== "expired_upload_intent" &&
        sourceType !== "rejected_payment"
      ) {
        throw new Error(`Cleanup task ${taskId} has an invalid source type.`);
      }
      if (
        sourceType === "rejected_payment" &&
        task.paymentId !== taskId
      ) {
        transaction.update(taskRef, {
          status: "terminal_failure",
          lastError: "Cleanup task payment ID does not match its document ID.",
          claimExpiresAt: FieldValue.delete(),
          claimedBy: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return null;
      }
      const claimedBy = randomUUID();
      const claim: CleanupClaim = {
        taskId,
        attempts: attempts + 1,
        claimedBy,
        publicId: String(task.publicId),
        folder: String(task.folder),
        resourceType: "image",
        sourceType,
        uploadIntentId:
          typeof task.uploadIntentId === "string" ?
            task.uploadIntentId :
            undefined,
        paymentId:
          typeof task.paymentId === "string" ? task.paymentId : undefined,
      };
      if (!claim.publicId || claim.folder !== paymentProofFolder) {
        throw new Error(`Cleanup task ${taskId} has invalid asset metadata.`);
      }
      if (
        (sourceType === "expired_upload_intent" && !claim.uploadIntentId) ||
        (sourceType === "rejected_payment" && !claim.paymentId)
      ) {
        throw new Error(
          `Cleanup task ${taskId} is missing its source record ID.`,
        );
      }
      const sourceRef =
        sourceType === "expired_upload_intent" ?
          db.collection(intentCollection).doc(claim.uploadIntentId!) :
          db.collection(paymentCollection).doc(claim.paymentId!);
      const sourceSnapshot = await transaction.get(sourceRef);
      if (!sourceSnapshot.exists) {
        if (sourceType === "rejected_payment") {
          transaction.update(taskRef, {
            status: "terminal_failure",
            lastError: "Rejected payment cleanup source does not exist.",
            claimExpiresAt: FieldValue.delete(),
            claimedBy: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return null;
        }
        throw new Error(`Cleanup task ${taskId} has no source record.`);
      }
      const source = sourceSnapshot.data()!;
      const sourceProof = sourceType === "rejected_payment" ?
        source.proof :
        undefined;
      const sourceCleanupStatus = isRecord(source.proofCleanup) ?
        source.proofCleanup.status :
        undefined;
      const cleanupSourceMatches =
        sourceType === "rejected_payment" ?
          claim.taskId === claim.paymentId &&
            task.paymentId === claim.paymentId &&
            source.status === "rejected" &&
            isRecord(sourceProof) &&
            sourceProof.provider === "cloudinary" &&
            sourceProof.publicId === claim.publicId &&
            sourceProof.resourceType === "image" :
          source.status === "cleanup_pending" ||
            (task.status === "pending" &&
              Number(task.manualRetryCount) > 0 &&
              source.status === "terminal_failure");
      if (
        !cleanupSourceMatches ||
        (sourceType === "expired_upload_intent" &&
          (source.publicId !== claim.publicId ||
            source.folder !== claim.folder ||
            source.resourceType !== "image")) ||
        (sourceType === "rejected_payment" &&
          (sourceCleanupStatus !== "pending" &&
            sourceCleanupStatus !== "processing" &&
            sourceCleanupStatus !== "terminal_failure"))
      ) {
        transaction.update(taskRef, {
          status: "terminal_failure",
          lastError: "Cleanup task does not match its immutable source proof.",
          claimExpiresAt: FieldValue.delete(),
          claimedBy: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (sourceType === "expired_upload_intent") {
          transaction.update(sourceRef, {
            status: "terminal_failure",
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          const sourceUpdate: Record<string, unknown> = {
            updatedAt: FieldValue.serverTimestamp(),
          };
          sourceUpdate["proofCleanup.status"] = "terminal_failure";
          transaction.update(sourceRef, sourceUpdate);
        }
        return null;
      }
      if (
        sourceType === "expired_upload_intent" &&
        source.uploadClaimExpiresAt instanceof Timestamp &&
        source.uploadClaimExpiresAt.toMillis() > currentTime
      ) {
        return null;
      }
      const manualRetry =
        task.status === "pending" &&
        Number(task.manualRetryCount) > 0 &&
        source.status === "terminal_failure";
      if (
        (sourceType === "expired_upload_intent" &&
          source.status !== "cleanup_pending" &&
          !manualRetry) ||
        (sourceType === "rejected_payment" && source.status !== "rejected")
      ) {
        throw new Error(`Cleanup task ${taskId} source is not eligible.`);
      }
      if (attempts >= paymentProofCleanupMaxAttempts) {
        transaction.update(taskRef, {
          status: "terminal_failure",
          lastError: "Automatic cleanup retry limit exhausted.",
          claimExpiresAt: FieldValue.delete(),
          claimedBy: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (sourceType === "expired_upload_intent") {
          transaction.update(sourceRef, {
            status: "terminal_failure",
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          transaction.update(sourceRef, {
            "proofCleanup.status": "terminal_failure",
            "updatedAt": FieldValue.serverTimestamp(),
          });
        }
        return null;
      }
      if (sourceType === "expired_upload_intent" && manualRetry) {
        transaction.update(sourceRef, {
          status: "cleanup_pending",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      transaction.update(taskRef, {
        status: "processing",
        attempts: attempts + 1,
        claimedBy,
        claimExpiresAt: Timestamp.fromMillis(currentTime + 5 * 60 * 1000),
        nextAttemptAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (sourceType === "rejected_payment") {
        transaction.update(sourceRef, {
          "proofCleanup.status": "processing",
          "updatedAt": FieldValue.serverTimestamp(),
        });
      }
      return claim;
    });
  }

  /**
   * Persists cleanup success or retry/terminal failure state.
   * @param {CleanupClaim} claim Claimed cleanup task
   * @param {?Error} error Optional deletion or integrity error
   * @param {boolean} forceTerminal Whether retry must stop immediately
   * @return {Promise<void>} Resolves after the transaction commits
   */
  async function updateCleanupResult(
    claim: CleanupClaim,
    error?: Error,
    forceTerminal = false,
  ): Promise<void> {
    const taskRef = db.collection(cleanupCollection).doc(claim.taskId);
    const sourceRef =
      claim.sourceType === "expired_upload_intent" ?
        db.collection(intentCollection).doc(claim.uploadIntentId!) :
        db.collection(paymentCollection).doc(claim.paymentId!);
    const currentTime = now();
    const failed = error !== undefined;
    const terminal =
      failed &&
      (forceTerminal || claim.attempts >= paymentProofCleanupMaxAttempts);
    const errorEntry = failed ?
      {
        attemptedAt: Timestamp.fromMillis(currentTime),
        attempt: claim.attempts,
        error: error.message.slice(0, 1000),
      } :
      undefined;
    const retryAt =
      failed && !terminal ?
        currentTime +
          paymentProofCleanupBaseBackoffMs * 2 ** (claim.attempts - 1) :
        undefined;

    await db.runTransaction(async (transaction) => {
      const [taskSnapshot, sourceSnapshot] = await Promise.all([
        transaction.get(taskRef),
        transaction.get(sourceRef),
      ]);
      if (
        !taskSnapshot.exists ||
        !sourceSnapshot.exists ||
        taskSnapshot.get("status") !== "processing" ||
        taskSnapshot.get("claimedBy") !== claim.claimedBy
      ) {
        return;
      }
      if (failed) {
        const sourceStatus = terminal ?
          "terminal_failure" :
          claim.sourceType === "expired_upload_intent" ?
            "cleanup_pending" :
            "pending";
        transaction.update(taskRef, {
          status: terminal ? "terminal_failure" : "pending",
          nextAttemptAt: terminal ?
            FieldValue.delete() :
            Timestamp.fromMillis(retryAt!),
          claimExpiresAt: FieldValue.delete(),
          claimedBy: FieldValue.delete(),
          lastError: errorEntry!.error,
          errorHistory: FieldValue.arrayUnion(errorEntry),
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (claim.sourceType === "expired_upload_intent") {
          transaction.update(sourceRef, {
            status: sourceStatus,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          transaction.update(sourceRef, {
            "proofCleanup.status": sourceStatus,
            "updatedAt": FieldValue.serverTimestamp(),
          });
        }
        return;
      }
      transaction.update(taskRef, {
        status: "completed",
        claimExpiresAt: FieldValue.delete(),
        claimedBy: FieldValue.delete(),
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (claim.sourceType === "expired_upload_intent") {
        transaction.update(sourceRef, {
          status: "cleaned",
          cleanedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        transaction.update(sourceRef, {
          "proofCleanup.status": "deleted",
          "proofCleanup.completedAt": FieldValue.serverTimestamp(),
          "updatedAt": FieldValue.serverTimestamp(),
        });
      }
    });
  }

  /**
   * Verifies that proof is not retained by a verified payment, then deletes it.
   * @param {string} taskId Cleanup outbox document ID
   * @return {Promise<void>} Resolves after task processing
   */
  async function processCleanupTask(taskId: string): Promise<void> {
    if (!cloudinary) {
      throw new Error("Cloudinary cleanup is not configured.");
    }
    const claim = await claimCleanupTask(taskId);
    if (!claim) return;

    try {
      const matchingPayments = await db
        .collection(paymentCollection)
        .where("proof.publicId", "==", claim.publicId)
        .get();
      const unsafeReference = matchingPayments.docs.some((payment) =>
        payment.get("status") === "verified" ||
        (claim.sourceType === "rejected_payment" ?
          payment.id !== claim.paymentId :
          true),
      );
      if (unsafeReference) {
        await updateCleanupResult(
          claim,
          new Error(
            "Deletion prohibited: proof is verified or belongs to another " +
              "payment.",
          ),
          true,
        );
        return;
      }
      await cloudinary.delete(claim.publicId, claim.folder);
      await updateCleanupResult(claim);
    } catch (error) {
      const cleanupError =
        error instanceof Error ?
          error :
          new Error("Cloudinary deletion failed with an unknown error.");
      await updateCleanupResult(claim, cleanupError);
    }
  }

  /**
   * Finds expired intents and due cleanup tasks for this scheduled run.
   * @return {Promise<void>} Resolves after selected tasks are processed
   */
  async function recoverCleanup(): Promise<void> {
    await createExpiredIntentCleanupTasks();
    const current = Timestamp.fromMillis(now());
    const pending = await db
      .collection(cleanupCollection)
      .where("status", "==", "pending")
      .where("nextAttemptAt", "<=", current)
      .limit(100)
      .get();
    const expiredClaims = await db
      .collection(cleanupCollection)
      .where("status", "==", "processing")
      .where("claimExpiresAt", "<=", current)
      .limit(100)
      .get();
    const taskIds = new Set([
      ...pending.docs.map((task) => task.id),
      ...expiredClaims.docs.map((task) => task.id),
    ]);
    for (const taskId of taskIds) {
      await processCleanupTask(taskId);
    }
  }

  return {prepare, create, verify, upload, recoverCleanup};
}

/**
 * Creates fixed-account Cloudinary upload and deletion operations.
 * @param {object} options Cloudinary credentials
 * @return {CloudinaryGateway} Server-side Cloudinary adapter
 */
export function createCloudinaryGateway(options: {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}): CloudinaryGateway {
  const {cloudName, apiKey, apiSecret} = options;
  if (!/^[A-Za-z0-9_-]+$/.test(cloudName) || !apiKey || !apiSecret) {
    throw new Error("Cloudinary configuration is incomplete.");
  }
  const authHeader = `Basic ${Buffer.from(
    `${apiKey}:${apiSecret}`,
    "utf8",
  ).toString("base64")}`;

  /**
   * Parses a Cloudinary response and surfaces API failures.
   * @param {Response} response HTTP response
   * @return {Promise<Record<string, unknown>>} Parsed Cloudinary response
   */
  async function parseResponse(
    response: Response,
  ): Promise<Record<string, unknown>> {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `Cloudinary returned an invalid response (${response.status}).`,
      );
    }
    if (!response.ok || !isRecord(parsed)) {
      const message =
        isRecord(parsed) &&
        isRecord(parsed.error) &&
        typeof parsed.error.message === "string" ?
          parsed.error.message :
          `Cloudinary request failed (${response.status}).`;
      throw new Error(message);
    }
    return parsed;
  }

  /**
   * Validates Cloudinary's resource metadata and account-scoped secure URL.
   * @param {Record<string, unknown>} asset Cloudinary resource response
   * @param {string} publicId Expected immutable public ID
   * @param {string} folder Expected fixed proof folder
   * @return {CloudinaryAsset} Verified Cloudinary asset metadata
   */
  function toVerifiedAsset(
    asset: Record<string, unknown>,
    publicId: string,
    folder: string,
  ): CloudinaryAsset {
    const assetFolder = String(asset.asset_folder ?? asset.folder ?? "");
    const secureUrl = String(asset.secure_url ?? "");
    const format = String(asset.format ?? "").toLowerCase();
    let url: URL;
    try {
      url = new URL(secureUrl);
    } catch {
      throw new Error("Cloudinary returned an invalid secure URL.");
    }
    const decodedPath = decodeURIComponent(url.pathname);
    if (
      asset.public_id !== publicId ||
      assetFolder !== folder ||
      asset.resource_type !== "image" ||
      url.protocol !== "https:" ||
      url.hostname !== "res.cloudinary.com" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      !decodedPath.startsWith(`/${cloudName}/image/upload/`) ||
      !decodedPath.endsWith(`/${publicId}.${format}`)
    ) {
      throw new Error("Cloudinary asset does not match the requested proof.");
    }
    return {
      publicId: String(asset.public_id),
      folder: assetFolder,
      resourceType: "image",
      format,
      bytes: Number(asset.bytes),
      secureUrl,
      createdAt: String(asset.created_at ?? ""),
    };
  }

  return {
    async upload(bytes, format, publicId, folder) {
      const form = new FormData();
      form.set(
        "file",
        new Blob([Uint8Array.from(bytes)], {
          type: imageMimeTypes[format],
        }),
        `proof.${format}`,
      );
      form.set("asset_folder", folder);
      form.set("overwrite", "false");
      form.set("public_id", publicId);
      form.set("unique_filename", "false");
      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
        {
          headers: {Authorization: authHeader},
          method: "POST",
          body: form,
        },
      );
      const asset = await parseResponse(response);
      return {
        publicId: String(asset.public_id ?? ""),
        folder: String(asset.asset_folder ?? asset.folder ?? ""),
        resourceType: String(asset.resource_type ?? ""),
        format: String(asset.format ?? ""),
        bytes: Number(asset.bytes),
        secureUrl: String(asset.secure_url ?? ""),
        createdAt: String(asset.created_at ?? ""),
      };
    },
    async get(publicId, folder) {
      const assetUrl =
        `https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload/` +
        encodeURIComponent(publicId);
      const response = await fetch(assetUrl, {
        headers: {Authorization: authHeader},
      });
      if (response.status === 404) return null;
      const asset = await parseResponse(response);
      return toVerifiedAsset(asset, publicId, folder);
    },
    async delete(publicId, folder) {
      const timestamp = Math.floor(Date.now() / 1000);
      const assetUrl =
        `https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload/` +
        encodeURIComponent(publicId);
      const assetResponse = await fetch(assetUrl, {
        headers: {Authorization: authHeader},
      });
      if (assetResponse.status === 404) return;
      const asset = await parseResponse(assetResponse);
      if (
        asset.public_id !== publicId ||
        (asset.asset_folder ?? asset.folder) !== folder ||
        asset.resource_type !== "image"
      ) {
        throw new Error("Cloudinary asset does not match the cleanup task.");
      }
      const form = new URLSearchParams({
        public_id: publicId,
        timestamp: String(timestamp),
      });
      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
        {
          headers: {
            "Authorization": authHeader,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          method: "POST",
          body: form,
        },
      );
      if (response.status === 404) return;
      const result = await parseResponse(response);
      if (result.result === "not found" || result.result === "ok") return;
      throw new Error("Cloudinary did not confirm asset deletion.");
    },
  };
}

/**
 * Maps upload errors to safe HTTP response status and message values.
 * @param {unknown} error Upload error
 * @return {object} HTTP response status and message
 */
export function paymentUploadEndpointStatus(error: unknown): {
  status: number;
  message: string;
} {
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number" &&
    error instanceof Error
  ) {
    return {status: error.status, message: error.message};
  }
  return {status: 500, message: "Proof upload could not be completed."};
}

/**
 * Builds an HTTP handler that rejects invalid headers before reading rawBody.
 * @param {Function} getService Lazily creates the upload service
 * @param {Function} logServerError Server-side error logger
 * @return {Function} HTTP handler
 */
export function createPaymentUploadHttpHandler(
  getService: () => PaymentUploadService,
  logServerError: (error: unknown) => void,
): (
  request: PaymentUploadHttpRequest,
  response: PaymentUploadHttpResponse,
) => Promise<void> {
  return async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    if (request.method !== "POST") {
      response.status(405).json({error: "Only POST is supported."});
      return;
    }

    const rawLength = request.header("content-length");
    if (rawLength !== undefined) {
      if (!/^[0-9]+$/.test(rawLength)) {
        response.status(400).json({error: "Invalid Content-Length."});
        return;
      }
      if (Number(rawLength) > paymentProofMaxBytes) {
        response.status(413).json({
          error: "Proof image exceeds 5,000,000 bytes.",
        });
        return;
      }
    }

    const contentType = request
      .header("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (!contentType || !Object.values(imageMimeTypes).includes(contentType)) {
      response.status(415).json({
        error: "Content-Type must be JPEG, PNG, or WebP.",
      });
      return;
    }

    const bytes = request.rawBody;
    if (!Buffer.isBuffer(bytes)) {
      response
        .status(400)
        .json({error: "A non-empty image body is required."});
      return;
    }
    if (bytes.length > paymentProofMaxBytes) {
      response.status(413).json({
        error: "Proof image exceeds 5,000,000 bytes.",
      });
      return;
    }

    const authorization = request.header("authorization");
    const token = authorization?.startsWith("Bearer ") ?
      authorization.slice("Bearer ".length).trim() :
      undefined;
    try {
      response
        .status(200)
        .json(await getService().upload(token, bytes, contentType));
    } catch (error) {
      const result = paymentUploadEndpointStatus(error);
      if (result.status >= 500) logServerError(error);
      response.status(result.status).json({error: result.message});
    }
  };
}
