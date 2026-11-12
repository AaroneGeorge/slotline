import { beforeEach, describe, expect, it } from "vitest";
import type { AvailabilityResponse, CreateBookingResponse } from "@/shared/types";
import { GET as availabilityRoute } from "@/app/api/availability/route";
import { POST as createBookingRoute } from "@/app/api/bookings/route";
import { listBookings, listResources } from "@/server/db";
import { seedDemoDay } from "@/server/seed";
import { operatorTz } from "@/server/config";
import { bookingsForDay, currentDay } from "@/server/planner/context";
import { conflicts, serviceDuration } from "@/server/solver";
import { at, body, byName, req, setupEnv } from "./helpers";

async function get(query: string): Promise<Response> {
  return availabilityRoute(req(`/api/availability${query}`));
}

describe("GET /api/availability (public)", () => {
  // Sign-in is on: the route must still answer without a cookie.
  beforeEach(() => setupEnv({ OPERATOR_PASSWORD: "an operator password" }));

  it("returns only day, timeZone and slots of {startAt, endAt, resourceId, available}; no customer data", async () => {
    await seedDemoDay();
    const day = currentDay();
    const res = await get(`?day=${day}`);
    expect(res.status).toBe(200);
    const a = await body<AvailabilityResponse>(res);
    expect(Object.keys(a).sort()).toEqual(["day", "slots", "timeZone"]);
    expect(a).toMatchObject({ day, timeZone: "America/Los_Angeles" });
    expect(a.slots.length).toBeGreaterThan(0);
    for (const s of a.slots) expect(Object.keys(s).sort()).toEqual(["available", "endAt", "resourceId", "startAt"]);
    const raw = JSON.stringify(a);
    for (const b of listBookings()) {
      expect(raw).not.toContain(b.id);
      expect(raw).not.toContain(b.customerName);
      if (b.customerEmail) expect(raw).not.toContain(b.customerEmail);
    }
    expect(raw).not.toMatch(/MOCK-|PP-D-|@/);
  });

  it("slots are exactly the solver's verdict for every van at every 30-minute start in working hours", async () => {
    await seedDemoDay();
    const day = currentDay();
    const resources = listResources();
    for (const service of ["battery", "water"] as const) {
      const a = await body<AvailabilityResponse>(await get(`?day=${day}&service=${service}`));
      const dur = serviceDuration(service);
      const starts = [...new Set(a.slots.map((s) => s.startAt))];
      expect(starts[0]).toBe(at("08:00"));
      expect(new Date(starts.at(-1)!).getTime() + dur * 60_000).toBeLessThanOrEqual(new Date(at("18:00")).getTime());
      expect(a.slots.length).toBe(starts.length * resources.length);
      const day0 = bookingsForDay(day, operatorTz());
      for (const s of a.slots) {
        expect(new Date(s.endAt).getTime() - new Date(s.startAt).getTime()).toBe(dur * 60_000);
        const ok = conflicts(day0, { resourceId: s.resourceId, startAt: s.startAt, durationMin: dur }, { tz: operatorTz() }, resources).length === 0;
        expect(s.available, `${service} ${s.resourceId} ${s.startAt}`).toBe(ok);
      }
    }
    // Marcus holds van 1 at his time, so van 1 is busy then; the default slot is 30 minutes.
    const marcus = byName(listBookings(), "Marcus");
    const def = await body<AvailabilityResponse>(await get(`?day=${day}`));
    expect(def.slots.find((s) => s.startAt === marcus.startAt && s.resourceId === marcus.resourceId)?.available).toBe(false);
    expect(new Date(def.slots[0].endAt).getTime() - new Date(def.slots[0].startAt).getTime()).toBe(30 * 60_000);
  });

  it("a new booking makes its slot unavailable", async () => {
    await seedDemoDay();
    const before = await body<AvailabilityResponse>(await get(`?service=screen`));
    const free = before.slots.find((s) => s.available && s.startAt === at("15:00"))!;
    expect(free).toBeTruthy();
    const created = await body<CreateBookingResponse>(await createBookingRoute(req("/api/bookings", { body: { customerName: "Nadia", service: "screen", startAt: free.startAt, resourceId: free.resourceId } })));
    expect(created.booking.resourceId).toBe(free.resourceId);
    const after = await body<AvailabilityResponse>(await get(`?service=screen`));
    expect(after.slots.find((s) => s.startAt === free.startAt && s.resourceId === free.resourceId)?.available).toBe(false);
  });

  it("rejects a malformed day or an unknown service with 400", async () => {
    for (const q of ["?day=today", "?day=2026-02-30", "?day=2026-13-01", "?service=laptop"]) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
      expect((await res.json()).code).toBe("INVALID_REQUEST");
    }
  });
});
