/**
 * Runtime configuration, read from process.env at call time (so tests can
 * change it). No secrets are ever logged or returned from here except through
 * the explicit getters used by the PayPal gateway.
 */
import type { AppMode, PublicConfig } from "@/shared/types";

export type PaypalMode = AppMode["paypal"];
export type LlmProvider = AppMode["llm"];

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function paypalMode(): PaypalMode {
  return env("PAYPAL_MODE") === "sandbox" ? "sandbox" : "mock";
}

export function llmProvider(): LlmProvider {
  const v = env("LLM_PROVIDER");
  if (v === "anthropic" || v === "gemini" || v === "groq") return v;
  return "rules";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The example value shipped in .env.example; refused in production. */
export const EXAMPLE_DEV_SECRET = "change-me";
/** Production minimum for DEV_TOOLS_SECRET. */
export const MIN_DEV_SECRET_LENGTH = 16;

/**
 * x-dev-secret value, or null when dev tools are off. `DEV_TOOLS_SECRET=off`
 * turns them off explicitly. In production the example value and short
 * secrets also count as off (startup refuses them too; this is the runtime
 * fail-closed backstop).
 */
export function devToolsSecret(): string | null {
  const v = env("DEV_TOOLS_SECRET");
  if (!v || v.toLowerCase() === "off") return null;
  if (isProduction() && (v === EXAMPLE_DEV_SECRET || v.length < MIN_DEV_SECRET_LENGTH)) return null;
  return v;
}

/** Shared operator password (OPERATOR_PASSWORD), or null when unset. */
export function operatorPassword(): string | null {
  return env("OPERATOR_PASSWORD") ?? null;
}

/** Optional separate session signing secret; otherwise the key is derived from OPERATOR_PASSWORD. */
export function sessionSecret(): string | null {
  return env("SESSION_SECRET") ?? null;
}

export function devToolsEnabled(): boolean {
  return devToolsSecret() !== null;
}

export function appMode(): AppMode {
  return { paypal: paypalMode(), llm: llmProvider(), devTools: devToolsEnabled() };
}

export function currency(): string {
  return env("NEXT_PUBLIC_PAYPAL_CURRENCY") ?? env("PAYPAL_CURRENCY") ?? "USD";
}

export function operatorTz(): string {
  return env("OPERATOR_TZ") ?? "America/Los_Angeles";
}

export function databasePath(): string {
  return env("DATABASE_PATH") ?? "./data/slotline.db";
}

export function appBaseUrl(): string {
  return (env("APP_BASE_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
}

export interface PaypalCredentials {
  clientId: string;
  clientSecret: string;
  webhookId: string | null;
}

/** Sandbox credentials, or null when they are not configured. */
export function paypalCredentials(): PaypalCredentials | null {
  const clientId = env("PAYPAL_CLIENT_ID");
  const clientSecret = env("PAYPAL_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, webhookId: env("PAYPAL_WEBHOOK_ID") ?? null };
}

export function webhookId(): string | null {
  return env("PAYPAL_WEBHOOK_ID") ?? null;
}

export function anthropicConfig(): { apiKey: string; model: string } | null {
  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
  return { apiKey, model: env("ANTHROPIC_MODEL") ?? "claude-opus-5-5" };
}

export function geminiConfig(): { apiKey: string; model: string } | null {
  const apiKey = env("GEMINI_API_KEY") ?? env("GOOGLE_GENERATIVE_AI_API_KEY");
  if (!apiKey) return null;
  return { apiKey, model: env("GEMINI_MODEL") ?? "gemini-2.5-flash" };
}

export function groqConfig(): { apiKey: string; model: string } | null {
  const apiKey = env("GROQ_API_KEY");
  if (!apiKey) return null;
  return { apiKey, model: env("GROQ_MODEL") ?? "openai/gpt-oss-120b" };
}

/** Planner provider timeout (ms). */
export function plannerTimeoutMs(): number {
  const n = Number(env("PLANNER_TIMEOUT_MS"));
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/**
 * Mock mode only: delay before the MockGateway "delivers" the webhook that
 * PayPal would send for an API call (exercises the idempotent webhook path).
 * 0 disables the echo (tests).
 */
export function mockWebhookDelayMs(): number {
  const raw = env("MOCK_WEBHOOK_DELAY_MS");
  if (raw === undefined) return process.env.NODE_ENV === "test" ? 0 : 1500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
}

export function publicConfig(): PublicConfig {
  return {
    paypalClientId: paypalMode() === "sandbox" ? (env("NEXT_PUBLIC_PAYPAL_CLIENT_ID") ?? env("PAYPAL_CLIENT_ID") ?? null) : null,
    currency: currency(),
    mode: appMode(),
    timeZone: operatorTz(),
  };
}

/** Grant lifetime. */
export const GRANT_TTL_MS = 15 * 60 * 1000;
