import { z } from "zod";
import { operatorRoute, json, readJson, HttpError } from "@/server/http";
import { getPlan } from "@/server/db";
import { rejectPlan } from "@/server/planner";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ reason: z.string().max(300).optional() });

export const POST = operatorRoute(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { reason } = await readJson(req, schema);
  const plan = getPlan(id);
  if (!plan) throw new HttpError(404, "PLAN_NOT_FOUND", `plan ${id} not found`);
  if (plan.status !== "proposed") throw new HttpError(409, "PLAN_NOT_OPEN", `plan is ${plan.status}`);
  return json({ plan: rejectPlan(plan, reason ?? null) });
});
