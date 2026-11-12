/**
 * Operator authentication: one shared password (OPERATOR_PASSWORD) and a
 * stateless, HMAC-signed session cookie. Route handlers check it through
 * `operatorRoute()` / `requireOperator()` in http.ts; the customer routes
 * (booking, checkout, availability, public config, the PayPal webhook) stay public.
 *
 * Token: `v1.<expiresAtMs>.<nonce>.<sig>`, sig = HMAC-SHA256(key, "v1.<exp>.<nonce>").
 * Key: SESSION_SECRET when set, otherwise scrypt(OPERATOR_PASSWORD), so
 * changing either one signs every session out. Logout clears the cookie and
 * revokes that token for the life of the process.
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AuthMeResponse } from "@/shared/types";
import { isProduction, operatorPassword, sessionSecret } from "./config";

export const SESSION_COOKIE = "slotline_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Failed sign-ins allowed per window (global: behind a tunnel every client has the same address). */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 60_000;

export type AuthMode = AuthMeResponse["mode"];

const g = globalThis as unknown as {
  __slotlineSessionKey?: { from: string; key: Buffer };
  __slotlineRevoked?: Map<string, number>;
  __slotlineLoginFailures?: number[];
  __slotlineSessionEvents?: EventEmitter;
};

function sessionEvents(): EventEmitter {
  if (!g.__slotlineSessionEvents) {
    g.__slotlineSessionEvents = new EventEmitter();
    g.__slotlineSessionEvents.setMaxListeners(0);
  }
  return g.__slotlineSessionEvents;
}

/** Run `fn` when the session with this nonce is revoked (logout in any tab); returns an unsubscribe. */
export function onSessionRevoked(nonce: string, fn: () => void): () => void {
  const ev = sessionEvents();
  ev.once(`revoked:${nonce}`, fn);
  return () => {
    ev.off(`revoked:${nonce}`, fn);
  };
}

/** "password": sign-in required. "open": development without a password. "locked": production without a password (fail closed). */
export function authMode(): AuthMode {
  if (operatorPassword()) return "password";
  return isProduction() ? "locked" : "open";
}

function signingKey(): Buffer | null {
  const secret = sessionSecret();
  const password = operatorPassword();
  if (!secret && !password) return null;
  const from = createHash("sha256").update(secret ? `secret:${secret}` : `password:${password}`).digest("hex");
  if (g.__slotlineSessionKey?.from === from) return g.__slotlineSessionKey.key;
  // scrypt makes an offline guess of a weak password from a stolen cookie expensive.
  const key = secret ? createHash("sha256").update(`slotline-session-v1:${secret}`).digest() : scryptSync(password as string, "slotline-session-v1", 32);
  g.__slotlineSessionKey = { from, key };
  return key;
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function revoked(now = Date.now()): Map<string, number> {
  g.__slotlineRevoked ??= new Map();
  for (const [nonce, exp] of g.__slotlineRevoked) if (exp <= now) g.__slotlineRevoked.delete(nonce);
  return g.__slotlineRevoked;
}

export interface Session {
  nonce: string;
  exp: number;
  expiresAt: string;
}

export function issueSession(now = Date.now()): { token: string; expiresAt: string } | null {
  const key = signingKey();
  if (!key) return null;
  const exp = now + SESSION_TTL_MS;
  const payload = `v1.${exp}.${randomBytes(16).toString("base64url")}`;
  return { token: `${payload}.${sign(key, payload)}`, expiresAt: new Date(exp).toISOString() };
}

export function verifySession(token: string | null | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const key = signingKey();
  if (!key) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^\d{1,16}$/.test(parts[1])) return null;
  const [, expRaw, nonce, sig] = parts;
  const exp = Number(expRaw);
  if (exp <= now) return null;
  const expected = Buffer.from(sign(key, `v1.${expRaw}.${nonce}`));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  if (revoked(now).has(nonce)) return null;
  return { nonce, exp, expiresAt: new Date(exp).toISOString() };
}

export function revokeSession(token: string | null | undefined): boolean {
  const s = verifySession(token);
  if (!s) return false;
  revoked().set(s.nonce, s.exp);
  sessionEvents().emit(`revoked:${s.nonce}`);
  return true;
}

export function readCookie(header: string | null, name = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export function sessionFromRequest(req: Request): Session | null {
  return verifySession(readCookie(req.headers.get("cookie")));
}

function cookieAttributes(maxAgeS: number): string[] {
  return ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeS}`, ...(isProduction() ? ["Secure"] : [])];
}

/** Set-Cookie value: HttpOnly, SameSite=Lax, Secure in production. */
export function sessionCookie(token: string): string {
  return [`${SESSION_COOKIE}=${token}`, ...cookieAttributes(SESSION_TTL_MS / 1000)].join("; ");
}

export function clearSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, ...cookieAttributes(0), "Expires=Thu, 01 Jan 1970 00:00:00 GMT"].join("; ");
}

/** Constant-time comparison (both sides hashed to the same length first). */
export function passwordMatches(given: string): boolean {
  const password = operatorPassword();
  if (!password) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(password, "utf8").digest();
  return timingSafeEqual(a, b);
}

function recentFailures(now: number): number[] {
  g.__slotlineLoginFailures = (g.__slotlineLoginFailures ?? []).filter((t) => t > now - LOGIN_WINDOW_MS);
  return g.__slotlineLoginFailures;
}

/** Seconds to wait before the next sign-in attempt (0 = go ahead). */
export function loginRetryAfter(now = Date.now()): number {
  const f = recentFailures(now);
  return f.length >= LOGIN_MAX_FAILURES ? Math.max(1, Math.ceil((f[0] + LOGIN_WINDOW_MS - now) / 1000)) : 0;
}

export function recordLoginFailure(now = Date.now()): void {
  recentFailures(now).push(now);
}

/** Tests: forget throttling and revocations. */
export function resetAuthForTests(): void {
  g.__slotlineLoginFailures = [];
  g.__slotlineRevoked = new Map();
}

export function authStatus(req: Request): AuthMeResponse {
  const mode = authMode();
  if (mode !== "password") return { authenticated: mode === "open", mode, expiresAt: null };
  const s = sessionFromRequest(req);
  return { authenticated: s !== null, mode, expiresAt: s?.expiresAt ?? null };
}
