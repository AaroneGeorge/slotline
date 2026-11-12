import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthMeResponse, Booking, StateResponse } from "@/shared/types";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { GET as stateRoute } from "@/app/api/state/route";
import { GET as streamRoute } from "@/app/api/stream/route";
import { GET as bookingRoute } from "@/app/api/bookings/[id]/route";
import { GET as evidenceRoute } from "@/app/api/bookings/[id]/evidence/route";
import { GET as planRoute } from "@/app/api/plans/[id]/route";
import { POST as seedRoute } from "@/app/api/dev/seed/route";
import { issueSession, LOGIN_MAX_FAILURES, SESSION_COOKIE, SESSION_TTL_MS } from "@/server/auth";
import { listBookings, listPlans } from "@/server/db";
import { seedDemoDay } from "@/server/seed";
import { captureBooking } from "@/server/bookings";
import { body, byName, DEV_SECRET, params, req, setupEnv } from "./helpers";

const PASSWORD = "correct horse battery staple";
const dev = { "x-dev-secret": DEV_SECRET };

/** POST /api/auth/login with the right password; returns the `name=value` pair to send back. */
async function login(): Promise<{ cookie: string; setCookie: string }> {
  const res = await loginRoute(req("/api/auth/login", { body: { password: PASSWORD } }));
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { cookie: setCookie.split(";")[0], setCookie };
}

// ---------------------------------------------------------------- route inventory

const API_DIR = path.resolve(__dirname, "../src/app/api");
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/** Every route the customer page, PayPal or a signed-out browser needs. Everything else must answer 401. */
const PUBLIC = new Set([
  "POST /api/bookings",
  "GET /api/bookings/[id]",
  "POST /api/bookings/[id]/order",
  "POST /api/bookings/[id]/authorize",
  "GET /api/config/public",
  "GET /api/availability",
  "POST /api/paypal/webhook",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "GET /api/auth/me",
]);

/** The operator routes the pass-2 brief names explicitly; the inventory must find each of them gated. */
const MUST_BE_GATED = [
  "GET /api/state",
  "GET /api/stream",
  "PATCH /api/bookings/[id]",
  "POST /api/bookings/[id]/capture",
  "POST /api/bookings/[id]/void",
  "POST /api/bookings/[id]/refund",
  "POST /api/bookings/[id]/invoice",
  "POST /api/bookings/[id]/remind",
  "GET /api/bookings/[id]/evidence",
  "GET /api/plans/[id]",
  "POST /api/plans/[id]/approve",
  "POST /api/plans/[id]/reject",
  "POST /api/plans/propose",
  "POST /api/dev/seed",
  "POST /api/dev/inject",
  "POST /api/dev/replay",
];

type Handler = (r: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : e.name === "route.ts" ? [p] : [];
  });
}

async function inventory(): Promise<{ key: string; urlPath: string; method: string; handler: Handler }[]> {
  const out = [];
  for (const file of routeFiles(API_DIR)) {
    const rel = path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/");
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    for (const method of METHODS) {
      if (typeof mod[method] !== "function") continue;
      out.push({ key: `${method} /api/${rel}`, urlPath: `/api/${rel.replace("[id]", "bk_nope")}`, method, handler: mod[method] as Handler });
    }
  }
  return out;
}

async function call(r: { urlPath: string; method: string; handler: Handler }, headers: Record<string, string>): Promise<Response> {
  const ac = new AbortController();
  const request = new Request(`http://localhost:3000${r.urlPath}`, {
    method: r.method,
    headers: { "content-type": "application/json", ...headers },
    body: r.method === "GET" ? undefined : "{}",
    signal: ac.signal,
  });
  const res = await r.handler(request, { params: Promise.resolve({ id: "bk_nope" }) });
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    ac.abort();
    await res.body?.cancel().catch(() => undefined);
  }
  return res;
}

