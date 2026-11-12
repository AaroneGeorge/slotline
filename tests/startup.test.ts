import { afterEach, describe, expect, it, vi } from "vitest";
import { checkStartupConfig, formatStartupReport } from "@/server/startup";
import { devToolsSecret } from "@/server/config";
import { DEFAULT_MOCK_WEBHOOK_SECRET, mockWebhookSecret } from "@/server/paypal/signature";
import { register } from "@/instrumentation";

const STRONG = {
  OPERATOR_PASSWORD: "a long operator password",
  DEV_TOOLS_SECRET: "0123456789abcdef0123",
  MOCK_WEBHOOK_SECRET: "fedcba9876543210fedcba9876543210",
};

/** What `cp .env.example .env.local` gives you. */
const EXAMPLE = { PAYPAL_MODE: "mock", OPERATOR_PASSWORD: "", DEV_TOOLS_SECRET: "change-me" };

describe("fail-closed startup check", () => {
  it("development keeps the defaults and warns loudly that operator routes are open", () => {
    const r = checkStartupConfig({ NODE_ENV: "development", ...EXAMPLE });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/OPERATOR_PASSWORD is not set: .* OPEN/);
    expect(checkStartupConfig({ NODE_ENV: "development", ...EXAMPLE, OPERATOR_PASSWORD: "x" }).warnings).toEqual([]);
  });

  it("production refuses the .env.example values: no password, change-me, public mock webhook key", () => {
    const r = checkStartupConfig({ NODE_ENV: "production", ...EXAMPLE });
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toMatch(/^OPERATOR_PASSWORD is not set/);
    expect(r.errors[1]).toMatch(/DEV_TOOLS_SECRET is the public example value `change-me`/);
    expect(r.errors[2]).toMatch(/PAYPAL_MODE=mock with the public default mock webhook key/);
    const text = formatStartupReport(r);
    expect(text).toContain("REFUSING TO START");
    expect(text).toContain("MOCK_WEBHOOK_SECRET");
  });

  it("production: DEV_TOOLS_SECRET must be set; `off` or a long value passes, short values do not", () => {
    const base = { NODE_ENV: "production", ...STRONG };
    expect(checkStartupConfig(base).errors).toEqual([]);
    expect(checkStartupConfig({ ...base, DEV_TOOLS_SECRET: "" }).errors.join()).toMatch(/DEV_TOOLS_SECRET is not set/);
    expect(checkStartupConfig({ ...base, DEV_TOOLS_SECRET: undefined }).errors.join()).toMatch(/DEV_TOOLS_SECRET is not set/);
    expect(checkStartupConfig({ ...base, DEV_TOOLS_SECRET: "short" }).errors.join()).toMatch(/shorter than 16/);
    expect(checkStartupConfig({ ...base, DEV_TOOLS_SECRET: "off" }).errors).toEqual([]);
  });

  it("production mock mode: MOCK_WEBHOOK_SECRET must be set and not the public default; sandbox mode does not need it", () => {
    const base = { NODE_ENV: "production", ...STRONG };
    expect(checkStartupConfig({ ...base, MOCK_WEBHOOK_SECRET: "" }).errors.join()).toMatch(/MOCK_WEBHOOK_SECRET/);
    expect(checkStartupConfig({ ...base, MOCK_WEBHOOK_SECRET: DEFAULT_MOCK_WEBHOOK_SECRET }).errors.join()).toMatch(/MOCK_WEBHOOK_SECRET/);
    expect(checkStartupConfig({ ...base, PAYPAL_MODE: "sandbox", MOCK_WEBHOOK_SECRET: "" }).errors).toEqual([]);
  });

  it("production: a short SESSION_SECRET is refused; a short password only warns", () => {
    const base = { NODE_ENV: "production", ...STRONG };
    expect(checkStartupConfig({ ...base, SESSION_SECRET: "too-short" }).errors.join()).toMatch(/SESSION_SECRET is shorter than 32/);
    expect(checkStartupConfig({ ...base, SESSION_SECRET: "x".repeat(32) }).errors).toEqual([]);
    const r = checkStartupConfig({ ...base, OPERATOR_PASSWORD: "dana" });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toMatch(/only 4 characters/);
  });
});

describe("instrumentation register() enforces it at server start", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function stub(env: Record<string, string>) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  }

  it("production with unsafe config: prints why and exits 1", async () => {
    stub({ NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-server", NODE_ENV: "production", ...EXAMPLE, MOCK_WEBHOOK_SECRET: "" });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0][0])).toContain("REFUSING TO START");
  });

  it("production with safe config starts; `next build` is never blocked", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stub({ NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-server", NODE_ENV: "production", PAYPAL_MODE: "mock", ...STRONG });
    await register();
    stub({ NEXT_PHASE: "phase-production-build", ...EXAMPLE, MOCK_WEBHOOK_SECRET: "" });
    await register();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("runtime backstops in production (if startup was bypassed)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("the example dev secret and short secrets switch dev tools off; `off` is off everywhere", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_TOOLS_SECRET", "change-me");
    expect(devToolsSecret()).toBeNull();
    vi.stubEnv("DEV_TOOLS_SECRET", "short");
    expect(devToolsSecret()).toBeNull();
    vi.stubEnv("DEV_TOOLS_SECRET", STRONG.DEV_TOOLS_SECRET);
    expect(devToolsSecret()).toBe(STRONG.DEV_TOOLS_SECRET);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_TOOLS_SECRET", "change-me");
    expect(devToolsSecret()).toBe("change-me");
    vi.stubEnv("DEV_TOOLS_SECRET", "off");
    expect(devToolsSecret()).toBeNull();
  });

  it("the public mock webhook key is never used in production", () => {
    vi.stubEnv("MOCK_WEBHOOK_SECRET", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(mockWebhookSecret()).toBe(DEFAULT_MOCK_WEBHOOK_SECRET);
    vi.stubEnv("NODE_ENV", "production");
    const k = mockWebhookSecret();
    expect(k).not.toBe(DEFAULT_MOCK_WEBHOOK_SECRET);
    expect(k.length).toBeGreaterThanOrEqual(32);
    expect(mockWebhookSecret()).toBe(k); // stable for the process, so the mock echo still verifies
    vi.stubEnv("MOCK_WEBHOOK_SECRET", STRONG.MOCK_WEBHOOK_SECRET);
    expect(mockWebhookSecret()).toBe(STRONG.MOCK_WEBHOOK_SECRET);
  });
});
