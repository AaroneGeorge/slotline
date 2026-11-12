/** Everything a planner may look at. Built from the database, never from the model. */
import type { Booking, MoneyEventType, Resource } from "@/shared/types";
import { getBooking, listBookings, listOpenInvoices, listResources, type InvoiceRecord } from "../db";
import { appBaseUrl, operatorTz } from "../config";
import { operatorDayOf } from "../time";

export interface PlanContext {
  now: string;
  day: string;
  tz: string;
  workingHours: { start: string; end: string };
  bufferMin: number;
  resources: Resource[];
  /** The operator day's bookings, including waitlist (plus the trigger booking). */
  bookings: Booking[];
  trigger: { eventType: MoneyEventType | "manual"; eventId: string | null; booking: Booking | null };
  openInvoices: InvoiceRecord[];
  appBaseUrl: string;
}

export function currentDay(): string {
  return operatorDayOf(new Date(), operatorTz());
}

export function bookingsForDay(day: string, tz = operatorTz()): Booking[] {
  return listBookings().filter((b) => operatorDayOf(new Date(b.startAt), tz) === day);
}

export function buildPlanContext(trigger: { eventType: MoneyEventType | "manual"; eventId?: string | null; bookingId?: string | null }): PlanContext {
  const tz = operatorTz();
  const triggerBooking = trigger.bookingId ? getBooking(trigger.bookingId) : null;
  const day = triggerBooking ? operatorDayOf(new Date(triggerBooking.startAt), tz) : currentDay();
  const bookings = bookingsForDay(day, tz);
  if (triggerBooking && !bookings.some((b) => b.id === triggerBooking.id)) bookings.push(triggerBooking);
  return {
    now: new Date().toISOString(),
    day,
    tz,
    workingHours: { start: "08:00", end: "18:00" },
    bufferMin: 30,
    resources: listResources(),
    bookings,
    trigger: { eventType: trigger.eventType, eventId: trigger.eventId ?? null, booking: triggerBooking },
    openInvoices: listOpenInvoices(),
    appBaseUrl: appBaseUrl(),
  };
}

export function solverOpts(ctx: PlanContext) {
  return { tz: ctx.tz, dayStart: ctx.workingHours.start, dayEnd: ctx.workingHours.end, bufferMin: ctx.bufferMin };
}
