/**
 * Execution grants. Planning is read-only; money moves only under a grant
 * that an operator approval minted. A grant is bound to the option's booking
 * ids, action types, a max amount + currency, and a 15-minute expiry, and is
 * checked before every PayPal call. It is used once: consumption is a single
 * atomic SQLite UPDATE (`claimGrant`), so two concurrent requests holding the
 * same grant id cannot both run.
 */
import type { ApprovePlanResponse, Plan, PlanAction, PlanActionType, PlanOption } from "@/shared/types";
import { claimGrant, claimPlan, getBooking, getGrant, getPlan, saveGrant, savePlan, publicGrant, type StoredGrant } from "./db";
import { currency as defaultCurrency, GRANT_TTL_MS, operatorTz } from "./config";
import { publish } from "./bus";
import { writeLog } from "./log";
import { HttpError } from "./http";
import { newId } from "./ids";
import { addMoney, cmpMoney } from "./money";
import { localHhmm } from "./time";
import { captureBooking, moveBooking, refundBooking, voidBooking, type ExecContext } from "./bookings";
import { remindBalanceInvoice, sendBalanceInvoice } from "./invoices";
import { buildPlanContext } from "./planner/context";
import { MONEY_ACTIONS, validatePlan } from "./planner/validate";
import type { RawPlan } from "./planner/schema";
import { buildEvidencePack } from "./evidence";

export class GrantError extends HttpError {
  constructor(code: string, message: string) {
    super(403, code, message);
    this.name = "GrantError";
  }
}

// ------------------------------------------------------------------ minting

export function mintGrant(plan: Plan, option: PlanOption, now = new Date()): StoredGrant {
  const feasible = option.actions.filter((a) => a.feasible);
  if (feasible.length === 0) throw new HttpError(409, "NOTHING_TO_EXECUTE", "the option has no feasible action");
  const money = feasible.filter((a) => MONEY_ACTIONS.has(a.type) && a.amount);
  const currencies = [...new Set(money.map((a) => a.currency ?? defaultCurrency()))];
  if (currencies.length > 1) throw new HttpError(409, "MIXED_CURRENCY", "one grant cannot cover more than one currency");
  const grant: StoredGrant = {
    id: newId("grant"),
    planId: plan.id,
    optionId: option.id,
    bookingIds: [...new Set(feasible.map((a) => a.bookingId))],
    allowedActions: [...new Set(feasible.map((a) => a.type))] as PlanActionType[],
    maxAmount: money.length ? addMoney(...money.map((a) => a.amount as string)) : "0.00",
    spentAmount: "0.00",
    currency: currencies[0] ?? defaultCurrency(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + GRANT_TTL_MS).toISOString(),
    approvedBy: "operator",
    status: "active",
    usedAt: null,
  };
  saveGrant(grant);
  publish({ type: "grant.updated", grant: publicGrant(grant) });
  writeLog({
    actor: "operator",
    kind: "grant.minted",
    message: `Operator approved "${option.title}". Execution grant: ${grant.allowedActions.join(", ")} on ${grant.bookingIds.length} booking${grant.bookingIds.length === 1 ? "" : "s"}, max ${grant.maxAmount} ${grant.currency}, expires ${localHhmm(grant.expiresAt, operatorTz())}`,
    bookingId: plan.trigger.bookingId,
    refs: { grantId: grant.id, planId: plan.id, optionId: option.id, maxAmount: grant.maxAmount, expiresAt: grant.expiresAt },
  });
  return grant;
}

// ------------------------------------------------------------------ checks

function setGrantStatus(gr: StoredGrant, status: StoredGrant["status"], extra: Partial<StoredGrant> = {}): StoredGrant {
  const next = { ...gr, status, ...extra };
  saveGrant(next);
  publish({ type: "grant.updated", grant: publicGrant(next) });
  return next;
}

type ScopedAction = { type: PlanActionType; bookingId: string; amount: string | null; currency?: string | null };

/** Throws GrantError unless `action` is inside the grant's scope right now. Expires the grant lazily. */
export function assertWithinGrant(gr: StoredGrant, action: ScopedAction, now = new Date()): void {
  if (gr.status !== "active") throw new GrantError("GRANT_INACTIVE", `grant ${gr.id} is ${gr.status}`);
  if (now.getTime() >= new Date(gr.expiresAt).getTime()) {
    setGrantStatus(gr, "expired");
    writeLog({ actor: "system", kind: "grant.expired", message: `Grant ${gr.id} expired at ${gr.expiresAt}; action refused`, refs: { grantId: gr.id } });
    throw new GrantError("GRANT_EXPIRED", `grant ${gr.id} expired at ${gr.expiresAt}`);
  }
  assertScope(gr, action);
}

