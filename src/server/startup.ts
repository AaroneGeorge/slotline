/**
 * Fail-closed configuration check, run once at server start by
 * src/instrumentation.ts. In production (NODE_ENV=production) the server
 * refuses to start with a missing or public secret. In development it keeps
 * the convenient defaults and says loudly what is open.
 */
import { EXAMPLE_DEV_SECRET, MIN_DEV_SECRET_LENGTH } from "./config";
import { DEFAULT_MOCK_WEBHOOK_SECRET } from "./paypal/signature";

export const MIN_SESSION_SECRET_LENGTH = 32;
/** Below this the password only earns a warning: sign-in is throttled, and the operator picks the trade-off. */
export const RECOMMENDED_PASSWORD_LENGTH = 12;

export interface StartupReport {
  production: boolean;
  /** Any error means: do not start. */
  errors: string[];
  warnings: string[];
}

type Env = Record<string, string | undefined>;

function val(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

export function checkStartupConfig(env: Env = process.env): StartupReport {
  const production = env.NODE_ENV === "production";
  const errors: string[] = [];
  const warnings: string[] = [];
  const password = val(env, "OPERATOR_PASSWORD");
  const sessionSecret = val(env, "SESSION_SECRET");
  const devSecret = val(env, "DEV_TOOLS_SECRET");
  const mockMode = val(env, "PAYPAL_MODE") !== "sandbox";
  const mockKey = val(env, "MOCK_WEBHOOK_SECRET");

  if (!production) {
    if (!password) warnings.push("OPERATOR_PASSWORD is not set: the dashboard and every operator API route are OPEN to anyone who can reach this server (development only; production refuses to start like this).");
    return { production, errors, warnings };
  }

  if (!password) errors.push("OPERATOR_PASSWORD is not set. It is required in production; without it every operator route (dashboard, approvals, money actions) would be locked.");
  else if (password.length < RECOMMENDED_PASSWORD_LENGTH) warnings.push(`OPERATOR_PASSWORD is only ${password.length} characters; a long random one is recommended (sign-in is throttled, not blocked).`);
  if (sessionSecret && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) errors.push(`SESSION_SECRET is shorter than ${MIN_SESSION_SECRET_LENGTH} characters. Use e.g. \`openssl rand -base64 48\`, or unset it to derive the session key from OPERATOR_PASSWORD.`);

  if (!devSecret) errors.push("DEV_TOOLS_SECRET is not set. Set it to a long random value (`openssl rand -hex 24`) to enable the dev tools, or to `off` to disable them.");
  else if (devSecret === EXAMPLE_DEV_SECRET) errors.push(`DEV_TOOLS_SECRET is the public example value \`${EXAMPLE_DEV_SECRET}\`: anyone who reads the repo could run money actions without a grant. Set a long random value, or \`off\`.`);
  else if (devSecret.toLowerCase() !== "off" && devSecret.length < MIN_DEV_SECRET_LENGTH) errors.push(`DEV_TOOLS_SECRET is shorter than ${MIN_DEV_SECRET_LENGTH} characters. Set a long random value, or \`off\`.`);

  if (mockMode && (!mockKey || mockKey === DEFAULT_MOCK_WEBHOOK_SECRET)) errors.push("PAYPAL_MODE=mock with the public default mock webhook key: anyone could forge a verified webhook and move bookings. Set MOCK_WEBHOOK_SECRET to a long random value (`openssl rand -hex 32`).");

  return { production, errors, warnings };
}

export function formatStartupReport(r: StartupReport): string {
  const lines: string[] = [];
  if (r.errors.length) {
    lines.push("[slotline] REFUSING TO START: NODE_ENV=production and the configuration is not safe to expose.");
    for (const e of r.errors) lines.push(`[slotline]   x ${e}`);
  }
  if (r.warnings.length) {
    const bar = "[slotline] " + "*".repeat(72);
    lines.push(bar);
    for (const w of r.warnings) lines.push(`[slotline] WARNING: ${w}`);
    lines.push(bar);
  }
  if (r.errors.length) lines.push("[slotline] Set these in .env.local (or the container environment) and start again. See README, \"Security\".");
  return lines.join("\n");
}

/** Print the report; exit the process (status 1) when there is any error. Called from src/instrumentation.ts. */
export function enforceStartupConfig(env: Env = process.env): StartupReport {
  const report = checkStartupConfig(env);
  if (report.errors.length) {
    console.error(formatStartupReport(report));
    process.exit(1);
  }
  if (report.warnings.length) console.warn(formatStartupReport(report));
  return report;
}
