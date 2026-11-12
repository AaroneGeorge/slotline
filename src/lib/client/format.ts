import type {
  Actor,
  BalanceState,
  Booking,
  BookingState,
  PlanActionType,
  Service,
} from "@/shared/types";

/** Display metadata per booking state. Colour is never the only cue: every state has an icon and a label. */
export interface StateMeta {
  label: string;
  short: string;
  /** what the money is doing, in Dana's words */
  money: string;
  /** FontAwesome 6 solid icon name (bundled with Bryntum) */
  fa: string;
  /** glyph used outside Bryntum, where FontAwesome is not loaded */
  glyph: string;
  onTimeline: boolean;
}

export const STATE_META: Record<BookingState, StateMeta> = {
  quoted: { label: "Quoted", short: "quoted", money: "No money yet", fa: "fa-hourglass-start", glyph: "◌", onTimeline: true },
  approved: { label: "Approved", short: "approved", money: "Buyer approved in PayPal", fa: "fa-circle-check", glyph: "◎", onTimeline: true },
  held: { label: "Deposit held", short: "held", money: "Authorization holds the deposit", fa: "fa-lock", glyph: "●", onTimeline: true },
  pending: { label: "Capture pending", short: "pending", money: "Capture in PayPal review", fa: "fa-clock", glyph: "◐", onTimeline: true },
  confirmed: { label: "Confirmed", short: "confirmed", money: "Deposit captured", fa: "fa-check-double", glyph: "✓", onTimeline: true },
  declined: { label: "Capture declined", short: "declined", money: "Slot at risk: capture declined", fa: "fa-triangle-exclamation", glyph: "▲", onTimeline: true },
  released: { label: "Released", short: "released", money: "Hold voided, slot free", fa: "fa-unlock", glyph: "○", onTimeline: false },
  refunded: { label: "Refunded", short: "refunded", money: "Customer repaid, slot free", fa: "fa-rotate-left", glyph: "↺", onTimeline: false },
  disputed: { label: "Disputed", short: "disputed", money: "Dispute open: evidence needed", fa: "fa-flag", glyph: "⚑", onTimeline: true },
};

export const STATE_ORDER: BookingState[] = [
  "quoted",
  "approved",
  "held",
  "pending",
  "confirmed",
  "declined",
  "disputed",
  "released",
  "refunded",
];

export const BALANCE_LABEL: Record<BalanceState, string> = {
  none: "no balance invoice",
  invoiced: "balance invoiced",
  paid: "balance paid",
};

export const SERVICE_META: Record<Service, { label: string; minutes: number; blurb: string }> = {
  screen: { label: "Screen replacement", minutes: 60, blurb: "Cracked or dead display" },
  battery: { label: "Battery swap", minutes: 45, blurb: "Drains fast or swollen" },
  diagnostic: { label: "Diagnostic", minutes: 30, blurb: "Not sure what's wrong" },
  water: { label: "Water damage", minutes: 90, blurb: "Dropped it in the drink" },
};

export const SERVICES: Service[] = ["screen", "battery", "diagnostic", "water"];

export const ACTOR_META: Record<Actor, { label: string; hint: string }> = {
  customer: { label: "customer", hint: "The person booking and paying" },
  operator: { label: "operator", hint: "Dana, approving on the dashboard" },
  agent: { label: "agent", hint: "The planner proposing options" },
  system: { label: "system", hint: "Slotline code: solver, grants, PayPal calls" },
  paypal: { label: "paypal", hint: "PayPal webhooks and API results" },
};

export const ACTORS: Actor[] = ["customer", "operator", "agent", "system", "paypal"];

export const ACTION_META: Record<PlanActionType, { label: string; money: boolean }> = {
  move: { label: "Move", money: false },
  promote: { label: "Promote", money: false },
  void: { label: "Void hold", money: true },
  capture: { label: "Capture", money: true },
  refund: { label: "Refund", money: true },
  send_invoice: { label: "Invoice", money: true },
  send_reminder: { label: "Remind", money: true },
  message: { label: "Message", money: false },
  flag_dispute: { label: "Evidence pack", money: false },
};

export function money(amount: string | number | null | undefined, currency = "USD"): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** Sum of decimal strings without float drift (cents). */
export function sumAmounts(values: (string | null | undefined)[]): number {
  return values.reduce((acc, v) => acc + Math.round(Number(v ?? 0) * 100), 0) / 100;
}

export function shortId(id: string | null | undefined, keep = 10): string {
  if (!id) return "—";
  return id.length > keep + 1 ? `${id.slice(0, keep)}…` : id;
}

export function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

export function isOnTimeline(b: Booking): boolean {
  return Boolean(b.resourceId) && !b.waitlist && STATE_META[b.state].onTimeline;
}

/** PayPal ids on a booking, in lifecycle order, for tooltips and chips. */
export function paypalRefs(b: Booking): { label: string; key: string; value: string }[] {
  const rows: { label: string; key: string; value: string | null }[] = [
    { label: "Order", key: "orderId", value: b.paypalOrderId },
    { label: "Authorization", key: "authorizationId", value: b.paypalAuthorizationId },
    { label: "Capture", key: "captureId", value: b.paypalCaptureId },
    { label: "Refund", key: "refundId", value: b.paypalRefundId },
    { label: "Invoice", key: "invoiceId", value: b.paypalInvoiceId },
    { label: "Dispute", key: "disputeId", value: b.paypalDisputeId },
  ];
  return rows.filter((r): r is { label: string; key: string; value: string } => Boolean(r.value));
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
