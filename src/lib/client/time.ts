/**
 * Time helpers for the operator day. All API times are ISO-8601 UTC; the
 * dashboard shows Dana's wall clock in the operator time zone no matter where
 * the viewer's browser is. Bryntum works on local `Date`s, so we hand it
 * "wall dates": local Dates whose fields equal the wall-clock time in the
 * operator zone, and convert back to UTC on drop.
 */

export const DEFAULT_OPERATOR_TZ =
  process.env.NEXT_PUBLIC_OPERATOR_TZ || "America/Los_Angeles";

/** Dana's displayed day on the timeline (BUILD-PLAN §6). */
export const DAY_START_HOUR = 7;
export const DAY_END_HOUR = 19;
/** Working hours the solver enforces (BUILD-PLAN §2). */
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 18;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallParts(date: Date, tz: string): WallParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Offset of `tz` from UTC at the instant `utcMs`, in ms (LA in November: -8h). */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = wallParts(new Date(utcMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant for a wall-clock time in `tz`. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = tzOffsetMs(guess, tz);
  let t = guess - first;
  const second = tzOffsetMs(t, tz);
  if (second !== first) t = guess - second;
  return new Date(t);
}

/** ISO UTC -> local Date carrying the operator's wall-clock fields (for Bryntum). */
export function isoToWall(iso: string, tz: string): Date {
  const p = wallParts(new Date(iso), tz);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Inverse of isoToWall. */
export function wallToIso(wall: Date, tz: string): string {
  return zonedToUtc(
    wall.getFullYear(),
    wall.getMonth() + 1,
    wall.getDate(),
    wall.getHours(),
    wall.getMinutes(),
    tz,
  ).toISOString();
}

/** "2026-11-05" + hour -> wall Date. */
export function dayWall(day: string, hour: number, minute = 0): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute);
}

/** "2026-11-05" + "09:30" in tz -> ISO UTC. */
export function dayTimeToIso(day: string, hhmm: string, tz: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return zonedToUtc(y, m, d, h, mi, tz).toISOString();
}

export function todayInTz(tz: string, now = new Date()): string {
  const p = wallParts(now, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, key: string, opts: Intl.DateTimeFormatOptions) {
  const k = `${tz}|${key}`;
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts });
    fmtCache.set(k, f);
  }
  return f;
}

/** "9:30 AM" in the operator zone. */
export function formatTime(iso: string, tz: string): string {
  return fmt(tz, "t", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "9:30–10:15 AM" */
export function formatRange(startIso: string, endIso: string, tz: string): string {
  const a = formatTime(startIso, tz);
  const b = formatTime(endIso, tz);
  const [aTime, aMer] = a.split(" ");
  const [, bMer] = b.split(" ");
  return aMer && aMer === bMer ? `${aTime}–${b}` : `${a}–${b}`;
}

/** "14:02:31" operator-zone clock for the log. */
export function formatClock(iso: string, tz: string): string {
  return fmt(tz, "c", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(
    new Date(iso),
  );
}

/** "Thu 5 Nov" from "2026-11-05". */
export function formatDayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

/** "Thursday, 5 November 2026" */
export function formatDayLong(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** "Pacific Time" style label for a zone. */
export function zoneLabel(tz: string, at = new Date()): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    return name ? `${tz.split("/").pop()?.replace(/_/g, " ")} · ${name}` : tz;
  } catch {
    return tz;
  }
}

export function addMinutesIso(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/** "12m 04s" until `iso`, or "expired". */
export function countdown(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function relativeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}
