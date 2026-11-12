/**
 * Webhook signature helpers.
 * - crc32 of the raw body (PayPal's signed string is
 *   `transmissionId|transmissionTime|webhookId|crc32(rawBody)`).
 * - The MockGateway signs that same string with HMAC-SHA256 so mock-mode
 *   webhooks are verified through exactly the same route code.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

let table: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(data: string | Uint8Array): number {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function signedString(transmissionId: string, transmissionTime: string, webhookId: string, rawBody: string): string {
  return `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody)}`;
}

export const MOCK_WEBHOOK_ID = "MOCK-WEBHOOK-ID";
export const MOCK_AUTH_ALGO = "HMACSHA256";
export const MOCK_CERT_URL = "https://mock.slotline.invalid/cert.pem";

/** Public default HMAC key (it is in the repo, so anyone can forge with it): development and tests only. */
export const DEFAULT_MOCK_WEBHOOK_SECRET = "slotline-mock-webhook-secret";

const g = globalThis as unknown as { __slotlineMockWebhookKey?: string };

/**
 * MOCK_WEBHOOK_SECRET, else the public default. In production the public
 * default is never used: startup refuses it, and as a backstop a random
 * per-process key is used instead (the mock gateway's own echo still
 * verifies, forged deliveries do not).
 */
export function mockWebhookSecret(): string {
  const set = process.env.MOCK_WEBHOOK_SECRET?.trim();
  if (process.env.NODE_ENV !== "production") return set || DEFAULT_MOCK_WEBHOOK_SECRET;
  if (set && set !== DEFAULT_MOCK_WEBHOOK_SECRET) return set;
  g.__slotlineMockWebhookKey ??= randomBytes(32).toString("base64url");
  return g.__slotlineMockWebhookKey;
}

export function mockSign(rawBody: string, transmissionId: string, transmissionTime: string, webhookId = MOCK_WEBHOOK_ID): string {
  return createHmac("sha256", mockWebhookSecret()).update(signedString(transmissionId, transmissionTime, webhookId, rawBody)).digest("base64");
}

export function mockVerify(rawBody: string, transmissionId: string, transmissionTime: string, sig: string, webhookId = MOCK_WEBHOOK_ID): boolean {
  const expected = Buffer.from(mockSign(rawBody, transmissionId, transmissionTime, webhookId));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** Headers a mock-mode "PayPal" would send with `rawBody`. */
export function mockWebhookHeaders(rawBody: string, transmissionId: string, transmissionTime = new Date().toISOString()): Record<string, string> {
  return {
    "content-type": "application/json",
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-time": transmissionTime,
    "paypal-cert-url": MOCK_CERT_URL,
    "paypal-auth-algo": MOCK_AUTH_ALGO,
    "paypal-transmission-sig": mockSign(rawBody, transmissionId, transmissionTime),
  };
}
