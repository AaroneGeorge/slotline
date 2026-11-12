/**
 * LLM planners (Vercel AI SDK 7). Structured output via generateText +
 * Output.object (generateObject is deprecated in v6+ and not typed in v7).
 * The model only proposes; validatePlan decides feasibility and amounts.
 */
import { generateText, isStepCount, Output, type LanguageModel } from "ai";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { anthropicConfig, geminiConfig, groqConfig, plannerTimeoutMs } from "../config";
import { localHhmm } from "../time";
import type { PlanContext } from "./context";
import type { Planner } from "./rules";
import { rawPlanSchema, type RawPlan } from "./schema";
import { planningTools } from "./tools";

export const PLANNER_INSTRUCTIONS = `You are the scheduling agent for Slotline, a two-van mobile phone-repair business run by Dana.
Every job is secured by a PayPal deposit. Something just happened to the money on a booking (the trigger).
Propose 1-3 ranked options (best first) for how Dana should respond, plus short, friendly customer messages.

Allowed action types (use only booking ids and van ids that appear in the context):
- void: void the booking's PayPal authorization (releases the hold and frees the slot)
- capture: retry capturing the booking's authorization
- refund: refund the booking's captured deposit
- promote: move a waitlisted booking onto the timeline (set startAt + resourceId); the customer still has to pay a deposit
- move: move a booking on the timeline (set startAt + resourceId); never move confirmed or disputed jobs
- send_invoice: create and send the PayPal invoice for a booking's balance
- send_reminder: remind the customer about an open PayPal invoice
- message: email the customer (set subject + body)
- flag_dispute: assemble the evidence pack for a disputed booking

Hard rules, enforced in code after you answer:
- Working hours are 08:00-18:00 in the operator time zone; jobs on the same van need a 30-minute travel buffer and may not overlap.
- You never choose amounts; code uses the booking's deposit/balance. Do not mention amounts you have not been given.
- Infeasible actions are dropped from execution; an option with no feasible action is discarded.
- Times are ISO-8601 UTC strings. Keep titles short and imperative. Messages: plain text, under 80 words, no promises about money other than what the actions do.
Nothing you propose runs until Dana approves one option; approval mints a 15-minute grant limited to that option's bookings, actions and amounts.`;

function compactBooking(b: PlanContext["bookings"][number], tz: string) {
  return {
    id: b.id,
    customer: b.customerName,
    hasEmail: Boolean(b.customerEmail),
    service: b.service,
    van: b.resourceId,
    waitlist: b.waitlist,
    startAt: b.startAt,
    endAt: b.endAt,
    local: `${localHhmm(b.startAt, tz)}-${localHhmm(b.endAt, tz)}`,
    state: b.state,
    deposit: `${b.depositAmount} ${b.currency}`,
    balance: `${b.balanceAmount} ${b.currency}`,
    balanceState: b.balanceState,
    paypal: { orderId: b.paypalOrderId, authorizationId: b.paypalAuthorizationId, captureId: b.paypalCaptureId, invoiceId: b.paypalInvoiceId, disputeId: b.paypalDisputeId },
  };
}

export function planPrompt(ctx: PlanContext): string {
  return JSON.stringify(
    {
      now: ctx.now,
      operatorDay: ctx.day,
      timeZone: ctx.tz,
      workingHours: ctx.workingHours,
      travelBufferMin: ctx.bufferMin,
      vans: ctx.resources,
      trigger: { eventType: ctx.trigger.eventType, eventId: ctx.trigger.eventId, bookingId: ctx.trigger.booking?.id ?? null },
      bookings: ctx.bookings.map((b) => compactBooking(b, ctx.tz)),
      openInvoices: ctx.openInvoices.map((i) => ({ bookingId: i.bookingId, paypalInvoiceId: i.paypalInvoiceId, amount: i.amount, status: i.status })),
      bookingLinkTemplate: `${ctx.appBaseUrl}/book?booking=<bookingId>`,
    },
    null,
    2,
  );
}

export class LlmPlanner implements Planner {
  constructor(
    readonly name: "gemini" | "groq",
    private readonly model: () => LanguageModel,
    private readonly withTools: () => boolean,
  ) {}

  async propose(ctx: PlanContext): Promise<RawPlan> {
    const timeout = plannerTimeoutMs();
    const useTools = this.withTools();
    const result = await generateText({
      model: this.model(),
      instructions: PLANNER_INSTRUCTIONS,
      prompt: `Context (JSON):\n${planPrompt(ctx)}\n\nRespond with the plan.`,
      output: Output.object({ schema: rawPlanSchema }),
      ...(useTools ? { tools: planningTools(), stopWhen: isStepCount(5) } : {}),
      timeout,
      abortSignal: AbortSignal.timeout(timeout + 1000),
      maxRetries: 1,
    });
    return result.output;
  }
}

export function geminiPlanner(withTools: () => boolean): Planner | null {
  const cfg = geminiConfig();
  if (!cfg) return null;
  const google = createGoogle({ apiKey: cfg.apiKey });
  return new LlmPlanner("gemini", () => google(cfg.model), withTools);
}

export function groqPlanner(withTools: () => boolean): Planner | null {
  const cfg = groqConfig();
  if (!cfg) return null;
  const groq = createGroq({ apiKey: cfg.apiKey });
  return new LlmPlanner("groq", () => groq(cfg.model), withTools);
}

/**
 * Claude planner (official Anthropic SDK, structured output via
 * output_config.format). Same contract as LlmPlanner: it only proposes; a
 * refusal or unparsable answer throws and getPlan falls back to rules.
 */
export class AnthropicPlanner implements Planner {
  readonly name = "anthropic" as const;
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async propose(ctx: PlanContext): Promise<RawPlan> {
    const timeout = plannerTimeoutMs();
    const response = await this.client.beta.messages.parse(
      {
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: betaZodOutputFormat(rawPlanSchema) },
        system: PLANNER_INSTRUCTIONS,
        messages: [{ role: "user", content: `Context (JSON):\n${planPrompt(ctx)}\n\nRespond with the plan.` }],
      },
      { timeout, maxRetries: 1, signal: AbortSignal.timeout(timeout + 1000) },
    );
    if (response.stop_reason === "refusal") throw new Error(`anthropic planner refused (${response.stop_details?.category ?? "no category"})`);
    if (!response.parsed_output) throw new Error(`anthropic planner returned no plan (stop_reason ${response.stop_reason})`);
    return response.parsed_output;
  }
}

export function anthropicPlanner(): Planner | null {
  const cfg = anthropicConfig();
  if (!cfg) return null;
  return new AnthropicPlanner(new Anthropic({ apiKey: cfg.apiKey }), cfg.model);
}
