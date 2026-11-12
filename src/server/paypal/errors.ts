/** Normalised PayPal API errors (from the SDK's ApiError or the REST helper). */

export class PaypalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The most specific PayPal error name, e.g. "INSTRUMENT_DECLINED" (details[0].issue) or "UNPROCESSABLE_ENTITY". */
    readonly issue: string,
    readonly debugId: string | null = null,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "PaypalError";
  }
}

/** Payer/instrument failures that mean "the capture was declined" (slot at risk), not a bug. */
export const DECLINE_ISSUES: ReadonlySet<string> = new Set([
  "INSTRUMENT_DECLINED",
  "TRANSACTION_REFUSED",
  "PAYER_CANNOT_PAY",
  "DECLINED_DUE_TO_RELATED_TXN",
  "PAYER_ACCOUNT_RESTRICTED",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "PAYEE_BLOCKED_TRANSACTION",
  "REDIRECT_PAYER_FOR_ALTERNATE_FUNDING",
  "INSUFFICIENT_FUNDS",
  "CARD_EXPIRED",
]);

export function isDecline(e: unknown): e is PaypalError {
  return e instanceof PaypalError && DECLINE_ISSUES.has(e.issue);
}

interface PaypalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: { issue?: string; description?: string; field?: string }[];
  error?: string; // OAuth errors
  error_description?: string;
}

export function fromErrorBody(status: number, body: unknown, fallbackMessage: string): PaypalError {
  const b = (body && typeof body === "object" ? body : {}) as PaypalErrorBody;
  const issue = b.details?.[0]?.issue ?? b.name ?? b.error ?? `HTTP_${status}`;
  const desc = b.details?.[0]?.description ?? b.message ?? b.error_description ?? fallbackMessage;
  return new PaypalError(`${issue}: ${desc}`, status, issue, b.debug_id ?? null, b.details ?? null);
}

/** Convert anything thrown by the SDK (ApiError / CustomError) or fetch into a PaypalError. */
export function normalizePaypalError(e: unknown): PaypalError {
  if (e instanceof PaypalError) return e;
  if (e && typeof e === "object" && "statusCode" in e) {
    const err = e as { statusCode: number; result?: unknown; body?: unknown; message?: string };
    let body: unknown = err.result;
    if (!body && typeof err.body === "string") {
      try {
        body = JSON.parse(err.body);
      } catch {
        body = undefined;
      }
    }
    return fromErrorBody(err.statusCode, body, err.message ?? "PayPal API error");
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new PaypalError(msg, 0, "NETWORK_ERROR");
}
