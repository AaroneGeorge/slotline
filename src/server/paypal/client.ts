/**
 * One official PayPal Server SDK client per process, sandbox only, and one
 * cached client-credentials token shared by the SDK and the REST helper
 * (rest.ts). Tokens are refreshed when expired (minus 5 min skew) or on 401.
 */
import { Client, Environment, LogLevel, type OAuthToken } from "@paypal/paypal-server-sdk";
import { paypalCredentials } from "../config";

export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
const CLOCK_SKEW_S = 300;

interface Holder {
  client: Client;
  key: string;
  token: OAuthToken | undefined;
}

const g = globalThis as unknown as { __slotlinePaypal?: Holder; __slotlineSdkAdapter?: unknown };

/**
 * Tests only: route every SDK HTTP request (including the token call) through
 * an axios-style adapter instead of the network. Resets the cached client.
 */
export function setSdkHttpAdapterForTests(adapter: ((config: Record<string, unknown>) => Promise<unknown>) | null): void {
  g.__slotlineSdkAdapter = adapter ?? undefined;
  g.__slotlinePaypal = undefined;
}

function tokenValid(t: OAuthToken | undefined): t is OAuthToken {
  if (!t) return false;
  if (t.expiry === undefined) return true;
  return Number(t.expiry) - CLOCK_SKEW_S > Date.now() / 1000;
}

function holder(): Holder {
  const creds = paypalCredentials();
  if (!creds) throw new Error("PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app credentials) in .env.local");
  const key = creds.clientId;
  if (g.__slotlinePaypal && g.__slotlinePaypal.key === key) return g.__slotlinePaypal;
  const h: Holder = { key, token: undefined, client: undefined as unknown as Client };
  h.client = new Client({
    environment: Environment.Sandbox, // never Production: this app only ever talks to the sandbox
    timeout: 30_000,
    clientCredentialsAuthCredentials: {
      oAuthClientId: creds.clientId,
      oAuthClientSecret: creds.clientSecret,
      oAuthClockSkew: CLOCK_SKEW_S,
      // Share one cached token between the SDK and rest.ts.
      oAuthTokenProvider: async (last, manager) => {
        if (tokenValid(h.token)) return h.token;
        if (tokenValid(last)) return last;
        h.token = await manager.fetchToken();
        return h.token;
      },
      oAuthOnTokenUpdate: (t) => {
        h.token = t;
      },
    },
    logging: { logLevel: LogLevel.Warn, logRequest: { logBody: false }, logResponse: { logBody: false, logHeaders: false } },
    ...(g.__slotlineSdkAdapter ? { unstable_httpClientOptions: { adapter: g.__slotlineSdkAdapter } } : {}),
  });
  g.__slotlinePaypal = h;
  return h;
}

export function sdkClient(): Client {
  return holder().client;
}

/** Bearer token for the REST helper; cached, refreshed when expired or when `force` is set (after a 401). */
export async function accessToken(force = false): Promise<string> {
  const h = holder();
  if (!force && tokenValid(h.token)) return h.token.accessToken;
  h.token = await h.client.clientCredentialsAuthManager.fetchToken();
  return h.token.accessToken;
}

export function invalidateToken(): void {
  if (g.__slotlinePaypal) g.__slotlinePaypal.token = undefined;
}
