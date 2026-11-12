/**
 * Booking state machine (pure). BUILD-PLAN §4. Money events are the only way
 * `Booking.state` changes; illegal transitions throw `IllegalTransition` and
 * are logged by the caller, never applied.
 */
import type { Booking, BookingState, MoneyEvent, MoneyEventType } from "@/shared/types";

export const MONEY_EVENT_TYPES: readonly MoneyEventType[] = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "INVOICING.INVOICE.PAID",
  "CUSTOMER.DISPUTE.CREATED",
] as const;

export const BOOKING_STATES: readonly BookingState[] = [
  "quoted",
  "approved",
  "held",
  "pending",
  "confirmed",
  "declined",
  "released",
  "refunded",
  "disputed",
] as const;

export function isMoneyEventType(v: unknown): v is MoneyEventType {
  return typeof v === "string" && (MONEY_EVENT_TYPES as readonly string[]).includes(v);
}

/** "idem" = legal no-op (same state); "balance" = only balanceState changes (INVOICE.PAID). */
type Cell = BookingState | "idem" | "balance";

export const TRANSITIONS: Readonly<Record<BookingState, Partial<Record<MoneyEventType, Cell>>>> = {
  quoted: {
    "CHECKOUT.ORDER.APPROVED": "approved",
    "PAYMENT.AUTHORIZATION.CREATED": "held",
    "PAYMENT.AUTHORIZATION.VOIDED": "released",
    "INVOICING.INVOICE.PAID": "balance",
  },
  approved: {
    "CHECKOUT.ORDER.APPROVED": "idem",
    "PAYMENT.AUTHORIZATION.CREATED": "held",
    "PAYMENT.AUTHORIZATION.VOIDED": "released",
    "INVOICING.INVOICE.PAID": "balance",
  },
  held: {
    "PAYMENT.AUTHORIZATION.CREATED": "idem",
    "PAYMENT.AUTHORIZATION.VOIDED": "released",
    "PAYMENT.CAPTURE.COMPLETED": "confirmed",
    "PAYMENT.CAPTURE.DENIED": "declined",
    "PAYMENT.CAPTURE.PENDING": "pending",
    "INVOICING.INVOICE.PAID": "balance",
    "CUSTOMER.DISPUTE.CREATED": "disputed",
  },
  pending: {
    "PAYMENT.CAPTURE.COMPLETED": "confirmed",
    "PAYMENT.CAPTURE.DENIED": "declined",
    "PAYMENT.CAPTURE.PENDING": "idem",
    "PAYMENT.CAPTURE.REFUNDED": "refunded",
    "INVOICING.INVOICE.PAID": "balance",
    "CUSTOMER.DISPUTE.CREATED": "disputed",
  },
  confirmed: {
    "PAYMENT.CAPTURE.COMPLETED": "idem",
    "PAYMENT.CAPTURE.REFUNDED": "refunded",
    "INVOICING.INVOICE.PAID": "balance",
    "CUSTOMER.DISPUTE.CREATED": "disputed",
  },
  declined: {
    "PAYMENT.AUTHORIZATION.CREATED": "held",
    "PAYMENT.AUTHORIZATION.VOIDED": "released",
    "PAYMENT.CAPTURE.COMPLETED": "confirmed",
    "PAYMENT.CAPTURE.DENIED": "idem",
    "PAYMENT.CAPTURE.PENDING": "pending",
    "INVOICING.INVOICE.PAID": "balance",
    "CUSTOMER.DISPUTE.CREATED": "disputed",
  },
  released: {
    "PAYMENT.AUTHORIZATION.CREATED": "held",
    "PAYMENT.AUTHORIZATION.VOIDED": "idem",
  },
  refunded: {
    "PAYMENT.CAPTURE.REFUNDED": "idem",
    "CUSTOMER.DISPUTE.CREATED": "disputed",
  },
  disputed: {
    "PAYMENT.CAPTURE.REFUNDED": "refunded",
    "CUSTOMER.DISPUTE.CREATED": "idem",
  },
};

export class IllegalTransition extends Error {
  readonly code = "ILLEGAL_TRANSITION";
  constructor(
    readonly from: BookingState,
    readonly eventType: MoneyEventType,
    readonly bookingId: string,
  ) {
    super(`illegal transition: ${eventType} while booking ${bookingId} is ${from}`);
    this.name = "IllegalTransition";
  }
}

export type ReduceOutcome = "applied" | "idempotent" | "stale";

export interface ReduceResult {
  booking: Booking;
  outcome: ReduceOutcome;
  from: BookingState;
  to: BookingState;
}

/** Whether `type` is a legal (possibly no-op) event in `state`. */
export function isLegal(state: BookingState, type: MoneyEventType): boolean {
  return TRANSITIONS[state][type] !== undefined;
}

/** The state `type` would move a booking in `state` to, or null if illegal. */
export function nextState(state: BookingState, type: MoneyEventType): BookingState | null {
  const cell = TRANSITIONS[state][type];
  if (cell === undefined) return null;
  if (cell === "idem" || cell === "balance") return state;
  return cell;
}

/** The states in which the booking occupies a slot on the timeline (when it has a resource). */
export function occupiesSlot(b: Pick<Booking, "state" | "waitlist" | "resourceId">): boolean {
  return !b.waitlist && b.resourceId !== null && b.state !== "released" && b.state !== "refunded";
}