describe("operator gate: every API route is either public or needs the session cookie", () => {
  beforeEach(() => setupEnv({ OPERATOR_PASSWORD: PASSWORD }));

  it("without the cookie: gated routes answer 401 JSON (even with x-dev-secret), public routes do not", async () => {
    const routes = await inventory();
    const gated = routes.filter((r) => !PUBLIC.has(r.key)).map((r) => r.key);
    for (const k of MUST_BE_GATED) expect(gated).toContain(k);
    expect(routes.map((r) => r.key)).toEqual(expect.arrayContaining([...PUBLIC]));
    for (const r of routes) {
      const res = await call(r, dev);
      if (PUBLIC.has(r.key)) {
        if (!r.key.startsWith("POST /api/auth/login")) expect(res.status, r.key).not.toBe(401);
        continue;
      }
      expect(res.status, r.key).toBe(401);
      expect(res.headers.get("content-type"), r.key).toContain("application/json");
      expect(await res.json(), r.key).toMatchObject({ code: "UNAUTHENTICATED", error: "operator sign-in required" });
    }
  });

  it("with the cookie: no gated route answers 401; dev routes still need x-dev-secret", async () => {
    const { cookie } = await login();
    for (const r of await inventory()) {
      if (PUBLIC.has(r.key)) continue;
      const res = await call(r, { cookie, ...dev });
      expect(res.status, r.key).not.toBe(401);
    }
    const noSecret = await seedRoute(req("/api/dev/seed", { method: "POST", headers: { cookie } }));
    expect(noSecret.status).toBe(401);
    expect((await noSecret.json()).code).toBe("DEV_SECRET_REQUIRED");
  });

  it("with the cookie: state, stream, evidence, plan and dev seed answer 200", async () => {
    const { cookie } = await login();
    expect((await seedRoute(req("/api/dev/seed", { method: "POST", headers: { cookie, ...dev } }))).status).toBe(200);
    const st = await stateRoute(req("/api/state", { headers: { cookie } }));
    expect(st.status).toBe(200);
    const marcus = byName((await body<StateResponse>(st)).bookings, "Marcus");
    await captureBooking(marcus.id, { actor: "operator", devTools: true, mockResponse: "INSTRUMENT_DECLINED" });
    await vi.waitFor(() => expect(listPlans().length).toBe(1));
    expect((await planRoute(req("", { headers: { cookie } }), params({ id: listPlans()[0].id }))).status).toBe(200);
    expect((await evidenceRoute(req("", { headers: { cookie } }), params({ id: marcus.id }))).status).toBe(200);
    const ac = new AbortController();
    const stream = await streamRoute(new Request("http://localhost:3000/api/stream", { headers: { cookie }, signal: ac.signal }));
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    ac.abort();
    await stream.body?.cancel().catch(() => undefined);
  });
});

// ---------------------------------------------------------------- login / logout / me

