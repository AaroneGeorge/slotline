/**
 * Dev tools (x-dev-secret): inject PayPal-shaped fixtures for a booking, and
 * replay a recorded event to prove the handler is idempotent.
 */
import type { DevFixture, DevInjectResponse, DevReplayResponse, MoneyEvent } from "@/shared/types";
import { getBooking, getEvent, latestEvent } from "./db";
import { writeLog } from "./log";
import { HttpError } from "./http";
import { uuid } from "./ids";
import { applyMoneyEvent } from "./pipeline";
import { getMockGateway } from "./paypal";
import { normalizeWebhook } from "./paypal/normalize";
import { mockWebhookHeaders } from "./paypal/signature";
import { webhookEnvelope, RESOURCE_TYPE } from "./paypal/shapes";
import { handleWebhook } from "./webhook";
import captureDenied from "./fixtures/capture.denied.json";
import capturePending from "./fixtures/capture.pending.json";
import captureRefunded from "./fixtures/capture.refunded.json";
import authorizationVoided from "./fixtures/authorization.voided.json";
import disputeCreated from "./fixtures/dispute.created.json";
import invoicePaid from "./fixtures/invoice.paid.json";

export const FIXTURES: Readonly<Record<DevFixture, unknown>> = {
  "capture.denied": captureDenied,
  "capture.pending": capturePending,
  "capture.refunded": captureRefunded,
  "authorization.voided": authorizationVoided,
  "dispute.created": disputeCreated,
  "invoice.paid": invoicePaid,
};

export function isDevFixture(v: unknown): v is DevFixture {
  return typeof v === "string" && v in FIXTURES;
}

/** Replace "{{name}}" placeholders anywhere in string values. */
export function renderTemplate<T>(tpl: T, vars: Record<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(tpl) as T;
}

function freshId(kind: "CAPTURE" | "REFUND" | "DISPUTE", fallbackPrefix: string): string {
  const mock = getMockGateway();
  return mock ? mock.nextId(kind) : `${fallbackPrefix}-${uuid().slice(0, 8).toUpperCase()}`;
}

/** Render the fixture with the booking's PayPal ids (new ids where the event creates a resource). */
export function renderFixture(fixture: DevFixture, bookingId: string): Record<string, unknown> {
  const b = getBooking(bookingId);
  if (!b) throw new HttpError(404, "BOOKING_NOT_FOUND", `booking ${bookingId} not found`);
  const now = new Date();
  const eventId = `WH-DEV-${uuid().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
  const needsNewCapture = (fixture === "capture.denied" || fixture === "capture.pending") && !b.paypalCaptureId;
  const vars: Record<string, string> = {
    eventId,
    now: now.toISOString(),
    today: now.toISOString().slice(0, 10),
    dueDate: new Date(now.getTime() + 10 * 86400000).toISOString(),
    bookingId: b.id,
    customerName: b.customerName,
    currency: b.currency,
    amount: b.depositAmount,
    balance: b.balanceAmount,
    invoiceRef: `SLOT-${b.id}`,
    orderId: b.paypalOrderId ?? "",
    authorizationId: b.paypalAuthorizationId ?? "",
    captureId: needsNewCapture ? freshId("CAPTURE", "FIXTURE-CAPTURE") : (b.paypalCaptureId ?? ""),
    refundId: freshId("REFUND", "FIXTURE-REFUND"),
    disputeId: freshId("DISPUTE", "PP-D-FIXTURE"),
    invoiceId: b.paypalInvoiceId ?? "",
    invoiceNumber: `${b.id}-bal`,
    paymentId: `FIXTURE-PAY-${uuid().slice(0, 8).toUpperCase()}`,
  };
  return renderTemplate(FIXTURES[fixture] as Record<string, unknown>, vars);
}

export async function injectFixture(fixture: DevFixture, bookingId: string): Promise<DevInjectResponse> {
  const body = renderFixture(fixture, bookingId);
  const norm = normalizeWebhook(body);
  if (norm.kind !== "event") throw new HttpError(500, "BAD_FIXTURE", `fixture ${fixture} did not normalise to a money event`);
  const event: MoneyEvent = { ...norm.event, id: `dev:${uuid()}`, source: "dev", verified: true, bookingId, refs: { ...norm.event.refs, devTools: "1", fixture, paypalEventId: String(body.id) } };
  writeLog({ actor: "operator", kind: "dev.inject", message: `Dev tools: injected ${String(body.event_type)} fixture (${fixture})`, bookingId, refs: { devTools: "1", fixture, eventId: event.id } });

  const mock = getMockGateway();
  if (mock && fixture === "dispute.created") mock.registerDispute(body.resource as Record<string, unknown>);
  if (mock && fixture === "invoice.paid" && event.refs.invoiceId) mock.markInvoicePaid(event.refs.invoiceId);

  const res = await applyMoneyEvent(event, { planning: "await" });
  const plan = await res.planned;
  return { eventId: event.id, outcome: res.outcome, booking: res.booking, plan };
}

/**
 * Re-deliver a recorded event. Webhook events are re-signed (mock mode) and
 * posted through the real webhook handler; dev/API events are re-applied
 * with the same id. Either way the pipeline must answer "duplicate".
 */
export async function replayEvent(eventId?: string): Promise<DevReplayResponse> {
  const stored = eventId ? getEvent(eventId) : latestEvent(["webhook", "dev"]);
  if (!stored) throw new HttpError(404, "EVENT_NOT_FOUND", eventId ? `event ${eventId} not found` : "no webhook or dev event recorded yet");
  writeLog({ actor: "operator", kind: "dev.replay", message: `Dev tools: replaying ${stored.type} ${stored.id}`, bookingId: stored.bookingId, refs: { devTools: "1", eventId: stored.id } });
  if (stored.source === "webhook" && getMockGateway()) {
    const originalType = stored.refs.paypalEventType ?? stored.type;
    const envelope = { ...webhookEnvelope(stored.id, originalType, RESOURCE_TYPE[originalType] ?? "unknown", stored.resource, `Replay of ${stored.id}`), create_time: stored.at };
    const raw = JSON.stringify(envelope);
    const res = await handleWebhook(raw, new Headers(mockWebhookHeaders(raw, `replay-${uuid()}`)));
    return { eventId: stored.id, outcome: res.body.outcome ?? (res.body.ok ? "ok" : "error"), httpStatus: res.status };
  }
  const { receivedAt: _r, outcome: _o, detail: _d, ...event } = stored; // eslint-disable-line @typescript-eslint/no-unused-vars
  const res = await applyMoneyEvent(event, { planning: "skip" });
  return { eventId: stored.id, outcome: res.outcome, httpStatus: 200 };
}
