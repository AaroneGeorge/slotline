/**
 * Every PayPal call goes through `paypalCall`, which logs it (actor "system",
 * with refs.grantId when under a grant) whether it succeeds or fails.
 */
import { writeLog } from "../log";
import { normalizePaypalError, PaypalError } from "./errors";
import { getGateway } from "./index";
import type { PaypalGateway } from "./gateway";

export interface CallContext {
  bookingId?: string | null;
  grantId?: string | null;
  planId?: string | null;
  devTools?: boolean;
  refs?: Record<string, string | null | undefined>;
}

export async function paypalCall<T>(
  op: string,
  ctx: CallContext,
  fn: (gw: PaypalGateway) => Promise<T>,
  describe: (result: T) => { message: string; refs?: Record<string, string | null | undefined> },
): Promise<T> {
  const gw = getGateway();
  const base = { grantId: ctx.grantId, planId: ctx.planId, devTools: ctx.devTools ? "1" : undefined, paypalMode: gw.mode, op, ...ctx.refs };
  try {
    const result = await fn(gw);
    const d = describe(result);
    writeLog({ actor: "system", kind: "paypal.call", message: `${op}: ${d.message}`, bookingId: ctx.bookingId ?? null, refs: { ...base, ...d.refs } });
    return result;
  } catch (e) {
    const err: PaypalError = normalizePaypalError(e);
    writeLog({
      actor: "system",
      kind: "paypal.error",
      message: `${op} failed: HTTP ${err.status} ${err.issue}${err.debugId ? ` (debug_id ${err.debugId})` : ""}`,
      bookingId: ctx.bookingId ?? null,
      refs: { ...base, issue: err.issue, status: String(err.status), debugId: err.debugId },
    });
    throw err;
  }
}
