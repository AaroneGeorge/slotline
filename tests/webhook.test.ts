import { beforeEach, describe, expect, it } from "vitest";
import type { Booking, BookingState } from "@/shared/types";
import { POST as webhookRoute } from "@/app/api/paypal/webhook/route";
import { MockGateway, setGatewayForTests } from "@/server/paypal";
import type { VerifyWebhookInput, VerifyWebhookResult } from "@/server/paypal/gateway";
import { countEvents, getBooking, getEvent, listLog, saveBooking } from "@/server/db";
import { mockWebhookHeaders } from "@/server/paypal/signature";
import { setupEnv } from "./helpers";

/** Fake verifier: a signature of "good" passes, anything else fails. */
class FakeVerifierGateway extends MockGateway {
  calls = 0;
  async verifyWebhookSignature(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    this.calls++;
    const ok = input.headers.transmissionSig === "good";
    return { verified: ok, reason: ok ? null : "bad signature", method: "test" };
  }
}

function seedBooking(state: BookingState, extra: Partial<Booking> = {}): Booking {
  const now = new Date().toISOString();
  const b: Booking = {
    id: "bk_wh",
    resourceId: "van-1",
    waitlist: false,
    customerName: "Webhook Customer",
    customerEmail: "w@example.com",
    service: "battery",
    startAt: "2026-11-05T17:00:00.000Z",
    endAt: "2026-11-05T17:45:00.000Z",
    durationMin: 45,
    depositAmount: "25.00",
    balanceAmount: "54.00",
    currency: "USD",
    state,
    balanceState: "none",
    paypalOrderId: "ORDER-1",
    paypalAuthorizationId: state === "quoted" || state === "approved" ? null : "AUTH-1",
    paypalCaptureId: ["pending", "confirmed", "refunded", "disputed"].includes(state) ? "CAPTURE-1" : null,
    paypalRefundId: null,
    paypalInvoiceId: null,
    paypalDisputeId: null,
    notes: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  saveBooking(b);
  return b;
}

let seq = 0;
function envelope(eventType: string, resource: Record<string, unknown>, id = `WH-TEST-${++seq}`) {
  return JSON.stringify({ id, event_version: "1.0", create_time: new Date().toISOString(), resource_type: "x", resource_version: "2.0", event_type: eventType, summary: "test", resource, links: [] });
}

function post(raw: string, sig = "good") {
  return webhookRoute(
    new Request("http://localhost:3000/api/paypal/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "paypal-transmission-id": "tx-1",
        "paypal-transmission-time": new Date().toISOString(),
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-transmission-sig": sig,
      },
      body: raw,
    }),
  );
}

