/** Time-zone helpers for the operator's working day (no external deps). */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
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
    dtfCache.set(tz, f);
  }
  return f;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(date: Date, tz: string): ZonedParts {
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

/** Offset of `tz` from UTC at `date`, in minutes (e.g. -420 for PDT). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Local wall-clock time on `day` ("YYYY-MM-DD") in `tz` -> UTC Date. */
export function zonedToUtc(day: string, hhmm: string, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let ts = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(ts), tz);
  if (off2 !== off1) ts = guess - off2 * 60000;
  return new Date(ts);
}

/** Operator day ("YYYY-MM-DD") that contains `date` in `tz`. */
export function operatorDayOf(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutes since local midnight in `tz`. */
export function localMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

/** "10:30" local in `tz`. */
export function localHhmm(iso: string, tz: string): string {
  const p = zonedParts(new Date(iso), tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function addMinutes(iso: string, min: number): string {
  return new Date(new Date(iso).getTime() + min * 60000).toISOString();
}

export function minutesBetween(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / 60000);
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}T/.test(v);
}

export function toIso(v: string): string {
  return new Date(v).toISOString();
}
