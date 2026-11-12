/**
 * SandboxGateway without the network: SDK requests go through an axios
 * adapter stub, REST helper requests through a fetch stub. Verifies the
 * headers and bodies we send to PayPal (negative testing, idempotency keys,
 * raw-body webhook verification, cached token + refresh on 401).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxGateway, extractQrBase64 } from "@/server/paypal/sandbox";
import { setSdkHttpAdapterForTests } from "@/server/paypal/client";
import { PaypalError, isDecline, normalizePaypalError } from "@/server/paypal/errors";
import { setupEnv } from "./helpers";

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let sdkSeen: SeenRequest[] = [];
let tokenCalls = 0;
let sdkResponder: (r: SeenRequest) => { status: number; body: unknown } = () => ({ status: 500, body: {} });

function lower(h: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

beforeEach(() => {
  setupEnv({ PAYPAL_MODE: "sandbox", PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret", PAYPAL_WEBHOOK_ID: "WH-ID-1" });
  sdkSeen = [];
  tokenCalls = 0;
  setSdkHttpAdapterForTests(async (config) => {
    const c = config as { url: string; method: string; headers: Record<string, unknown>; data?: string };
    const r: SeenRequest = { url: c.url, method: String(c.method).toUpperCase(), headers: lower(c.headers), body: typeof c.data === "string" ? c.data : c.data === undefined ? undefined : String(c.data) };
    if (r.url.endsWith("/v1/oauth2/token")) {
      tokenCalls++;
      return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, config, data: JSON.stringify({ access_token: `token-${tokenCalls}`, token_type: "Bearer", expires_in: 32400 }) };
    }
    sdkSeen.push(r);
    const out = sdkResponder(r);
    return { status: out.status, statusText: "x", headers: { "content-type": "application/json" }, config, data: JSON.stringify(out.body) };
  });
});

afterEach(() => {
  setSdkHttpAdapterForTests(null);
  vi.unstubAllGlobals();
});

describe("SandboxGateway via the official SDK (no network)", () => {
  it("createOrder: intent AUTHORIZE, custom_id, invoice_id, PayPal-Request-Id; token fetched once and cached", async () => {
    sdkResponder = () => ({ status: 201, body: { id: "5O190127TN364715T", status: "CREATED", links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=5O1", rel: "payer-action", method: "GET" }] } });
    const gw = new SandboxGateway();
    const r = await gw.createOrder({ bookingId: "bk_1", amount: { value: "40.00", currency: "USD" }, description: "deposit", customId: "bk_1", invoiceId: "SLOT-bk_1", requestId: "order-bk_1" });
    expect(r.orderId).toBe("5O190127TN364715T");
    expect(r.approveUrl).toContain("checkoutnow");
    const req = sdkSeen[0];
    expect(req.url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(req.headers["paypal-request-id"]).toBe("order-bk_1");
    expect(req.headers.authorization).toBe("Bearer token-1");
    const body = JSON.parse(req.body!);
    expect(body.intent).toBe("AUTHORIZE");
    expect(body.purchase_units[0]).toMatchObject({ custom_id: "bk_1", invoice_id: "SLOT-bk_1", amount: { currency_code: "USD", value: "40.00" } });
    expect(body.payment_source.paypal.experience_context.shipping_preference).toBe("NO_SHIPPING");
    await gw.getOrder("5O190127TN364715T");
    expect(tokenCalls).toBe(1);
  });

  it("authorizeOrder returns the authorization id from purchase_units[0].payments.authorizations[0]", async () => {
    sdkResponder = () => ({ status: 201, body: { id: "ORD1", status: "COMPLETED", purchase_units: [{ custom_id: "bk_1", payments: { authorizations: [{ id: "AUTH1", status: "CREATED", amount: { currency_code: "USD", value: "40.00" }, expiration_time: "2026-12-01T00:00:00Z" }] } }] } });
    const r = await new SandboxGateway().authorizeOrder({ orderId: "ORD1", requestId: "auth-ORD1" });
    expect(r).toMatchObject({ authorizationId: "AUTH1", authorizationStatus: "CREATED", amount: { value: "40.00", currency: "USD" } });
    expect(sdkSeen[0].url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/ORD1/authorize");
    expect(sdkSeen[0].headers.prefer).toBe("return=representation");
  });

  it("captureAuthorization sends PayPal-Mock-Response for negative testing; the 422 becomes a decline", async () => {
    sdkResponder = () => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed", debug_id: "dbg123", details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument presented was either declined by the processor or bank" }] } });
    const err = await new SandboxGateway().captureAuthorization({ authorizationId: "AUTH1", requestId: "cap-1", mockResponse: "INSTRUMENT_DECLINED" }).catch((e) => e);
    expect(err).toBeInstanceOf(PaypalError);
    expect(err).toMatchObject({ status: 422, issue: "INSTRUMENT_DECLINED", debugId: "dbg123" });
    expect(isDecline(err)).toBe(true);
    const req = sdkSeen[0];
    expect(req.url).toBe("https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH1/capture");
    expect(JSON.parse(req.headers["paypal-mock-response"])).toEqual({ mock_application_codes: "INSTRUMENT_DECLINED" });
    expect(req.headers["paypal-request-id"]).toBe("cap-1");
  });

  it("captureAuthorization maps a 201 DECLINED / PENDING capture", async () => {
    sdkResponder = () => ({ status: 201, body: { id: "CAP1", status: "PENDING", status_details: { reason: "PENDING_REVIEW" } } });
    expect(await new SandboxGateway().captureAuthorization({ authorizationId: "AUTH1", requestId: "c" })).toMatchObject({ captureId: "CAP1", status: "PENDING", statusReason: "PENDING_REVIEW" });
  });

  it("void and refund hit the Payments v2 paths with idempotency keys", async () => {
    sdkResponder = (r) => (r.url.endsWith("/void") ? { status: 200, body: { id: "AUTH1", status: "VOIDED" } } : { status: 201, body: { id: "REF1", status: "COMPLETED", amount: { currency_code: "USD", value: "40.00" } } });
    const gw = new SandboxGateway();
    expect((await gw.voidAuthorization({ authorizationId: "AUTH1", requestId: "void-1" })).status).toBe("VOIDED");
    const ref = await gw.refundCapture({ captureId: "CAP1", amount: { value: "40.00", currency: "USD" }, requestId: "refund-1" });
    expect(ref).toMatchObject({ refundId: "REF1", status: "COMPLETED" });
    expect(sdkSeen.map((s) => s.url)).toEqual(["https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH1/void", "https://api-m.sandbox.paypal.com/v2/payments/captures/CAP1/refund"]);
    expect(sdkSeen.map((s) => s.headers["paypal-request-id"])).toEqual(["void-1", "refund-1"]);
  });
});

describe("SandboxGateway REST helper (fetch stub)", () => {
  function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: URL | string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const r = handler(String(url), init);
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    });
    return calls;
  }

  it("verify-webhook-signature embeds the raw event bytes verbatim", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { verification_status: "SUCCESS" } }));
    const raw = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"40.00"}},"x":1.10}';
    const res = await new SandboxGateway().verifyWebhookSignature({
      rawBody: raw,
      webhookId: "WH-ID-1",
      headers: { transmissionId: "t1", transmissionTime: "2026-11-05T17:00:00Z", certUrl: "https://api.sandbox.paypal.com/cert", authAlgo: "SHA256withRSA", transmissionSig: "sig==" },
    });
    expect(res.verified).toBe(true);
    expect(calls[0].url).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    const sent = String(calls[0].init.body);
    expect(sent.endsWith(`"webhook_event":${raw}}`)).toBe(true); // 1.10 survives (re-serialising would print 1.1)
    expect(JSON.parse(sent)).toMatchObject({ auth_algo: "SHA256withRSA", cert_url: "https://api.sandbox.paypal.com/cert", transmission_id: "t1", transmission_sig: "sig==", webhook_id: "WH-ID-1" });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
  });

  it("FAILURE, missing headers, or no webhook id -> not verified", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { verification_status: "FAILURE" } }));
    const gw = new SandboxGateway();
    const h = { transmissionId: "t1", transmissionTime: "x", certUrl: "c", authAlgo: "a", transmissionSig: "s" };
    expect((await gw.verifyWebhookSignature({ rawBody: "{}", webhookId: "WH-ID-1", headers: h })).verified).toBe(false);
    expect((await gw.verifyWebhookSignature({ rawBody: "{}", webhookId: null, headers: h })).reason).toMatch(/PAYPAL_WEBHOOK_ID/);
    expect((await gw.verifyWebhookSignature({ rawBody: "{}", webhookId: "WH-ID-1", headers: { ...h, transmissionSig: null } })).reason).toMatch(/missing/);
    expect(calls).toHaveLength(1);
  });

  it("refreshes the token once on 401", async () => {
    let n = 0;
    const calls = stubFetch(() => (++n === 1 ? { status: 401, body: { error: "invalid_token" } } : { status: 200, body: { id: "INV2-1", status: "SENT", detail: { metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#INV2-1" } } } }));
    const inv = await new SandboxGateway().getInvoice("INV2-1");
    expect(inv).toMatchObject({ invoiceId: "INV2-1", status: "SENT", payUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-1" });
    expect(calls.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("createInvoice: Invoicing v2 body, Prefer representation, id from the response", async () => {
    const calls = stubFetch(() => ({ status: 201, body: { id: "INV2-ABCD", status: "DRAFT" } }));
    const r = await new SandboxGateway().createInvoice({ bookingId: "bk_1", invoiceNumber: "bk_1-x", reference: "bk_1", currency: "USD", note: "n", recipient: { name: "Ahmed Khan", email: "ahmed@example.com" }, items: [{ name: "Screen (balance)", quantity: "1", unitAmount: "89.00" }] });
    expect(r.invoiceId).toBe("INV2-ABCD");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.detail).toMatchObject({ currency_code: "USD", invoice_number: "bk_1-x", reference: "bk_1" });
    expect(body.primary_recipients[0].billing_info).toEqual({ name: { given_name: "Ahmed", surname: "Khan" }, email_address: "ahmed@example.com" });
    expect(body.items[0]).toEqual({ name: "Screen (balance)", quantity: "1", unit_amount: { currency_code: "USD", value: "89.00" } });
    expect((calls[0].init.headers as Record<string, string>).Prefer).toBe("return=representation");
  });

  it("maps PayPal error bodies to PaypalError", async () => {
    stubFetch(() => ({ status: 404, body: { name: "RESOURCE_NOT_FOUND", message: "x", debug_id: "d1", details: [{ issue: "INVALID_RESOURCE_ID", description: "Specified resource ID does not exist." }] } }));
    const e = await new SandboxGateway().getDispute("PP-D-1").catch((x) => x);
    expect(e).toMatchObject({ status: 404, issue: "INVALID_RESOURCE_ID", debugId: "d1" });
  });
});

describe("helpers", () => {
  it("extractQrBase64 handles bare base64 and multipart bodies", () => {
    const b64 = "iVBORw0KGgo" + "A".repeat(200);
    expect(extractQrBase64(b64)).toBe(b64);
    const multipart = `--boundary\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--boundary--`;
    expect(extractQrBase64(multipart)).toBe(b64);
    expect(extractQrBase64("not a qr")).toBeNull();
  });

  it("normalizePaypalError reads SDK ApiError-like objects", () => {
    const e = normalizePaypalError({ statusCode: 422, body: JSON.stringify({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "TRANSACTION_REFUSED" }] }) });
    expect(e).toMatchObject({ status: 422, issue: "TRANSACTION_REFUSED" });
    expect(isDecline(e)).toBe(true);
    expect(normalizePaypalError(new Error("socket hang up")).issue).toBe("NETWORK_ERROR");
  });
});