/** Inside a claimed grant (status already `used` by this caller): expiry and scope only. */
function assertClaimedScope(gr: StoredGrant, action: ScopedAction, now = new Date()): void {
  if (now.getTime() >= new Date(gr.expiresAt).getTime()) throw new GrantError("GRANT_EXPIRED", `grant ${gr.id} expired at ${gr.expiresAt}`);
  assertScope(gr, action);
}

function assertScope(gr: StoredGrant, action: ScopedAction): void {
  if (!gr.allowedActions.includes(action.type)) throw new GrantError("ACTION_NOT_ALLOWED", `grant ${gr.id} does not allow "${action.type}"`);
  if (!gr.bookingIds.includes(action.bookingId)) throw new GrantError("BOOKING_NOT_IN_GRANT", `grant ${gr.id} does not cover booking ${action.bookingId}`);
  if (action.amount) {
    if (action.currency && action.currency !== gr.currency) throw new GrantError("CURRENCY_MISMATCH", `grant ${gr.id} is in ${gr.currency}, action is in ${action.currency}`);
    const after = addMoney(gr.spentAmount, action.amount);
    if (cmpMoney(after, gr.maxAmount) > 0) throw new GrantError("AMOUNT_EXCEEDS_GRANT", `action amount ${action.amount} ${gr.currency} would exceed the grant's remaining ${addMoney(gr.maxAmount, `-${gr.spentAmount}`)} ${gr.currency}`);
  }
}

function recordSpend(gr: StoredGrant, amount: string | null): StoredGrant {
  if (!amount) return gr;
  const next = { ...gr, spentAmount: addMoney(gr.spentAmount, amount) };
  saveGrant(next);
  return next;
}

export function requireGrant(id: string): StoredGrant {
  const gr = getGrant(id);
  if (!gr) throw new GrantError("GRANT_NOT_FOUND", `grant ${id} not found`);
  return gr;
}

/** Why `claimGrant` matched nothing: someone else consumed it, or it expired a moment ago. */
function refusedClaim(id: string): GrantError {
  const cur = getGrant(id);
  if (cur?.status === "active") return new GrantError("GRANT_EXPIRED", `grant ${id} expired at ${cur.expiresAt}`);
  return new GrantError("GRANT_INACTIVE", `grant ${id} is ${cur?.status ?? "not found"}`);
}

/** Consume the grant atomically, or throw. Exactly one of any number of concurrent callers gets the grant back. */
function consumeGrant(id: string, bookingId: string | null): StoredGrant {
  const claimed = claimGrant(id);
  if (!claimed) {
    const err = refusedClaim(id);
    writeLog({ actor: "system", kind: "grant.refused", message: `Grant ${id} refused: ${err.message}`, bookingId, refs: { grantId: id, code: err.code } });
    throw err;
  }
  publish({ type: "grant.updated", grant: publicGrant(claimed) });
  return claimed;
}

// ------------------------------------------------------------------ actions

export interface ActionOutcome {
  ok: boolean;
  detail: string;
  refs: Record<string, string>;
}

/** Perform one plan action (grant already checked). Money actions call PayPal through the gateway. */
export async function performAction(action: PlanAction, ctx: ExecContext): Promise<ActionOutcome> {
  const p = action.params as Record<string, unknown>;
  switch (action.type) {
    case "capture": {
      const r = await captureBooking(action.bookingId, ctx);
      return { ok: r.outcome !== "declined", detail: r.detail, refs: r.refs };
    }
    case "void": {
      const r = await voidBooking(action.bookingId, ctx);
      return { ok: true, detail: r.detail, refs: r.refs };
    }
    case "refund": {
      const r = await refundBooking(action.bookingId, { ...ctx, amount: action.amount ?? undefined });
      return { ok: true, detail: r.detail, refs: r.refs };
    }
    case "send_invoice": {
      const r = await sendBalanceInvoice(action.bookingId, ctx);
      return { ok: true, detail: r.detail, refs: r.refs };
    }
    case "send_reminder": {
      const r = await remindBalanceInvoice(action.bookingId, ctx);
      return { ok: true, detail: r.detail, refs: r.refs };
    }
    case "move":
    case "promote": {
      const r = moveBooking(action.bookingId, String(p.startAt), String(p.resourceId), ctx);
      if (!r.ok) return { ok: false, detail: `conflicts: ${r.conflicts.join("; ")}`, refs: {} };
      return { ok: true, detail: `${action.type === "promote" ? "promoted" : "moved"} to ${String(p.startAt)} on ${String(p.resourceId)}`, refs: {} };
    }
    case "message": {
      const subject = typeof p.subject === "string" ? p.subject : "";
      writeLog({
        actor: "system",
        kind: "message.sent",
        message: `Email to customer${subject ? `: "${subject}"` : ""} (demo: recorded, not delivered; no mail provider is configured)`,
        bookingId: action.bookingId,
        refs: { grantId: ctx.grantId, planId: ctx.planId, actionId: action.id, channel: String(p.channel ?? "email") },
      });
      return { ok: true, detail: "message recorded (no mail provider configured)", refs: {} };
    }
    case "flag_dispute": {
      const pack = await buildEvidencePack(action.bookingId);
      writeLog({
        actor: "system",
        kind: "dispute.flagged",
        message: `Evidence pack assembled for ${pack.booking.customerName}: ${pack.events?.length ?? 0} money events, ${pack.timeline?.length ?? 0} log entries`,
        bookingId: action.bookingId,
        refs: { grantId: ctx.grantId, planId: ctx.planId, disputeId: pack.booking.paypalDisputeId, evidenceUrl: `/evidence/${action.bookingId}` },
      });
      return { ok: true, detail: "evidence pack assembled", refs: { evidenceUrl: `/evidence/${action.bookingId}` } };
    }
  }
}

