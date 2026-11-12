import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { Booking } from "@/shared/types";
import { seedDemoDay } from "@/server/seed";
import { listBookings, listLog, listPlans } from "@/server/db";
import { captureBooking, refundBooking } from "@/server/bookings";
import { injectFixture } from "@/server/dev";
import { buildPlanContext, proposePlan, setPlannerForTests, validatePlan } from "@/server/planner";
import { rulesPlan, type Planner } from "@/server/planner/rules";
import { LlmPlanner } from "@/server/planner/llm";
import { rawAction, type RawPlan } from "@/server/planner/schema";
import { at, byName, setupEnv } from "./helpers";

async function seeded(): Promise<Booking[]> {
  await seedDemoDay();
  return listBookings();
}

function feasibleOptions(plan: { options: { actions: { feasible: boolean }[] }[] }) {
  return plan.options.filter((o) => o.actions.some((a) => a.feasible));
}

describe("rules planner on the seed day", () => {
  beforeEach(() => setupEnv());

  it("declined capture -> plan with a feasible 'give the slot to the waitlist' option", async () => {
    const day = await seeded();
    const marcus = byName(day, "Marcus");
    const lee = byName(day, "Lee");
    const res = await captureBooking(marcus.id, { actor: "operator", devTools: true, mockResponse: "INSTRUMENT_DECLINED" });
    expect(res.booking.state).toBe("declined");
    await vi.waitFor(() => expect(listPlans().length).toBe(1));
    const plan = listPlans()[0];
    expect(plan.provider).toBe("rules");
    expect(plan.trigger).toMatchObject({ eventType: "PAYMENT.CAPTURE.DENIED", bookingId: marcus.id });
    expect(feasibleOptions(plan).length).toBeGreaterThanOrEqual(1);
    const a = plan.options[0];
    const voidA = a.actions.find((x) => x.type === "void");
    const promote = a.actions.find((x) => x.type === "promote");
    expect(voidA).toMatchObject({ bookingId: marcus.id, feasible: true, amount: "25.00", currency: "USD" });
    expect(promote).toMatchObject({ bookingId: lee.id, feasible: true, params: { startAt: marcus.startAt, resourceId: "van-1" } });
    // money is released before the slot is reused
    expect(a.actions.findIndex((x) => x.type === "void")).toBeLessThan(a.actions.findIndex((x) => x.type === "promote"));
    expect(plan.draftMessages.length).toBeGreaterThan(0);
    expect(listLog().some((l) => l.actor === "agent" && l.kind === "plan.proposed")).toBe(true);
  });

  it("refund -> plan offering the freed slot (promote or repack)", async () => {
    const day = await seeded();
    const priya = byName(day, "Priya");
    await refundBooking(priya.id, { actor: "operator", devTools: true });
    await vi.waitFor(() => expect(listPlans().length).toBe(1));
    const plan = listPlans()[0];
    expect(plan.trigger.eventType).toBe("PAYMENT.CAPTURE.REFUNDED");
    const options = feasibleOptions(plan);
    expect(options.length).toBeGreaterThanOrEqual(1);
    const kinds = plan.options.flatMap((o) => o.actions.filter((x) => x.feasible).map((x) => x.type));
    expect(kinds.some((k) => k === "promote" || k === "move")).toBe(true);
  });

  it("dispute -> plan with a feasible evidence-pack option", async () => {
    const day = await seeded();
    const priya = byName(day, "Priya");
    const res = await injectFixture("dispute.created", priya.id);
    expect(res.outcome).toBe("applied");
    expect(res.plan).not.toBeNull();
    const plan = res.plan!;
    expect(plan.options[0].actions.find((x) => x.type === "flag_dispute")?.feasible).toBe(true);
    expect(plan.options.some((o) => o.actions.some((x) => x.type === "refund" && x.feasible && x.amount === priya.depositAmount))).toBe(true);
  });

  it("our own void under a grant does not trigger another plan", async () => {
    const day = await seeded();
    const marcus = byName(day, "Marcus");
    const { voidBooking } = await import("@/server/bookings");
    await voidBooking(marcus.id, { actor: "system", grantId: "grant_fake" });
    await new Promise((r) => setTimeout(r, 20));
    expect(listPlans()).toHaveLength(0);
  });
});

