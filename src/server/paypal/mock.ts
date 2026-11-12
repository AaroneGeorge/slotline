/**
 * MockGateway (PAYPAL_MODE=mock): no network, deterministic ids
 * (MOCK-ORDER-1, MOCK-AUTH-1, ...), PayPal-shaped JSON persisted in SQLite so
 * it survives restarts. It mirrors sandbox behaviour that matters to the app:
 * PayPal-Request-Id idempotency, negative testing via `mockResponse`
 * (INSTRUMENT_DECLINED etc. -> 422 like the sandbox), and it "delivers" the
 * webhook PayPal would send for each call, signed with the mock HMAC scheme,
 * through the same webhook handler a real delivery uses.
 */
import { getMeta, getMockObject, listMockObjects, nextCounter, putMockObject, setMeta } from "../db";
import { mockWebhookDelayMs } from "../config";
import { addMoney, cmpMoney, fromCents, toCents } from "../money";
import { PaypalError } from "./errors";
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
  PaypalGateway,
  RefundInput,
  RefundResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
  VoidInput,
  VoidResult,
} from "./gateway";
import { captureLinks, moneyJson, refundLinks, RESOURCE_TYPE, webhookEnvelope } from "./shapes";
import { MOCK_WEBHOOK_ID, mockVerify, mockWebhookHeaders } from "./signature";

type Obj = Record<string, unknown>;

export type WebhookSink = (rawBody: string, headers: Record<string, string>) => Promise<unknown>;

interface MockOrder extends Obj {
  id: string;
  status: string;
  intent: "AUTHORIZE";
  purchase_units: { reference_id: string; amount: { currency_code: string; value: string }; custom_id: string; invoice_id: string; description: string; payments?: Obj }[];
  create_time: string;
  update_time: string;
  links: Obj[];
  authorization_id?: string;
}

interface MockAuth extends Obj {
  id: string;
  status: string;
  amount: { currency_code: string; value: string };
  custom_id: string;
  invoice_id: string;
  expiration_time: string;
  supplementary_data: { related_ids: { order_id: string } };
  create_time: string;
  update_time: string;
}

interface MockCapture extends Obj {
  id: string;
  status: string;
  amount: { currency_code: string; value: string };
  refunded_cents: number;
  custom_id: string;
  invoice_id: string;
  final_capture: boolean;
  supplementary_data: { related_ids: { order_id: string; authorization_id: string } };
  create_time: string;
  update_time: string;
}

const DECLINE_LIKE = new Set(["INSTRUMENT_DECLINED", "TRANSACTION_REFUSED", "PAYER_CANNOT_PAY", "DECLINED_DUE_TO_RELATED_TXN", "PAYEE_BLOCKED_TRANSACTION"]);

function now(): string {
  return new Date().toISOString();
}

function unprocessable(issue: string, description: string): PaypalError {
  return new PaypalError(`${issue}: ${description}`, 422, issue, `mock-debug-${Date.now().toString(36)}`, [{ issue, description }]);
}

function notFound(what: string): PaypalError {
  return new PaypalError(`RESOURCE_NOT_FOUND: ${what}`, 404, "RESOURCE_NOT_FOUND", null, [{ issue: "INVALID_RESOURCE_ID", description: what }]);
}

export class MockGateway implements PaypalGateway {
  readonly mode = "mock" as const;
  private sink: WebhookSink | null;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(opts: { sink?: WebhookSink | null } = {}) {
    this.sink = opts.sink ?? null;
  }

  setSink(sink: WebhookSink | null): void {
    this.sink = sink;
  }

  // ------------------------------------------------------------ ids & idempotency

  nextId(kind: "ORDER" | "AUTH" | "CAPTURE" | "REFUND" | "INV" | "DISPUTE" | "WH"): string {
    const n = nextCounter(`mock:${kind}`);
    return kind === "DISPUTE" ? `PP-D-MOCK-${n}` : `MOCK-${kind}-${n}`;
  }

  private remembered(op: string, requestId: string | undefined): Obj | null {
    if (!requestId) return null;
    const v = getMeta(`mockreq:${op}:${requestId}`);
    return v ? (JSON.parse(v) as Obj) : null;
  }

  private remember(op: string, requestId: string | undefined, result: unknown): void {
    if (requestId) setMeta(`mockreq:${op}:${requestId}`, JSON.stringify(result));
  }

  // ------------------------------------------------------------ webhook echo

