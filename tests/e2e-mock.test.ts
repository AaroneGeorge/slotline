import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovePlanResponse, AuthorizeResponse, Booking, CreateBookingResponse, CreateOrderResponse, DevInjectResponse, DevReplayResponse, EvidencePack, MoveBookingResponse, PublicConfig, StateResponse, StreamEvent } from "@/shared/types";
import { POST as createBookingRoute } from "@/app/api/bookings/route";
import { GET as getBookingRoute, PATCH as moveRoute } from "@/app/api/bookings/[id]/route";
import { POST as orderRoute } from "@/app/api/bookings/[id]/order/route";
import { POST as authorizeRoute } from "@/app/api/bookings/[id]/authorize/route";
import { POST as captureRoute } from "@/app/api/bookings/[id]/capture/route";
import { POST as refundRoute } from "@/app/api/bookings/[id]/refund/route";
import { POST as invoiceRoute } from "@/app/api/bookings/[id]/invoice/route";
import { GET as evidenceRoute } from "@/app/api/bookings/[id]/evidence/route";
import { GET as stateRoute } from "@/app/api/state/route";
import { GET as configRoute } from "@/app/api/config/public/route";
import { GET as streamRoute } from "@/app/api/stream/route";
import { GET as planRoute } from "@/app/api/plans/[id]/route";
import { POST as approveRoute } from "@/app/api/plans/[id]/approve/route";
import { POST as proposeRoute } from "@/app/api/plans/propose/route";
import { POST as seedRoute } from "@/app/api/dev/seed/route";
import { POST as injectRoute } from "@/app/api/dev/inject/route";
import { POST as replayRoute } from "@/app/api/dev/replay/route";
import { countEvents, getBooking, listLog } from "@/server/db";
import { at, body, byName, DEV_SECRET, params, req, setupEnv } from "./helpers";

const dev = { "x-dev-secret": DEV_SECRET };

async function seed() {
  const res = await seedRoute(req("/api/dev/seed", { method: "POST", headers: dev }));
  expect(res.status).toBe(200);
  return body<StateResponse>(await stateRoute(req("/api/state")));
}