describe("operator sign-in", () => {
  beforeEach(() => setupEnv({ OPERATOR_PASSWORD: PASSWORD }));
  afterEach(() => vi.unstubAllEnvs());

  it("a wrong password is 401 and sets no cookie", async () => {
    const res = await loginRoute(req("/api/auth/login", { body: { password: "hunter2" } }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("INVALID_PASSWORD");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await loginRoute(req("/api/auth/login", { body: {} }))).status).toBe(400);
  });

  it("the session cookie is HttpOnly, SameSite=Lax, Path=/, 12 h, and not Secure outside production", async () => {
    const { setCookie } = await login();
    const attrs = setCookie.split(";").map((s) => s.trim());
    expect(attrs[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.\\d+\\.[\\w-]+\\.[\\w-]+$`));
    expect(attrs).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_TTL_MS / 1000}`]));
    expect(attrs).not.toContain("Secure");
  });

  it("in production the cookie is also Secure", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { setCookie } = await login();
    expect(setCookie.split(";").map((s) => s.trim())).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Secure"]));
  });

  it("GET /api/auth/me reflects the session; logout clears the cookie and revokes the token", async () => {
    expect(await body<AuthMeResponse>(await meRoute(req("/api/auth/me")))).toEqual({ authenticated: false, mode: "password", expiresAt: null });
    const { cookie } = await login();
    const me = await body<AuthMeResponse>(await meRoute(req("/api/auth/me", { headers: { cookie } })));
    expect(me).toMatchObject({ authenticated: true, mode: "password" });
    expect(new Date(me.expiresAt!).getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
    expect((await stateRoute(req("/api/state", { headers: { cookie } }))).status).toBe(200);

    const out = await logoutRoute(req("/api/auth/logout", { method: "POST", headers: { cookie } }));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`));
    // a copy of the old cookie no longer works
    expect((await stateRoute(req("/api/state", { headers: { cookie } }))).status).toBe(401);
    expect((await body<AuthMeResponse>(await meRoute(req("/api/auth/me", { headers: { cookie } })))).authenticated).toBe(false);
  });

  it("tampered, expired and foreign tokens are refused", async () => {
    const { cookie } = await login();
    const [name, token] = cookie.split("=");
    const parts = token.split(".");
    const tampered = `${name}=${[parts[0], String(Number(parts[1]) + 1000), parts[2], parts[3]].join(".")}`;
    expect((await stateRoute(req("/api/state", { headers: { cookie: tampered } }))).status).toBe(401);
    const expired = issueSession(Date.now() - SESSION_TTL_MS - 1000)!;
    expect((await stateRoute(req("/api/state", { headers: { cookie: `${SESSION_COOKIE}=${expired.token}` } }))).status).toBe(401);
    // a token signed under another password is worthless after the password changes
    process.env.OPERATOR_PASSWORD = "a different long password";
    expect((await stateRoute(req("/api/state", { headers: { cookie } }))).status).toBe(401);
  });

  it("sign-in is throttled after repeated failures", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await loginRoute(req("/api/auth/login", { body: { password: `nope-${i}` } }))).status).toBe(401);
    const res = await loginRoute(req("/api/auth/login", { body: { password: PASSWORD } }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("an open stream ends when its session is signed out", async () => {
    const { cookie } = await login();
    const stream = await streamRoute(new Request("http://localhost:3000/api/stream", { headers: { cookie } }));
    const reader = stream.body!.getReader();
    await reader.read(); // retry + hello
    await logoutRoute(req("/api/auth/logout", { method: "POST", headers: { cookie } }));
    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
  });
});

describe("auth modes", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("development without OPERATOR_PASSWORD is open (no cookie needed)", async () => {
    setupEnv({ OPERATOR_PASSWORD: "" });
    expect((await stateRoute(req("/api/state"))).status).toBe(200);
    expect(await body<AuthMeResponse>(await meRoute(req("/api/auth/me")))).toEqual({ authenticated: true, mode: "open", expiresAt: null });
  });

  it("production without OPERATOR_PASSWORD is locked: operator routes 401, sign-in impossible", async () => {
    setupEnv({ OPERATOR_PASSWORD: "" });
    vi.stubEnv("NODE_ENV", "production");
    const res = await stateRoute(req("/api/state"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("AUTH_NOT_CONFIGURED");
    expect((await loginRoute(req("/api/auth/login", { body: { password: "anything" } }))).status).toBe(401);
    expect((await body<AuthMeResponse>(await meRoute(req("/api/auth/me")))).mode).toBe("locked");
  });
});

describe("GET /api/bookings/:id (public resume link) returns the holder's essentials only", () => {
  beforeEach(() => setupEnv({ OPERATOR_PASSWORD: PASSWORD }));

  it("no email, notes, capture/refund/invoice/dispute ids; no cookie needed", async () => {
    await seedDemoDay();
    const ahmed = byName(listBookings(), "Ahmed");
    expect(ahmed.customerEmail).toBeTruthy();
    expect(ahmed.paypalInvoiceId).toBeTruthy();
    const res = await bookingRoute(req(""), params({ id: ahmed.id }));
    expect(res.status).toBe(200);
    const { booking } = await body<{ booking: Partial<Booking> }>(res);
    expect(Object.keys(booking).sort()).toEqual(
      ["balanceAmount", "currency", "customerName", "depositAmount", "durationMin", "endAt", "id", "paypalAuthorizationId", "paypalOrderId", "resourceId", "service", "startAt", "state", "waitlist"].sort(),
    );
    const raw = JSON.stringify(booking);
    expect(raw).not.toContain(ahmed.customerEmail as string);
    expect(raw).not.toContain(ahmed.paypalInvoiceId as string);
    expect((await bookingRoute(req(""), params({ id: "bk_nope" }))).status).toBe(404);
  });
});