describe("validatePlan (code decides feasibility and amounts)", () => {
  beforeEach(() => setupEnv());

  it("marks an overlapping move infeasible and keeps the option if anything else is feasible", async () => {
    const day = await seeded();
    const sofia = byName(day, "Sofia");
    const priya = byName(day, "Priya");
    const ctx = buildPlanContext({ eventType: "manual", bookingId: sofia.id });
    const raw: RawPlan = {
      summary: "test",
      options: [
        {
          title: "Squeeze Sofia in",
          rationale: "r",
          actions: [rawAction("move", sofia.id, { startAt: priya.startAt, resourceId: "van-2" }), rawAction("message", sofia.id, { channel: "email", subject: "s", body: "hello" })],
        },
      ],
      draftMessages: [],
    };
    const v = validatePlan(raw, ctx);
    const move = v.options[0].actions.find((a) => a.type === "move")!;
    expect(move.feasible).toBe(false);
    expect(move.infeasibleReason).toMatch(/overlaps Priya/);
    expect(v.options[0].actions.find((a) => a.type === "message")?.feasible).toBe(true);
  });

  it("drops options with zero feasible actions, rejects unknown bookings, caps at 3", async () => {
    const day = await seeded();
    const sofia = byName(day, "Sofia");
    const ctx = buildPlanContext({ eventType: "manual", bookingId: sofia.id });
    const good = { title: "ok", rationale: "r", actions: [rawAction("message", sofia.id, { body: "hi" })] };
    const raw: RawPlan = {
      summary: "s",
      options: [{ title: "ghost", rationale: "r", actions: [rawAction("void", "bk_does_not_exist")] }, good, good, good, good],
      draftMessages: [{ bookingId: "bk_ghost", channel: "email", subject: null, body: "x" }],
    };
    const v = validatePlan(raw, ctx);
    expect(v.options).toHaveLength(3);
    expect(v.options.map((o) => o.id)).toEqual(["opt_a", "opt_b", "opt_c"]);
    expect(v.options.every((o) => o.title === "ok")).toBe(true);
    expect(v.draftMessages).toHaveLength(0);
  });

  it("refuses money actions the state machine forbids, and amounts come from the booking", async () => {
    const day = await seeded();
    const ahmed = byName(day, "Ahmed"); // held, balance invoiced
    const priya = byName(day, "Priya"); // confirmed
    const ctx = buildPlanContext({ eventType: "manual", bookingId: ahmed.id });
    const v = validatePlan(
      {
        summary: "s",
        options: [{ title: "t", rationale: "r", actions: [rawAction("refund", ahmed.id), rawAction("capture", priya.id), rawAction("send_invoice", ahmed.id), rawAction("capture", ahmed.id), rawAction("send_reminder", ahmed.id)] }],
        draftMessages: [],
      },
      ctx,
    );
    const byKey = Object.fromEntries(v.options[0].actions.map((a) => [`${a.type}:${a.bookingId === ahmed.id ? "ahmed" : "priya"}`, a]));
    expect(byKey["refund:ahmed"].feasible).toBe(false); // nothing captured yet
    expect(byKey["capture:priya"].feasible).toBe(false); // already confirmed
    expect(byKey["send_invoice:ahmed"].feasible).toBe(false); // already invoiced
    expect(byKey["capture:ahmed"]).toMatchObject({ feasible: true, amount: ahmed.depositAmount, currency: "USD" });
    expect(byKey["send_reminder:ahmed"].feasible).toBe(true);
  });

  it("an action after a simulated void can reuse the freed slot (order-independent)", async () => {
    const day = await seeded();
    const marcus = byName(day, "Marcus");
    const lee = byName(day, "Lee");
    const ctx = buildPlanContext({ eventType: "manual", bookingId: marcus.id });
    // promote listed before void: validation reorders so the void frees the slot first
    const v = validatePlan({ summary: "s", options: [{ title: "t", rationale: "r", actions: [rawAction("promote", lee.id, { startAt: marcus.startAt, resourceId: "van-1" }), rawAction("void", marcus.id)] }], draftMessages: [] }, ctx);
    expect(v.options[0].actions.map((a) => [a.type, a.feasible])).toEqual([
      ["void", true],
      ["promote", true],
    ]);
    // without the void the promote overlaps Marcus
    const v2 = validatePlan({ summary: "s", options: [{ title: "t", rationale: "r", actions: [rawAction("promote", lee.id, { startAt: marcus.startAt, resourceId: "van-1" }), rawAction("message", lee.id, { body: "hi" })] }], draftMessages: [] }, ctx);
    expect(v2.options[0].actions[0]).toMatchObject({ type: "promote", feasible: false });
  });

  it("rulesPlan for a booking that needs nothing returns no options", async () => {
    const day = await seeded();
    const ctx = buildPlanContext({ eventType: "manual", bookingId: byName(day, "Ahmed").id });
    expect(rulesPlan(ctx).options).toHaveLength(0);
  });
});

