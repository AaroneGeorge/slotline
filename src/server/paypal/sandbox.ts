/**
 * SandboxGateway: the official @paypal/paypal-server-sdk (Orders v2, Payments v2)
 * plus rest.ts for Invoicing v2, Disputes v1 and webhook verification.
 * Negative testing: `mockResponse` becomes the PayPal-Mock-Response header.
 * Idempotency: every create/authorize/capture/void/refund sends PayPal-Request-Id.
 */
import {
  CheckoutPaymentIntent,
  OrdersController,
  PaymentsController,
  PaypalWalletContextShippingPreference,
  type ApiResponse,
} from "@paypal/paypal-server-sdk";
import { sdkClient } from "./client";
import { normalizePaypalError, PaypalError } from "./errors";
import { paypalRest } from "./rest";
import type {
  AuthorizeOrderInput,
  AuthorizeOrderResult,
  CaptureInput,
  CaptureResult,
  CreateInvoiceInput,
  CreateOrderInput,
  CreateOrderResult,
  DisputeSummary,
  InvoiceResult,
  MoneyAmount,
  PaypalGateway,
  RefundInput,
  RefundResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
  VoidInput,
  VoidResult,
} from "./gateway";

const PREFER = "return=representation";

function mockHeader(code: string | undefined): string | undefined {
  return code ? JSON.stringify({ mock_application_codes: code }) : undefined;
}

