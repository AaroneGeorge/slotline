/**
 * Balance invoices (PayPal Invoicing v2): create -> send -> QR, and reminders.
 * The balance is a separate PayPal object from the deposit; `balanceState`
 * becomes "invoiced" here and "paid" only via INVOICING.INVOICE.PAID.
 */
import type { Booking } from "@/shared/types";
import { getBooking, listInvoicesForBooking, saveBooking, saveInvoice, type InvoiceRecord } from "./db";
import { publish } from "./bus";
import { writeLog } from "./log";
import { HttpError } from "./http";
import { newId, nowIso } from "./ids";
import { PRICES } from "./pricing";
import { paypalCall } from "./paypal/calls";
import { toCents } from "./money";
import type { ActionResult, ExecContext } from "./bookings";
import { withBookingLock } from "./locks";

function requireBooking(id: string): Booking {
  const b = getBooking(id);
  if (!b) throw new HttpError(404, "BOOKING_NOT_FOUND", `booking ${id} not found`);
  return b;
}

/** PayPal invoice numbers must be unique per merchant and at most 25 chars. */
export function invoiceNumberFor(b: Booking): string {
  return `${b.id}-${Date.now().toString(36).slice(-6)}`.slice(0, 25);
}

export async function sendBalanceInvoice(id: string, ctx: ExecContext): Promise<ActionResult & { invoice: InvoiceRecord }> {
  return withBookingLock(id, () => sendBalanceInvoiceUnlocked(id, ctx));
}

async function sendBalanceInvoiceUnlocked(id: string, ctx: ExecContext): Promise<ActionResult & { invoice: InvoiceRecord }> {
  const b = requireBooking(id);
  if (toCents(b.balanceAmount) <= 0) throw new HttpError(409, "NO_BALANCE", "booking has no balance due");
  if (b.balanceState !== "none") throw new HttpError(409, "ALREADY_INVOICED", `balance is already ${b.balanceState}`);
  if (["released", "refunded"].includes(b.state)) throw new HttpError(409, "ILLEGAL_STATE", `will not invoice a ${b.state} booking`);
  const price = PRICES[b.service];
  const call = { bookingId: b.id, grantId: ctx.grantId, planId: ctx.planId, devTools: ctx.devTools };
  const created = await paypalCall(
    "createInvoice",
    call,
    (gw) =>
      gw.createInvoice({
        bookingId: b.id,
        invoiceNumber: invoiceNumberFor(b),
        reference: b.id,
        currency: b.currency,
        note: `Balance for your ${price.label.toLowerCase()} with Slotline. Your deposit was taken separately.`,
        recipient: { name: b.customerName, email: b.customerEmail },
        items: [{ name: `${price.label} (balance)`, quantity: "1", unitAmount: b.balanceAmount }],
      }),
    (r) => ({ message: `invoice ${r.invoiceId} ${r.status} (${b.balanceAmount} ${b.currency})`, refs: { invoiceId: r.invoiceId } }),
  );
  const sent = await paypalCall(
    "sendInvoice",
    { ...call, refs: { invoiceId: created.invoiceId } },
    (gw) => gw.sendInvoice(created.invoiceId, { subject: `Your Slotline balance: ${b.balanceAmount} ${b.currency}`, requestId: `send-${created.invoiceId}` }),
    (r) => ({ message: `invoice ${created.invoiceId} ${r.status}${b.customerEmail ? ` to ${b.customerName}` : ""}` }),
  );
  let qr: string | null = null;
  try {
    qr = (
      await paypalCall(
        "invoiceQr",
        { ...call, refs: { invoiceId: created.invoiceId } },
        (gw) => gw.invoiceQr(created.invoiceId),
        (r) => ({ message: r.pngBase64 ? "QR code generated for on-site payment" : "no QR code (mock mode)" }),
      )
    ).pngBase64;
  } catch {
    qr = null; // QR is a convenience; the invoice is already sent
  }
  const record: InvoiceRecord = { id: newId("inv"), bookingId: b.id, paypalInvoiceId: created.invoiceId, amount: b.balanceAmount, status: sent.status, qrPngBase64: qr, createdAt: nowIso() };
  saveInvoice(record);
  const fresh = requireBooking(id);
  const next: Booking = { ...fresh, paypalInvoiceId: created.invoiceId, balanceState: "invoiced", updatedAt: nowIso() };
  saveBooking(next);
  publish({ type: "booking.updated", booking: next });
  writeLog({ actor: "system", kind: "invoice.sent", message: `${b.customerName}: balance invoice ${created.invoiceId} for ${b.balanceAmount} ${b.currency} sent via PayPal`, bookingId: b.id, refs: { invoiceId: created.invoiceId, grantId: ctx.grantId, planId: ctx.planId, payUrl: sent.payUrl } });
  return { booking: next, refs: { invoiceId: created.invoiceId }, outcome: "sent", detail: `invoice ${created.invoiceId} sent`, invoice: record };
}

export async function remindBalanceInvoice(id: string, ctx: ExecContext): Promise<ActionResult> {
  return withBookingLock(id, () => remindBalanceInvoiceUnlocked(id, ctx));
}

async function remindBalanceInvoiceUnlocked(id: string, ctx: ExecContext): Promise<ActionResult> {
  const b = requireBooking(id);
  if (b.balanceState !== "invoiced" || !b.paypalInvoiceId) throw new HttpError(409, "NO_OPEN_INVOICE", "booking has no open PayPal invoice");
  const invoiceId = b.paypalInvoiceId;
  await paypalCall(
    "remindInvoice",
    { bookingId: b.id, grantId: ctx.grantId, planId: ctx.planId, devTools: ctx.devTools, refs: { invoiceId } },
    (gw) => gw.remindInvoice(invoiceId, { subject: `Reminder: your Slotline balance of ${b.balanceAmount} ${b.currency}` }),
    () => ({ message: `reminder sent for invoice ${invoiceId}` }),
  );
  writeLog({ actor: "system", kind: "invoice.reminded", message: `${b.customerName}: reminder sent for invoice ${invoiceId}`, bookingId: b.id, refs: { invoiceId, grantId: ctx.grantId, planId: ctx.planId } });
  return { booking: b, refs: { invoiceId }, outcome: "reminded", detail: `reminder sent for ${invoiceId}` };
}

export function invoicesFor(bookingId: string): InvoiceRecord[] {
  return listInvoicesForBooking(bookingId);
}
