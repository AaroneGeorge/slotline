/**
 * Dana's demo day (operator day = today in OPERATOR_TZ). Two vans; Ahmed held
 * with his balance invoiced, Lee on the waitlist, Priya confirmed, Marcus held,
 * Sofia quoted (unpaid, movable), and free time on both vans. Seeded states
 * are reached through the money-event pipeline (source "dev", refs.seed=1),
 * never by writing `state` directly. In mock mode the PayPal objects exist in
 * the MockGateway, so capture/void/refund work on them.
 */
import type { Booking, MoneyEvent, MoneyEventType, Resource, Service } from "@/shared/types";
import { getBooking, listBookings, saveBooking, saveInvoice, setMeta, upsertResource, wipeAll } from "./db";
import { appMode, currency, operatorTz } from "./config";
import { publish } from "./bus";
import { writeLog } from "./log";
import { newId, nowIso, uuid } from "./ids";
import { PRICES } from "./pricing";
import { serviceDuration } from "./solver";
import { addMinutes, operatorDayOf, zonedToUtc } from "./time";
import { applyMoneyEvent } from "./pipeline";
import { refsFromResource } from "./paypal/normalize";
import { getMockGateway } from "./paypal";

export const SEED_RESOURCES: Resource[] = [
  { id: "van-1", name: "Van 1 (Dana)", color: "#2563eb" },
  { id: "van-2", name: "Van 2 (Sam)", color: "#7c3aed" },
];

interface SeedSpec {
  key: string;
  name: string;
  email: string;
  service: Service;
  van: string | null;
  at: string; // local "HH:MM"
  target: "quoted" | "held" | "confirmed";
  balanceInvoiced?: boolean;
}

export const SEED_SPECS: SeedSpec[] = [
  { key: "ahmed", name: "Ahmed Khan", email: "ahmed@example.com", service: "screen", van: "van-1", at: "08:30", target: "held", balanceInvoiced: true },
  { key: "marcus", name: "Marcus Webb", email: "marcus@example.com", service: "battery", van: "van-1", at: "10:00", target: "held" },
  { key: "priya", name: "Priya Patel", email: "priya@example.com", service: "screen", van: "van-2", at: "09:30", target: "confirmed" },
  { key: "sofia", name: "Sofia Reyes", email: "sofia@example.com", service: "diagnostic", van: "van-2", at: "11:30", target: "quoted" },
  { key: "lee", name: "Lee Chen", email: "lee@example.com", service: "battery", van: null, at: "10:00", target: "quoted" },
];

function seedEvent(type: MoneyEventType, bookingId: string, resource: Record<string, unknown>): MoneyEvent {
  return { id: `dev:seed:${uuid()}`, type, at: nowIso(), source: "dev", verified: true, bookingId, resource, refs: { ...refsFromResource(type, resource), seed: "1" } };
}

export interface SeedResult {
  day: string;
  bookings: Booking[];
}

export async function seedDemoDay(now = new Date()): Promise<SeedResult> {
  const tz = operatorTz();
  const day = operatorDayOf(now, tz);
  const mock = getMockGateway();
  mock?.cancelPendingWebhooks();
  const previous = listBookings().map((b) => b.id);

  wipeAll();
  setMeta("seedDay", day);
  SEED_RESOURCES.forEach((r, i) => upsertResource(r, i));
  for (const id of previous) publish({ type: "booking.removed", bookingId: id });

  const cur = currency();
  const created: Booking[] = [];
  for (const s of SEED_SPECS) {
    const price = PRICES[s.service];
    const startAt = zonedToUtc(day, s.at, tz).toISOString();
    const durationMin = serviceDuration(s.service);
    const ts = nowIso();
    const b: Booking = {
      id: newId("bk"),
      resourceId: s.van,
      waitlist: s.van === null,
      customerName: s.name,
      customerEmail: s.email,
      service: s.service,
      startAt,
      endAt: addMinutes(startAt, durationMin),
      durationMin,
      depositAmount: price.deposit,
      balanceAmount: price.balance,
      currency: cur,
      state: "quoted",
      balanceState: "none",
      paypalOrderId: null,
      paypalAuthorizationId: null,
      paypalCaptureId: null,
      paypalRefundId: null,
      paypalInvoiceId: null,
      paypalDisputeId: null,
      notes: `seed:${s.key}`,
      createdAt: ts,
      updatedAt: ts,
    };
    saveBooking(b);
    publish({ type: "booking.updated", booking: b });

    if (s.target !== "quoted") {
      // Mock mode: real mock PayPal objects. Sandbox mode: no PayPal ids (money actions on seeded jobs are infeasible).
      const ids = mock ? mock.seedAuthorization({ bookingId: b.id, value: b.depositAmount, currency: cur, description: `Slotline deposit: ${price.label}` }) : null;
      const orderRes = { id: ids?.orderId, status: "APPROVED", purchase_units: [{ custom_id: b.id, invoice_id: `SLOT-${b.id}` }] };
      await applyMoneyEvent(seedEvent("CHECKOUT.ORDER.APPROVED", b.id, ids ? orderRes : {}), { planning: "skip" });
      const authRes = { id: ids?.authorizationId, status: "CREATED", amount: { currency_code: cur, value: b.depositAmount }, custom_id: b.id, supplementary_data: { related_ids: { order_id: ids?.orderId } } };
      await applyMoneyEvent(seedEvent("PAYMENT.AUTHORIZATION.CREATED", b.id, ids ? authRes : {}), { planning: "skip" });
      if (s.target === "confirmed") {
        const captureId = mock && ids ? mock.seedCapture(ids.authorizationId) : null;
        const capRes = { id: captureId, status: "COMPLETED", amount: { currency_code: cur, value: b.depositAmount }, custom_id: b.id, supplementary_data: { related_ids: { order_id: ids?.orderId, authorization_id: ids?.authorizationId } } };
        await applyMoneyEvent(seedEvent("PAYMENT.CAPTURE.COMPLETED", b.id, captureId ? capRes : {}), { planning: "skip" });
      }
    }
    if (s.balanceInvoiced) {
      const inv = mock
        ? await mock.createInvoice({ bookingId: b.id, invoiceNumber: `${b.id}-seed`, reference: b.id, currency: cur, note: "Balance", recipient: { name: s.name, email: s.email }, items: [{ name: `${price.label} (balance)`, quantity: "1", unitAmount: b.balanceAmount }] })
        : null;
      if (inv && mock) await mock.sendInvoice(inv.invoiceId);
      const fresh = getBooking(b.id) as Booking;
      const next: Booking = { ...fresh, balanceState: "invoiced", paypalInvoiceId: inv?.invoiceId ?? null, updatedAt: nowIso() };
      saveBooking(next);
      saveInvoice({ id: newId("inv"), bookingId: b.id, paypalInvoiceId: inv?.invoiceId ?? null, amount: b.balanceAmount, status: "SENT", qrPngBase64: null, createdAt: nowIso() });
      publish({ type: "booking.updated", booking: next });
    }
  }
  const all = listBookings();
  created.push(...all);
  writeLog({ actor: "system", kind: "seed", message: `Demo day ${day} loaded: ${all.length} bookings on ${SEED_RESOURCES.length} vans (PayPal ${appMode().paypal})`, refs: { day } });
  publish({ type: "hello", mode: appMode() });
  return { day, bookings: created };
}
