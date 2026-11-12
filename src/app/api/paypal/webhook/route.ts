import { route, json } from "@/server/http";
import { handleWebhook } from "@/server/webhook";

/**
 * PayPal webhook listener. Reads the RAW body (signature verification needs
 * the exact bytes), verifies via the gateway, then applies idempotently.
 * 400 on bad signature (nothing mutated), 200 on replay/apply, 500 to make
 * PayPal retry on an internal failure.
 */
export const POST = route(async (req: Request) => {
  const rawBody = await req.text();
  const res = await handleWebhook(rawBody, req.headers);
  return json(res.body, res.status);
});
