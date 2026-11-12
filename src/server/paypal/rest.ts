/**
 * Thin authenticated fetch for the PayPal endpoints the Server SDK 2.5.0 does
 * not cover: webhook signature verification, Invoicing v2, Disputes v1,
 * webhook management. Sandbox base URL only; uses the SDK's cached token.
 */
import { accessToken, invalidateToken, SANDBOX_BASE_URL } from "./client";
import { fromErrorBody, PaypalError } from "./errors";

export interface RestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON-serialisable body, or a pre-serialised string (sent verbatim). */
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  /** Return the raw text instead of parsing JSON. */
  text?: boolean;
}

export interface RestResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export async function paypalRest<T = Record<string, unknown>>(path: string, opts: RestOptions = {}): Promise<RestResponse<T>> {
  if (!path.startsWith("/")) throw new Error(`paypalRest: path must start with "/": ${path}`);
  const url = new URL(SANDBOX_BASE_URL + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  if (url.host !== "api-m.sandbox.paypal.com") throw new Error("refusing to call a non-sandbox PayPal host");
  const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);

  const attempt = async (force: boolean) => {
    const token = await accessToken(force);
    return fetch(url, {
      method: opts.method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  };

  let res = await attempt(false);
  if (res.status === 401) {
    invalidateToken();
    res = await attempt(true);
  }
  const text = await res.text();
  if (!res.ok) {
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    throw fromErrorBody(res.status, parsed, `${opts.method ?? "GET"} ${path} failed with HTTP ${res.status}`);
  }
  if (opts.text) return { status: res.status, data: text as unknown as T, headers: res.headers };
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new PaypalError(`unexpected non-JSON response from ${path}`, res.status, "BAD_RESPONSE");
    }
  }
  return { status: res.status, data: data as T, headers: res.headers };
}
