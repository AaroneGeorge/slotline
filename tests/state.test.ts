import { beforeEach, describe, expect, it } from "vitest";
import type { Booking, BookingState, MoneyEvent, MoneyEventType } from "@/shared/types";
import { BOOKING_STATES, IllegalTransition, MONEY_EVENT_TYPES, reduce, TRANSITIONS } from "@/server/state";
import { applyMoneyEvent } from "@/server/pipeline";
import { countEvents, getBooking, listLog, saveBooking } from "@/server/db";
import { setupEnv } from "./helpers";

function booking(state: BookingState, extra: Partial<Booking> = {}): Booking {
  return {
    id: "bk_test",
    resourceId: "van-1",
    waitlist: false,
    customerName: "Test Customer",
    customerEmail: "t@example.com",
    service: "screen",
    startAt: "2026-11-05T17:00:00.000Z",
    endAt: "2026-11-05T18:00:00.000Z",
    durationMin: 60,
    depositAmount: "40.00",
    balanceAmount: "89.00",
    currency: "USD",
    state,
    balanceState: "none",
    paypalOrderId: null,
    paypalAuthorizationId: null,
    paypalCaptureId: null,
    paypalRefundId: null,
    paypalInvoiceId: null,
    paypalDisputeId: null,
    notes: null,
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    ...extra,
  };
}

function event(type: MoneyEventType, refs: Record<string, string> = {}, id = `ev-${type}-${Math.random()}`): MoneyEvent {
  return { id, type, at: new Date().toISOString(), source: "webhook", verified: true, bookingId: "bk_test", resource: {}, refs };
}

describe("reducer: transition table (BUILD-PLAN §4)", () => {
  const legal: [BookingState, MoneyEventType, string][] = [];
  const illegal: [BookingState, MoneyEventType][] = [];
  for (const s of BOOKING_STATES) {
    for (const t of MONEY_EVENT_TYPES) {
      const cell = TRANSITIONS[s][t];
      if (cell === undefined) illegal.push([s, t]);
      else legal.push([s, t, cell]);
    }
  }

  it("covers the whole table", () => {
    expect(legal.length + illegal.length).toBe(BOOKING_STATES.length * MONEY_EVENT_TYPES.length);
    expect(legal.length).toBe(38); // 4+4+7+6+4+7+2+2+2 cells in the plan table
  });

  it.each(legal)("%s + %s is legal (-> %s)", (from, type, cell) => {
    const res = reduce(booking(from), event(type));
    if (cell === "idem") {
      expect(res.outcome).toBe("idempotent");
      expect(res.booking.state).toBe(from);
    } else if (cell === "balance") {
      expect(res.outcome).toBe("applied");
      expect(res.booking.state).toBe(from);
      expect(res.booking.balanceState).toBe("paid");
    } else {
      expect(res.outcome).toBe("applied");
      expect(res.booking.state).toBe(cell);
    }
  });

  it.each(illegal)("%s + %s throws IllegalTransition", (from, type) => {
    expect(() => reduce(booking(from), event(type))).toThrow(IllegalTransition);
  });

  it("is pure: the input booking is not mutated", () => {
    const b = booking("held");
    const copy = structuredClone(b);
    reduce(b, event("PAYMENT.CAPTURE.COMPLETED", { captureId: "CAP-1" }));
    expect(b).toEqual(copy);
  });

  it("released/refunded leave the timeline but keep the resource for the log", () => {
    const r = reduce(booking("held"), event("PAYMENT.AUTHORIZATION.VOIDED")).booking;
    expect(r.state).toBe("released");
    expect(r.waitlist).toBe(false);
    expect(r.resourceId).toBe("van-1");
    const f = reduce(booking("confirmed"), event("PAYMENT.CAPTURE.REFUNDED", { refundId: "R-1" })).booking;
    expect(f.state).toBe("refunded");
    expect(f.paypalRefundId).toBe("R-1");
  });

  it("copies PayPal ids from the event onto the booking", () => {
    const b = reduce(booking("approved"), event("PAYMENT.AUTHORIZATION.CREATED", { authorizationId: "AUTH-9", orderId: "ORD-9" })).booking;
    expect(b.paypalAuthorizationId).toBe("AUTH-9");
    expect(b.paypalOrderId).toBe("ORD-9");
  });

  it("INVOICE.PAID only changes balanceState, and twice is idempotent", () => {
    const once = reduce(booking("confirmed", { balanceState: "invoiced" }), event("INVOICING.INVOICE.PAID"));
    expect(once.booking.state).toBe("confirmed");
    expect(once.booking.balanceState).toBe("paid");
    expect(reduce(once.booking, event("INVOICING.INVOICE.PAID")).outcome).toBe("idempotent");
  });

  it("a late delivery for the resource on file is stale, not illegal", () => {
    // CHECKOUT.ORDER.APPROVED webhook arriving after our own authorize call made the booking held
    expect(reduce(booking("held", { paypalOrderId: "ORD-1" }), event("CHECKOUT.ORDER.APPROVED", { orderId: "ORD-1" })).outcome).toBe("stale");
    // a different order id is still illegal
    expect(() => reduce(booking("held", { paypalOrderId: "ORD-1" }), event("CHECKOUT.ORDER.APPROVED", { orderId: "ORD-2" }))).toThrow(IllegalTransition);
  });

  it("the original AUTHORIZATION.CREATED arriving after a decline does not undo it; a new authorization re-holds", () => {
    const declined = booking("declined", { paypalAuthorizationId: "AUTH-1" });
    const late = reduce(declined, event("PAYMENT.AUTHORIZATION.CREATED", { authorizationId: "AUTH-1" }));
    expect(late.outcome).toBe("stale");
    expect(late.booking.state).toBe("declined");
    const reauth = reduce(declined, event("PAYMENT.AUTHORIZATION.CREATED", { authorizationId: "AUTH-2" }));
    expect(reauth.booking.state).toBe("held");
    expect(reauth.booking.paypalAuthorizationId).toBe("AUTH-2");
  });
});