// ------------------------------------------------------------------ plans

function toRaw(plan: Plan, option: PlanOption): RawPlan {
  return {
    summary: plan.summary,
    options: [
      {
        title: option.title,
        rationale: option.rationale,
        actions: option.actions.map((a) => {
          const p = a.params as Record<string, unknown>;
          return {
            type: a.type,
            bookingId: a.bookingId,
            startAt: typeof p.startAt === "string" ? p.startAt : null,
            resourceId: typeof p.resourceId === "string" ? p.resourceId : null,
            channel: p.channel === "email" || p.channel === "sms" ? p.channel : null,
            subject: typeof p.subject === "string" ? p.subject : null,
            body: typeof p.body === "string" ? p.body : null,
          };
        }),
      },
    ],
    draftMessages: plan.draftMessages,
  };
}

/** Re-check the chosen option against the schedule as it is now (it may have changed since the proposal). */
export function revalidateOption(plan: Plan, option: PlanOption): PlanOption | null {
  const ctx = buildPlanContext({ eventType: plan.trigger.eventType, eventId: plan.trigger.eventId, bookingId: plan.trigger.bookingId });
  const v = validatePlan(toRaw(plan, option), ctx);
  const fresh = v.options[0];
  if (!fresh) return null;
  // Actions were already in execution order, and validatePlan's sort is stable, so index i is the same action.
  // Keep the original action ids so the dashboard can match results to chips.
  return { ...option, actions: fresh.actions.map((a, i) => ({ ...a, id: option.actions[i]?.id ?? a.id })) };
}

export async function approvePlan(planId: string, optionId: string): Promise<ApprovePlanResponse> {
  const plan = getPlan(planId);
  if (!plan) throw new HttpError(404, "PLAN_NOT_FOUND", `plan ${planId} not found`);
  if (plan.status !== "proposed") throw new HttpError(409, "PLAN_NOT_OPEN", `plan is ${plan.status}`);
  const option = plan.options.find((o) => o.id === optionId);
  if (!option) throw new HttpError(404, "OPTION_NOT_FOUND", `option ${optionId} not in plan ${planId}`);
  // Claim the plan atomically: of two concurrent approvals exactly one continues past this line.
  if (!claimPlan(planId, optionId)) throw new HttpError(409, "PLAN_NOT_OPEN", `plan is ${getPlan(planId)?.status ?? "gone"}`);
  writeLog({ actor: "operator", kind: "plan.approved", message: `Operator approved option "${option.title}"`, bookingId: plan.trigger.bookingId, refs: { planId, optionId } });

  const current = revalidateOption(plan, option);
  if (!current || !current.actions.some((a) => a.feasible)) {
    const failed: Plan = { ...plan, status: "failed", chosenOptionId: optionId, error: "the schedule changed and no action in this option is feasible any more" };
    savePlan(failed);
    publish({ type: "plan.updated", plan: failed });
    throw new HttpError(409, "PLAN_STALE", failed.error as string);
  }
  let grant: StoredGrant;
  try {
    grant = mintGrant(plan, current);
  } catch (e) {
    savePlan(plan); // nothing ran: reopen the proposal so another option can be chosen
    publish({ type: "plan.updated", plan });
    throw e;
  }
  const options = plan.options.map((o) => (o.id === optionId ? current : o));
  let working: Plan = { ...plan, options, status: "approved", chosenOptionId: optionId, grantId: grant.id };
  savePlan(working);
  publish({ type: "plan.updated", plan: working });

  const { results, grant: finalGrant, error } = await executeOption(working, current, grant);
  working = { ...working, status: error ? "failed" : "executed", error };
  savePlan(working);
  publish({ type: "plan.updated", plan: working });
  writeLog({
    actor: "system",
    kind: error ? "plan.failed" : "plan.executed",
    message: error ? `Plan failed: ${error}` : `Plan executed: ${results.filter((r) => r.ok).length}/${results.length} actions done under grant ${grant.id}`,
    bookingId: plan.trigger.bookingId,
    refs: { planId, grantId: grant.id },
  });
  if (error && plan.trigger.bookingId) {
    // Give the operator fresh options for the booking that still needs attention.
    const { proposePlan } = await import("./planner");
    void proposePlan(buildPlanContext({ eventType: plan.trigger.eventType, eventId: null, bookingId: plan.trigger.bookingId })).catch(() => null);
  }
  return { plan: working, grant: publicGrant(finalGrant), results };
}