// PayPal resource ids carried by an event (set by the normaliser / API mapper).
function ref(e: MoneyEvent, key: string): string | null {
  const v = e.refs[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * A late delivery for a resource the booking has already moved past
 * (e.g. the CHECKOUT.ORDER.APPROVED webhook arriving after our own
 * authorize call made the booking `held`, or the original
 * PAYMENT.AUTHORIZATION.CREATED webhook arriving after the capture was
 * declined). Only recognised when the event's PayPal resource id matches the
 * one on file, so genuinely out-of-order events (no matching id) are still
 * illegal, and a re-authorization (new authorization id) still applies.
 */
export function isStale(b: Booking, e: MoneyEvent): boolean {
  const orderId = ref(e, "orderId");
  const authId = ref(e, "authorizationId");
  const captureId = ref(e, "captureId");
  switch (e.type) {
    case "CHECKOUT.ORDER.APPROVED":
      return orderId !== null && orderId === b.paypalOrderId && b.state !== "quoted" && b.state !== "approved";
    case "PAYMENT.AUTHORIZATION.CREATED":
      return authId !== null && authId === b.paypalAuthorizationId && !["quoted", "approved", "held"].includes(b.state);
    case "PAYMENT.CAPTURE.PENDING":
      return captureId !== null && captureId === b.paypalCaptureId && ["declined", "confirmed", "refunded", "disputed"].includes(b.state);
    case "PAYMENT.CAPTURE.COMPLETED":
      return captureId !== null && captureId === b.paypalCaptureId && ["refunded", "disputed"].includes(b.state);
    case "PAYMENT.CAPTURE.DENIED":
      return captureId !== null && captureId === b.paypalCaptureId && ["confirmed", "refunded", "disputed"].includes(b.state);
    case "PAYMENT.AUTHORIZATION.VOIDED":
      return authId !== null && authId === b.paypalAuthorizationId && b.state === "released";
    default:
      return false;
  }
}

/**
 * Pure reducer. Returns the next booking (a new object) and what happened.
 * Throws IllegalTransition for "—" cells of the table.
 */
export function reduce(booking: Booking, event: MoneyEvent): ReduceResult {
  const from = booking.state;
  const cell = TRANSITIONS[from][event.type];
  if (cell === undefined) {
    if (isStale(booking, event)) return { booking, outcome: "stale", from, to: from };
    throw new IllegalTransition(from, event.type, booking.id);
  }
  if (cell !== "idem" && cell !== "balance" && isStale(booking, event)) {
    return { booking, outcome: "stale", from, to: from };
  }
  if (cell === "idem") {
    // Fill in ids we did not have yet (e.g. capture id arriving with a webhook), but no state change.
    const filled = withRefs(booking, event);
    const changedIds = filled !== booking;
    return { booking: changedIds ? { ...filled, updatedAt: event.at > booking.updatedAt ? event.at : booking.updatedAt } : booking, outcome: "idempotent", from, to: from };
  }
  let next: Booking = withRefs({ ...booking }, event);
  if (cell === "balance") {
    if (booking.balanceState === "paid") return { booking, outcome: "idempotent", from, to: from };
    next = { ...next, balanceState: "paid" };
  } else {
    next = { ...next, state: cell };
    if (cell === "released" || cell === "refunded") next.waitlist = false;
  }
  next.updatedAt = new Date().toISOString();
  return { booking: next, outcome: "applied", from, to: next.state };
}

/** Copy PayPal ids from the event refs onto the booking (returns the same object when nothing changes). */
function withRefs(b: Booking, e: MoneyEvent): Booking {
  const patch: Partial<Booking> = {};
  const set = <K extends keyof Booking>(k: K, v: Booking[K] | null) => {
    if (v !== null && v !== undefined && b[k] !== v) patch[k] = v;
  };
  switch (e.type) {
    case "CHECKOUT.ORDER.APPROVED":
      if (!b.paypalOrderId) set("paypalOrderId", ref(e, "orderId"));
      break;
    case "PAYMENT.AUTHORIZATION.CREATED":
      set("paypalAuthorizationId", ref(e, "authorizationId"));
      if (!b.paypalOrderId) set("paypalOrderId", ref(e, "orderId"));
      break;
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.PENDING":
    case "PAYMENT.CAPTURE.DENIED":
      set("paypalCaptureId", ref(e, "captureId"));
      if (!b.paypalAuthorizationId) set("paypalAuthorizationId", ref(e, "authorizationId"));
      break;
    case "PAYMENT.CAPTURE.REFUNDED":
      set("paypalRefundId", ref(e, "refundId"));
      if (!b.paypalCaptureId) set("paypalCaptureId", ref(e, "captureId"));
      break;
    case "INVOICING.INVOICE.PAID":
      if (!b.paypalInvoiceId) set("paypalInvoiceId", ref(e, "invoiceId"));
      break;
    case "CUSTOMER.DISPUTE.CREATED":
      set("paypalDisputeId", ref(e, "disputeId"));
      break;
    default:
      break;
  }
  return Object.keys(patch).length === 0 ? b : { ...b, ...patch };
}
