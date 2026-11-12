import { z } from "zod";
import type { CreateBookingResponse } from "@/shared/types";
import { route, json, readJson } from "@/server/http";
import { createBooking } from "@/server/bookings";
import { ensureSeeded } from "@/server/app-state";

const schema = z.object({
  customerName: z.string().trim().min(1).max(80),
  customerEmail: z.string().trim().email().max(254).optional().or(z.literal("").transform(() => undefined)),
  service: z.enum(["screen", "battery", "diagnostic", "water"]),
  startAt: z.string().min(1),
  resourceId: z.string().min(1).optional(),
});

export const POST = route(async (req: Request) => {
  await ensureSeeded();
  const body = await readJson(req, schema);
  const booking = createBooking(body);
  return json<CreateBookingResponse>({ booking }, 201);
});
