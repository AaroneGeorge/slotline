/**
 * validatePlan: the model proposes, code decides. Every action is run through
 * the booking state machine and the solver against a simulated copy of the
 * day (earlier actions in the option change what later ones see). Sets
 * feasible / infeasibleReason / amount; drops options with no feasible
 * action; caps at 3 options. Amounts come from the booking, never the model.
 */
import type { Booking, DraftMessage, PlanAction, PlanActionType, PlanOption } from "@/shared/types";
import { conflicts } from "../solver";
import { nextState, occupiesSlot } from "../state";
import { addMinutes, isIsoDate, toIso } from "../time";
import { toCents } from "../money";
import type { PlanContext } from "./context";
import { solverOpts } from "./context";
import type { RawAction, RawPlan } from "./schema";

export const MONEY_ACTIONS: ReadonlySet<PlanActionType> = new Set(["void", "capture", "refund", "send_invoice"]);

/** Execution order: release money first (frees slots), then placements, then follow-ups. */
const PHASE: Record<PlanActionType, number> = {
  void: 0,
  refund: 0,
  capture: 1,
  move: 2,
  promote: 2,
  send_invoice: 3,
  send_reminder: 3,
  flag_dispute: 4,
  message: 5,
};

export interface ValidatedPlan {
  summary: string;
  options: PlanOption[];
  draftMessages: DraftMessage[];
}

interface Check {
  feasible: boolean;
  reason: string | null;
  amount: string | null;
  params: Record<string, unknown>;
  apply?: (b: Booking) => Booking;
}

const ok = (params: Record<string, unknown>, amount: string | null, apply?: (b: Booking) => Booking): Check => ({ feasible: true, reason: null, amount, params, apply });
const no = (reason: string, params: Record<string, unknown> = {}, amount: string | null = null): Check => ({ feasible: false, reason, amount, params });

function placementParams(a: RawAction): { startAt: string | null; resourceId: string | null } {
  return { startAt: a.startAt && isIsoDate(a.startAt) ? toIso(a.startAt) : null, resourceId: a.resourceId ?? null };
}

function checkAction(a: RawAction, b: Booking | undefined, work: Map<string, Booking>, ctx: PlanContext): Check {
  if (!b) return no(`unknown booking ${a.bookingId}`);
  const opts = solverOpts(ctx);
  switch (a.type) {
    case "void": {
      if (!b.paypalAuthorizationId) return no("no PayPal authorization on file to void");
      const to = nextState(b.state, "PAYMENT.AUTHORIZATION.VOIDED");
      if (to !== "released" || b.state === "released") return no(`cannot void while booking is ${b.state}`, {}, b.depositAmount);
      return ok({ authorizationId: b.paypalAuthorizationId }, b.depositAmount, (x) => ({ ...x, state: "released", waitlist: false }));
    }
    case "capture": {
      if (!b.paypalAuthorizationId) return no("no PayPal authorization on file to capture");
      const to = nextState(b.state, "PAYMENT.CAPTURE.COMPLETED");
      if (to !== "confirmed" || b.state === "confirmed") return no(`cannot capture while booking is ${b.state}`, {}, b.depositAmount);
      return ok({ authorizationId: b.paypalAuthorizationId }, b.depositAmount, (x) => ({ ...x, state: "confirmed" }));
    }
    case "refund": {
      if (!b.paypalCaptureId) return no("no captured payment on file to refund");
      const to = nextState(b.state, "PAYMENT.CAPTURE.REFUNDED");
      if (to !== "refunded" || b.state === "refunded") return no(`cannot refund while booking is ${b.state}`, {}, b.depositAmount);
      return ok({ captureId: b.paypalCaptureId }, b.depositAmount, (x) => ({ ...x, state: "refunded", waitlist: false }));
    }
    case "move": {
      const p = placementParams(a);
      if (!p.startAt || !p.resourceId) return no("move needs startAt and resourceId", p);
      if (!occupiesSlot(b)) return no(`booking is not on the timeline (${b.state}${b.waitlist ? ", waitlist" : ""})`, p);
      if (b.state === "confirmed" || b.state === "disputed") return no(`the agent may not move a ${b.state} job`, p);
      const c = conflicts([...work.values()], { id: b.id, resourceId: p.resourceId, startAt: p.startAt, durationMin: b.durationMin }, opts, ctx.resources);
      if (c.length) return no(c.join("; "), p);
      const sa = p.startAt;
      const rid = p.resourceId;
      return ok({ startAt: sa, resourceId: rid, fromStartAt: b.startAt, fromResourceId: b.resourceId }, null, (x) => ({ ...x, startAt: sa, endAt: addMinutes(sa, x.durationMin), resourceId: rid }));
    }
    case "promote": {
      const p = placementParams(a);
      if (!p.startAt || !p.resourceId) return no("promote needs startAt and resourceId", p);
      if (b.state !== "quoted" || (!b.waitlist && b.resourceId !== null)) return no(`only waitlisted quoted bookings can be promoted (this one is ${b.state}${b.waitlist ? ", waitlist" : ", on the timeline"})`, p);
      const c = conflicts([...work.values()], { id: b.id, resourceId: p.resourceId, startAt: p.startAt, durationMin: b.durationMin }, opts, ctx.resources);
      if (c.length) return no(c.join("; "), p);
      const sa = p.startAt;
      const rid = p.resourceId;
      return ok({ startAt: sa, resourceId: rid }, null, (x) => ({ ...x, startAt: sa, endAt: addMinutes(sa, x.durationMin), resourceId: rid, waitlist: false }));
    }
    case "send_invoice": {
      if (toCents(b.balanceAmount) <= 0) return no("no balance due on this booking");
      if (b.balanceState !== "none") return no(`balance is already ${b.balanceState}`);
      if (!["held", "pending", "confirmed"].includes(b.state)) return no(`will not invoice a ${b.state} booking`);
      return ok({}, b.balanceAmount, (x) => ({ ...x, balanceState: "invoiced" }));
    }
    case "send_reminder": {
      if (b.balanceState !== "invoiced" || !b.paypalInvoiceId) return no("no open PayPal invoice to remind about");
      if (["released", "refunded"].includes(b.state)) return no(`will not chase a ${b.state} booking`);
      return ok({ invoiceId: b.paypalInvoiceId }, null);
    }
    case "message": {
      const body = (a.body ?? "").trim();
      const channel = a.channel ?? "email";
      const params = { channel, subject: a.subject ?? null, body };
      if (!body) return no("message has no body", params);
      if (channel === "sms") return no("no phone number on file for SMS", params);
      if (!b.customerEmail) return no("no email address on file", params);
      return ok(params, null);
    }
    case "flag_dispute": {
      if (b.state !== "disputed") return no(`booking is ${b.state}, not disputed`);
      return ok({ disputeId: b.paypalDisputeId }, null);
    }
    default:
      return no(`unsupported action ${(a as RawAction).type}`);
  }
}

