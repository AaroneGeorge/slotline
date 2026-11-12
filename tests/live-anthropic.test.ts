/** Live Claude planner check. Skipped unless LIVE_ANTHROPIC=1 and ANTHROPIC_API_KEY are set (costs a real API call). */
import { beforeEach, describe, expect, it } from "vitest";
import { seedDemoDay } from "@/server/seed";
import { listBookings, listLog } from "@/server/db";
import { buildPlanContext, proposePlan } from "@/server/planner";
import { byName, setupEnv } from "./helpers";

const live = process.env.LIVE_ANTHROPIC === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!live)("Claude planner (live API)", () => {
  beforeEach(() => setupEnv({ LLM_PROVIDER: "anthropic", PLANNER_TIMEOUT_MS: "60000" }));

  it("returns a validated plan for a manual trigger on the seed day", async () => {
    await seedDemoDay();
    const marcus = byName(listBookings(), "Marcus");
    const plan = await proposePlan(buildPlanContext({ eventType: "manual", bookingId: marcus.id }));
    const fallback = listLog().find((l) => l.kind === "planner.fallback");
    expect(fallback?.message).toBeUndefined();
    expect(plan.provider).toBe("anthropic");
    expect(plan.options.length).toBeGreaterThanOrEqual(1);
    console.log(JSON.stringify({ summary: plan.summary, options: plan.options.map((o) => ({ title: o.title, actions: o.actions.map((a) => `${a.type}:${a.feasible}`) })) }, null, 2));
  }, 90_000);
});
