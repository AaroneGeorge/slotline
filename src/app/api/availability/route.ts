import { z } from "zod";
import type { AvailabilityResponse } from "@/shared/types";
import { route, json, HttpError } from "@/server/http";
import { availability } from "@/server/availability";
import { ensureSeeded } from "@/server/app-state";
import { currentDay } from "@/server/planner/context";

const querySchema = z.object({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((d) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().startsWith(d), "not a calendar date")
    .optional(),
  service: z.enum(["screen", "battery", "diagnostic", "water"]).optional(),
});

/** Public: free/busy per van and start time for the booking page. Times, van ids and a flag only; no customer data. */
export const GET = route(async (req: Request) => {
  await ensureSeeded();
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({ day: url.searchParams.get("day") ?? undefined, service: url.searchParams.get("service") ?? undefined });
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST", "day must be YYYY-MM-DD and service one of screen, battery, diagnostic, water", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return json<AvailabilityResponse>(availability(parsed.data.day ?? currentDay(), parsed.data.service));
});
