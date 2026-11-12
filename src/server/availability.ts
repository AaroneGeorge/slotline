/**
 * Public availability for the customer booking page: which van is free at
 * each 30-minute start, decided by the solver (working hours, travel buffer,
 * no overlap). It carries no customer data, only times, van ids and a flag.
 */
import type { AvailabilityResponse, AvailabilitySlot, Service } from "@/shared/types";
import { listResources } from "./db";
import { operatorTz } from "./config";
import { bookingsForDay } from "./planner/context";
import { conflicts, serviceDuration, WORKING_HOURS } from "./solver";
import { addMinutes, zonedToUtc } from "./time";

/** Slot length when no service is given: the shortest job (diagnostic, 30 min). */
export const DEFAULT_SLOT_MIN = 30;
const STEP_MIN = 30;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function availability(day: string, service?: Service): AvailabilityResponse {
  const tz = operatorTz();
  const durationMin = service ? serviceDuration(service) : DEFAULT_SLOT_MIN;
  const resources = listResources();
  const bookings = bookingsForDay(day, tz);
  const slots: AvailabilitySlot[] = [];
  for (let m = minutesOf(WORKING_HOURS.start); m + durationMin <= minutesOf(WORKING_HOURS.end); m += STEP_MIN) {
    const startAt = zonedToUtc(day, hhmm(m), tz).toISOString();
    const endAt = addMinutes(startAt, durationMin);
    for (const r of resources) {
      const available = conflicts(bookings, { resourceId: r.id, startAt, durationMin }, { tz }, resources).length === 0;
      slots.push({ startAt, endAt, resourceId: r.id, available });
    }
  }
  return { day, timeZone: tz, slots };
}
