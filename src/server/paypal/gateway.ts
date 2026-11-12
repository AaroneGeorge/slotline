/**
 * The seam between Slotline and PayPal. Two implementations:
 * - SandboxGateway (official @paypal/paypal-server-sdk + a thin REST helper for
 *   the endpoints the SDK does not cover), PAYPAL_MODE=sandbox
 * - MockGateway (deterministic ids, no network), PAYPAL_MODE=mock
 * All amounts are decimal strings.
 */

export interface MoneyAmount {
  value: string;
  currency: string;
}

export interface CreateOrderInput {
  bookingId: string;
  amount: MoneyAmount;
  description: string;
  customId: string; // booking id
  invoiceId: string; // "SLOT-<bookingId>"
  requestId: string; // PayPal-Request-Id
  returnUrl?: string;
  cancelUrl?: string;
}

export interface CreateOrderResult {
  orderId: string;
  status: string; // CREATED | APPROVED | ...
  approveUrl: string | null;
  raw: Record<string, unknown>;
}

export interface AuthorizeOrderInput {
  orderId: string;
  requestId: string;
  mockResponse?: string;
}

export interface AuthorizeOrderResult {
  orderId: string;
  orderStatus: string; // COMPLETED
  authorizationId: string;
  authorizationStatus: string; // CREATED | PENDING | DENIED ...
  amount: MoneyAmount | null;
  expirationTime: string | null;
  customId: string | null;
  raw: Record<string, unknown>;
}

export interface CaptureInput {
  authorizationId: string;
  amount?: MoneyAmount;
  invoiceId?: string;
  requestId: string;
  /** Sandbox negative testing, e.g. "INSTRUMENT_DECLINED" -> PayPal-Mock-Response header. */
  mockResponse?: string;
}

export interface CaptureResult {
  captureId: string | null;
  status: string; // COMPLETED | PENDING | DECLINED | FAILED | ...
  statusReason: string | null;
  amount: MoneyAmount | null;
  raw: Record<string, unknown>;
}

export interface VoidInput {
  authorizationId: string;
  requestId: string;
  mockResponse?: string;
}

export interface VoidResult {
  authorizationId: string;
  status: string; // VOIDED
  raw: Record<string, unknown>;
}

export interface RefundInput {
  captureId: string;
  amount?: MoneyAmount; // omitted = full refund
  invoiceId?: string;
  noteToPayer?: string;
  requestId: string;
  mockResponse?: string;
}

export interface RefundResult {
  refundId: string;
  status: string; // COMPLETED | PENDING | FAILED | CANCELLED
  amount: MoneyAmount | null;
  raw: Record<string, unknown>;
}

export interface CreateInvoiceInput {
  bookingId: string;
  invoiceNumber: string;
  reference: string;
  currency: string;
  note: string;
  recipient: { name: string; email: string | null };
  items: { name: string; quantity: string; unitAmount: string; description?: string }[];
}

export interface InvoiceResult {
  invoiceId: string;
  status: string; // DRAFT | SENT | PAID | ...
  payUrl: string | null;
  amount: MoneyAmount | null;
  raw: Record<string, unknown>;
}

export interface DisputeSummary {
  disputeId: string;
  status: string;
  reason: string | null;
  amount: MoneyAmount | null;
  createTime: string | null;
  sellerResponseDueDate: string | null;
  raw: Record<string, unknown>;
}

export interface WebhookHeaders {
  transmissionId: string | null;
  transmissionTime: string | null;
  certUrl: string | null;
  authAlgo: string | null;
  transmissionSig: string | null;
}

export interface VerifyWebhookInput {
  headers: WebhookHeaders;
  rawBody: string;
  webhookId: string | null;
}

export interface VerifyWebhookResult {
  verified: boolean;
  reason: string | null;
  method: "postback" | "mock-hmac" | "test";
}

export interface PaypalGateway {
  readonly mode: "sandbox" | "mock";
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  getOrder(orderId: string): Promise<Record<string, unknown>>;
  authorizeOrder(input: AuthorizeOrderInput): Promise<AuthorizeOrderResult>;
  getAuthorization(authorizationId: string): Promise<Record<string, unknown>>;
  captureAuthorization(input: CaptureInput): Promise<CaptureResult>;
  voidAuthorization(input: VoidInput): Promise<VoidResult>;
  refundCapture(input: RefundInput): Promise<RefundResult>;
  createInvoice(input: CreateInvoiceInput): Promise<InvoiceResult>;
  sendInvoice(invoiceId: string, opts: { subject?: string; note?: string; requestId: string }): Promise<InvoiceResult>;
  remindInvoice(invoiceId: string, opts: { subject?: string; note?: string }): Promise<{ invoiceId: string; status: string }>;
  invoiceQr(invoiceId: string): Promise<{ pngBase64: string | null }>;
  getInvoice(invoiceId: string): Promise<InvoiceResult>;
  listInvoices(opts?: { page?: number; pageSize?: number }): Promise<InvoiceResult[]>;
  getDispute(disputeId: string): Promise<DisputeSummary>;
  listDisputes(opts?: { disputedTransactionId?: string; startTime?: string }): Promise<DisputeSummary[]>;
  verifyWebhookSignature(input: VerifyWebhookInput): Promise<VerifyWebhookResult>;
}

export function webhookHeadersFrom(h: Headers): WebhookHeaders {
  return {
    transmissionId: h.get("paypal-transmission-id"),
    transmissionTime: h.get("paypal-transmission-time"),
    certUrl: h.get("paypal-cert-url"),
    authAlgo: h.get("paypal-auth-algo"),
    transmissionSig: h.get("paypal-transmission-sig"),
  };
}
