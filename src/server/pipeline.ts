/**
 * The money-event pipeline. Webhooks (verified), API results and dev fixtures
 * all go through applyMoneyEvent:
 *   record (idempotent by event id) -> resolve booking -> reduce (pure)
 *   -> persist -> log -> broadcast -> maybePlan
 * Recording, reducing and persisting happen in one SQLite transaction, so a
 * crash can never mark an event as seen without applying it.
 */
import type { Actor, Booking, MoneyEvent, Plan } from "@/shared/types";
import { findBookingByPaypalRef, getBooking, insertEventIfNew, saveBooking, setEventOutcome, setInvoiceStatusByPaypalId, tx, type EventOutcome } from "./db";
import { publish } from "./bus";
import { writeLog } from "./log";
import { IllegalTransition, reduce } from "./state";
import { bookingIdFromInvoiceRef } from "./paypal/normalize";
import { nowIso } from "./ids";

export type ApplyOutcome = EventOutcome | "duplicate";

export interface ApplyResult {
  outcome: ApplyOutcome;
  eventId: string;
  booking: Booking | null;
  detail: string | null;
  /** Resolves when planning triggered by this event has finished (null when no plan). */
  planned: Promise<Plan | null>;
}

export interface ApplyOptions {
  /** "await": wait for the planner before returning; "background" (default): fire and forget; "skip": no planning. */
  planning?: "await" | "background" | "skip";
}

/** Find the booking an event belongs to: explicit id, our custom_id / invoice_id hints, then PayPal ids. */
export function resolveBooking(event: MoneyEvent): Booking | null {
  const candidates = [event.bookingId, event.refs.customId, bookingIdFromInvoiceRef(event.refs.invoiceRef)];
  for (const id of candidates) {
    if (id) {
      const b = getBooking(id);
      if (b) return b;
    }
  }
  const byRef: [Parameters<typeof findBookingByPaypalRef>[0], string | undefined][] = [
    ["paypal_dispute_id", event.refs.disputeId],
    ["paypal_refund_id", event.refs.refundId],
    ["paypal_capture_id", event.refs.captureId],
    ["paypal_authorization_id", event.refs.authorizationId],
    ["paypal_invoice_id", event.refs.invoiceId],
    ["paypal_order_id", event.refs.orderId],
  ];
  for (const [field, value] of byRef) {
    if (value) {
      const b = findBookingByPaypalRef(field, value);
      if (b) return b;
    }
  }
  return null;
}

function actorFor(e: MoneyEvent): Actor {
  return e.source === "api" ? "system" : "paypal";
}

function eventRefs(e: MoneyEvent): Record<string, string> {
  const { customId: _c, invoiceRef: _i, ...rest } = e.refs; // eslint-disable-line @typescript-eslint/no-unused-vars
  return { eventId: e.id, eventType: e.type, source: e.source, ...rest };
}

const noPlan: Promise<Plan | null> = Promise.resolve(null);

export async function applyMoneyEvent(event: MoneyEvent, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const receivedAt = nowIso();
  type TxResult =
    | { kind: "duplicate" }
    | { kind: "unmatched" }
    | { kind: "illegal"; booking: Booking; err: IllegalTransition }
    | { kind: "reduced"; before: Booking; after: Booking; outcome: "applied" | "idempotent" | "stale"; idsChanged: boolean };

  const r: TxResult = tx((): TxResult => {
    const booking = resolveBooking(event);
    const fresh = insertEventIfNew({ ...event, bookingId: booking?.id ?? event.bookingId }, receivedAt);
    if (!fresh) return { kind: "duplicate" };
    if (!booking) {
      setEventOutcome(event.id, "unmatched", "no booking matches this event");
      return { kind: "unmatched" };
    }
    try {
      const res = reduce(booking, event);
      const idsChanged = res.booking !== booking;
      if (idsChanged) saveBooking(res.booking);
      if (event.type === "INVOICING.INVOICE.PAID" && res.outcome === "applied") {
        const invId = event.refs.invoiceId ?? res.booking.paypalInvoiceId;
        if (invId) setInvoiceStatusByPaypalId(invId, "PAID");
      }
      setEventOutcome(event.id, res.outcome, `${res.from} -> ${res.to}`, booking.id);
      return { kind: "reduced", before: booking, after: res.booking, outcome: res.outcome, idsChanged };
    } catch (e) {
      if (e instanceof IllegalTransition) {
        setEventOutcome(event.id, "illegal", e.message, booking.id);
        return { kind: "illegal", booking, err: e };
      }
      throw e;
    }
  });

  const actor = actorFor(event);
  const refs = eventRefs(event);
  switch (r.kind) {
    case "duplicate":
      writeLog({ actor: "system", kind: "event.duplicate", message: `Replayed ${event.type} ${event.id} ignored (already processed)`, bookingId: event.bookingId, refs });
      return { outcome: "duplicate", eventId: event.id, booking: event.bookingId ? getBooking(event.bookingId) : null, detail: "already processed", planned: noPlan };
    case "unmatched":
      writeLog({ actor: "system", kind: "event.unmatched", message: `${event.type} ${event.id} matches no booking; recorded and ignored`, refs });
      return { outcome: "unmatched", eventId: event.id, booking: null, detail: "no booking matches this event", planned: noPlan };
    case "illegal":
      writeLog({ actor: "system", kind: "booking.illegal", message: `${r.booking.customerName}: ${r.err.message}; not applied`, bookingId: r.booking.id, refs });
      return { outcome: "illegal", eventId: event.id, booking: r.booking, detail: r.err.message, planned: noPlan };
    case "reduced": {
      const b = r.after;
      if (r.outcome === "applied") {
        const what = r.before.state !== b.state ? `${r.before.state} → ${b.state}` : `balance ${r.before.balanceState} → ${b.balanceState}`;
        writeLog({ actor, kind: "booking.state", message: `${b.customerName}: ${what} (${event.type} via ${event.source})`, bookingId: b.id, refs });
      } else {
        writeLog({ actor, kind: "event.noop", message: `${b.customerName}: ${event.type} via ${event.source} is a no-op (${r.outcome}; booking already ${b.state})`, bookingId: b.id, refs });
      }
      if (r.outcome === "applied" || r.idsChanged) publish({ type: "booking.updated", booking: b });
      let planned = noPlan;
      if (r.outcome === "applied" && opts.planning !== "skip") {
        const { maybePlan } = await import("./planner");
        planned = maybePlan(event, b).catch((e) => {
          writeLog({ actor: "system", kind: "plan.error", message: `planning failed: ${e instanceof Error ? e.message : String(e)}`, bookingId: b.id, refs });
          return null;
        });
        if (opts.planning === "await") await planned;
      }
      return { outcome: r.outcome, eventId: event.id, booking: b, detail: `${r.before.state} -> ${b.state}`, planned };
    }
  }
}
