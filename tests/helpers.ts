/** Shared test setup: in-memory SQLite, mock PayPal, rules planner, dev tools on, no webhook echo, operator sign-in off (open). */
import { resetDbForTests } from "@/server/db";
import { resetAuthForTests } from "@/server/auth";
import { setGatewayForTests } from "@/server/paypal";
import { setPlannerForTests } from "@/server/planner";
import { operatorTz } from "@/server/config";
import { currentDay } from "@/server/planner/context";
import { zonedToUtc } from "@/server/time";
import type { Booking } from "@/shared/types";

export const DEV_SECRET = "test-dev-secret";

export function setupEnv(extra: Record<string, string> = {}): void {
  Object.assign(process.env, {
    DATABASE_PATH: ":memory:",
    PAYPAL_MODE: "mock",
    LLM_PROVIDER: "rules",
    DEV_TOOLS_SECRET: DEV_SECRET,
    MOCK_WEBHOOK_DELAY_MS: "0",
    OPERATOR_TZ: "America/Los_Angeles",
    AUTO_RESEED: "off",
    APP_BASE_URL: "http://localhost:3000",
    OPERATOR_PASSWORD: "",
    SESSION_SECRET: "",
    ...extra,
  });
  resetDbForTests();
  resetAuthForTests();
  setGatewayForTests(null);
  setPlannerForTests(null);
}

/** ISO time for local "HH:MM" today in the operator time zone. */
export function at(hhmm: string): string {
  return zonedToUtc(currentDay(), hhmm, operatorTz()).toISOString();
}

export function req(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  return new Request(`http://localhost:3000${path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...init.headers },
    body,
  });
}

export function params<T extends Record<string, string>>(p: T): { params: Promise<T> } {
  return { params: Promise.resolve(p) };
}

export async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function byName(bookings: Booking[], first: string): Booking {
  const b = bookings.find((x) => x.customerName.startsWith(first));
  if (!b) throw new Error(`no booking for ${first}`);
  return b;
}