/** PayPal's wire-format (snake_case) JSON of an SDK response, for the event log / evidence pack. */
function raw(res: ApiResponse<unknown>): Record<string, unknown> {
  if (typeof res.body === "string" && res.body.length > 0) {
    try {
      return JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw normalizePaypalError(e);
  }
}

function money(m: { currencyCode?: string; value?: string } | undefined | null): MoneyAmount | null {
  return m && m.value && m.currencyCode ? { value: m.value, currency: m.currencyCode } : null;
}

function rawMoney(m: unknown): MoneyAmount | null {
  const o = m as { currency_code?: string; value?: string } | undefined;
  return o && o.value && o.currency_code ? { value: o.value, currency: o.currency_code } : null;
}

function idFromHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const m = href.match(/\/invoices\/([^/?#]+)/);
  return m ? m[1] : null;
}

function invoiceResult(data: Record<string, unknown>): InvoiceResult {
  const detail = (data.detail ?? {}) as { metadata?: { recipient_view_url?: string } };
  return {
    invoiceId: String(data.id ?? idFromHref(data.href) ?? ""),
    status: String(data.status ?? "UNKNOWN"),
    payUrl: detail.metadata?.recipient_view_url ?? null,
    amount: rawMoney(data.amount),
    raw: data,
  };
}

function disputeSummary(d: Record<string, unknown>): DisputeSummary {
  return {
    disputeId: String(d.dispute_id ?? ""),
    status: String(d.status ?? "UNKNOWN"),
    reason: typeof d.reason === "string" ? d.reason : null,
    amount: rawMoney(d.dispute_amount),
    createTime: typeof d.create_time === "string" ? d.create_time : null,
    sellerResponseDueDate: typeof d.seller_response_due_date === "string" ? d.seller_response_due_date : null,
    raw: d,
  };
}

/** Pull the base64 PNG out of the generate-qr-code response (multipart or bare base64). */
export function extractQrBase64(text: string): string | null {
  const t = text.trim();
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(t) && t.length > 100) return t.replace(/\s+/g, "");
  const parts = t.split(/\r?\n\r?\n/);
  for (const p of parts) {
    const candidate = p.split(/\r?\n--/)[0].trim();
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(candidate) && candidate.length > 100) return candidate.replace(/\s+/g, "");
  }
  return null;
}

export class SandboxGateway implements PaypalGateway {
  readonly mode = "sandbox" as const;

  private orders() {
    return new OrdersController(sdkClient());
  }
  private payments() {
    return new PaymentsController(sdkClient());
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const res = await call(() =>
      this.orders().createOrder({
        body: {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [
            {
              referenceId: input.bookingId,
              amount: { currencyCode: input.amount.currency, value: input.amount.value },
              customId: input.customId,
              invoiceId: input.invoiceId,
              description: input.description.slice(0, 127),
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                brandName: "Slotline",
                shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
                ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
                ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
              },
            },
          },
        },
        paypalRequestId: input.requestId,
        prefer: PREFER,
      }),
    );
    const o = res.result;
    return {
      orderId: o.id ?? "",
      status: String(o.status ?? "CREATED"),
      approveUrl: o.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href ?? null,
      raw: raw(res),
    };
  }

  async getOrder(orderId: string): Promise<Record<string, unknown>> {
    const res = await call(() => this.orders().getOrder({ id: orderId }));
    return raw(res);
  }

  async authorizeOrder(input: AuthorizeOrderInput): Promise<AuthorizeOrderResult> {
    const res = await call(() =>
      this.orders().authorizeOrder({
        id: input.orderId,
        paypalRequestId: input.requestId,
        paypalMockResponse: mockHeader(input.mockResponse),
        prefer: PREFER,
      }),
    );
    const o = res.result;
    const auth = o.purchaseUnits?.[0]?.payments?.authorizations?.[0];
    if (!auth?.id) throw new PaypalError("authorizeOrder returned no authorization", 502, "NO_AUTHORIZATION");
    return {
      orderId: o.id ?? input.orderId,
      orderStatus: String(o.status ?? "COMPLETED"),
      authorizationId: auth.id,
      authorizationStatus: String(auth.status ?? "CREATED"),
      amount: money(auth.amount),
      expirationTime: auth.expirationTime ?? null,
      customId: auth.customId ?? o.purchaseUnits?.[0]?.customId ?? null,
      raw: raw(res),
    };
  }

  async getAuthorization(authorizationId: string): Promise<Record<string, unknown>> {
    const res = await call(() => this.payments().getAuthorizedPayment({ authorizationId }));
    return raw(res);
  }

  async captureAuthorization(input: CaptureInput): Promise<CaptureResult> {
    const res = await call(() =>
      this.payments().captureAuthorizedPayment({
        authorizationId: input.authorizationId,
        paypalRequestId: input.requestId,
        paypalMockResponse: mockHeader(input.mockResponse),
        prefer: PREFER,
        body: {
          finalCapture: true,
          ...(input.amount ? { amount: { currencyCode: input.amount.currency, value: input.amount.value } } : {}),
          ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
        },
      }),
    );
    const c = res.result;
    return {
      captureId: c.id ?? null,
      status: String(c.status ?? "UNKNOWN"),
      statusReason: c.statusDetails?.reason ? String(c.statusDetails.reason) : null,
      amount: money(c.amount),
      raw: raw(res),
    };
  }

  async voidAuthorization(input: VoidInput): Promise<VoidResult> {
    const res = await call(() =>
      this.payments().voidPayment({
        authorizationId: input.authorizationId,
        paypalRequestId: input.requestId,
        paypalMockResponse: mockHeader(input.mockResponse),
        prefer: PREFER,
      }),
    );
    return { authorizationId: input.authorizationId, status: String(res.result?.status ?? "VOIDED"), raw: raw(res) };
  }

  async refundCapture(input: RefundInput): Promise<RefundResult> {
    const res = await call(() =>
      this.payments().refundCapturedPayment({
        captureId: input.captureId,
        paypalRequestId: input.requestId,
        paypalMockResponse: mockHeader(input.mockResponse),
        prefer: PREFER,
        body: {
          ...(input.amount ? { amount: { currencyCode: input.amount.currency, value: input.amount.value } } : {}),
          ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
          ...(input.noteToPayer ? { noteToPayer: input.noteToPayer.slice(0, 255) } : {}),
        },
      }),
    );
    const r = res.result;
    return { refundId: r.id ?? "", status: String(r.status ?? "UNKNOWN"), amount: money(r.amount), raw: raw(res) };
  }

  async createInvoice(input: CreateInvoiceInput): Promise<InvoiceResult> {
    const [given, ...rest] = input.recipient.name.trim().split(/\s+/);
    const body = {
      detail: {
        currency_code: input.currency,
        invoice_number: input.invoiceNumber.slice(0, 25),
        reference: input.reference.slice(0, 120),
        note: input.note.slice(0, 4000),
        payment_term: { term_type: "DUE_ON_RECEIPT" },
      },
      primary_recipients: [
        {
          billing_info: {
            name: { given_name: given ?? input.recipient.name, ...(rest.length ? { surname: rest.join(" ") } : {}) },
            ...(input.recipient.email ? { email_address: input.recipient.email } : {}),
          },
        },
      ],
      items: input.items.map((i) => ({
        name: i.name.slice(0, 200),
        ...(i.description ? { description: i.description.slice(0, 1000) } : {}),
        quantity: i.quantity,
        unit_amount: { currency_code: input.currency, value: i.unitAmount },
      })),
    };
    const res = await paypalRest<Record<string, unknown>>("/v2/invoicing/invoices", {
      method: "POST",
      body,
      headers: { Prefer: PREFER, "PayPal-Request-Id": `inv-${input.invoiceNumber}` },
    });
    const out = invoiceResult(res.data);
    if (!out.invoiceId) throw new PaypalError("create invoice returned no id", 502, "NO_INVOICE_ID");
    return out;
  }

  async sendInvoice(invoiceId: string, opts: { subject?: string; note?: string; requestId: string }): Promise<InvoiceResult> {
    const res = await paypalRest<Record<string, unknown>>(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, {
      method: "POST",
      body: { send_to_recipient: true, send_to_invoicer: false, ...(opts.subject ? { subject: opts.subject } : {}), ...(opts.note ? { note: opts.note } : {}) },
      headers: { "PayPal-Request-Id": opts.requestId },
    });
    const links = (res.data.links as { href?: string; rel?: string }[] | undefined) ?? [];
    const payUrl = (typeof res.data.href === "string" ? res.data.href : null) ?? links.find((l) => l.rel === "payer-view")?.href ?? null;
    return { invoiceId, status: "SENT", payUrl, amount: null, raw: res.data };
  }

  async remindInvoice(invoiceId: string, opts: { subject?: string; note?: string }): Promise<{ invoiceId: string; status: string }> {
    await paypalRest(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/remind`, {
      method: "POST",
      body: { send_to_invoicer: false, ...(opts.subject ? { subject: opts.subject } : {}), ...(opts.note ? { note: opts.note } : {}) },
    });
    return { invoiceId, status: "REMINDED" };
  }

  async invoiceQr(invoiceId: string): Promise<{ pngBase64: string | null }> {
    const res = await paypalRest<string>(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/generate-qr-code`, {
      method: "POST",
      body: { width: 300, height: 300, action: "pay" },
      text: true,
    });
    return { pngBase64: extractQrBase64(res.data) };
  }

  async getInvoice(invoiceId: string): Promise<InvoiceResult> {
    const res = await paypalRest<Record<string, unknown>>(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
    return invoiceResult(res.data);
  }

  async listInvoices(opts: { page?: number; pageSize?: number } = {}): Promise<InvoiceResult[]> {
    const res = await paypalRest<{ items?: Record<string, unknown>[] }>("/v2/invoicing/invoices", {
      query: { page: opts.page ?? 1, page_size: opts.pageSize ?? 20, total_required: "false" },
    });
    return (res.data.items ?? []).map(invoiceResult);
  }

  async getDispute(disputeId: string): Promise<DisputeSummary> {
    const res = await paypalRest<Record<string, unknown>>(`/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
    return disputeSummary(res.data);
  }

  async listDisputes(opts: { disputedTransactionId?: string; startTime?: string } = {}): Promise<DisputeSummary[]> {
    const res = await paypalRest<{ items?: Record<string, unknown>[] }>("/v1/customer/disputes", {
      query: { disputed_transaction_id: opts.disputedTransactionId, start_time: opts.disputedTransactionId ? undefined : opts.startTime, page_size: 20 },
    });
    return (res.data.items ?? []).map(disputeSummary);
  }

  /**
   * POST /v1/notifications/verify-webhook-signature. The event is embedded as
   * the exact raw bytes PayPal sent (re-serialising parsed JSON can change
   * them and fail verification).
   */
  async verifyWebhookSignature(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    const h = input.headers;
    if (!input.webhookId) return { verified: false, reason: "PAYPAL_WEBHOOK_ID is not configured", method: "postback" };
    if (!h.transmissionId || !h.transmissionTime || !h.certUrl || !h.authAlgo || !h.transmissionSig) {
      return { verified: false, reason: "missing PayPal transmission headers", method: "postback" };
    }
    const body =
      `{"auth_algo":${JSON.stringify(h.authAlgo)},"cert_url":${JSON.stringify(h.certUrl)},` +
      `"transmission_id":${JSON.stringify(h.transmissionId)},"transmission_sig":${JSON.stringify(h.transmissionSig)},` +
      `"transmission_time":${JSON.stringify(h.transmissionTime)},"webhook_id":${JSON.stringify(input.webhookId)},` +
      `"webhook_event":${input.rawBody}}`;
    try {
      const res = await paypalRest<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", { method: "POST", body });
      const ok = res.data.verification_status === "SUCCESS";
      return { verified: ok, reason: ok ? null : `verification_status=${res.data.verification_status ?? "missing"}`, method: "postback" };
    } catch (e) {
      const err = normalizePaypalError(e);
      return { verified: false, reason: `verify call failed: ${err.issue}`, method: "postback" };
    }
  }
}
