import { describe, expect, it } from "vitest";
import type { Booking, BookingState, Resource } from "@/shared/types";
import { conflicts, findSlot, promoteCandidates, repack, SERVICE_DURATION_MIN } from "@/server/solver";
import { addMinutes, operatorDayOf, tzOffsetMinutes, zonedToUtc } from "@/server/time";

const tz = "America/Los_Angeles";
const day = "2026-11-05"; // PST (UTC-8) after the 1 Nov DST change
const t = (hhmm: string) => zonedToUtc(day, hhmm, tz).toISOString();
const opts = { tz };
const vans: Resource[] = [
  { id: "van-1", name: "Van 1" },
  { id: "van-2", name: "Van 2" },
];

let n = 0;
function bk(name: string, van: string | null, start: string, dur: number, state: BookingState = "held", extra: Partial<Booking> = {}): Booking {
  const startAt = t(start);
  return {
    id: `bk_${name.toLowerCase()}_${++n}`,
    resourceId: van,
    waitlist: van === null,
    customerName: name,
    customerEmail: null,
    service: "screen",
    startAt,
    endAt: addMinutes(startAt, dur),
    durationMin: dur,
    depositAmount: "40.00",
    balanceAmount: "89.00",
    currency: "USD",
    state,
    balanceState: "none",
    paypalOrderId: null,
    paypalAuthorizationId: null,
    paypalCaptureId: null,
    paypalRefundId: null,
    paypalInvoiceId: null,
    paypalDisputeId: null,
    notes: null,
    createdAt: new Date(2026, 0, 1, 0, n).toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

describe("time helpers", () => {
  it("converts operator wall-clock time to UTC across DST", () => {
    expect(zonedToUtc("2026-11-05", "10:00", tz).toISOString()).toBe("2026-11-05T18:00:00.000Z"); // PST
    expect(zonedToUtc("2026-10-20", "10:00", tz).toISOString()).toBe("2026-10-20T17:00:00.000Z"); // PDT
    expect(tzOffsetMinutes(new Date("2026-07-01T12:00:00Z"), tz)).toBe(-420);
    expect(operatorDayOf(new Date("2026-11-06T05:00:00Z"), tz)).toBe("2026-11-05");
  });
});

describe("solver", () => {
  it("service durations", () => {
    expect(SERVICE_DURATION_MIN).toEqual({ screen: 60, battery: 45, diagnostic: 30, water: 90 });
  });

  it("detects overlaps on the same van only", () => {
    const a = bk("Ahmed", "van-1", "10:00", 60);
    expect(conflicts([a], { resourceId: "van-1", startAt: t("10:30"), durationMin: 60 }, opts)[0]).toMatch(/overlaps Ahmed/);
    expect(conflicts([a], { resourceId: "van-2", startAt: t("10:30"), durationMin: 60 }, opts)).toEqual([]);
  });

  it("requires a 30 min travel buffer between jobs on the same van", () => {
    const a = bk("Ahmed", "van-1", "10:00", 60); // ends 11:00
    expect(conflicts([a], { resourceId: "van-1", startAt: t("11:15"), durationMin: 30 }, opts)[0]).toMatch(/buffer after Ahmed/);
    expect(conflicts([a], { resourceId: "van-1", startAt: t("11:30"), durationMin: 30 }, opts)).toEqual([]);
    expect(conflicts([a], { resourceId: "van-1", startAt: t("09:00"), durationMin: 45 }, opts)[0]).toMatch(/buffer before Ahmed/);
    expect(conflicts([a], { resourceId: "van-1", startAt: t("08:30"), durationMin: 60 }, opts)).toEqual([]);
  });

  it("enforces working hours 08:00-18:00 in the operator time zone", () => {
    expect(conflicts([], { resourceId: "van-1", startAt: t("07:30"), durationMin: 30 }, opts)[0]).toMatch(/working hours/);
    expect(conflicts([], { resourceId: "van-1", startAt: t("17:30"), durationMin: 60 }, opts)[0]).toMatch(/working hours/);
    expect(conflicts([], { resourceId: "van-1", startAt: t("17:00"), durationMin: 60 }, opts)).toEqual([]);
    expect(conflicts([], { resourceId: "van-1", startAt: t("08:00"), durationMin: 90 }, opts)).toEqual([]);
  });

  it("released and refunded jobs do not block; declined and disputed do", () => {
    const cand = { resourceId: "van-1", startAt: t("10:00"), durationMin: 60 };
    expect(conflicts([bk("R", "van-1", "10:00", 60, "released")], cand, opts)).toEqual([]);
    expect(conflicts([bk("F", "van-1", "10:00", 60, "refunded")], cand, opts)).toEqual([]);
    expect(conflicts([bk("D", "van-1", "10:00", 60, "declined")], cand, opts)).toHaveLength(1);
    expect(conflicts([bk("X", "van-1", "10:00", 60, "disputed")], cand, opts)).toHaveLength(1);
  });

  it("a booking does not conflict with itself (moves)", () => {
    const a = bk("Ahmed", "van-1", "10:00", 60);
    expect(conflicts([a], { id: a.id, resourceId: "van-1", startAt: t("10:30"), durationMin: 60 }, opts)).toEqual([]);
  });

  it("rejects unknown vans", () => {
    expect(conflicts([], { resourceId: "van-9", startAt: t("10:00"), durationMin: 30 }, opts, vans)[0]).toMatch(/unknown resource/);
  });

  it("findSlot prefers the requested van, falls back to another, else null", () => {
    const a = bk("Ahmed", "van-1", "10:00", 60);
    expect(findSlot([a], vans, t("12:00"), 60, "van-1", opts)?.resourceId).toBe("van-1");
    expect(findSlot([a], vans, t("10:00"), 60, "van-1", opts)?.resourceId).toBe("van-2");
    const b = bk("Priya", "van-2", "10:00", 60);
    expect(findSlot([a, b], vans, t("10:00"), 60, undefined, opts)).toBeNull();
    expect(findSlot([a, b], vans, t("10:00"), 60, undefined, { ...opts, searchForwardMin: 120 })?.startAt).toBe(t("11:30"));
  });

  it("repack pulls unpaid jobs earlier (<= 2 h) and never moves confirmed or held jobs", () => {
    const gapBefore = bk("Gone", "van-1", "09:00", 60, "refunded");
    const confirmed = bk("Priya", "van-1", "12:00", 60, "confirmed");
    const held = bk("Marcus", "van-1", "14:00", 45, "held");
    const quoted = bk("Sofia", "van-1", "10:30", 30, "quoted");
    const moves = repack([gapBefore, quoted, confirmed, held], "van-1", opts);
    expect(moves).toEqual([{ bookingId: quoted.id, resourceId: "van-1", fromStartAt: t("10:30"), toStartAt: t("08:30") }]);
    expect(moves.some((m) => m.bookingId === confirmed.id || m.bookingId === held.id)).toBe(false);
  });

  it("repack keeps the buffer to the job before it", () => {
    const a = bk("Ahmed", "van-1", "08:00", 60, "confirmed"); // ends 09:00
    const q = bk("Sofia", "van-1", "11:00", 30, "quoted");
    const moves = repack([a, q], "van-1", opts);
    expect(moves[0].toStartAt).toBe(t("09:30"));
  });

  it("promoteCandidates: waitlisted quoted jobs that fit the freed slot, first come first served", () => {
    const freedBy = bk("Marcus", "van-1", "10:00", 45, "released");
    const before = bk("Ahmed", "van-1", "08:30", 60, "held");
    const after = bk("Next", "van-1", "11:15", 30, "held");
    const lee = bk("Lee", null, "10:00", 45, "quoted");
    const big = bk("Big", null, "10:00", 90, "quoted", { service: "water" });
    const cands = promoteCandidates([big, lee], { resourceId: "van-1", startAt: freedBy.startAt, endAt: freedBy.endAt }, [before, freedBy, after], opts);
    expect(cands.map((c) => c.booking.customerName)).toEqual(["Lee"]); // 90 min would hit the 11:15 job
    expect(cands[0].startAt).toBe(t("10:00"));
  });
});