describe("mock gateway end to end through the route handlers", () => {
  beforeEach(() => setupEnv());

  it("create booking -> order -> authorize -> capture -> refund", async () => {
    await seed();
    const created = await createBookingRoute(req("/api/bookings", { body: { customerName: "Nadia Ortiz", customerEmail: "nadia@example.com", service: "screen", startAt: at("14:00") } }));
    expect(created.status).toBe(201);
    const { booking } = await body<CreateBookingResponse>(created);
    expect(booking).toMatchObject({ state: "quoted", waitlist: false, resourceId: "van-1", depositAmount: "40.00", durationMin: 60 });

    const order = await body<CreateOrderResponse>(await orderRoute(req("", { method: "POST" }), params({ id: booking.id })));
    expect(order.orderId).toMatch(/^MOCK-ORDER-\d+$/);
    // /order is idempotent
    expect((await body<CreateOrderResponse>(await orderRoute(req("", { method: "POST" }), params({ id: booking.id })))).orderId).toBe(order.orderId);

    // wrong order id is refused
    expect((await authorizeRoute(req("", { body: { orderId: "MOCK-ORDER-999" } }), params({ id: booking.id }))).status).toBe(409);

    const auth = await body<AuthorizeResponse>(await authorizeRoute(req("", { body: { orderId: order.orderId } }), params({ id: booking.id })));
    expect(auth.booking.state).toBe("held");
    expect(auth.authorizationId).toMatch(/^MOCK-AUTH-\d+$/);
    // double-submit of the approval is idempotent
    const again = await body<AuthorizeResponse>(await authorizeRoute(req("", { body: { orderId: order.orderId } }), params({ id: booking.id })));
    expect(again.authorizationId).toBe(auth.authorizationId);

    const cap = await captureRoute(req("", { body: {}, headers: dev }), params({ id: booking.id }));
    expect(cap.status).toBe(200);
    const capBody = await body<{ booking: Booking; refs: Record<string, string> }>(cap);
    expect(capBody.booking.state).toBe("confirmed");
    expect(capBody.refs.captureId).toMatch(/^MOCK-CAPTURE-\d+$/);

    const inv = await invoiceRoute(req("", { body: {}, headers: dev }), params({ id: booking.id }));
    expect(inv.status).toBe(200);
    expect(getBooking(booking.id)?.balanceState).toBe("invoiced");

    const ref = await refundRoute(req("", { body: {}, headers: dev }), params({ id: booking.id }));
    expect(ref.status).toBe(200);
    const refunded = (await body<{ booking: Booking }>(ref)).booking;
    expect(refunded.state).toBe("refunded");
    expect(refunded.paypalRefundId).toMatch(/^MOCK-REFUND-\d+$/);

    // refunding twice is refused by the state machine, not sent to PayPal
    expect((await refundRoute(req("", { body: {}, headers: dev }), params({ id: booking.id }))).status).toBe(409);

    const got = await body<{ booking: Booking }>(await getBookingRoute(req(""), params({ id: booking.id })));
    expect(got.booking.state).toBe("refunded");

    // five distinct actors in the log (the refund triggered an agent plan)
    await vi.waitFor(() => expect([...new Set(listLog(500).map((l) => l.actor))].sort()).toEqual(["agent", "customer", "operator", "paypal", "system"]));
  });

  it("declined capture (negative test) -> agent card -> approve -> timeline reflows", async () => {
    const st = await seed();
    const marcus = byName(st.bookings, "Marcus");
    const lee = byName(st.bookings, "Lee");
    const cap = await captureRoute(req("", { body: { mockResponse: "INSTRUMENT_DECLINED" }, headers: dev }), params({ id: marcus.id }));
    const capBody = await body<{ booking: Booking; refs: Record<string, string> }>(cap);
    expect(capBody.booking.state).toBe("declined");
    expect(capBody.refs).toMatchObject({ issue: "INSTRUMENT_DECLINED", outcome: "declined" });
    let plans: StateResponse["plans"] = [];
    await vi.waitFor(async () => {
      plans = (await body<StateResponse>(await stateRoute(req("/api/state")))).plans;
      expect(plans[0]?.status).toBe("proposed");
    });
    const plan = plans[0];
    const fetched = await body<{ plan: { id: string } }>(await planRoute(req(""), params({ id: plan.id })));
    expect(fetched.plan.id).toBe(plan.id);
    const approved = await body<ApprovePlanResponse>(await approveRoute(req("", { body: { optionId: plan.options[0].id } }), params({ id: plan.id })));
    expect(approved.plan.status).toBe("executed");
    const after = await body<StateResponse>(await stateRoute(req("/api/state")));
    expect(byName(after.bookings, "Marcus").state).toBe("released");
    expect(byName(after.bookings, "Lee")).toMatchObject({ waitlist: false, resourceId: "van-1", startAt: marcus.startAt });
    expect(after.plans.find((p) => p.id === plan.id)?.grantId).toBe(approved.grant.id);
    expect(lee.waitlist).toBe(true);
  });

  it("refund fixture releases a slot; replaying it is a no-op", async () => {
    const st = await seed();
    const priya = byName(st.bookings, "Priya");
    const inj = await injectRoute(req("/api/dev/inject", { body: { fixture: "capture.refunded", bookingId: priya.id }, headers: dev }));
    expect(inj.status).toBe(200);
    const out = await body<DevInjectResponse>(inj);
    expect(out.outcome).toBe("applied");
    expect(out.booking?.state).toBe("refunded");
    expect(out.plan?.status).toBe("proposed");
    const events = countEvents();
    const rep = await body<DevReplayResponse>(await replayRoute(req("/api/dev/replay", { body: {}, headers: dev })));
    expect(rep).toMatchObject({ eventId: out.eventId, outcome: "duplicate", httpStatus: 200 });
    expect(countEvents()).toBe(events);
    expect(getBooking(priya.id)?.state).toBe("refunded");
  });

  it("dispute fixture flags the booking and the evidence pack assembles", async () => {
    const st = await seed();
    const priya = byName(st.bookings, "Priya");
    const out = await body<DevInjectResponse>(await injectRoute(req("/api/dev/inject", { body: { fixture: "dispute.created", bookingId: priya.id }, headers: dev })));
    expect(out.booking?.state).toBe("disputed");
    expect(out.booking?.paypalDisputeId).toMatch(/^PP-D-MOCK-\d+$/);
    const plan = out.plan!;
    const contest = plan.options.find((o) => o.actions.some((a) => a.type === "flag_dispute"))!;
    const approved = await body<ApprovePlanResponse>(await approveRoute(req("", { body: { optionId: contest.id } }), params({ id: plan.id })));
    expect(approved.results.find((r) => r.refs.evidenceUrl)?.refs.evidenceUrl).toBe(`/evidence/${priya.id}`);
    const pack = await body<EvidencePack>(await evidenceRoute(req(""), params({ id: priya.id })));
    expect(pack.booking.id).toBe(priya.id);
    expect(pack.order?.id).toBe(priya.paypalOrderId);
    expect(pack.authorization?.id).toBe(priya.paypalAuthorizationId);
    expect(pack.capture?.id).toBe(priya.paypalCaptureId);
    expect((pack.dispute as { dispute_id?: string })?.dispute_id).toBe(out.booking?.paypalDisputeId);
    expect(pack.events?.map((e) => e.type)).toContain("CUSTOMER.DISPUTE.CREATED");
    expect(pack.timeline?.length).toBeGreaterThan(0);
    expect(pack.facts?.some((f) => f.includes("CUSTOMER.DISPUTE.CREATED"))).toBe(true);
    expect(pack.grants?.[0]?.status).toBe("used");
  });

  it("dev routes require the secret", async () => {
    expect((await seedRoute(req("/api/dev/seed", { method: "POST" }))).status).toBe(401);
    expect((await injectRoute(req("/api/dev/inject", { body: { fixture: "capture.denied", bookingId: "x" }, headers: { "x-dev-secret": "wrong" } }))).status).toBe(401);
    process.env.DEV_TOOLS_SECRET = "";
    expect((await seedRoute(req("/api/dev/seed", { method: "POST", headers: dev }))).status).toBe(403);
  });

  it("PATCH move: 409 with conflicts when infeasible, applied otherwise", async () => {
    const st = await seed();
    const sofia = byName(st.bookings, "Sofia");
    const priya = byName(st.bookings, "Priya");
    const bad = await moveRoute(req("", { method: "PATCH", body: { startAt: priya.startAt, resourceId: "van-2" } }), params({ id: sofia.id }));
    expect(bad.status).toBe(409);
    const badBody = await body<MoveBookingResponse>(bad);
    expect(badBody.conflicts[0]).toMatch(/overlaps Priya/);
    expect(getBooking(sofia.id)?.startAt).toBe(sofia.startAt);
    const good = await moveRoute(req("", { method: "PATCH", body: { startAt: at("15:00"), resourceId: "van-1" } }), params({ id: sofia.id }));
    expect(good.status).toBe(200);
    expect((await body<MoveBookingResponse>(good)).booking).toMatchObject({ resourceId: "van-1", startAt: at("15:00") });
  });

  it("booking requests: full slot -> waitlist; outside hours -> 422; bad body -> 400", async () => {
    const st = await seed();
    const priya = byName(st.bookings, "Priya");
    const marcus = byName(st.bookings, "Marcus");
    expect(priya.startAt < marcus.endAt).toBe(true);
    const full = await body<CreateBookingResponse>(await createBookingRoute(req("/api/bookings", { body: { customerName: "Late Larry", service: "battery", startAt: marcus.startAt } })));
    expect(full.booking).toMatchObject({ waitlist: true, resourceId: null, state: "quoted" });
    // a waitlisted booking cannot take a deposit yet
    expect((await orderRoute(req("", { method: "POST" }), params({ id: full.booking.id }))).status).toBe(409);
    expect((await createBookingRoute(req("/api/bookings", { body: { customerName: "Night Owl", service: "battery", startAt: at("21:00") } }))).status).toBe(422);
    expect((await createBookingRoute(req("/api/bookings", { body: { customerName: "", service: "laptop", startAt: "soon" } }))).status).toBe(400);
  });

  it("manual propose returns a plan", async () => {
    const st = await seed();
    const res = await proposeRoute(req("/api/plans/propose", { body: { bookingId: byName(st.bookings, "Marcus").id } }));
    expect(res.status).toBe(200);
    expect((await body<{ plan: { provider: string } }>(res)).plan.provider).toBe("rules");
  });

  it("GET /api/state auto-seeds an empty database and GET /api/config/public reports mock mode", async () => {
    process.env.AUTO_RESEED = "empty";
    const st = await body<StateResponse>(await stateRoute(req("/api/state")));
    expect(st.resources.map((r) => r.id)).toEqual(["van-1", "van-2"]);
    expect(st.bookings.length).toBe(5);
    expect(st.mode).toEqual({ paypal: "mock", llm: "rules", devTools: true });
    const cfg = await body<PublicConfig>(await configRoute(req("/api/config/public")));
    expect(cfg).toMatchObject({ paypalClientId: null, currency: "USD", mode: { paypal: "mock" }, timeZone: "America/Los_Angeles" });
  });

  it("the mock gateway echoes PayPal's webhook after an API call; the late webhook is a verified no-op", async () => {
    process.env.MOCK_WEBHOOK_DELAY_MS = "5";
    const st = await seed();
    const marcus = byName(st.bookings, "Marcus");
    await captureRoute(req("", { body: {}, headers: dev }), params({ id: marcus.id }));
    await vi.waitFor(() => expect(listLog().some((l) => l.kind === "webhook.received" && l.refs.eventType === "PAYMENT.CAPTURE.COMPLETED")).toBe(true));
    await vi.waitFor(() => expect(listLog().some((l) => l.kind === "event.noop" && l.refs.eventType === "PAYMENT.CAPTURE.COMPLETED")).toBe(true));
    expect(getBooking(marcus.id)?.state).toBe("confirmed");
  });

  it("a double-clicked capture sends one PayPal capture; the second request is refused by the state machine", async () => {
    const st = await seed();
    const marcus = byName(st.bookings, "Marcus");
    const [a, b] = await Promise.all([
      captureRoute(req("", { body: {}, headers: dev }), params({ id: marcus.id })),
      captureRoute(req("", { body: {}, headers: dev }), params({ id: marcus.id })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(listLog().filter((l) => l.kind === "paypal.call" && l.refs.op === "captureAuthorization")).toHaveLength(1);
    expect(getBooking(marcus.id)?.state).toBe("confirmed");
  });

  it("GET /api/stream sends hello, then live events", async () => {
    await seed();
    const ac = new AbortController();
    const res = await streamRoute(new Request("http://localhost:3000/api/stream", { signal: ac.signal }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const events: StreamEvent[] = [];
    const pump = async (until: (e: StreamEvent[]) => boolean) => {
      while (!until(events)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) events.push(JSON.parse(line.slice(6)) as StreamEvent);
        }
      }
    };
    await pump((e) => e.length >= 1);
    expect(events[0].type).toBe("hello");
    await createBookingRoute(req("/api/bookings", { body: { customerName: "Stream Sam", service: "diagnostic", startAt: at("16:00") } }));
    await pump((e) => e.some((x) => x.type === "booking.updated") && e.some((x) => x.type === "log"));
    expect(events.some((e) => e.type === "booking.updated" && e.booking.customerName === "Stream Sam")).toBe(true);
    ac.abort();
    await reader.cancel().catch(() => undefined);
  });
});