export function validatePlan(raw: RawPlan, ctx: PlanContext): ValidatedPlan {
  const known = new Map(ctx.bookings.map((b) => [b.id, b]));
  const options: PlanOption[] = [];
  raw.options.forEach((ro, oi) => {
    const work = new Map(ctx.bookings.map((b) => [b.id, { ...b }]));
    const seen = new Set<string>();
    const ordered = ro.actions
      .map((a, i) => ({ a, i }))
      .sort((x, y) => PHASE[x.a.type] - PHASE[y.a.type] || x.i - y.i)
      .map((x) => x.a);
    const actions: PlanAction[] = ordered.map((a, ai) => {
      const b = work.get(a.bookingId);
      const key = a.type === "message" ? `${a.type}:${a.bookingId}:${a.body}` : `${a.type}:${a.bookingId}`;
      let check: Check;
      if (seen.has(key)) check = no("duplicate of an earlier action in this option");
      else check = checkAction(a, b, work, ctx);
      seen.add(key);
      if (check.feasible && check.apply && b) work.set(b.id, check.apply(b));
      const isMoney = MONEY_ACTIONS.has(a.type);
      return {
        id: `act_${oi + 1}_${ai + 1}`,
        type: a.type,
        bookingId: a.bookingId,
        params: check.params,
        feasible: check.feasible,
        infeasibleReason: check.reason,
        amount: isMoney ? check.amount : null,
        currency: isMoney && check.amount ? (known.get(a.bookingId)?.currency ?? null) : null,
      };
    });
    if (actions.some((a) => a.feasible)) {
      options.push({ id: "", title: ro.title.trim().slice(0, 140) || `Option ${oi + 1}`, rationale: ro.rationale.trim().slice(0, 600), actions });
    }
  });
  const capped = options.slice(0, 3).map((o, i) => ({ ...o, id: `opt_${String.fromCharCode(97 + i)}` }));
  const draftMessages: DraftMessage[] = raw.draftMessages
    .filter((d) => known.has(d.bookingId) && d.body.trim() !== "")
    .slice(0, 6)
    .map((d) => ({ bookingId: d.bookingId, channel: d.channel, subject: d.subject ?? null, body: d.body.trim().slice(0, 2000) }));
  return { summary: raw.summary.trim().slice(0, 400) || "Proposed changes", options: capped, draftMessages };
}
