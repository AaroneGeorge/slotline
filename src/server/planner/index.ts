/**
 * Planner orchestration: choose a provider, call it with a timeout, fall back
 * to the rules planner on any failure, validate in code, persist, broadcast.
 */
import type { Booking, MoneyEvent, MoneyEventType, Plan } from "@/shared/types";
import { listPlans, savePlan } from "../db";
import { llmProvider, plannerTimeoutMs } from "../config";
import { publish } from "../bus";
import { writeLog } from "../log";
import { newId, nowIso } from "../ids";
import { getGateway } from "../paypal";
import { buildPlanContext, type PlanContext } from "./context";
import { anthropicPlanner, geminiPlanner, groqPlanner } from "./llm";
import { rulesPlanner, type Planner } from "./rules";
import type { RawPlan } from "./schema";
import { validatePlan } from "./validate";

export { buildPlanContext } from "./context";
export { validatePlan } from "./validate";
export type { PlanContext } from "./context";

/** Events that make the schedule reflow. */
export const PLAN_TRIGGERS: ReadonlySet<MoneyEventType> = new Set([
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "CUSTOMER.DISPUTE.CREATED",
]);

const g = globalThis as unknown as { __slotlinePlannerOverride?: Planner | null };

/** Tests: force a planner (null restores env-based selection). */
export function setPlannerForTests(p: Planner | null): void {
  g.__slotlinePlannerOverride = p;
}

export function getPlanner(): Planner {
  if (g.__slotlinePlannerOverride) return g.__slotlinePlannerOverride;
  const withTools = () => getGateway().mode === "sandbox";
  const wanted = llmProvider();
  if (wanted === "anthropic") return anthropicPlanner() ?? rulesPlanner;
  if (wanted === "gemini") return geminiPlanner(withTools) ?? rulesPlanner;
  if (wanted === "groq") return groqPlanner(withTools) ?? rulesPlanner;
  return rulesPlanner;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Mark older open plans for the same booking as expired (superseded). */
function supersedeOpenPlans(bookingId: string | null, keepId: string): void {
  if (!bookingId) return;
  for (const p of listPlans()) {
    if (p.id !== keepId && p.status === "proposed" && p.trigger.bookingId === bookingId) {
      const expired: Plan = { ...p, status: "expired", error: "superseded by a newer plan" };
      savePlan(expired);
      publish({ type: "plan.updated", plan: expired });
    }
  }
}

export async function proposePlan(ctx: PlanContext): Promise<Plan> {
  const wanted = llmProvider();
  let planner = getPlanner();
  if (planner.name !== wanted && !g.__slotlinePlannerOverride) {
    writeLog({ actor: "system", kind: "planner.fallback", message: `LLM_PROVIDER=${wanted} has no API key configured; using the rules planner`, bookingId: ctx.trigger.booking?.id ?? null });
  }
  let raw: RawPlan;
  try {
    raw = await withTimeout(planner.propose(ctx), plannerTimeoutMs() + 2000, `${planner.name} planner`);
  } catch (e) {
    if (planner.name === "rules") throw e;
    writeLog({
      actor: "system",
      kind: "planner.fallback",
      message: `${planner.name} planner failed (${e instanceof Error ? e.message : String(e)}); falling back to rules`,
      bookingId: ctx.trigger.booking?.id ?? null,
    });
    planner = rulesPlanner;
    raw = await rulesPlanner.propose(ctx);
  }
  const v = validatePlan(raw, ctx);
  const plan: Plan = {
    id: newId("plan"),
    createdAt: nowIso(),
    trigger: { eventType: ctx.trigger.eventType, bookingId: ctx.trigger.booking?.id ?? null, eventId: ctx.trigger.eventId },
    provider: planner.name,
    summary: v.summary,
    options: v.options,
    draftMessages: v.draftMessages,
    status: "proposed",
    chosenOptionId: null,
    grantId: null,
    error: v.options.length === 0 ? "no feasible option" : null,
  };
  savePlan(plan);
  supersedeOpenPlans(plan.trigger.bookingId, plan.id);
  publish({ type: "plan.created", plan });
  const feasible = plan.options.map((o) => o.actions.filter((a) => a.feasible).length);
  writeLog({
    actor: "agent",
    kind: "plan.proposed",
    message: `${plan.summary} Proposed ${plan.options.length} option${plan.options.length === 1 ? "" : "s"} (${feasible.join("/")} feasible actions) via ${plan.provider}.`,
    bookingId: plan.trigger.bookingId,
    refs: { planId: plan.id, eventId: plan.trigger.eventId, provider: plan.provider },
  });
  return plan;
}

/** Called by the pipeline after a state change. Returns the new plan, or null when no reflow is needed. */
export async function maybePlan(event: MoneyEvent, booking: Booking): Promise<Plan | null> {
  if (!PLAN_TRIGGERS.has(event.type)) return null;
  // Our own approved actions (void/refund under a grant) do not trigger a new plan.
  if (event.refs.grantId && (event.type === "PAYMENT.AUTHORIZATION.VOIDED" || event.type === "PAYMENT.CAPTURE.REFUNDED")) return null;
  const ctx = buildPlanContext({ eventType: event.type, eventId: event.id, bookingId: booking.id });
  return proposePlan(ctx);
}

export function rejectPlan(plan: Plan, reason: string | null): Plan {
  const rejected: Plan = { ...plan, status: "rejected", error: reason };
  savePlan(rejected);
  publish({ type: "plan.updated", plan: rejected });
  writeLog({ actor: "operator", kind: "plan.rejected", message: `Operator rejected plan: ${plan.summary}${reason ? ` (${reason})` : ""}`, bookingId: plan.trigger.bookingId, refs: { planId: plan.id } });
  return rejected;
}
