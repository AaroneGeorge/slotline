import { operatorRoute } from "@/server/http";
import { handleMoneyRoute } from "@/server/money-routes";

type Ctx = { params: Promise<{ id: string }> };

/** Moves money: needs { grantId } of an active execution grant, or x-dev-secret (dev tools). */
export const POST = operatorRoute(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  return handleMoneyRoute("void", req, id);
});