  /** Simulate PayPal delivering a webhook for `resource` after the configured delay. */
  emitWebhook(eventType: string, resource: Obj, summary: string): void {
    const delay = mockWebhookDelayMs();
    if (!this.sink || delay <= 0) return;
    const envelope = webhookEnvelope(this.nextId("WH"), eventType, RESOURCE_TYPE[eventType] ?? "unknown", resource, summary);
    const rawBody = JSON.stringify(envelope);
    const headers = mockWebhookHeaders(rawBody, `mock-tx-${envelope.id}`);
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.sink?.(rawBody, headers).catch((e) => console.error("[mock-webhook] delivery failed", e));
    }, delay);
    this.timers.add(t);
  }

  cancelPendingWebhooks(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ------------------------------------------------------------ orders

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const prior = this.remembered("createOrder", input.requestId) as CreateOrderResult | null;
    if (prior) return prior;
    const id = this.nextId("ORDER");
    const order: MockOrder = {
      id,
      status: "CREATED",
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: input.bookingId,
          amount: moneyJson(input.amount.value, input.amount.currency),
          custom_id: input.customId,
          invoice_id: input.invoiceId,
          description: input.description,
        },
      ],
      create_time: now(),
      update_time: now(),
      links: [
        { href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
        { href: `mock://approve/${id}`, rel: "approve", method: "GET" },
      ],
    };
    putMockObject(id, "order", order);
    const result: CreateOrderResult = { orderId: id, status: "CREATED", approveUrl: null, raw: order };
    this.remember("createOrder", input.requestId, result);
    return result;
  }

  async getOrder(orderId: string): Promise<Obj> {
    const o = getMockObject<MockOrder>(orderId);
    if (!o) throw notFound(`order ${orderId}`);
    return o;
  }

  async authorizeOrder(input: AuthorizeOrderInput): Promise<AuthorizeOrderResult> {
    const prior = this.remembered("authorizeOrder", input.requestId) as AuthorizeOrderResult | null;
    if (prior) return prior;
    const order = getMockObject<MockOrder>(input.orderId);
    if (!order) throw notFound(`order ${input.orderId}`);
    if (order.authorization_id) throw unprocessable("ORDER_ALREADY_AUTHORIZED", "Order already authorized.");
    if (input.mockResponse) throw unprocessable(input.mockResponse, "Mock negative test (PayPal-Mock-Response).");
    const pu = order.purchase_units[0];
    const authId = this.nextId("AUTH");
    const auth: MockAuth = {
      id: authId,
      status: "CREATED",
      amount: pu.amount,
      custom_id: pu.custom_id,
      invoice_id: pu.invoice_id,
      expiration_time: new Date(Date.now() + 29 * 86400000).toISOString(),
      supplementary_data: { related_ids: { order_id: order.id } },
      create_time: now(),
      update_time: now(),
    };
    putMockObject(authId, "authorization", auth);
    const approvedOrder = { ...order, status: "APPROVED" };
    order.status = "COMPLETED";
    order.authorization_id = authId;
    order.update_time = now();
    pu.payments = { authorizations: [auth] };
    putMockObject(order.id, "order", order);
    const result: AuthorizeOrderResult = {
      orderId: order.id,
      orderStatus: "COMPLETED",
      authorizationId: authId,
      authorizationStatus: "CREATED",
      amount: { value: pu.amount.value, currency: pu.amount.currency_code },
      expirationTime: auth.expiration_time,
      customId: pu.custom_id,
      raw: order,
    };
    this.remember("authorizeOrder", input.requestId, result);
    this.emitWebhook("CHECKOUT.ORDER.APPROVED", approvedOrder, `An order has been approved by buyer`);
    this.emitWebhook("PAYMENT.AUTHORIZATION.CREATED", auth, `Payment authorization is created for ${pu.amount.value} ${pu.amount.currency_code}`);
    return result;
  }

  async getAuthorization(authorizationId: string): Promise<Obj> {
    const a = getMockObject<MockAuth>(authorizationId);
    if (!a) throw notFound(`authorization ${authorizationId}`);
    return a;
  }

  /** Seed helper: register an authorization (and its order) as if the buyer had approved it. */
  seedAuthorization(p: { bookingId: string; value: string; currency: string; description: string }): { orderId: string; authorizationId: string } {
    const orderId = this.nextId("ORDER");
    const authId = this.nextId("AUTH");
    const pu = { reference_id: p.bookingId, amount: moneyJson(p.value, p.currency), custom_id: p.bookingId, invoice_id: `SLOT-${p.bookingId}`, description: p.description };
    const auth: MockAuth = {
      id: authId,
      status: "CREATED",
      amount: pu.amount,
      custom_id: p.bookingId,
      invoice_id: pu.invoice_id,
      expiration_time: new Date(Date.now() + 29 * 86400000).toISOString(),
      supplementary_data: { related_ids: { order_id: orderId } },
      create_time: now(),
      update_time: now(),
    };
    putMockObject(authId, "authorization", auth);
    putMockObject(orderId, "order", { id: orderId, status: "COMPLETED", intent: "AUTHORIZE", authorization_id: authId, purchase_units: [{ ...pu, payments: { authorizations: [auth] } }], create_time: now(), update_time: now(), links: [] });
    return { orderId, authorizationId: authId };
  }

  /** Seed helper: capture an authorization synchronously (no webhook echo). */
  seedCapture(authorizationId: string): string {
    const auth = getMockObject<MockAuth>(authorizationId);
    if (!auth) throw notFound(`authorization ${authorizationId}`);
    const id = this.nextId("CAPTURE");
    const cap: MockCapture = {
      id,
      status: "COMPLETED",
      amount: auth.amount,
      refunded_cents: 0,
      custom_id: auth.custom_id,
      invoice_id: auth.invoice_id,
      final_capture: true,
      supplementary_data: { related_ids: { order_id: auth.supplementary_data.related_ids.order_id, authorization_id: auth.id } },
      create_time: now(),
      update_time: now(),
    };
    putMockObject(id, "capture", cap);
    putMockObject(auth.id, "authorization", { ...auth, status: "CAPTURED", update_time: now() });
    return id;
  }

  // ------------------------------------------------------------ payments

  async captureAuthorization(input: CaptureInput): Promise<CaptureResult> {
    const prior = this.remembered("capture", input.requestId) as CaptureResult | null;
    if (prior) return prior;
    const auth = getMockObject<MockAuth>(input.authorizationId);
    if (!auth) throw notFound(`authorization ${input.authorizationId}`);
    if (auth.status === "VOIDED") throw unprocessable("AUTHORIZATION_VOIDED", "A voided authorization cannot be captured.");
    if (auth.status === "CAPTURED") throw unprocessable("AUTHORIZATION_ALREADY_CAPTURED", "Authorization has already been captured.");
    const code = input.mockResponse?.trim();
    if (code && code !== "PENDING") {
      // Same shape as the sandbox's negative-testing response: HTTP 422 with details[0].issue = code.
      throw unprocessable(code, DECLINE_LIKE.has(code) ? "The instrument presented was either declined by the processor or bank, or it can't be used for this payment." : "Mock negative test (PayPal-Mock-Response).");
    }
    const amount = input.amount ? moneyJson(input.amount.value, input.amount.currency) : auth.amount;
    if (cmpMoney(amount.value, auth.amount.value) > 0) throw unprocessable("CAPTURE_AMOUNT_EXCEEDS_AUTHORIZED_AMOUNT", "Capture amount exceeds the authorized amount.");
    const id = this.nextId("CAPTURE");
    const status = code === "PENDING" ? "PENDING" : "COMPLETED";
    const cap: MockCapture = {
      id,
      status,
      ...(status === "PENDING" ? { status_details: { reason: "PENDING_REVIEW" } } : {}),
      amount,
      refunded_cents: 0,
      custom_id: auth.custom_id,
      invoice_id: input.invoiceId ?? auth.invoice_id,
      final_capture: true,
      supplementary_data: { related_ids: { order_id: auth.supplementary_data.related_ids.order_id, authorization_id: auth.id } },
      create_time: now(),
      update_time: now(),
      links: captureLinks(id, auth.id),
    };
    putMockObject(id, "capture", cap);
    putMockObject(auth.id, "authorization", { ...auth, status: "CAPTURED", update_time: now() });
    const result: CaptureResult = { captureId: id, status, statusReason: status === "PENDING" ? "PENDING_REVIEW" : null, amount: { value: amount.value, currency: amount.currency_code }, raw: cap };
    this.remember("capture", input.requestId, result);
    this.emitWebhook(status === "PENDING" ? "PAYMENT.CAPTURE.PENDING" : "PAYMENT.CAPTURE.COMPLETED", cap, `Payment ${status.toLowerCase()} for ${amount.value} ${amount.currency_code}`);
    return result;
  }

  async voidAuthorization(input: VoidInput): Promise<VoidResult> {
    const prior = this.remembered("void", input.requestId) as VoidResult | null;
    if (prior) return prior;
    const auth = getMockObject<MockAuth>(input.authorizationId);
    if (!auth) throw notFound(`authorization ${input.authorizationId}`);
    if (input.mockResponse) throw unprocessable(input.mockResponse, "Mock negative test (PayPal-Mock-Response).");
    if (auth.status === "CAPTURED") throw unprocessable("AUTHORIZATION_ALREADY_CAPTURED", "Authorization has been previously captured and hence cannot be voided.");
    if (auth.status === "VOIDED") throw unprocessable("PREVIOUSLY_VOIDED", "Authorization has been previously voided and hence cannot be voided again.");
    const voided = { ...auth, status: "VOIDED", update_time: now() };
    putMockObject(auth.id, "authorization", voided);
    const result: VoidResult = { authorizationId: auth.id, status: "VOIDED", raw: voided };
    this.remember("void", input.requestId, result);
    this.emitWebhook("PAYMENT.AUTHORIZATION.VOIDED", voided, `A payment authorization was voided`);
    return result;
  }

  async refundCapture(input: RefundInput): Promise<RefundResult> {
    const prior = this.remembered("refund", input.requestId) as RefundResult | null;
    if (prior) return prior;
    const cap = getMockObject<MockCapture>(input.captureId);
    if (!cap) throw notFound(`capture ${input.captureId}`);
    if (input.mockResponse) throw unprocessable(input.mockResponse, "Mock negative test (PayPal-Mock-Response).");
    if (cap.status !== "COMPLETED" && cap.status !== "PARTIALLY_REFUNDED") throw unprocessable("CAPTURE_FULLY_REFUNDED", `Capture is ${cap.status} and cannot be refunded.`);
    const remaining = toCents(cap.amount.value) - cap.refunded_cents;
    const cents = input.amount ? toCents(input.amount.value) : remaining;
    if (cents <= 0 || cents > remaining) throw unprocessable("REFUND_AMOUNT_EXCEEDED", "The refund amount must be less than or equal to the capture amount that has not yet been refunded.");
    const id = this.nextId("REFUND");
    const refund = {
      id,
      status: "COMPLETED",
      amount: moneyJson(fromCents(cents), cap.amount.currency_code),
      invoice_id: input.invoiceId ?? cap.invoice_id,
      custom_id: cap.custom_id,
      ...(input.noteToPayer ? { note_to_payer: input.noteToPayer } : {}),
      create_time: now(),
      update_time: now(),
      links: refundLinks(id, cap.id),
    };
    putMockObject(id, "refund", refund);
    const refunded = cap.refunded_cents + cents;
    putMockObject(cap.id, "capture", { ...cap, refunded_cents: refunded, status: refunded >= toCents(cap.amount.value) ? "REFUNDED" : "PARTIALLY_REFUNDED", update_time: now() });
    const result: RefundResult = { refundId: id, status: "COMPLETED", amount: { value: fromCents(cents), currency: cap.amount.currency_code }, raw: refund };
    this.remember("refund", input.requestId, result);
    this.emitWebhook("PAYMENT.CAPTURE.REFUNDED", refund, `A ${fromCents(cents)} ${cap.amount.currency_code} capture payment was refunded`);
    return result;
  }

  // ------------------------------------------------------------ invoices

  private invoiceResult(inv: Obj): InvoiceResult {
    const amount = inv.amount as { currency_code: string; value: string } | undefined;
    return { invoiceId: String(inv.id), status: String(inv.status), payUrl: null, amount: amount ? { value: amount.value, currency: amount.currency_code } : null, raw: inv };
  }

  async createInvoice(input: CreateInvoiceInput): Promise<InvoiceResult> {
    const prior = this.remembered("createInvoice", input.invoiceNumber) as InvoiceResult | null;
    if (prior) return prior;
    const id = this.nextId("INV");
    const total = addMoney(...input.items.map((i) => fromCents(toCents(i.unitAmount) * Number(i.quantity))));
    const inv = {
      id,
      status: "DRAFT",
      detail: { invoice_number: input.invoiceNumber, reference: input.reference, currency_code: input.currency, note: input.note, payment_term: { term_type: "DUE_ON_RECEIPT" } },
      primary_recipients: [{ billing_info: { name: { full_name: input.recipient.name }, ...(input.recipient.email ? { email_address: input.recipient.email } : {}) } }],
      items: input.items.map((i) => ({ name: i.name, quantity: i.quantity, unit_amount: moneyJson(i.unitAmount, input.currency) })),
      amount: moneyJson(total, input.currency),
    };
    putMockObject(id, "invoice", inv);
    const result = this.invoiceResult(inv);
    this.remember("createInvoice", input.invoiceNumber, result);
    return result;
  }

  async sendInvoice(invoiceId: string): Promise<InvoiceResult> {
    const inv = getMockObject<Obj>(invoiceId);
    if (!inv) throw notFound(`invoice ${invoiceId}`);
    if (inv.status !== "DRAFT" && inv.status !== "SENT") throw unprocessable("INVALID_INVOICE_STATUS", `Invoice is ${String(inv.status)}.`);
    const sent = { ...inv, status: "SENT" };
    putMockObject(invoiceId, "invoice", sent);
    return this.invoiceResult(sent);
  }

  async remindInvoice(invoiceId: string): Promise<{ invoiceId: string; status: string }> {
    const inv = getMockObject<Obj>(invoiceId);
    if (!inv) throw notFound(`invoice ${invoiceId}`);
    if (inv.status !== "SENT" && inv.status !== "UNPAID" && inv.status !== "PARTIALLY_PAID") throw unprocessable("INVALID_INVOICE_STATUS", `Cannot remind an invoice that is ${String(inv.status)}.`);
    return { invoiceId, status: "REMINDED" };
  }

  async invoiceQr(): Promise<{ pngBase64: string | null }> {
    return { pngBase64: null }; // the sandbox returns a real QR PNG; mock mode has none
  }

  async getInvoice(invoiceId: string): Promise<InvoiceResult> {
    const inv = getMockObject<Obj>(invoiceId);
    if (!inv) throw notFound(`invoice ${invoiceId}`);
    return this.invoiceResult(inv);
  }

  async listInvoices(): Promise<InvoiceResult[]> {
    return listMockObjects<Obj>("invoice").map((i) => this.invoiceResult(i));
  }

  /** Dev fixture helper: mark a mock invoice paid (mirrors INVOICING.INVOICE.PAID). */
  markInvoicePaid(invoiceId: string): Obj | null {
    const inv = getMockObject<Obj>(invoiceId);
    if (!inv) return null;
    const paid = { ...inv, status: "PAID" };
    putMockObject(invoiceId, "invoice", paid);
    return paid;
  }

  // ------------------------------------------------------------ disputes

  registerDispute(d: Obj): void {
    putMockObject(String(d.dispute_id), "dispute", d);
  }

  private disputeSummary(d: Obj): DisputeSummary {
    const amt = d.dispute_amount as { currency_code: string; value: string } | undefined;
    return {
      disputeId: String(d.dispute_id),
      status: String(d.status ?? "OPEN"),
      reason: typeof d.reason === "string" ? d.reason : null,
      amount: amt ? { value: amt.value, currency: amt.currency_code } : null,
      createTime: typeof d.create_time === "string" ? d.create_time : null,
      sellerResponseDueDate: typeof d.seller_response_due_date === "string" ? d.seller_response_due_date : null,
      raw: d,
    };
  }

  async getDispute(disputeId: string): Promise<DisputeSummary> {
    const d = getMockObject<Obj>(disputeId);
    if (!d) throw notFound(`dispute ${disputeId}`);
    return this.disputeSummary(d);
  }

  async listDisputes(opts: { disputedTransactionId?: string } = {}): Promise<DisputeSummary[]> {
    return listMockObjects<Obj>("dispute")
      .filter((d) => !opts.disputedTransactionId || ((d.disputed_transactions as { seller_transaction_id?: string }[] | undefined) ?? []).some((t) => t.seller_transaction_id === opts.disputedTransactionId))
      .map((d) => this.disputeSummary(d));
  }

  // ------------------------------------------------------------ webhooks

  async verifyWebhookSignature(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    const h = input.headers;
    if (!h.transmissionId || !h.transmissionTime || !h.transmissionSig) return { verified: false, reason: "missing PayPal transmission headers", method: "mock-hmac" };
    const ok = mockVerify(input.rawBody, h.transmissionId, h.transmissionTime, h.transmissionSig, MOCK_WEBHOOK_ID);
    return { verified: ok, reason: ok ? null : "signature mismatch", method: "mock-hmac" };
  }
}
