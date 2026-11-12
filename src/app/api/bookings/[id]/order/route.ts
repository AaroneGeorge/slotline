import type { CreateOrderResponse } from "@/shared/types";
import { route, json } from "@/server/http";
import { createOrderForBooking } from "@/server/bookings";

type Ctx = { params: Promise<{ id: string }> };

/** Creates the PayPal order (intent AUTHORIZE) for the booking's deposit. */
export const POST = route(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const res = await createOrderForBooking(id);
  return json<CreateOrderResponse & { approveUrl: string | null }>(res);
});
