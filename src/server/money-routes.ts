/**
 * Shared logic for POST /api/bookings/:id/{capture,void,refund,invoice,remind}.
 * Needs an active grant (grantId), or the x-dev-secret header when dev tools
 * are enabled (logged as actor "operator" with refs.devTools = "1").
 */
import { z } from "zod";
import type { Booking, PlanActionType } from "@/shared/types";
import { getBooking } from "./db";
import { writeLog } from "./log";
import { HttpError, hasDevSecret, json, readJson } from "./http";
import { captureBooking, refundBooking, voidBooking, type ExecContext } from "./bookings";
import { remindBalanceInvoice, sendBalanceInvoice } from "./invoices";
import { runSingleGrantedAction } from "./grants";
import { devToolsEnabled } from "./config";

export const grantedActionSchema = z.object({
  grantId: z.string().min(1).optional(),
  mockResponse: z.string().regex(/^[A-Z0-9_]{3,64}$/).optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
});

export type MoneyRoute = "capture" | "void" | "refund" | "invoice" | "remind";

const ACTION_TYPE: Record<MoneyRoute, PlanActionType> = {
  capture: "capture",
  void: "void",
  refund: "refund",
  invoice: "send_invoice",
  remind: "send_reminder",
};

function amountFor(kind: MoneyRoute, b: Booking, requested?: string): string | null {
  switch (kind) {
    case "capture":
    case "void":
      return b.depositAmount;
    case "refund":
      return requested ?? b.depositAmount;
    case "invoice":
      return b.balanceAmount;
    case "remind":
      return null;
  }
}

export async function handleMoneyRoute(kind: MoneyRoute, req: Request, bookingId: string): Promise<Response> {
  const body = await readJson(req, grantedActionSchema);
  const b = getBooking(bookingId);
  if (!b) throw new HttpError(404, "BOOKING_NOT_FOUND", `booking ${bookingId} not found`);
  if (body.mockResponse && kind !== "capture") throw new HttpError(400, "INVALID_REQUEST", "mockResponse is only supported for capture");

  const run = async (ctx: ExecContext) => {
    switch (kind) {
      case "capture":
        return captureBooking(bookingId, { ...ctx, mockResponse: body.mockResponse });
      case "void":
        return voidBooking(bookingId, ctx);
      case "refund":
        return refundBooking(bookingId, { ...ctx, amount: body.amount });
      case "invoice":
        return sendBalanceInvoice(bookingId, ctx);
      case "remind":
        return remindBalanceInvoice(bookingId, ctx);
    }
  };

  if (body.grantId) {
    const res = await runSingleGrantedAction(body.grantId, ACTION_TYPE[kind], bookingId, amountFor(kind, b, body.amount), run);
    return json({ booking: res.booking, refs: { ...res.refs, outcome: res.outcome } });
  }
  if (devToolsEnabled() && hasDevSecret(req)) {
    writeLog({
      actor: "operator",
      kind: "dev.action",
      message: `Dev tools: ${kind}${body.mockResponse ? ` with PayPal-Mock-Response ${body.mockResponse}` : ""} on ${b.customerName}'s booking (no grant)`,
      bookingId,
      refs: { devTools: "1", mockResponse: body.mockResponse },
    });
    const res = await run({ actor: "operator", devTools: true });
    return json({ booking: res.booking, refs: { ...res.refs, outcome: res.outcome } });
  }
  throw new HttpError(403, "GRANT_REQUIRED", `${kind} moves money and needs an execution grant (approve a plan option) or dev tools`);
}
