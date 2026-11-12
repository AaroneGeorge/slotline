import { z } from "zod";
import type { MoveBookingResponse, PublicBookingView } from "@/shared/types";
import { route, operatorRoute, json, readJson, HttpError } from "@/server/http";
import { getBooking, publicBooking } from "@/server/db";
import { moveBooking } from "@/server/bookings";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Public: the /book?booking=<id> resume link. The unguessable id is the
 * customer's handle on their own booking, so this returns only what that page
 * shows (no email, notes, capture/refund/invoice/dispute ids). Operators read
 * full bookings from /api/state.
 */
export const GET = route(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const booking = getBooking(id);
  if (!booking) throw new HttpError(404, "BOOKING_NOT_FOUND", `booking ${id} not found`);
  return json<{ booking: PublicBookingView }>({ booking: publicBooking(booking) });
});

const moveSchema = z.object({ startAt: z.string().min(1), resourceId: z.string().min(1) });

/** Operator drag/drop on the timeline. 409 with `conflicts` when infeasible. */
export const PATCH = operatorRoute(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req, moveSchema);
  const res = moveBooking(id, body.startAt, body.resourceId, { actor: "operator" });
  return json<MoveBookingResponse>({ booking: res.booking, conflicts: res.conflicts }, res.ok ? 200 : 409);
});
