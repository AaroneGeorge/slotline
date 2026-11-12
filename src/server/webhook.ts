/**
 * POST /api/paypal/webhook core. Raw body in, signature verified through the
 * gateway before anything is trusted:
 *   bad/missing signature -> 400, nothing recorded or mutated
 *   replay (same event id) -> 200 no-op
 *   unknown event type     -> recorded, ignored, 200
 *   known event            -> applyMoneyEvent, 200
 *   unexpected failure     -> 500 (PayPal retries; the transaction rolled back)
 */
import { insertEventIfNew, setEventOutcome } from "./db";
import { webhookId } from "./config";
import { writeLog } from "./log";
import { applyMoneyEvent, type ApplyOutcome } from "./pipeline";
import { getGateway } from "./paypal";
import { webhookHeadersFrom } from "./paypal/gateway";
import { normalizeWebhook } from "./paypal/normalize";
import { MOCK_WEBHOOK_ID } from "./paypal/signature";
import { nowIso } from "./ids";

export interface WebhookResult {
  status: number;
  body: { ok: boolean; outcome?: ApplyOutcome | "ignored"; eventId?: string; error?: string; code?: string };
}

export async function handleWebhook(rawBody: string, headers: Headers): Promise<WebhookResult> {
  const gw = getGateway();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    writeLog({ actor: "system", kind: "webhook.rejected", message: "Webhook rejected: body is not JSON", refs: { reason: "invalid_json" } });
    return { status: 400, body: { ok: false, error: "body is not valid JSON", code: "INVALID_JSON" } };
  }

  const verification = await gw.verifyWebhookSignature({
    headers: webhookHeadersFrom(headers),
    rawBody,
    webhookId: gw.mode === "mock" ? MOCK_WEBHOOK_ID : webhookId(),
  });
  const p = (parsed ?? {}) as { id?: unknown; event_type?: unknown };
  const claimedId = typeof p.id === "string" ? p.id : undefined;
  const claimedType = typeof p.event_type === "string" ? p.event_type : undefined;
  if (!verification.verified) {
    writeLog({
      actor: "system",
      kind: "webhook.rejected",
      message: `Webhook ${claimedType ?? "?"} rejected: signature not verified (${verification.reason ?? "unknown reason"}); nothing applied`,
      refs: { eventId: claimedId, eventType: claimedType, method: verification.method, transmissionId: headers.get("paypal-transmission-id") },
    });
    return { status: 400, body: { ok: false, error: "webhook signature verification failed", code: "INVALID_SIGNATURE" } };
  }

  const norm = normalizeWebhook(parsed);
  if (norm.kind === "invalid") {
    writeLog({ actor: "system", kind: "webhook.rejected", message: `Webhook rejected: ${norm.reason}`, refs: { method: verification.method } });
    return { status: 400, body: { ok: false, error: norm.reason, code: "INVALID_EVENT" } };
  }

  const eventId = norm.kind === "event" ? norm.event.id : norm.id;
  const eventType = norm.kind === "event" ? norm.event.type : norm.type;
  writeLog({
    actor: "paypal",
    kind: "webhook.received",
    message: `Webhook ${claimedType} ${eventId} received, signature verified (${verification.method})`,
    refs: { eventId, eventType: claimedType, transmissionId: headers.get("paypal-transmission-id"), method: verification.method },
  });

  if (norm.kind === "unknown") {
    const fresh = insertEventIfNew({ id: norm.id, type: norm.type, at: norm.at, source: "webhook", verified: true, bookingId: null, resource: norm.resource, refs: {} }, nowIso());
    if (fresh) setEventOutcome(norm.id, "ignored", "event type not handled by Slotline");
    writeLog({ actor: "system", kind: "event.ignored", message: `${eventType} is not a Slotline money event; recorded and ignored`, refs: { eventId } });
    return { status: 200, body: { ok: true, outcome: "ignored", eventId } };
  }

  try {
    const res = await applyMoneyEvent({ ...norm.event, source: "webhook", verified: true }, { planning: "background" });
    return { status: 200, body: { ok: true, outcome: res.outcome, eventId } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeLog({ actor: "system", kind: "webhook.error", message: `Webhook ${eventType} ${eventId} failed: ${msg}; PayPal will retry`, refs: { eventId } });
    return { status: 500, body: { ok: false, error: "internal error while applying the event", code: "APPLY_FAILED", eventId } };
  }
}