const capture = (id: string, status: string) => ({ id, status, custom_id: "bk_wh", amount: { currency_code: "USD", value: "25.00" }, supplementary_data: { related_ids: { order_id: "ORDER-1", authorization_id: "AUTH-1" } } });
const authorization = (id: string, status = "CREATED") => ({ id, status, custom_id: "bk_wh", supplementary_data: { related_ids: { order_id: "ORDER-1" } } });
const refund = (id: string) => ({ id, status: "COMPLETED", amount: { currency_code: "USD", value: "25.00" }, links: [{ href: "https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE-1", rel: "up", method: "GET" }] });
const dispute = (id: string) => ({ dispute_id: id, status: "OPEN", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", disputed_transactions: [{ seller_transaction_id: "CAPTURE-1" }], dispute_amount: { currency_code: "USD", value: "25.00" } });

describe("POST /api/paypal/webhook", () => {
  let gw: FakeVerifierGateway;
  beforeEach(() => {
    setupEnv();
    gw = new FakeVerifierGateway();
    setGatewayForTests(gw);
  });

  it("bad signature -> 400 and no state change, nothing recorded", async () => {
    seedBooking("held");
    const res = await post(envelope("PAYMENT.CAPTURE.COMPLETED", capture("CAPTURE-1", "COMPLETED")), "forged");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SIGNATURE");
    expect(getBooking("bk_wh")?.state).toBe("held");
    expect(countEvents()).toBe(0);
    expect(listLog().some((l) => l.kind === "webhook.rejected")).toBe(true);
  });

  it("missing signature headers -> 400", async () => {
    setGatewayForTests(null); // the real MockGateway HMAC verifier
    seedBooking("held");
    const res = await webhookRoute(new Request("http://x/api/paypal/webhook", { method: "POST", body: envelope("PAYMENT.CAPTURE.COMPLETED", capture("CAPTURE-1", "COMPLETED")) }));
    expect(res.status).toBe(400);
    expect(getBooking("bk_wh")?.state).toBe("held");
  });

  it("invalid JSON -> 400", async () => {
    const res = await post("{not json", "good");
    expect(res.status).toBe(400);
  });

  it("good signature applies the event", async () => {
    seedBooking("held");
    const res = await post(envelope("PAYMENT.CAPTURE.COMPLETED", capture("CAPTURE-1", "COMPLETED")));
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("applied");
    const b = getBooking("bk_wh");
    expect(b?.state).toBe("confirmed");
    expect(b?.paypalCaptureId).toBe("CAPTURE-1");
    expect(gw.calls).toBe(1);
    expect(listLog().some((l) => l.actor === "paypal" && l.kind === "webhook.received")).toBe(true);
  });

  it("replay of the same event id -> 200 and a no-op", async () => {
    seedBooking("held");
    const raw = envelope("PAYMENT.CAPTURE.DENIED", capture("CAPTURE-D", "DECLINED"), "WH-REPLAY-1");
    expect((await post(raw)).status).toBe(200);
    const updatedAt = getBooking("bk_wh")?.updatedAt;
    const again = await post(raw);
    expect(again.status).toBe(200);
    expect((await again.json()).outcome).toBe("duplicate");
    expect(getBooking("bk_wh")?.state).toBe("declined");
    expect(getBooking("bk_wh")?.updatedAt).toBe(updatedAt);
    expect(countEvents()).toBe(1);
  });

  it("normalises the Payments v2 name PAYMENT.CAPTURE.DECLINED to DENIED", async () => {
    seedBooking("held");
    const res = await post(envelope("PAYMENT.CAPTURE.DECLINED", capture("CAPTURE-D", "DECLINED"), "WH-V2-DECLINED"));
    expect((await res.json()).outcome).toBe("applied");
    expect(getBooking("bk_wh")?.state).toBe("declined");
    const ev = getEvent("WH-V2-DECLINED");
    expect(ev?.type).toBe("PAYMENT.CAPTURE.DENIED");
    expect(ev?.refs.paypalEventType).toBe("PAYMENT.CAPTURE.DECLINED");
  });

  it("out-of-order capture before any authorization is logged, not applied", async () => {
    seedBooking("quoted", { paypalAuthorizationId: null });
    const res = await post(envelope("PAYMENT.CAPTURE.COMPLETED", { ...capture("CAPTURE-EARLY", "COMPLETED"), supplementary_data: { related_ids: { order_id: "ORDER-1", authorization_id: "AUTH-NEW" } } }));
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("illegal");
    expect(getBooking("bk_wh")?.state).toBe("quoted");
    expect(listLog().some((l) => l.kind === "booking.illegal")).toBe(true);
  });

  it("authorization then capture then refund (refund after capture)", async () => {
    seedBooking("approved");
    expect((await (await post(envelope("PAYMENT.AUTHORIZATION.CREATED", authorization("AUTH-1")))).json()).outcome).toBe("applied");
    expect(getBooking("bk_wh")?.state).toBe("held");
    await post(envelope("PAYMENT.CAPTURE.COMPLETED", capture("CAPTURE-1", "COMPLETED")));
    expect(getBooking("bk_wh")?.state).toBe("confirmed");
    const res = await post(envelope("PAYMENT.CAPTURE.REFUNDED", refund("REFUND-1")));
    expect((await res.json()).outcome).toBe("applied");
    const b = getBooking("bk_wh");
    expect(b?.state).toBe("refunded");
    expect(b?.paypalRefundId).toBe("REFUND-1");
  });

  it("refund before any capture is illegal", async () => {
    seedBooking("held");
    const res = await post(envelope("PAYMENT.CAPTURE.REFUNDED", { ...refund("REFUND-X"), custom_id: "bk_wh" }));
    expect((await res.json()).outcome).toBe("illegal");
    expect(getBooking("bk_wh")?.state).toBe("held");
  });

  it.each(["held", "pending", "confirmed", "declined", "refunded"] as BookingState[])("dispute from %s -> disputed", async (state) => {
    seedBooking(state, { paypalCaptureId: "CAPTURE-1" });
    const res = await post(envelope("CUSTOMER.DISPUTE.CREATED", dispute(`PP-D-${state}`)));
    expect((await res.json()).outcome).toBe("applied");
    const b = getBooking("bk_wh");
    expect(b?.state).toBe("disputed");
    expect(b?.paypalDisputeId).toBe(`PP-D-${state}`);
  });

  it("dispute on a booking that never took money is illegal", async () => {
    seedBooking("quoted", { paypalCaptureId: "CAPTURE-1" });
    expect((await (await post(envelope("CUSTOMER.DISPUTE.CREATED", dispute("PP-D-Q")))).json()).outcome).toBe("illegal");
  });

  it("unknown event types are recorded and ignored with 200", async () => {
    const res = await post(envelope("PAYMENT.CAPTURE.REVERSED", { id: "CAPTURE-1" }, "WH-UNKNOWN"));
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("ignored");
    expect(getEvent("WH-UNKNOWN")?.outcome).toBe("ignored");
  });

  it("the late CHECKOUT.ORDER.APPROVED after our own authorize call is a no-op", async () => {
    seedBooking("held");
    const res = await post(envelope("CHECKOUT.ORDER.APPROVED", { id: "ORDER-1", status: "APPROVED", purchase_units: [{ custom_id: "bk_wh" }] }));
    expect((await res.json()).outcome).toBe("stale");
    expect(getBooking("bk_wh")?.state).toBe("held");
  });

  it("mock mode: HMAC-signed deliveries verify through the real MockGateway; tampering fails", async () => {
    setGatewayForTests(null);
    seedBooking("held");
    const raw = envelope("PAYMENT.CAPTURE.COMPLETED", capture("CAPTURE-1", "COMPLETED"), "WH-MOCK-SIGNED");
    const headers = mockWebhookHeaders(raw, "tx-mock-1");
    const tampered = raw.replace('"25.00"', '"2500.00"');
    const bad = await webhookRoute(new Request("http://x/api/paypal/webhook", { method: "POST", headers, body: tampered }));
    expect(bad.status).toBe(400);
    expect(getBooking("bk_wh")?.state).toBe("held");
    const good = await webhookRoute(new Request("http://x/api/paypal/webhook", { method: "POST", headers, body: raw }));
    expect(good.status).toBe(200);
    expect(getBooking("bk_wh")?.state).toBe("confirmed");
  });
});
