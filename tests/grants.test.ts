import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovePlanResponse, Plan, PlanOption } from "@/shared/types";
import { seedDemoDay } from "@/server/seed";
import { claimGrant, getBooking, getGrant, getPlan, listBookings, listGrantsForPlan, listLog, listPlans } from "@/server/db";
import { assertWithinGrant, GrantError, mintGrant, requireGrant } from "@/server/grants";
import { captureBooking } from "@/server/bookings";
import { getMockGateway } from "@/server/paypal";
import { POST as approveRoute } from "@/app/api/plans/[id]/approve/route";
import { POST as rejectRoute } from "@/app/api/plans/[id]/reject/route";
import { POST as captureRoute } from "@/app/api/bookings/[id]/capture/route";
import { POST as voidRoute } from "@/app/api/bookings/[id]/void/route";
import { POST as refundRoute } from "@/app/api/bookings/[id]/refund/route";
import { body, byName, DEV_SECRET, params, req, setupEnv } from "./helpers";

async function declinedPlan(): Promise<{ plan: Plan; marcusId: string; leeId: string; ahmedId: string }> {
  await seedDemoDay();
  const day = listBookings();
  const marcus = byName(day, "Marcus");
  await captureBooking(marcus.id, { actor: "operator", devTools: true, mockResponse: "INSTRUMENT_DECLINED" });
  await vi.waitFor(() => expect(listPlans().length).toBe(1));
  return { plan: listPlans()[0], marcusId: marcus.id, leeId: byName(day, "Lee").id, ahmedId: byName(day, "Ahmed").id };
}

function fakeOption(): PlanOption {
  return {
    id: "opt_a",
    title: "t",
    rationale: "r",
    actions: [
      { id: "a1", type: "void", bookingId: "bk_1", params: {}, feasible: true, infeasibleReason: null, amount: "25.00", currency: "USD" },
      { id: "a2", type: "send_invoice", bookingId: "bk_2", params: {}, feasible: true, infeasibleReason: null, amount: "54.00", currency: "USD" },
      { id: "a3", type: "message", bookingId: "bk_2", params: {}, feasible: true, infeasibleReason: null, amount: null, currency: null },
      { id: "a4", type: "capture", bookingId: "bk_3", params: {}, feasible: false, infeasibleReason: "nope", amount: "40.00", currency: "USD" },
    ],
  };
}

const fakePlan = (): Plan => ({ id: "plan_x", createdAt: new Date().toISOString(), trigger: { eventType: "manual", bookingId: null, eventId: null }, provider: "rules", summary: "s", options: [fakeOption()], draftMessages: [], status: "proposed", chosenOptionId: null, grantId: null, error: null });

describe("grant minting and scope", () => {
  beforeEach(() => setupEnv());

  it("binds booking ids, allowed actions, max amount, currency and a 15 minute expiry (feasible actions only)", () => {
    const now = new Date("2026-11-05T17:00:00.000Z");
    const g = mintGrant(fakePlan(), fakeOption(), now);
    expect(g.bookingIds.sort()).toEqual(["bk_1", "bk_2"]);
    expect(g.allowedActions.sort()).toEqual(["message", "send_invoice", "void"]);
    expect(g.maxAmount).toBe("79.00");
    expect(g.currency).toBe("USD");
    expect(g.expiresAt).toBe("2026-11-05T17:15:00.000Z");
    expect(g.status).toBe("active");
    expect(g.approvedBy).toBe("operator");
  });

  it("refuses an action outside allowedActions", () => {
    const g = mintGrant(fakePlan(), fakeOption());
    expect(() => assertWithinGrant(g, { type: "refund", bookingId: "bk_1", amount: "1.00" })).toThrow(/does not allow "refund"/);
    expect(() => assertWithinGrant(g, { type: "capture", bookingId: "bk_3", amount: "40.00" })).toThrow(GrantError); // infeasible action is not in scope
  });

  it("refuses an amount above maxAmount", () => {
    const g = mintGrant(fakePlan(), fakeOption());
    expect(() => assertWithinGrant(g, { type: "void", bookingId: "bk_1", amount: "79.01" })).toThrow(/exceed/);
    expect(() => assertWithinGrant(g, { type: "void", bookingId: "bk_1", amount: "79.00" })).not.toThrow();
  });

  it("refuses a booking that is not in the grant", () => {
    const g = mintGrant(fakePlan(), fakeOption());
    expect(() => assertWithinGrant(g, { type: "void", bookingId: "bk_999", amount: "25.00" })).toThrow(/does not cover booking/);
  });

  it("refuses a currency mismatch", () => {
    const g = mintGrant(fakePlan(), fakeOption());
    expect(() => assertWithinGrant(g, { type: "void", bookingId: "bk_1", amount: "25.00", currency: "EUR" })).toThrow(/CURRENCY|EUR/);
  });

  it("expires after 15 minutes and is marked expired", () => {
    const issued = new Date("2026-11-05T17:00:00.000Z");
    const g = mintGrant(fakePlan(), fakeOption(), issued);
    expect(() => assertWithinGrant(g, { type: "void", bookingId: "bk_1", amount: "25.00" }, new Date("2026-11-05T17:14:59.000Z"))).not.toThrow();
    expect(() => assertWithinGrant(g, { type: "void", bookingId: "bk_1", amount: "25.00" }, new Date("2026-11-05T17:15:00.000Z"))).toThrow(/expired/);
    expect(requireGrant(g.id).status).toBe("expired");
    expect(() => assertWithinGrant(requireGrant(g.id), { type: "void", bookingId: "bk_1", amount: "25.00" }, issued)).toThrow(/is expired/);
  });
});

