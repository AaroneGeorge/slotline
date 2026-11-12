import { z } from "zod";
import { operatorRoute, json, readJson, HttpError } from "@/server/http";
import { getBooking } from "@/server/db";
import { buildPlanContext, proposePlan } from "@/server/planner";
import { writeLog } from "@/server/log";
import { isMoneyEventType } from "@/server/state";

const schema = z.object({
  bookingId: z.string().min(1).optional(),
  eventType: z
    .string()
    .refine((v) => v === "manual" || isMoneyEventType(v), "unknown event type")
    .optional(),
});

/** Manual re-plan for a booking (operator). */
export const POST = operatorRoute(async (req: Request) => {
  const body = await readJson(req, schema);
  if (body.bookingId && !getBooking(body.bookingId)) throw new HttpError(404, "BOOKING_NOT_FOUND", `booking ${body.bookingId} not found`);
  writeLog({ actor: "operator", kind: "plan.requested", message: "Operator asked the agent for a new plan", bookingId: body.bookingId ?? null });
  const eventType = body.eventType && isMoneyEventType(body.eventType) ? body.eventType : "manual";
  const ctx = buildPlanContext({ eventType, bookingId: body.bookingId ?? null });
  return json({ plan: await proposePlan(ctx) });
});
