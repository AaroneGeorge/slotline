/**
 * Scheduling constraints (pure). Working hours in the operator's time zone,
 * service durations, a travel buffer between jobs on the same van, no overlap.
 */
import type { Booking, Resource, Service } from "@/shared/types";
import { addMinutes, localHhmm, localMinutes, minutesBetween } from "./time";
import { occupiesSlot } from "./state";

export const SERVICE_DURATION_MIN: Readonly<Record<Service, number>> = {
  screen: 60,
  battery: 45,
  diagnostic: 30,
  water: 90,
};

export const SERVICES = Object.keys(SERVICE_DURATION_MIN) as Service[];

export interface SolverOptions {
  tz: string;
  dayStart?: string; // "08:00" local
  dayEnd?: string; // "18:00" local
  bufferMin?: number; // travel buffer between jobs on the same van
  maxShiftMin?: number; // repack: max move distance
}

/** Working day in the operator's zone (local wall clock). */
export const WORKING_HOURS = { start: "08:00", end: "18:00" } as const;

const DEFAULTS = { dayStart: WORKING_HOURS.start, dayEnd: WORKING_HOURS.end, bufferMin: 30, maxShiftMin: 120 };

function opt(o: SolverOptions) {
  return { ...DEFAULTS, ...o };
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

export interface Candidate {
  id?: string; // the booking being placed/moved (excluded from its own conflicts)
  resourceId: string;
  startAt: string;
  durationMin: number;
}

export function serviceDuration(s: Service): number {
  return SERVICE_DURATION_MIN[s];
}

function label(b: Booking, tz: string): string {
  return `${b.customerName} (${b.service} ${localHhmm(b.startAt, tz)}–${localHhmm(b.endAt, tz)})`;
}

/**
 * Human-readable reasons why `cand` cannot be placed. Empty array = feasible.
 * `resources`, when given, is used to reject unknown vans.
 */
export function conflicts(bookings: Booking[], cand: Candidate, o: SolverOptions, resources?: Resource[]): string[] {
  const { tz, dayStart, dayEnd, bufferMin } = opt(o);
  const out: string[] = [];
  if (resources && !resources.some((r) => r.id === cand.resourceId)) {
    out.push(`unknown resource ${cand.resourceId}`);
    return out;
  }
  const start = new Date(cand.startAt);
  if (Number.isNaN(start.getTime())) return [`invalid start time ${cand.startAt}`];
  const endIso = addMinutes(cand.startAt, cand.durationMin);
  const end = new Date(endIso);
  const startMin = localMinutes(start, tz);
  if (startMin < hhmmToMin(dayStart) || startMin + cand.durationMin > hhmmToMin(dayEnd)) {
    out.push(`outside working hours ${dayStart}–${dayEnd} (${tz})`);
  }
  for (const b of bookings) {
    if (b.id === cand.id || b.resourceId !== cand.resourceId || !occupiesSlot(b)) continue;
    const bs = new Date(b.startAt).getTime();
    const be = new Date(b.endAt).getTime();
    if (start.getTime() < be && bs < end.getTime()) {
      out.push(`overlaps ${label(b, tz)}`);
      continue;
    }
    const gapAfter = (start.getTime() - be) / 60000; // b then cand
    const gapBefore = (bs - end.getTime()) / 60000; // cand then b
    if (gapAfter >= 0 && gapAfter < bufferMin) out.push(`needs ${bufferMin} min travel buffer after ${label(b, tz)}`);
    else if (gapBefore >= 0 && gapBefore < bufferMin) out.push(`needs ${bufferMin} min travel buffer before ${label(b, tz)}`);
  }
  return out;
}

export interface Placement {
  resourceId: string;
  startAt: string;
  endAt: string;
}

/**
 * Place a job at `startAt`, trying `preferredResource` first and then every
 * other van. With `searchForwardMin` > 0 it also tries later starts in
 * `stepMin` steps. Returns null when nothing fits.
 */
export function findSlot(
  bookings: Booking[],
  resources: Resource[],
  startAt: string,
  durationMin: number,
  preferredResource: string | undefined,
  o: SolverOptions & { searchForwardMin?: number; stepMin?: number; excludeId?: string },
): Placement | null {
  const order = [
    ...resources.filter((r) => r.id === preferredResource),
    ...resources.filter((r) => r.id !== preferredResource),
  ];
  const step = o.stepMin ?? 30;
  const forward = o.searchForwardMin ?? 0;
  for (let shift = 0; shift <= forward; shift += step) {
    const s = addMinutes(startAt, shift);
    for (const r of order) {
      if (conflicts(bookings, { id: o.excludeId, resourceId: r.id, startAt: s, durationMin }, o, resources).length === 0) {
        return { resourceId: r.id, startAt: s, endAt: addMinutes(s, durationMin) };
      }
    }
  }
  return null;
}

/** Only pre-money jobs may be moved by the repacker (never held/confirmed earlier than agreed). */
export const REPACK_MOVABLE: ReadonlySet<Booking["state"]> = new Set(["quoted", "approved"]);

export interface Move {
  bookingId: string;
  resourceId: string;
  fromStartAt: string;
  toStartAt: string;
}

/**
 * Close gaps on one van by pulling movable jobs earlier, at most
 * `maxShiftMin`, in 30-min steps. Never moves a confirmed (or any paid) job.
 */
export function repack(bookings: Booking[], resourceId: string, o: SolverOptions): Move[] {
  const { maxShiftMin } = opt(o);
  const work = bookings.map((b) => ({ ...b }));
  const onVan = work
    .filter((b) => b.resourceId === resourceId && occupiesSlot(b))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const moves: Move[] = [];
  for (const b of onVan) {
    if (!REPACK_MOVABLE.has(b.state)) continue;
    let best: string | null = null;
    for (let shift = maxShiftMin; shift >= 30; shift -= 30) {
      const s = addMinutes(b.startAt, -shift);
      if (conflicts(work, { id: b.id, resourceId, startAt: s, durationMin: b.durationMin }, o).length === 0) {
        best = s;
        break;
      }
    }
    if (best) {
      moves.push({ bookingId: b.id, resourceId, fromStartAt: b.startAt, toStartAt: best });
      b.startAt = best;
      b.endAt = addMinutes(best, b.durationMin);
    }
  }
  return moves;
}

export interface PromoteCandidate {
  booking: Booking;
  resourceId: string;
  startAt: string;
  endAt: string;
  /** minutes between the customer's requested start and the offered start */
  shiftMin: number;
}

/**
 * Waitlisted jobs that fit into a freed slot (same van, same start), first come
 * first served. `bookings` should already exclude/release the job that freed it.
 */
export function promoteCandidates(waitlist: Booking[], freed: Placement, bookings: Booking[], o: SolverOptions): PromoteCandidate[] {
  return waitlist
    .filter((w) => (w.waitlist || w.resourceId === null) && w.state === "quoted")
    .filter((w) => conflicts(bookings, { id: w.id, resourceId: freed.resourceId, startAt: freed.startAt, durationMin: w.durationMin }, o).length === 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((w) => ({
      booking: w,
      resourceId: freed.resourceId,
      startAt: freed.startAt,
      endAt: addMinutes(freed.startAt, w.durationMin),
      shiftMin: Math.abs(minutesBetween(w.startAt, freed.startAt)),
    }));
}