function textModel(json: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(json) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } },
      warnings: [],
    }),
  });
}

describe("LLM planner path (AI SDK 7, mock model) and fallback", () => {
  beforeEach(() => setupEnv());

  it("structured output from the model is validated in code (hallucinated ids and times are infeasible)", async () => {
    const day = await seeded();
    const marcus = byName(day, "Marcus");
    const lee = byName(day, "Lee");
    const modelOut: RawPlan = {
      summary: "Marcus's deposit failed.",
      options: [
        { title: "Give the slot to Lee", rationale: "r", actions: [rawAction("void", marcus.id), rawAction("promote", lee.id, { startAt: marcus.startAt, resourceId: "van-1" })] },
        { title: "Hallucinated", rationale: "r", actions: [rawAction("void", "bk_imaginary"), rawAction("move", lee.id, { startAt: at("23:00"), resourceId: "van-7" })] },
      ],
      draftMessages: [{ bookingId: lee.id, channel: "email", subject: "Slot", body: "A slot opened." }],
    };
    const model = textModel(modelOut);
    const planner = new LlmPlanner("gemini", () => model, () => false);
    setPlannerForTests(planner);
    // the declined capture triggers the automatic plan through the (mock) LLM planner
    await captureBooking(marcus.id, { actor: "operator", devTools: true, mockResponse: "INSTRUMENT_DECLINED" });
    await vi.waitFor(() => expect(listPlans().length).toBe(1));
    const plan = listPlans()[0];
    expect(plan.provider).toBe("gemini");
    expect(plan.options).toHaveLength(1); // the hallucinated option had no feasible action
    expect(plan.options[0].actions.every((a) => a.feasible)).toBe(true);
    expect(model.doGenerateCalls.length).toBeGreaterThanOrEqual(1);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain(marcus.id);
  });

  it("falls back to the rules planner when the provider throws", async () => {
    const day = await seeded();
    const failing: Planner = { name: "groq", propose: async () => Promise.reject(new Error("429 rate limited")) };
    setPlannerForTests(failing);
    const ctx = buildPlanContext({ eventType: "manual", bookingId: byName(day, "Marcus").id });
    const plan = await proposePlan(ctx);
    expect(plan.provider).toBe("rules");
    expect(listLog().some((l) => l.kind === "planner.fallback" && l.message.includes("429"))).toBe(true);
  });

  it("falls back to the rules planner when the provider times out", async () => {
    process.env.PLANNER_TIMEOUT_MS = "10";
    const day = await seeded();
    const hanging: Planner = { name: "gemini", propose: () => new Promise(() => {}) };
    setPlannerForTests(hanging);
    const plan = await proposePlan(buildPlanContext({ eventType: "manual", bookingId: byName(day, "Marcus").id }));
    expect(plan.provider).toBe("rules");
    expect(listLog().some((l) => l.kind === "planner.fallback" && l.message.includes("timed out"))).toBe(true);
    delete process.env.PLANNER_TIMEOUT_MS;
  }, 10_000);

  it("LLM_PROVIDER=gemini without a key uses rules and says so", async () => {
    process.env.LLM_PROVIDER = "gemini";
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const day = await seeded();
    const plan = await proposePlan(buildPlanContext({ eventType: "manual", bookingId: byName(day, "Marcus").id }));
    expect(plan.provider).toBe("rules");
    expect(listLog().some((l) => l.kind === "planner.fallback")).toBe(true);
  });
});
