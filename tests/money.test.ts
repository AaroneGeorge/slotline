import { describe, expect, it } from "vitest";
import { addMoney, cmpMoney, fromCents, isMoney, normalizeMoney, toCents } from "@/server/money";
import { bookingIdFromInvoiceRef, canonicalEventType, normalizeWebhook, refsFromResource } from "@/server/paypal/normalize";
import { crc32, mockSign, mockVerify } from "@/server/paypal/signature";
import { renderTemplate } from "@/server/dev";

describe("money", () => {
  it("does integer-cent arithmetic on decimal strings", () => {
    expect(toCents("40.00")).toBe(4000);
    expect(toCents("0.1")).toBe(10);
    expect(fromCents(7900)).toBe("79.00");
    expect(addMoney("25.00", "54.00", "0.01")).toBe("79.01");
    expect(addMoney("10.00", "-2.50")).toBe("7.50");
    expect(cmpMoney("79.01", "79.00")).toBeGreaterThan(0);
    expect(normalizeMoney("5")).toBe("5.00");
    expect(isMoney("1.234")).toBe(false);
    expect(() => toCents("abc")).toThrow();
  });
});

describe("PayPal normalisation helpers", () => {
  it("maps the v2 decline name and leaves known names alone", () => {
    expect(canonicalEventType("PAYMENT.CAPTURE.DECLINED")).toBe("PAYMENT.CAPTURE.DENIED");
    expect(canonicalEventType("PAYMENT.CAPTURE.COMPLETED")).toBe("PAYMENT.CAPTURE.COMPLETED");
    expect(canonicalEventType("BILLING.SUBSCRIPTION.CREATED")).toBeNull();
  });

  it("extracts ids from each resource shape", () => {
    expect(refsFromResource("PAYMENT.CAPTURE.REFUNDED", { id: "R1", links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/C9" }] })).toEqual({ refundId: "R1", captureId: "C9" });
    expect(refsFromResource("CUSTOMER.DISPUTE.CREATED", { dispute_id: "PP-D-1", disputed_transactions: [{ seller_transaction_id: "C1", custom: "bk_1" }] })).toEqual({ disputeId: "PP-D-1", captureId: "C1", customId: "bk_1" });
    expect(refsFromResource("INVOICING.INVOICE.PAID", { invoice: { id: "INV2-1", detail: { reference: "bk_1", invoice_number: "n" } } })).toEqual({ invoiceId: "INV2-1", customId: "bk_1", invoiceRef: "n" });
    expect(refsFromResource("CHECKOUT.ORDER.APPROVED", { id: "O1", purchase_units: [{ custom_id: "bk_1", invoice_id: "SLOT-bk_1" }] })).toEqual({ orderId: "O1", customId: "bk_1", invoiceRef: "SLOT-bk_1" });
    expect(bookingIdFromInvoiceRef("SLOT-bk_abc")).toBe("bk_abc");
    expect(bookingIdFromInvoiceRef("SLOT-bk_abc-BAL")).toBe("bk_abc");
    expect(bookingIdFromInvoiceRef("INV-1")).toBeNull();
  });

  it("rejects envelopes without id or event_type", () => {
    expect(normalizeWebhook({ event_type: "PAYMENT.CAPTURE.COMPLETED" }).kind).toBe("invalid");
    expect(normalizeWebhook({ id: "WH-1", event_type: "X.Y" }).kind).toBe("unknown");
  });
});

describe("signature helpers", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32("123456789")).toBe(0xcbf43926);
  });
  it("mock HMAC signs and verifies the PayPal signed string", () => {
    const sig = mockSign('{"id":"WH-1"}', "tx", "2026-11-05T00:00:00Z");
    expect(mockVerify('{"id":"WH-1"}', "tx", "2026-11-05T00:00:00Z", sig)).toBe(true);
    expect(mockVerify('{"id":"WH-2"}', "tx", "2026-11-05T00:00:00Z", sig)).toBe(false);
    expect(mockVerify('{"id":"WH-1"}', "tx2", "2026-11-05T00:00:00Z", sig)).toBe(false);
  });
});

describe("fixture templating", () => {
  it("replaces placeholders anywhere in string values", () => {
    expect(renderTemplate({ a: "{{x}}", b: ["pre-{{x}}-{{y}}"], c: 1 }, { x: "1", y: "2" })).toEqual({ a: "1", b: ["pre-1-2"], c: 1 });
  });
});
