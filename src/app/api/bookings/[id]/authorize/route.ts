import { z } from "zod";
import type { AuthorizeResponse } from "@/shared/types";
import { route, json, readJson } from "@/server/http";
import { authorizeBooking } from "@/server/bookings";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ orderId: z.string().min(1) });

/** The customer approved the order in PayPal; the server authorizes it (deposit held). */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { orderId } = await readJson(req, schema);
  return json<AuthorizeResponse>(await authorizeBooking(id, orderId));
});
