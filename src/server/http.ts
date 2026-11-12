/** Route-handler helpers: JSON responses, typed errors, body parsing, the operator gate, dev-secret check. */
import { connection } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import type { ApiError } from "@/shared/types";
import { authMode, sessionFromRequest } from "./auth";
import { devToolsSecret } from "./config";
import { PaypalError } from "./paypal/errors";
import { IllegalTransition } from "./state";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json<T>(data: T, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json<ApiError>({ error: e.message, code: e.code, ...(e.details !== undefined ? { details: e.details } : {}) }, e.status);
  if (e instanceof IllegalTransition) return json<ApiError>({ error: e.message, code: e.code }, 409);
  if (e instanceof PaypalError) {
    const status = e.status >= 400 && e.status < 500 ? (e.status === 401 || e.status === 403 ? 502 : 422) : 502;
    return json<ApiError>({ error: e.message, code: e.issue, details: { paypalStatus: e.status, debugId: e.debugId } }, status);
  }
  console.error("[api] unhandled error", e);
  return json<ApiError>({ error: e instanceof Error ? e.message : "internal error", code: "INTERNAL" }, 500);
}

/**
 * With Cache Components, a GET handler that only does synchronous SQLite reads
 * would be prerendered at build time; `connection()` marks it request-time.
 * Outside a Next request (vitest calling handlers directly) it throws
 * "outside a request scope", which is safe to ignore.
 */
async function requestTime(): Promise<void> {
  try {
    await connection();
  } catch (e) {
    if (!(e instanceof Error && e.message.includes("outside a request scope"))) throw e;
  }
}

/** Wrap a handler: opt out of prerendering (Cache Components) and map errors to `{ error, code }`. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      await requestTime();
      return await fn(...args);
    } catch (e) {
      unstable_rethrow(e); // let Next handle its own control-flow errors (e.g. connection() rejecting at the end of a build-time prerender)
      return errorResponse(e);
    }
  };
}

/**
 * The one operator gate. Throws 401 unless the request carries a valid
 * operator session cookie. Development without OPERATOR_PASSWORD is open;
 * production without it is locked (fail closed).
 */
export function requireOperator(req: Request): void {
  const mode = authMode();
  if (mode === "open") return;
  if (mode === "locked") throw new HttpError(401, "AUTH_NOT_CONFIGURED", "operator sign-in is not configured on this server (OPERATOR_PASSWORD is unset)");
  if (!sessionFromRequest(req)) throw new HttpError(401, "UNAUTHENTICATED", "operator sign-in required");
}

/** `route()` for operator-only handlers: `requireOperator` runs first, before the body is read. */
export function operatorRoute<A extends [Request, ...unknown[]]>(fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return route(async (...args: A) => {
    requireOperator(args[0]);
    return fn(...args);
  });
}

export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown = {};
  const text = await req.text();
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, "INVALID_JSON", "request body is not valid JSON");
    }
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST", "request body failed validation", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return parsed.data;
}

export function hasDevSecret(req: Request): boolean {
  const secret = devToolsSecret();
  const got = req.headers.get("x-dev-secret");
  if (!secret || !got) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireDevSecret(req: Request): void {
  if (!devToolsSecret()) throw new HttpError(403, "DEV_TOOLS_DISABLED", "dev tools are disabled (DEV_TOOLS_SECRET is not set)");
  if (!hasDevSecret(req)) throw new HttpError(401, "DEV_SECRET_REQUIRED", "missing or wrong x-dev-secret header");
}
