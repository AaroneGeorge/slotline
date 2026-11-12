/**
 * Dana's demo day for `?demo=1`: the UI runs with no backend, and the same
 * data is the screenshot mode. Mirrors the server seed in BUILD-PLAN §2
 * (Ahmed held with balance invoiced, Lee on the waitlist, Priya confirmed,
 * Marcus held, two free slots), plus a few more jobs so the day looks lived-in.
 * All PayPal ids are MOCK- ids, matching PAYPAL_MODE=mock.
 */
import type { Booking, BookingState, BalanceState, LogEntry, Resource, Service, StateResponse } from "@/shared/types";
import { dayTimeToIso, DEFAULT_OPERATOR_TZ, todayInTz } from "./time";

export const DEMO_PRICES: Record<Service, { deposit: string; balance: string }> = {
  screen: { deposit: "40.00", balance: "109.00" },
  battery: { deposit: "25.00", balance: "54.00" },
  diagnostic: { deposit: "15.00", balance: "24.00" },
  water: { deposit: "45.00", balance: "84.00" },
};

export const DEMO_DURATION: Record<Service, number> = { screen: 60, battery: 45, diagnostic: 30, water: 90 };

export const DEMO_RESOURCES: Resource[] = [
  { id: "van-1", name: "Van 1 (Dana)", color: "#2b59c3" },
  { id: "van-2", name: "Van 2 (Jules)", color: "#7a4fd0" },
];

interface SeedRow {
  id: string;
  customerName: string;
  email: string;
  service: Service;
  resourceId: string | null;
  start: string; // "09:30" operator wall clock
  state: BookingState;
  balanceState?: BalanceState;
  ppn?: number; // mock PayPal id number
  invoice?: boolean;
  notes?: string;
}

const ROWS: SeedRow[] = [
  { id: "bk-priya", customerName: "Priya Raman", email: "priya.r@example.com", service: "screen", resourceId: "van-1", start: "08:30", state: "confirmed", ppn: 1001, notes: "iPhone 15, cracked top-left" },
  { id: "bk-ahmed", customerName: "Ahmed Siddiqui", email: "ahmed.s@example.com", service: "water", resourceId: "van-1", start: "10:00", state: "held", balanceState: "invoiced", ppn: 1002, invoice: true, notes: "Pixel 8 in the pool, rice tried" },
  { id: "bk-nora", customerName: "Nora Fitzgerald", email: "nora.fitz@example.com", service: "battery", resourceId: "van-1", start: "14:00", state: "held", ppn: 1003 },
  { id: "bk-tomas", customerName: "Tomás Reyes", email: "tomas.reyes@example.com", service: "diagnostic", resourceId: "van-1", start: "15:30", state: "quoted", notes: "Boot loop after update" },
  { id: "bk-marcus", customerName: "Marcus Bell", email: "marcus.bell@example.com", service: "screen", resourceId: "van-2", start: "09:00", state: "held", ppn: 1004 },
  { id: "bk-ines", customerName: "Inés Duarte", email: "ines.d@example.com", service: "diagnostic", resourceId: "van-2", start: "10:30", state: "approved", ppn: 1005 },
  { id: "bk-kai", customerName: "Kai Okafor", email: "kai.okafor@example.com", service: "battery", resourceId: "van-2", start: "11:30", state: "pending", ppn: 1006 },
  { id: "bk-sofia", customerName: "Sofia Marin", email: "sofia.marin@example.com", service: "water", resourceId: "van-2", start: "15:30", state: "confirmed", ppn: 1007 },
  { id: "bk-lee", customerName: "Lee Chen", email: "lee.chen@example.com", service: "screen", resourceId: null, start: "10:00", state: "quoted", notes: "Wants 10:00, any van" },
  { id: "bk-gwen", customerName: "Gwen Park", email: "gwen.park@example.com", service: "battery", resourceId: null, start: "13:00", state: "quoted", notes: "Flexible after lunch" },
];

function paypalIdsFor(row: SeedRow): Pick<
  Booking,
  "paypalOrderId" | "paypalAuthorizationId" | "paypalCaptureId" | "paypalRefundId" | "paypalInvoiceId" | "paypalDisputeId"
> {
  const n = row.ppn;
  const has = (states: BookingState[]) => n !== undefined && states.includes(row.state);
  return {
    paypalOrderId: has(["approved", "held", "pending", "confirmed", "declined", "disputed", "refunded"]) ? `MOCK-ORDER-${n}` : null,
    paypalAuthorizationId: has(["held", "pending", "confirmed", "declined", "disputed", "refunded"]) ? `MOCK-AUTH-${n}` : null,
    paypalCaptureId: has(["confirmed", "disputed", "refunded"]) ? `MOCK-CAPTURE-${n}` : null,
    paypalRefundId: has(["refunded"]) ? `MOCK-REFUND-${n}` : null,
    paypalInvoiceId: row.invoice && n !== undefined ? `MOCK-INV-${n}` : null,
    paypalDisputeId: has(["disputed"]) ? `MOCK-DISPUTE-${n}` : null,
  };
}

