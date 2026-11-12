/**
 * Booking services: creation (solver placement), PayPal checkout (order +
 * authorize), operator money actions (capture/void/refund), moves and
 * promotions. Booking `state` only ever changes through applyMoneyEvent.
 */
import type { AuthorizeResponse, Booking, CreateBookingRequest, CreateOrderResponse, MoveBookingResponse, Service } from "@/shared/types";
import { getBooking, listBookings, listResources, saveBooking } from "./db";
import { appBaseUrl, currency, operatorTz } from "./config";
import { publish } from "./bus";
import { writeLog } from "./log";
import { HttpError } from "./http";
import { newId, nowIso, uuid } from "./ids";
import { PRICES } from "./pricing";
import { conflicts, findSlot, serviceDuration } from "./solver";
import { nextState } from "./state";
import { addMinutes, isIsoDate, localHhmm, toIso } from "./time";
import { applyMoneyEvent } from "./pipeline";
import { apiEvent } from "./paypal/normalize";
import { paypalCall, type CallContext } from "./paypal/calls";
import { isDecline, PaypalError } from "./paypal/errors";
import { cmpMoney, isMoney, normalizeMoney } from "./money";
import { withBookingLock } from "./locks";

export interface ExecContext extends CallContext {
  actor: "operator" | "system" | "customer";
  actionId?: string | null;
}

export interface ActionResult {
  booking: Booking;
  refs: Record<string, string>;
  /** "applied" | "idempotent" | "declined" | "pending" ... */
  outcome: string;
  detail: string;
}

function requireBooking(id: string): Booking {
  const b = getBooking(id);
  if (!b) throw new HttpError(404, "BOOKING_NOT_FOUND", `booking ${id} not found`);
  return b;
}

function solverOptions() {
  return { tz: operatorTz() };
}

function touch(b: Booking): Booking {
  return { ...b, updatedAt: nowIso() };
}

function persist(b: Booking): Booking {
  saveBooking(b);
  publish({ type: "booking.updated", booking: b });
  return b;
}

function ctxRefs(ctx: ExecContext): Record<string, string | null | undefined> {
  return { grantId: ctx.grantId, planId: ctx.planId, actionId: ctx.actionId, devTools: ctx.devTools ? "1" : undefined };
}

function requestId(op: string, b: Booking, ctx: ExecContext): string {
  // Under a grant the request id is deterministic per action, so a retried execution cannot double-charge.
  return ctx.grantId && ctx.actionId ? `${op}-${ctx.grantId}-${ctx.actionId}` : `${op}-${b.id}-${uuid()}`;
}

// ------------------------------------------------------------------ create

