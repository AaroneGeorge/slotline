/**
 * Create the sandbox webhook subscription for APP_BASE_URL/api/paypal/webhook
 * and print its id (put it in .env.local as PAYPAL_WEBHOOK_ID). Run:
 *   pnpm tsx scripts/register-webhook.ts
 * PayPal needs a public HTTPS URL (e.g. a Cloudflare Tunnel to this server).
 */
import { loadEnvLocal, requireSandbox } from "./env";

async function main(): Promise<void> {
  loadEnvLocal();
  requireSandbox();

  const { paypalRest } = await import("@/server/paypal/rest");
  const { PaypalError } = await import("@/server/paypal/errors");
  const { SUBSCRIBED_EVENT_TYPES } = await import("@/server/paypal/normalize");

  const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  if (!base.startsWith("https://")) {
    console.error(`APP_BASE_URL must be a public https:// URL (got "${base || "unset"}"); PayPal will not deliver to localhost.`);
    process.exit(2);
  }
  const url = `${base}/api/paypal/webhook`;

  interface Webhook {
    id: string;
    url: string;
    event_types: { name: string }[];
  }

  try {
    const res = await paypalRest<Webhook>("/v1/notifications/webhooks", {
      method: "POST",
      body: { url, event_types: SUBSCRIBED_EVENT_TYPES.map((name) => ({ name })) },
    });
    console.log(`Created webhook ${res.data.id} -> ${res.data.url}`);
    console.log(`Events: ${res.data.event_types.map((e) => e.name).join(", ")}`);
    console.log(`\nAdd to .env.local:\nPAYPAL_WEBHOOK_ID=${res.data.id}`);
  } catch (e) {
    if (e instanceof PaypalError && e.issue === "WEBHOOK_URL_ALREADY_EXISTS") {
      const list = await paypalRest<{ webhooks: Webhook[] }>("/v1/notifications/webhooks");
      const existing = list.data.webhooks.find((w) => w.url === url);
      console.log(`A webhook for ${url} already exists${existing ? `: ${existing.id}` : ""}.`);
      if (existing) {
        const missing = SUBSCRIBED_EVENT_TYPES.filter((n) => !existing.event_types.some((t) => t.name === n || t.name === "*"));
        if (missing.length) console.log(`It is missing: ${missing.join(", ")} (update it in the developer dashboard).`);
        console.log(`\nAdd to .env.local:\nPAYPAL_WEBHOOK_ID=${existing.id}`);
      }
    } else {
      console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