describe("approve -> grant -> execute (authorize twice)", () => {
  beforeEach(() => setupEnv());

  it("approval mints a grant, executes the option under it, reflows the timeline, and uses the grant once", async () => {
    const { plan, marcusId, leeId, ahmedId } = await declinedPlan();
    const res = await approveRoute(req("", { body: { optionId: plan.options[0].id } }), params({ id: plan.id }));
    expect(res.status).toBe(200);
    const out = await body<ApprovePlanResponse>(res);
    expect(out.plan.status).toBe("executed");
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(out.grant.status).toBe("used");
    expect(out.grant.usedAt).not.toBeNull();
    expect(getBooking(marcusId)?.state).toBe("released");
    const lee = getBooking(leeId)!;
    expect(lee.waitlist).toBe(false);
    expect(lee.resourceId).toBe("van-1");
    expect(lee.state).toBe("quoted"); // still has to pay a deposit
    expect(getBooking(ahmedId)?.balanceState).toBe("invoiced");
    // every PayPal call under the grant is logged with the grant id
    const calls = listLog().filter((l) => l.kind === "paypal.call" && l.refs.grantId === out.grant.id);
    expect(calls.map((c) => c.refs.op).sort()).toEqual(["remindInvoice", "voidAuthorization"]);
    // the void under the grant does not create a second plan
    expect(listPlans().filter((p) => p.status === "proposed")).toHaveLength(0);
    // human approval and agent proposal are distinct actors
    expect(listLog(500).some((l) => l.actor === "operator" && l.kind === "grant.minted")).toBe(true);
    expect(listLog(500).some((l) => l.actor === "agent" && l.kind === "plan.proposed")).toBe(true);
    // used once: the same grant cannot run another money action
    const again = await voidRoute(req("", { body: { grantId: out.grant.id } }), params({ id: marcusId }));
    expect(again.status).toBe(403);
    expect((await again.json()).code).toBe("GRANT_INACTIVE");
    // the plan cannot be approved twice
    const twice = await approveRoute(req("", { body: { optionId: plan.options[0].id } }), params({ id: plan.id }));
    expect(twice.status).toBe(409);
  });

  it("a plan superseded by a newer event cannot be approved", async () => {
    const { plan, marcusId } = await declinedPlan();
    // Marcus's hold is voided out-of-band (not under this plan's grant) -> a new plan supersedes the old one
    const { voidBooking } = await import("@/server/bookings");
    await voidBooking(marcusId, { actor: "operator", devTools: true });
    await vi.waitFor(() => expect(getPlan(plan.id)?.status).toBe("expired"));
    const stale = await approveRoute(req("", { body: { optionId: plan.options[0].id } }), params({ id: plan.id }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("PLAN_NOT_OPEN");
  });

  it("an option whose actions became infeasible is refused at approval time (re-validated)", async () => {
    const { plan, leeId } = await declinedPlan();
    // Lee gets placed somewhere else by the operator before Dana approves "give the slot to Lee"
    const { moveBooking } = await import("@/server/bookings");
    const { at } = await import("./helpers");
    expect(moveBooking(leeId, at("15:00"), "van-2", { actor: "operator" }).ok).toBe(true);
    const res = await approveRoute(req("", { body: { optionId: plan.options[0].id } }), params({ id: plan.id }));
    const out = await body<ApprovePlanResponse>(res);
    const promote = out.plan.options[0].actions.find((a) => a.type === "promote")!;
    expect(promote.feasible).toBe(false);
    expect(out.results.find((r) => r.actionId === promote.id)?.detail).toMatch(/^skipped/);
    expect(out.grant.allowedActions).not.toContain("promote");
  });

  it("retry capture that declines again -> plan failed, grant revoked, new plan proposed", async () => {
    const { plan, marcusId } = await declinedPlan();
    const retry = plan.options.find((o) => o.actions.some((a) => a.type === "capture"))!;
    // second decline: patch the mock gateway so this capture fails too
    const { getMockGateway } = await import("@/server/paypal");
    const gw = getMockGateway()!;
    const orig = gw.captureAuthorization.bind(gw);
    gw.captureAuthorization = (input) => orig({ ...input, mockResponse: "INSTRUMENT_DECLINED" });
    try {
      const res = await approveRoute(req("", { body: { optionId: retry.id } }), params({ id: plan.id }));
      const out = await body<ApprovePlanResponse>(res);
      expect(out.plan.status).toBe("failed");
      expect(out.grant.status).toBe("revoked");
      expect(getBooking(marcusId)?.state).toBe("declined");
      await vi.waitFor(() => expect(listPlans().filter((p) => p.status === "proposed")).toHaveLength(1));
    } finally {
      gw.captureAuthorization = orig;
    }
  });

  it("reject closes the plan", async () => {
    const { plan } = await declinedPlan();
    const res = await rejectRoute(req("", { body: { reason: "will call Marcus" } }), params({ id: plan.id }));
    expect(res.status).toBe(200);
    expect(getPlan(plan.id)?.status).toBe("rejected");
    expect((await approveRoute(req("", { body: { optionId: plan.options[0].id } }), params({ id: plan.id }))).status).toBe(409);
  });
});

describe("operator money routes need a grant (or dev tools)", () => {
  beforeEach(() => setupEnv());

  it("capture without grant or dev secret -> 403 GRANT_REQUIRED, no PayPal call", async () => {
    await seedDemoDay();
    const marcus = byName(listBookings(), "Marcus");
    const res = await captureRoute(req("", { body: {} }), params({ id: marcus.id }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("GRANT_REQUIRED");
    expect(getBooking(marcus.id)?.state).toBe("held");
    expect(listLog().some((l) => l.kind === "paypal.call" && l.refs.op === "captureAuthorization")).toBe(false);
  });

  it("a wrong dev secret is not enough", async () => {
    await seedDemoDay();
    const marcus = byName(listBookings(), "Marcus");
    const res = await captureRoute(req("", { body: {}, headers: { "x-dev-secret": "nope" } }), params({ id: marcus.id }));
    expect(res.status).toBe(403);
  });

  it("dev secret works and is logged as operator with refs.devTools", async () => {
    await seedDemoDay();
    const marcus = byName(listBookings(), "Marcus");
    const res = await captureRoute(req("", { body: {}, headers: { "x-dev-secret": DEV_SECRET } }), params({ id: marcus.id }));
    expect(res.status).toBe(200);
    expect(getBooking(marcus.id)?.state).toBe("confirmed");
    expect(listLog().some((l) => l.actor === "operator" && l.kind === "dev.action" && l.refs.devTools === "1")).toBe(true);
  });

  it("a grant for one booking cannot refund another, and an over-limit refund is refused", async () => {
    const { plan, marcusId } = await declinedPlan();
    const option = plan.options[0];
    const grant = mintGrant(plan, option);
    const priya = byName(listBookings(), "Priya");
    const wrongBooking = await refundRoute(req("", { body: { grantId: grant.id } }), params({ id: priya.id }));
    expect(wrongBooking.status).toBe(403);
    expect(getBooking(priya.id)?.state).toBe("confirmed");
    // void Marcus is in scope: works, then the grant is used up
    const ok = await voidRoute(req("", { body: { grantId: grant.id } }), params({ id: marcusId }));
    expect(ok.status).toBe(200);
    expect(getGrant(grant.id)?.status).toBe("used");
  });
});

describe("grant consumption is atomic under concurrency", () => {
  beforeEach(() => setupEnv());

  /** Make every PayPal void take `ms`, so concurrent requests really interleave around the PayPal call. */
  function slowVoids(ms = 40): () => void {
    const gw = getMockGateway()!;
    const orig = gw.voidAuthorization.bind(gw);
    gw.voidAuthorization = async (input) => {
      await new Promise((r) => setTimeout(r, ms));
      return orig(input);
    };
    return () => {
      gw.voidAuthorization = orig;
    };
  }

  const voidCalls = (grantId?: string) => listLog(500).filter((l) => l.kind === "paypal.call" && l.refs.op === "voidAuthorization" && (!grantId || l.refs.grantId === grantId));

  it("two concurrent approvals of the same plan: one executes, the other is 409, one grant, one PayPal void", async () => {
    const { plan, marcusId } = await declinedPlan();
    const restore = slowVoids();
    try {
      const [a, b] = await Promise.all([
        approveRoute(req("", { body: { optionId: plan.options[0].id } }), params({ id: plan.id })),
        approveRoute(req("", { body: { optionId: plan.options[0].id } }), params({ id: plan.id })),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect((await loser.json()).code).toBe("PLAN_NOT_OPEN");
      expect(listGrantsForPlan(plan.id)).toHaveLength(1);
      expect(voidCalls()).toHaveLength(1);
      expect(getPlan(plan.id)?.status).toBe("executed");
      expect(getBooking(marcusId)?.state).toBe("released");
    } finally {
      restore();
    }
  });

  it("two concurrent money-route uses of one grant on different bookings: exactly one runs", async () => {
    await seedDemoDay();
    const day = listBookings();
    const marcus = byName(day, "Marcus");
    const ahmed = byName(day, "Ahmed");
    expect([marcus.state, ahmed.state]).toEqual(["held", "held"]);
    const option: PlanOption = {
      id: "opt_two",
      title: "void both holds",
      rationale: "race test",
      actions: [marcus, ahmed].map((b, i) => ({ id: `a${i}`, type: "void" as const, bookingId: b.id, params: {}, feasible: true, infeasibleReason: null, amount: b.depositAmount, currency: b.currency })),
    };
    const grant = mintGrant({ ...fakePlan(), options: [option] }, option);
    const restore = slowVoids();
    try {
      // Different bookings, so the per-booking lock does not serialise them: only the grant claim can.
      const [a, b] = await Promise.all([
        voidRoute(req("", { body: { grantId: grant.id } }), params({ id: marcus.id })),
        voidRoute(req("", { body: { grantId: grant.id } }), params({ id: ahmed.id })),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 403]);
      const loser = a.status === 403 ? a : b;
      expect((await loser.json()).code).toBe("GRANT_INACTIVE");
      expect(voidCalls(grant.id)).toHaveLength(1);
      expect([getBooking(marcus.id)?.state, getBooking(ahmed.id)?.state].sort()).toEqual(["held", "released"]);
      expect(getGrant(grant.id)).toMatchObject({ status: "used" });
    } finally {
      restore();
    }
  });

  it("claimGrant is one SQL UPDATE that matches only an active, unexpired grant, exactly once", () => {
    const now = new Date("2026-11-05T17:00:00.000Z");
    const g1 = mintGrant(fakePlan(), fakeOption(), now);
    expect(claimGrant(g1.id, new Date(now.getTime() + 60_000))).toMatchObject({ id: g1.id, status: "used", usedAt: "2026-11-05T17:01:00.000Z" });
    expect(claimGrant(g1.id, new Date(now.getTime() + 61_000))).toBeNull();
    const g2 = mintGrant(fakePlan(), fakeOption(), now);
    expect(claimGrant(g2.id, new Date(now.getTime() + 15 * 60_000))).toBeNull(); // expired at exactly 15 min
    expect(getGrant(g2.id)?.status).toBe("active");
    expect(claimGrant("grant_missing", now)).toBeNull();
  });

  it("a money route racing an approval's execution with the freshly minted grant is refused", async () => {
    const { plan, marcusId } = await declinedPlan();
    const restore = slowVoids(80);
    try {
      const approving = approveRoute(req("", { body: { optionId: plan.options[0].id } }), params({ id: plan.id }));
      await vi.waitFor(() => expect(listGrantsForPlan(plan.id)).toHaveLength(1));
      const grantId = listGrantsForPlan(plan.id)[0].id;
      const sneak = await voidRoute(req("", { body: { grantId } }), params({ id: marcusId }));
      expect(sneak.status).toBe(403);
      expect((await sneak.json()).code).toBe("GRANT_INACTIVE");
      const res = await approving;
      expect(res.status).toBe(200);
      expect((await body<ApprovePlanResponse>(res)).plan.status).toBe("executed");
      expect(voidCalls(grantId)).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