export async function executeOption(plan: Plan, option: PlanOption, grant: StoredGrant): Promise<{ results: ApprovePlanResponse["results"]; grant: StoredGrant; error: string | null }> {
  const results: ApprovePlanResponse["results"] = [];
  // Consume the grant for the whole execution up front (atomic), so a money route
  // called concurrently with the same grant id is refused instead of running too.
  let claimError: string | null = null;
  let gr = grant;
  try {
    gr = consumeGrant(grant.id, plan.trigger.bookingId);
  } catch (e) {
    claimError = e instanceof Error ? e.message : String(e);
  }
  let error: string | null = claimError;
  for (const action of option.actions) {
    if (error) {
      results.push({ actionId: action.id, ok: false, detail: claimError ? `not run: ${claimError}` : "not run: an earlier action failed", refs: {} });
      continue;
    }
    if (!action.feasible) {
      results.push({ actionId: action.id, ok: false, detail: `skipped: ${action.infeasibleReason ?? "infeasible"}`, refs: {} });
      continue;
    }
    try {
      assertClaimedScope(gr, action);
      const out = await performAction(action, { actor: "system", grantId: gr.id, planId: plan.id, actionId: action.id });
      if (out.ok) gr = recordSpend(gr, MONEY_ACTIONS.has(action.type) ? action.amount : null);
      results.push({ actionId: action.id, ok: out.ok, detail: out.detail, refs: out.refs });
      if (!out.ok) error = `${action.type} on ${action.bookingId}: ${out.detail}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ actionId: action.id, ok: false, detail: msg, refs: e instanceof HttpError ? { code: e.code } : {} });
      error = `${action.type} on ${action.bookingId}: ${msg}`;
      writeLog({ actor: "system", kind: "grant.refused", message: `Action ${action.type} on ${action.bookingId} stopped: ${msg}`, bookingId: action.bookingId, refs: { grantId: gr.id, planId: plan.id, actionId: action.id } });
    }
  }
  const final = getGrant(gr.id) ?? gr;
  // A failed execution revokes the grant it consumed (kept for audit); one it never claimed is left as it is.
  gr = error && !claimError && final.status === "used" ? setGrantStatus(final, "revoked") : final;
  return { results, grant: gr, error };
}

/**
 * Operator money routes (POST /api/bookings/:id/capture|void|refund|invoice|remind)
 * with a grant id: check scope (an out-of-scope request does not burn the
 * grant), consume the grant atomically, then run the one action. Of two
 * concurrent requests with the same grant, even on different bookings, one runs.
 */
export async function runSingleGrantedAction<R extends { booking: unknown; refs: Record<string, string> }>(grantId: string, type: PlanActionType, bookingId: string, amount: string | null, run: (ctx: ExecContext) => Promise<R>): Promise<R> {
  const gr = requireGrant(grantId);
  const b = getBooking(bookingId);
  assertWithinGrant(gr, { type, bookingId, amount, currency: b?.currency ?? null });
  const claimed = consumeGrant(gr.id, bookingId);
  try {
    const res = await run({ actor: "system", grantId: claimed.id, planId: claimed.planId || null });
    recordSpend(getGrant(claimed.id) ?? claimed, amount);
    return res;
  } catch (e) {
    setGrantStatus(getGrant(claimed.id) ?? claimed, "revoked");
    throw e;
  }
}
