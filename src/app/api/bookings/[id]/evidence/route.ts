import type { EvidencePack } from "@/shared/types";
import { operatorRoute, json } from "@/server/http";
import { buildEvidencePack } from "@/server/evidence";

type Ctx = { params: Promise<{ id: string }> };

export const GET = operatorRoute(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  return json<EvidencePack>(await buildEvidencePack(id));
});
