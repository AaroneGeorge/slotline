/** Dispute-grade evidence pack for one booking: PayPal objects, events, log, plans, grants. */
import type { EvidencePack, Grant, Plan } from "@/shared/types";
import { getBooking, listEventsForBooking, listGrantsForPlan, listLogForBooking, listPlans, listResources, publicGrant } from "./db";
import { operatorTz } from "./config";
import { HttpError } from "./http";
import { getGateway } from "./paypal";
import { localHhmm } from "./time";
import { nowIso } from "./ids";
import { writeLog } from "./log";

type Obj = Record<string, unknown>;

async function tryRead<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function buildEvidencePack(bookingId: string): Promise<EvidencePack> {
  const b = getBooking(bookingId);
  if (!b) throw new HttpError(404, "BOOKING_NOT_FOUND", `booking ${bookingId} not found`);
  const tz = operatorTz();
  const events = listEventsForBooking(b.id);
  const lastResource = (types: string[]): Obj | null => {
    for (let i = events.length - 1; i >= 0; i--) if (types.includes(events[i].type) && Object.keys(events[i].resource).length) return events[i].resource;
    return null;
  };

  const gw = getGateway();
  const live = {
    order: b.paypalOrderId ? await tryRead(() => gw.getOrder(b.paypalOrderId!)) : null,
    authorization: b.paypalAuthorizationId ? await tryRead(() => gw.getAuthorization(b.paypalAuthorizationId!)) : null,
    invoice: b.paypalInvoiceId ? await tryRead(async () => (await gw.getInvoice(b.paypalInvoiceId!)).raw) : null,
    dispute: b.paypalDisputeId ? await tryRead(async () => (await gw.getDispute(b.paypalDisputeId!)).raw) : null,
  };
  const paypal = {
    order: live.order ?? lastResource(["CHECKOUT.ORDER.APPROVED"]),
    authorization: live.authorization ?? lastResource(["PAYMENT.AUTHORIZATION.CREATED", "PAYMENT.AUTHORIZATION.VOIDED"]),
    capture: lastResource(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED"]),
    refund: lastResource(["PAYMENT.CAPTURE.REFUNDED"]),
    invoice: live.invoice ?? lastResource(["INVOICING.INVOICE.PAID"]),
    dispute: live.dispute ?? lastResource(["CUSTOMER.DISPUTE.CREATED"]),
  };
  const paypalSource: "api" | "events" = live.order || live.authorization || live.invoice || live.dispute ? "api" : "events";
  const read = Object.entries(live).filter(([, v]) => v).map(([k]) => k);
  if (read.length) writeLog({ actor: "system", kind: "paypal.read", message: `Evidence pack: read ${read.join(", ")} from PayPal (${gw.mode})`, bookingId: b.id, refs: { paypalMode: gw.mode, orderId: b.paypalOrderId, authorizationId: b.paypalAuthorizationId, invoiceId: b.paypalInvoiceId, disputeId: b.paypalDisputeId } });

  const timeline = listLogForBooking(b.id);
  const plans: Plan[] = listPlans().filter((p) => p.trigger.bookingId === b.id || p.options.some((o) => o.actions.some((a) => a.bookingId === b.id)));
  const grants: Grant[] = plans.flatMap((p) => listGrantsForPlan(p.id)).filter((gr) => gr.bookingIds.includes(b.id)).map(publicGrant);

  const facts: string[] = [];
  facts.push(`${b.customerName} booked ${b.service} for ${localHhmm(b.startAt, tz)}–${localHhmm(b.endAt, tz)} (${tz}) on ${b.resourceId ?? "the waitlist"}; deposit ${b.depositAmount} ${b.currency}, balance ${b.balanceAmount} ${b.currency}.`);
  for (const e of events) {
    if (e.outcome !== "applied") continue;
    const t = localHhmm(e.receivedAt, tz);
    const via = e.source === "webhook" ? "PayPal webhook (signature verified)" : e.source === "api" ? "PayPal API response" : "dev fixture";
    const id = e.refs.captureId ?? e.refs.authorizationId ?? e.refs.refundId ?? e.refs.invoiceId ?? e.refs.disputeId ?? e.refs.orderId ?? "";
    facts.push(`${t} ${e.type}${id ? ` ${id}` : ""} via ${via}${e.detail ? ` (${e.detail})` : ""}.`);
  }
  for (const gr of grants) facts.push(`${localHhmm(gr.issuedAt, tz)} operator approved execution grant ${gr.id} (${gr.allowedActions.join(", ")}; max ${gr.maxAmount} ${gr.currency}; ${gr.status}).`);
  facts.push(`Current state: ${b.state}; balance ${b.balanceState}.`);

  return {
    booking: b,
    generatedAt: nowIso(),
    ...paypal,
    timeline,
    events,
    facts,
    resource: listResources().find((r) => r.id === b.resourceId) ?? null,
    paypalSource,
    plans,
    grants,
  };
}
