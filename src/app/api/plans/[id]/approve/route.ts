import { z } from "zod";
import type { ApprovePlanResponse } from "@/shared/types";
import { operatorRoute, json, readJson } from "@/server/http";
import { approvePlan } from "@/server/grants";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ optionId: z.string().min(1) });

/** Operator approval: mints a 15-minute execution grant for the option and executes it. */
export const POST = operatorRoute(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { optionId } = await readJson(req, schema);
  return json<ApprovePlanResponse>(await approvePlan(id, optionId));
});