describe("pipeline: idempotency by event id", () => {
  beforeEach(() => {
    setupEnv();
    saveBooking(booking("held", { paypalAuthorizationId: "AUTH-1" }));
  });

  it("the same event id twice -> one row, one state change", async () => {
    const e = event("PAYMENT.CAPTURE.COMPLETED", { captureId: "CAP-1", authorizationId: "AUTH-1" }, "WH-SAME-1");
    const first = await applyMoneyEvent(e, { planning: "skip" });
    const second = await applyMoneyEvent(e, { planning: "skip" });
    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("duplicate");
    expect(countEvents()).toBe(1);
    expect(getBooking("bk_test")?.state).toBe("confirmed");
    expect(listLog().filter((l) => l.kind === "booking.state")).toHaveLength(1);
    expect(listLog().filter((l) => l.kind === "event.duplicate")).toHaveLength(1);
  });

  it("an illegal event is recorded and logged but not applied", async () => {
    const res = await applyMoneyEvent(event("PAYMENT.CAPTURE.REFUNDED", { refundId: "R-1" }, "WH-ILLEGAL"), { planning: "skip" });
    expect(res.outcome).toBe("illegal");
    expect(getBooking("bk_test")?.state).toBe("held");
    expect(listLog().some((l) => l.kind === "booking.illegal")).toBe(true);
    // a replay of the illegal event is a duplicate, not a second illegal attempt
    expect((await applyMoneyEvent(event("PAYMENT.CAPTURE.REFUNDED", {}, "WH-ILLEGAL"), { planning: "skip" })).outcome).toBe("duplicate");
  });

  it("an event that matches no booking is recorded as unmatched", async () => {
    const res = await applyMoneyEvent({ ...event("PAYMENT.CAPTURE.COMPLETED", { captureId: "NOPE" }), bookingId: null }, { planning: "skip" });
    expect(res.outcome).toBe("unmatched");
    expect(countEvents()).toBe(1);
  });

  it("resolves the booking from custom_id / invoice_id / PayPal ids", async () => {
    const byAuth = await applyMoneyEvent({ ...event("PAYMENT.CAPTURE.PENDING", { authorizationId: "AUTH-1", captureId: "CAP-P" }), bookingId: null }, { planning: "skip" });
    expect(byAuth.booking?.id).toBe("bk_test");
    expect(getBooking("bk_test")?.state).toBe("pending");
    const byInvoiceRef = await applyMoneyEvent({ ...event("PAYMENT.CAPTURE.COMPLETED", { invoiceRef: "SLOT-bk_test" }), bookingId: null }, { planning: "skip" });
    expect(byInvoiceRef.booking?.state).toBe("confirmed");
  });
});