export function createBooking(req: CreateBookingRequest): Booking {
  const name = req.customerName?.trim();
  if (!name) throw new HttpError(400, "INVALID_REQUEST", "customerName is required");
  if (!(req.service in PRICES)) throw new HttpError(400, "INVALID_REQUEST", `unknown service ${String(req.service)}`);
  if (!isIsoDate(req.startAt)) throw new HttpError(400, "INVALID_REQUEST", "startAt must be an ISO-8601 date-time");
  const service = req.service as Service;
  const startAt = toIso(req.startAt);
  const durationMin = serviceDuration(service);
  const resources = listResources();
  const all = listBookings();
  const opts = solverOptions();
  const anyVan = resources[0]?.id ?? "van-1";
  const hours = conflicts([], { resourceId: req.resourceId ?? anyVan, startAt, durationMin }, opts).filter((c) => c.startsWith("outside working hours"));
  if (hours.length) throw new HttpError(422, "OUTSIDE_WORKING_HOURS", hours[0]);
  if (req.resourceId && !resources.some((r) => r.id === req.resourceId)) throw new HttpError(400, "INVALID_REQUEST", `unknown resource ${req.resourceId}`);

  const placement = req.resourceId
    ? conflicts(all, { resourceId: req.resourceId, startAt, durationMin }, opts, resources).length === 0
      ? { resourceId: req.resourceId, startAt, endAt: addMinutes(startAt, durationMin) }
      : null
    : findSlot(all, resources, startAt, durationMin, undefined, opts);
  const price = PRICES[service];
  const now = nowIso();
  const b: Booking = {
    id: newId("bk"),
    resourceId: placement?.resourceId ?? null,
    waitlist: placement === null,
    customerName: name.slice(0, 80),
    customerEmail: req.customerEmail?.trim() ? req.customerEmail.trim().slice(0, 254) : null,
    service,
    startAt,
    endAt: addMinutes(startAt, durationMin),
    durationMin,
    depositAmount: price.deposit,
    balanceAmount: price.balance,
    currency: currency(),
    state: "quoted",
    balanceState: "none",
    paypalOrderId: null,
    paypalAuthorizationId: null,
    paypalCaptureId: null,
    paypalRefundId: null,
    paypalInvoiceId: null,
    paypalDisputeId: null,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
  persist(b);
  const when = localHhmm(startAt, opts.tz);
  writeLog({
    actor: "customer",
    kind: "booking.created",
    message: placement ? `${b.customerName} requested ${price.label.toLowerCase()} at ${when}; placed on ${resources.find((r) => r.id === b.resourceId)?.name ?? b.resourceId} (quoted, awaiting deposit)` : `${b.customerName} requested ${price.label.toLowerCase()} at ${when}; no van free, added to the waitlist`,
    bookingId: b.id,
    refs: { service, resourceId: b.resourceId },
  });
  return b;
}

// ------------------------------------------------------------------ checkout

export async function createOrderForBooking(id: string): Promise<CreateOrderResponse & { approveUrl: string | null }> {
  return withBookingLock(id, () => createOrderForBookingUnlocked(id));
}

async function createOrderForBookingUnlocked(id: string): Promise<CreateOrderResponse & { approveUrl: string | null }> {
  const b = requireBooking(id);
  if (b.waitlist || !b.resourceId) throw new HttpError(409, "ON_WAITLIST", "this booking is on the waitlist; a deposit can be taken once a slot is offered");
  if (b.state !== "quoted" && b.state !== "approved") throw new HttpError(409, "ILLEGAL_STATE", `booking is ${b.state}; no new order needed`);
  if (b.paypalOrderId) return { orderId: b.paypalOrderId, approveUrl: null };
  const price = PRICES[b.service];
  const res = await paypalCall(
    "createOrder",
    { bookingId: b.id },
    (gw) =>
      gw.createOrder({
        bookingId: b.id,
        amount: { value: b.depositAmount, currency: b.currency },
        description: `Slotline deposit: ${price.label}, ${localHhmm(b.startAt, operatorTz())}`,
        customId: b.id,
        invoiceId: `SLOT-${b.id}`,
        requestId: `order-${b.id}`,
        returnUrl: `${appBaseUrl()}/book?booking=${b.id}`,
        cancelUrl: `${appBaseUrl()}/book?booking=${b.id}&cancelled=1`,
      }),
    (r) => ({ message: `order ${r.orderId} (${r.status}, intent AUTHORIZE, ${b.depositAmount} ${b.currency})`, refs: { orderId: r.orderId } }),
  );
  const fresh = requireBooking(id);
  persist(touch({ ...fresh, paypalOrderId: res.orderId }));
  writeLog({ actor: "customer", kind: "checkout.started", message: `${b.customerName} opened PayPal checkout for the ${b.depositAmount} ${b.currency} deposit`, bookingId: b.id, refs: { orderId: res.orderId } });
  return { orderId: res.orderId, approveUrl: res.approveUrl };
}

export async function authorizeBooking(id: string, orderId: string): Promise<AuthorizeResponse> {
  return withBookingLock(id, () => authorizeBookingUnlocked(id, orderId));
}

async function authorizeBookingUnlocked(id: string, orderId: string): Promise<AuthorizeResponse> {
  const b = requireBooking(id);
  if (!orderId || orderId !== b.paypalOrderId) throw new HttpError(409, "ORDER_MISMATCH", "orderId does not belong to this booking");
  if (b.paypalAuthorizationId && ["held", "pending", "confirmed", "declined", "disputed"].includes(b.state)) {
    return { booking: b, authorizationId: b.paypalAuthorizationId }; // already authorized: idempotent
  }
  if (b.state !== "quoted" && b.state !== "approved") throw new HttpError(409, "ILLEGAL_STATE", `booking is ${b.state}`);
  writeLog({ actor: "customer", kind: "checkout.approved", message: `${b.customerName} approved the deposit hold in PayPal`, bookingId: b.id, refs: { orderId } });
  const res = await paypalCall(
    "authorizeOrder",
    { bookingId: b.id },
    (gw) => gw.authorizeOrder({ orderId, requestId: `auth-${orderId}` }),
    (r) => ({ message: `authorization ${r.authorizationId} ${r.authorizationStatus} (order ${r.orderStatus})`, refs: { orderId, authorizationId: r.authorizationId } }),
  );
  await applyMoneyEvent(apiEvent("CHECKOUT.ORDER.APPROVED", b.id, { id: orderId, status: "APPROVED", intent: "AUTHORIZE", purchase_units: [{ custom_id: b.id, invoice_id: `SLOT-${b.id}` }] }));
  if (res.authorizationStatus === "CREATED" || res.authorizationStatus === "PENDING") {
    await applyMoneyEvent(
      apiEvent("PAYMENT.AUTHORIZATION.CREATED", b.id, {
        id: res.authorizationId,
        status: res.authorizationStatus,
        ...(res.amount ? { amount: { currency_code: res.amount.currency, value: res.amount.value } } : {}),
        custom_id: b.id,
        invoice_id: `SLOT-${b.id}`,
        expiration_time: res.expirationTime,
        supplementary_data: { related_ids: { order_id: orderId } },
      }),
    );
  } else {
    writeLog({ actor: "system", kind: "booking.authorization", message: `Authorization ${res.authorizationId} came back ${res.authorizationStatus}; slot not held`, bookingId: b.id, refs: { authorizationId: res.authorizationId } });
  }
  return { booking: requireBooking(id), authorizationId: res.authorizationId };
}

// ------------------------------------------------------------------ money actions

export async function captureBooking(id: string, ctx: ExecContext & { mockResponse?: string }): Promise<ActionResult> {
  return withBookingLock(id, () => captureBookingUnlocked(id, ctx));
}

async function captureBookingUnlocked(id: string, ctx: ExecContext & { mockResponse?: string }): Promise<ActionResult> {
  const b = requireBooking(id);
  if (!b.paypalAuthorizationId) throw new HttpError(409, "NO_AUTHORIZATION", "booking has no PayPal authorization to capture");
  if (nextState(b.state, "PAYMENT.CAPTURE.COMPLETED") !== "confirmed" || b.state === "confirmed") throw new HttpError(409, "ILLEGAL_STATE", `cannot capture while booking is ${b.state}`);
  const authorizationId = b.paypalAuthorizationId;
  const refs = ctxRefs(ctx);
  try {
    const r = await paypalCall(
      "captureAuthorization",
      { bookingId: b.id, grantId: ctx.grantId, planId: ctx.planId, devTools: ctx.devTools, refs: { authorizationId, mockResponse: ctx.mockResponse } },
      (gw) => gw.captureAuthorization({ authorizationId, amount: { value: b.depositAmount, currency: b.currency }, invoiceId: `SLOT-${b.id}`, requestId: requestId("cap", b, ctx), mockResponse: ctx.mockResponse }),
      (r) => ({ message: `capture ${r.captureId ?? "-"} ${r.status}${r.statusReason ? ` (${r.statusReason})` : ""}`, refs: { captureId: r.captureId } }),
    );
    const type = r.status === "COMPLETED" ? "PAYMENT.CAPTURE.COMPLETED" : r.status === "PENDING" ? "PAYMENT.CAPTURE.PENDING" : "PAYMENT.CAPTURE.DENIED";
    const resource = { ...r.raw, id: r.captureId, status: r.status, custom_id: b.id, supplementary_data: { related_ids: { order_id: b.paypalOrderId, authorization_id: authorizationId } } };
    const res = await applyMoneyEvent(apiEvent(type, b.id, resource, { ...refs, authorizationId, captureId: r.captureId }));
    return { booking: res.booking ?? requireBooking(id), refs: { authorizationId, ...(r.captureId ? { captureId: r.captureId } : {}), eventId: res.eventId }, outcome: type === "PAYMENT.CAPTURE.DENIED" ? "declined" : r.status.toLowerCase(), detail: `capture ${r.status}` };
  } catch (e) {
    if (isDecline(e)) {
      const resource = { id: null, status: "DECLINED", custom_id: b.id, invoice_id: `SLOT-${b.id}`, error: { name: "UNPROCESSABLE_ENTITY", issue: e.issue, debug_id: e.debugId }, supplementary_data: { related_ids: { order_id: b.paypalOrderId, authorization_id: authorizationId } } };
      const res = await applyMoneyEvent(apiEvent("PAYMENT.CAPTURE.DENIED", b.id, resource, { ...refs, authorizationId, issue: e.issue }));
      return { booking: res.booking ?? requireBooking(id), refs: { authorizationId, issue: e.issue, eventId: res.eventId }, outcome: "declined", detail: `capture declined: ${e.issue}` };
    }
    throw e;
  }
}

export async function voidBooking(id: string, ctx: ExecContext): Promise<ActionResult> {
  return withBookingLock(id, () => voidBookingUnlocked(id, ctx));
}

async function voidBookingUnlocked(id: string, ctx: ExecContext): Promise<ActionResult> {
  const b = requireBooking(id);
  if (!b.paypalAuthorizationId) throw new HttpError(409, "NO_AUTHORIZATION", "booking has no PayPal authorization to void");
  if (nextState(b.state, "PAYMENT.AUTHORIZATION.VOIDED") !== "released" || b.state === "released") throw new HttpError(409, "ILLEGAL_STATE", `cannot void while booking is ${b.state}`);
  const authorizationId = b.paypalAuthorizationId;
  const r = await paypalCall(
    "voidAuthorization",
    { bookingId: b.id, grantId: ctx.grantId, planId: ctx.planId, devTools: ctx.devTools, refs: { authorizationId } },
    (gw) => gw.voidAuthorization({ authorizationId, requestId: requestId("void", b, ctx) }),
    (r) => ({ message: `authorization ${r.authorizationId} ${r.status}` }),
  );
  const resource = { ...r.raw, id: authorizationId, status: r.status, custom_id: b.id, supplementary_data: { related_ids: { order_id: b.paypalOrderId } } };
  const res = await applyMoneyEvent(apiEvent("PAYMENT.AUTHORIZATION.VOIDED", b.id, resource, { ...ctxRefs(ctx), authorizationId }));
  return { booking: res.booking ?? requireBooking(id), refs: { authorizationId, eventId: res.eventId }, outcome: res.outcome, detail: `authorization ${r.status}` };
}

export async function refundBooking(id: string, ctx: ExecContext & { amount?: string }): Promise<ActionResult> {
  return withBookingLock(id, () => refundBookingUnlocked(id, ctx));
}

async function refundBookingUnlocked(id: string, ctx: ExecContext & { amount?: string }): Promise<ActionResult> {
  const b = requireBooking(id);
  if (!b.paypalCaptureId) throw new HttpError(409, "NO_CAPTURE", "booking has no captured payment to refund");
  if (nextState(b.state, "PAYMENT.CAPTURE.REFUNDED") !== "refunded" || b.state === "refunded") throw new HttpError(409, "ILLEGAL_STATE", `cannot refund while booking is ${b.state}`);
  const amount = ctx.amount ? normalizeMoney(ctx.amount) : b.depositAmount;
  if (!isMoney(amount) || cmpMoney(amount, "0.00") <= 0 || cmpMoney(amount, b.depositAmount) > 0) throw new HttpError(400, "INVALID_AMOUNT", `refund amount must be between 0.01 and ${b.depositAmount}`);
  const captureId = b.paypalCaptureId;
  const r = await paypalCall(
    "refundCapture",
    { bookingId: b.id, grantId: ctx.grantId, planId: ctx.planId, devTools: ctx.devTools, refs: { captureId } },
    (gw) => gw.refundCapture({ captureId, amount: { value: amount, currency: b.currency }, invoiceId: `SLOT-${b.id}-R`, noteToPayer: "Slotline refund", requestId: requestId("refund", b, ctx) }),
    (r) => ({ message: `refund ${r.refundId} ${r.status} (${r.amount?.value ?? amount} ${b.currency})`, refs: { refundId: r.refundId } }),
  );
  if (r.status !== "COMPLETED") {
    if (r.status === "PENDING") {
      writeLog({ actor: "system", kind: "refund.pending", message: `Refund ${r.refundId} is PENDING at PayPal; the slot is released when PAYMENT.CAPTURE.REFUNDED arrives`, bookingId: b.id, refs: { refundId: r.refundId, captureId } });
      return { booking: requireBooking(id), refs: { captureId, refundId: r.refundId }, outcome: "pending", detail: "refund pending" };
    }
    throw new PaypalError(`refund ${r.status}`, 502, `REFUND_${r.status}`);
  }
  const resource = { ...r.raw, id: r.refundId, status: r.status, custom_id: b.id, links: [{ href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: "up", method: "GET" }] };
  const res = await applyMoneyEvent(apiEvent("PAYMENT.CAPTURE.REFUNDED", b.id, resource, { ...ctxRefs(ctx), captureId, refundId: r.refundId }));
  return { booking: res.booking ?? requireBooking(id), refs: { captureId, refundId: r.refundId, eventId: res.eventId }, outcome: res.outcome, detail: `refund ${r.status}` };
}

// ------------------------------------------------------------------ placement

export function moveBooking(id: string, startAtRaw: string, resourceId: string, ctx: ExecContext): MoveBookingResponse & { ok: boolean } {
  const b = requireBooking(id);
  if (!isIsoDate(startAtRaw)) throw new HttpError(400, "INVALID_REQUEST", "startAt must be an ISO-8601 date-time");
  if (b.state === "released" || b.state === "refunded") throw new HttpError(409, "ILLEGAL_STATE", `a ${b.state} booking is not on the timeline`);
  const isPromotion = b.waitlist || b.resourceId === null;
  if (isPromotion && b.state !== "quoted") throw new HttpError(409, "ILLEGAL_STATE", `cannot place a ${b.state} booking from the waitlist`);
  const startAt = toIso(startAtRaw);
  const c = conflicts(listBookings(), { id: b.id, resourceId, startAt, durationMin: b.durationMin }, solverOptions(), listResources());
  if (c.length) return { ok: false, booking: b, conflicts: c };
  const moved = persist(touch({ ...b, startAt, endAt: addMinutes(startAt, b.durationMin), resourceId, waitlist: false }));
  const tz = operatorTz();
  writeLog({
    actor: ctx.actor,
    kind: isPromotion ? "booking.promoted" : "booking.moved",
    message: isPromotion
      ? `${b.customerName} promoted from the waitlist to ${localHhmm(startAt, tz)} on ${resourceId} (still needs a deposit)`
      : `${b.customerName} moved ${b.resourceId === resourceId ? "" : `from ${b.resourceId} to ${resourceId} `}${localHhmm(b.startAt, tz)} → ${localHhmm(startAt, tz)}`,
    bookingId: b.id,
    refs: { ...ctxRefs(ctx), fromStartAt: b.startAt, toStartAt: startAt, resourceId },
  });
  return { ok: true, booking: moved, conflicts: [] };
}