export function buildSeedBookings(day: string, tz: string, now = Date.now()): Booking[] {
  return ROWS.map((row, i) => {
    const startAt = dayTimeToIso(day, row.start, tz);
    const durationMin = DEMO_DURATION[row.service];
    const endAt = new Date(new Date(startAt).getTime() + durationMin * 60_000).toISOString();
    const created = new Date(now - (180 - i * 12) * 60_000).toISOString();
    const price = DEMO_PRICES[row.service];
    return {
      id: row.id,
      resourceId: row.resourceId,
      waitlist: row.resourceId === null,
      customerName: row.customerName,
      customerEmail: row.email,
      service: row.service,
      startAt,
      endAt,
      durationMin,
      depositAmount: price.deposit,
      balanceAmount: price.balance,
      currency: "USD",
      state: row.state,
      balanceState: row.balanceState ?? "none",
      ...paypalIdsFor(row),
      notes: row.notes ?? null,
      createdAt: created,
      updatedAt: created,
    };
  });
}

/** A believable morning of history so the Log tab shows all five actors. */
export function buildSeedLog(now = Date.now()): LogEntry[] {
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  let n = 0;
  const e = (minAgo: number, actor: LogEntry["actor"], kind: string, message: string, bookingId: string | null, refs: Record<string, string> = {}): LogEntry => ({
    id: `seed-log-${++n}`,
    at: at(minAgo),
    actor,
    kind,
    message,
    bookingId,
    refs,
  });
  const entries: LogEntry[] = [
    e(171, "system", "seed", "Dana's day loaded: 8 jobs on 2 vans, 2 on the waitlist", null),
    e(166, "customer", "booking.created", "Priya Raman booked a screen replacement for 8:30 AM", "bk-priya"),
    e(165.5, "paypal", "webhook.received", "CHECKOUT.ORDER.APPROVED (verified)", "bk-priya", { eventId: "WH-MOCK-7001", orderId: "MOCK-ORDER-1001" }),
    e(165, "paypal", "webhook.received", "PAYMENT.AUTHORIZATION.CREATED (verified): $40 deposit held", "bk-priya", { eventId: "WH-MOCK-7002", authorizationId: "MOCK-AUTH-1001" }),
    e(150, "customer", "booking.created", "Ahmed Siddiqui booked water-damage repair for 10:00 AM", "bk-ahmed"),
    e(149, "paypal", "webhook.received", "PAYMENT.AUTHORIZATION.CREATED (verified): $45 deposit held", "bk-ahmed", { eventId: "WH-MOCK-7003", authorizationId: "MOCK-AUTH-1002" }),
    e(140, "agent", "plan.proposed", "Balance for Ahmed is $84: proposed a PayPal invoice so he can pay on site by QR", "bk-ahmed", { planId: "PLN-0001" }),
    e(138.5, "operator", "plan.approved", "Dana approved “Send Ahmed's balance invoice”", "bk-ahmed", { planId: "PLN-0001", grantId: "GRT-0001" }),
    e(138, "system", "grant.minted", "Grant GRT-0001: send_invoice on bk-ahmed, max $84.00, 15 min", "bk-ahmed", { grantId: "GRT-0001" }),
    e(137, "system", "paypal.call", "POST /v2/invoicing/invoices + /send → 201", "bk-ahmed", { grantId: "GRT-0001", invoiceId: "MOCK-INV-1002" }),
    e(120, "customer", "booking.created", "Marcus Bell booked a screen replacement for 9:00 AM", "bk-marcus"),
    e(119, "paypal", "webhook.received", "PAYMENT.AUTHORIZATION.CREATED (verified): $40 deposit held", "bk-marcus", { eventId: "WH-MOCK-7004", authorizationId: "MOCK-AUTH-1004" }),
    e(96, "customer", "booking.created", "Lee Chen asked for 10:00 AM; both vans busy, added to the waitlist", "bk-lee"),
    e(70.5, "system", "paypal.call", "POST /v2/payments/authorizations/MOCK-AUTH-1001/capture → 201 COMPLETED", "bk-priya", { captureId: "MOCK-CAPTURE-1001" }),
    e(70, "paypal", "webhook.received", "PAYMENT.CAPTURE.COMPLETED (verified): Priya confirmed", "bk-priya", { eventId: "WH-MOCK-7005", captureId: "MOCK-CAPTURE-1001" }),
    e(52, "paypal", "webhook.received", "PAYMENT.CAPTURE.PENDING (verified): Kai's capture in review", "bk-kai", { eventId: "WH-MOCK-7006", captureId: "MOCK-CAPTURE-1006" }),
    e(31, "paypal", "webhook.received", "CHECKOUT.ORDER.APPROVED (verified): Inés approved, authorization next", "bk-ines", { eventId: "WH-MOCK-7007", orderId: "MOCK-ORDER-1005" }),
    e(12, "paypal", "webhook.replayed", "PAYMENT.AUTHORIZATION.CREATED replayed: event id already seen, ignored", "bk-marcus", { eventId: "WH-MOCK-7004" }),
  ];
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

export function buildDemoState(tz = DEFAULT_OPERATOR_TZ, now = Date.now()): StateResponse & { timeZone: string } {
  const day = todayInTz(tz, new Date(now));
  return {
    resources: DEMO_RESOURCES.map((r) => ({ ...r })),
    bookings: buildSeedBookings(day, tz, now),
    plans: [],
    log: buildSeedLog(now),
    mode: { paypal: "mock", llm: "rules", devTools: true },
    day,
    timeZone: tz,
  };
}
