/**
 * Map PayPal webhook bodies (and API results) onto Slotline MoneyEvents.
 * Webhook names are used verbatim, except that the Payments v2 name
 * PAYMENT.CAPTURE.DECLINED is normalised to PAYMENT.CAPTURE.DENIED (the v1
 * name used by the shared contract); the original is kept in refs.paypalEventType.
 */
import type { MoneyEvent, MoneyEventType } from "@/shared/types";
import { isMoneyEventType } from "../state";
import { uuid } from "../ids";

export const EVENT_ALIASES: Readonly<Record<string, MoneyEventType>> = {
  "PAYMENT.CAPTURE.DECLINED": "PAYMENT.CAPTURE.DENIED",
};

/** Event types the webhook should be subscribed to (scripts/register-webhook.ts). */
export const SUBSCRIBED_EVENT_TYPES = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "INVOICING.INVOICE.PAID",
  "CUSTOMER.DISPUTE.CREATED",
] as const;

export function canonicalEventType(t: string): MoneyEventType | null {
  if (isMoneyEventType(t)) return t;
  return EVENT_ALIASES[t] ?? null;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? (v as Obj[]) : [];
}

function linkId(resource: Obj, rel: string, segment: string): string | undefined {
  for (const l of arr(resource.links)) {
    if (l.rel === rel && typeof l.href === "string") {
      const m = l.href.match(new RegExp(`/${segment}/([^/?#]+)`));
      if (m) return m[1];
    }
  }
  return undefined;
}

/** PayPal resource ids + our booking hints (customId, invoiceRef) carried by a resource. */
export function refsFromResource(type: MoneyEventType, resource: Obj): Record<string, string> {
  const refs: Record<string, string | undefined> = {};
  const related = obj(obj(resource.supplementary_data).related_ids);
  switch (type) {
    case "CHECKOUT.ORDER.APPROVED": {
      const pu = obj(arr(resource.purchase_units)[0]);
      refs.orderId = str(resource.id);
      refs.customId = str(pu.custom_id);
      refs.invoiceRef = str(pu.invoice_id);
      break;
    }
    case "PAYMENT.AUTHORIZATION.CREATED":
    case "PAYMENT.AUTHORIZATION.VOIDED":
      refs.authorizationId = str(resource.id);
      refs.orderId = str(related.order_id);
      refs.customId = str(resource.custom_id);
      refs.invoiceRef = str(resource.invoice_id);
      break;
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.PENDING":
      refs.captureId = str(resource.id);
      refs.authorizationId = str(related.authorization_id) ?? linkId(resource, "up", "authorizations");
      refs.orderId = str(related.order_id);
      refs.customId = str(resource.custom_id);
      refs.invoiceRef = str(resource.invoice_id);
      break;
    case "PAYMENT.CAPTURE.REFUNDED":
      refs.refundId = str(resource.id);
      refs.captureId = linkId(resource, "up", "captures");
      refs.customId = str(resource.custom_id);
      refs.invoiceRef = str(resource.invoice_id);
      break;
    case "INVOICING.INVOICE.PAID": {
      const inv = Object.keys(obj(resource.invoice)).length ? obj(resource.invoice) : resource;
      const detail = obj(inv.detail);
      refs.invoiceId = str(inv.id);
      refs.customId = str(detail.reference);
      refs.invoiceRef = str(detail.invoice_number);
      break;
    }
    case "CUSTOMER.DISPUTE.CREATED": {
      const t = obj(arr(resource.disputed_transactions)[0]);
      refs.disputeId = str(resource.dispute_id);
      refs.captureId = str(t.seller_transaction_id);
      refs.customId = str(t.custom);
      refs.invoiceRef = str(t.invoice_number);
      break;
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(refs)) if (v) out[k] = v;
  return out;
}

/** Booking id encoded in our invoice ids: "SLOT-<bookingId>" or "SLOT-<bookingId>-BAL". */
export function bookingIdFromInvoiceRef(ref: string | undefined): string | null {
  if (!ref) return null;
  const m = ref.match(/^SLOT-(.+?)(?:-BAL(?:-\d+)?)?$/);
  return m ? m[1] : null;
}

export type NormalizedWebhook =
  | { kind: "event"; event: MoneyEvent }
  | { kind: "unknown"; id: string; type: string; at: string; resource: Obj }
  | { kind: "invalid"; reason: string };

export function normalizeWebhook(body: unknown): NormalizedWebhook {
  const b = obj(body);
  const id = str(b.id);
  const rawType = str(b.event_type);
  if (!id || !rawType) return { kind: "invalid", reason: "webhook body has no id or event_type" };
  const at = str(b.create_time) ?? new Date().toISOString();
  const resource = obj(b.resource);
  const type = canonicalEventType(rawType);
  if (!type) return { kind: "unknown", id, type: rawType, at, resource };
  const refs = refsFromResource(type, resource);
  if (rawType !== type) refs.paypalEventType = rawType;
  return {
    kind: "event",
    event: { id, type, at, source: "webhook", verified: true, bookingId: null, resource, refs },
  };
}

/** An event derived from our own (authenticated) API call result. */
export function apiEvent(type: MoneyEventType, bookingId: string, resource: Obj, extraRefs: Record<string, string | null | undefined> = {}): MoneyEvent {
  const refs = refsFromResource(type, resource);
  for (const [k, v] of Object.entries(extraRefs)) if (v) refs[k] = v;
  return { id: `api:${uuid()}`, type, at: new Date().toISOString(), source: "api", verified: true, bookingId, resource, refs };
}
