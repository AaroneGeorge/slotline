import { operatorRoute, json, HttpError } from "@/server/http";
import { getPlan, listGrantsForPlan, publicGrant } from "@/server/db";

type Ctx = { params: Promise<{ id: string }> };

export const GET = operatorRoute(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const plan = getPlan(id);
  if (!plan) throw new HttpError(404, "PLAN_NOT_FOUND", `plan ${id} not found`);
  return json({ plan, grants: listGrantsForPlan(id).map(publicGrant) });
});
