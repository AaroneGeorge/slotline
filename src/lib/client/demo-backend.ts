/**
 * In-browser stand-in for the Slotline server, used only behind `?demo=1`.
 * It follows the same rules the backend does (state machine of BUILD-PLAN §4,
 * 30-minute travel buffer, grants that bound execution) closely enough that
 * every button on the dashboard and the booking page works with no server.
 * It is a simulation: nothing here talks to PayPal.
 */
import type {
  ApprovePlanResponse,
  AvailabilityResponse,
  Booking,
  BookingState,
  DevFixture,
  DevInjectResponse,
  DevReplayResponse,
  EvidencePack,
  Grant,
  LogEntry,
  MoneyEventType,
  Plan,
  PlanAction,
  PlanActionType,
  PlanOption,
  Resource,
  Service,
  StateResponse,
  StreamEvent,
} from "@/shared/types";
import { ApiRequestError, type MoneyAction, type MoneyActionResponse, type MoveOutcome } from "./api";
import type { SlotlineBackend } from "./backend";
import { buildDemoState, DEMO_DURATION, DEMO_PRICES } from "./demo-data";
import { firstName, money, sumAmounts, SERVICE_META } from "./format";
import { dayTimeToIso, formatRange, formatTime, wallParts, WORK_END_HOUR, WORK_START_HOUR } from "./time";

const BUFFER_MIN = 30;
const MIN = 60_000;

/** crypto.randomUUID only exists in secure contexts (https, localhost); the demo may be opened over plain http. */
function rid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

/** BUILD-PLAN §4. `null` = illegal. */
const TRANSITIONS: Record<MoneyEventType, Partial<Record<BookingState, BookingState>>> = {
  "CHECKOUT.ORDER.APPROVED": { quoted: "approved", approved: "approved" },
  "PAYMENT.AUTHORIZATION.CREATED": { quoted: "held", approved: "held", held: "held", declined: "held", released: "held" },
  "PAYMENT.AUTHORIZATION.VOIDED": { quoted: "released", approved: "released", held: "released", declined: "released", released: "released" },
  "PAYMENT.CAPTURE.COMPLETED": { held: "confirmed", pending: "confirmed", confirmed: "confirmed", declined: "confirmed" },
  "PAYMENT.CAPTURE.DENIED": { held: "declined", pending: "declined", declined: "declined" },
  "PAYMENT.CAPTURE.PENDING": { held: "pending", pending: "pending", declined: "pending" },
  "PAYMENT.CAPTURE.REFUNDED": { pending: "refunded", confirmed: "refunded", refunded: "refunded", disputed: "refunded" },
  "INVOICING.INVOICE.PAID": { quoted: "quoted", approved: "approved", held: "held", pending: "pending", confirmed: "confirmed", declined: "declined" },
  "CUSTOMER.DISPUTE.CREATED": { held: "disputed", pending: "disputed", confirmed: "disputed", declined: "disputed", refunded: "disputed", disputed: "disputed" },
};

const FIXTURE_EVENT: Record<DevFixture, MoneyEventType> = {
  "capture.denied": "PAYMENT.CAPTURE.DENIED",
  "capture.pending": "PAYMENT.CAPTURE.PENDING",
  "capture.refunded": "PAYMENT.CAPTURE.REFUNDED",
  "authorization.voided": "PAYMENT.AUTHORIZATION.VOIDED",
  "dispute.created": "CUSTOMER.DISPUTE.CREATED",
  "invoice.paid": "INVOICING.INVOICE.PAID",
};

type Listener = (e: StreamEvent) => void;

class DemoSim {
  tz: string;
  day: string;
  resources: Resource[];
  bookings = new Map<string, Booking>();
  plans = new Map<string, Plan>();
  grants = new Map<string, Grant>();
  log: LogEntry[] = [];
  listeners = new Set<Listener>();
  instant = false;
  private seq = 100;
  private ppSeq = 2000;

  constructor() {
    const s = buildDemoState();
    this.tz = s.timeZone;
    this.day = s.day;
    this.resources = s.resources;
    for (const b of s.bookings) this.bookings.set(b.id, b);
    this.log = s.log;
  }

  reset() {
    const s = buildDemoState(this.tz);
    this.day = s.day;
    this.resources = s.resources;
    const now = new Date().toISOString();
    // fresher than anything the dashboard holds, so the reset wins over local state
    this.bookings = new Map(s.bookings.map((b) => [b.id, { ...b, updatedAt: now }]));
    this.plans.clear();
    this.grants.clear();
    this.log = s.log;
  }

  snapshot(): StateResponse {
    const plans = [...this.plans.values()].sort((a, b) => {
      if ((a.status === "proposed") !== (b.status === "proposed")) return a.status === "proposed" ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return {
      resources: this.resources.map((r) => ({ ...r })),
      bookings: [...this.bookings.values()].map((b) => ({ ...b })),
      plans: plans.slice(0, 12).map(clone),
      log: this.log.slice(0, 200),
      mode: { paypal: "mock", llm: "rules", devTools: true },
      day: this.day,
      timeZone: this.tz,
      grants: [...this.grants.values()].map(clone),
    };
  }

  // ---- plumbing -------------------------------------------------------

  emit(e: StreamEvent) {
    for (const l of this.listeners) {
      try {
        l(clone(e));
      } catch {
        // a broken listener must not stop the simulation
      }
    }
  }

  sleep(ms: number) {
    return this.instant ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms));
  }

  id(prefix: string) {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, "0")}`;
  }

  ppId(kind: string) {
    this.ppSeq += 1;
    return `MOCK-${kind}-${this.ppSeq}`;
  }

  addLog(actor: LogEntry["actor"], kind: string, message: string, bookingId: string | null, refs: Record<string, string> = {}) {
    const entry: LogEntry = { id: this.id("log"), at: new Date().toISOString(), actor, kind, message, bookingId, refs };
    this.log.unshift(entry);
    if (this.log.length > 300) this.log.length = 300;
    this.emit({ type: "log", entry });
    return entry;
  }

  put(b: Booking) {
    const next = { ...b, updatedAt: new Date().toISOString() };
    this.bookings.set(b.id, next);
    this.emit({ type: "booking.updated", booking: next });
    return next;
  }

  get(id: string): Booking {
    const b = this.bookings.get(id);
    if (!b) throw new ApiRequestError(404, { error: `Booking ${id} not found`, code: "not_found" }, "Not found");
    return b;
  }

  putPlan(plan: Plan, created = false) {
    this.plans.set(plan.id, plan);
    this.emit(created ? { type: "plan.created", plan } : { type: "plan.updated", plan });
  }

  putGrant(grant: Grant) {
    this.grants.set(grant.id, grant);
    this.emit({ type: "grant.updated", grant });
  }

  /** The single door for money state changes, like applyMoneyEvent on the server. */
  async moneyEvent(type: MoneyEventType, bookingId: string, source: "webhook" | "api" | "dev", refs: Record<string, string> = {}, patch: Partial<Booking> = {}) {
    const b = this.get(bookingId);
    const eventId = source === "webhook" ? `WH-MOCK-${this.ppSeq++}` : `${source}:${rid().slice(0, 8)}`;
    this.addLog("paypal", source === "webhook" ? "webhook.received" : "paypal.event", `${type}${source === "webhook" ? " (verified)" : ` (source: ${source})`}`, b.id, { eventId, ...refs });
    const to = TRANSITIONS[type][b.state];
    if (!to) {
      this.addLog("system", "booking.illegal", `Illegal transition ${b.state} + ${type}: logged, not applied`, b.id, { eventId });
      return b;
    }
    const next: Booking = { ...b, ...patch };
    if (type === "INVOICING.INVOICE.PAID") next.balanceState = "paid";
    else next.state = to;
    if (to === "released" || to === "refunded") next.waitlist = false;
    await this.sleep(120);
    const saved = this.put(next);
    if (b.state !== saved.state) {
      this.addLog("system", "booking.state", `${saved.customerName}: ${b.state} → ${saved.state}`, b.id, { eventId });
    } else if (type === "INVOICING.INVOICE.PAID") {
      this.addLog("system", "booking.balance", `${saved.customerName}: balance paid`, b.id, { eventId });
    }
    if (b.state !== saved.state || type === "CUSTOMER.DISPUTE.CREATED") void this.maybePlan(type, saved, eventId);
    return saved;
  }

  // ---- solver ----------------------------------------------------------

  onTimeline(b: Booking) {
    return Boolean(b.resourceId) && !b.waitlist && !["released", "refunded"].includes(b.state);
  }

  conflicts(candidate: { id?: string; resourceId: string; startAt: string; durationMin: number }): string[] {
    const start = new Date(candidate.startAt).getTime();
    const end = start + candidate.durationMin * MIN;
    const out: string[] = [];
    const s = wallParts(new Date(start), this.tz);
    const e = wallParts(new Date(end), this.tz);
    const startMin = s.hour * 60 + s.minute;
    const endMin = e.hour * 60 + e.minute + (e.day !== s.day ? 24 * 60 : 0);
    if (startMin < WORK_START_HOUR * 60 || endMin > WORK_END_HOUR * 60) {
      out.push(`Outside working hours (${WORK_START_HOUR} AM–${WORK_END_HOUR - 12} PM)`);
    }
    for (const o of this.bookings.values()) {
      if (o.id === candidate.id || o.resourceId !== candidate.resourceId || !this.onTimeline(o)) continue;
      const os = new Date(o.startAt).getTime();
      const oe = new Date(o.endAt).getTime();
      if (start < oe + BUFFER_MIN * MIN && os < end + BUFFER_MIN * MIN) {
        const touching = start < oe && os < end;
        out.push(
          `${touching ? "Overlaps" : "Too close to"} ${o.customerName} ${formatRange(o.startAt, o.endAt, this.tz)}${touching ? "" : " (30 min travel buffer)"}`,
        );
      }
    }
    return out;
  }

  /** Same shape as GET /api/availability: every van at every 30-minute start, no customer data. */
  availability(day: string, service: Service): AvailabilityResponse {
    const durationMin = DEMO_DURATION[service];
    const slots: AvailabilityResponse["slots"] = [];
    for (let m = WORK_START_HOUR * 60; m + durationMin <= WORK_END_HOUR * 60; m += 30) {
      const startAt = dayTimeToIso(day, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, this.tz);
      const endAt = new Date(new Date(startAt).getTime() + durationMin * MIN).toISOString();
      for (const r of this.resources) slots.push({ startAt, endAt, resourceId: r.id, available: this.conflicts({ resourceId: r.id, startAt, durationMin }).length === 0 });
    }
    return { day, timeZone: this.tz, slots };
  }

  firstFeasibleVan(startAt: string, durationMin: number, exclude?: string): string | null {
    for (const r of this.resources) {
      if (this.conflicts({ id: exclude, resourceId: r.id, startAt, durationMin }).length === 0) return r.id;
    }
    return null;
  }

  /** First feasible start after this booking's own window (its slot may be handed to someone else). */
  nextFreeSlot(b: Booking): { resourceId: string; startAt: string } | null {
    const from = new Date(b.endAt).getTime() + BUFFER_MIN * MIN;
    for (let step = 0; step <= 16; step++) {
      const t = new Date(from + step * 30 * MIN).toISOString();
      const van = this.firstFeasibleVan(t, b.durationMin, b.id);
      if (van) return { resourceId: van, startAt: t };
    }
    return null;
  }

  waitlistFor(slot: { startAt: string; endAt: string }): Booking | null {
    const window = (new Date(slot.endAt).getTime() - new Date(slot.startAt).getTime()) / MIN;
    const list = [...this.bookings.values()]
      .filter((b) => b.waitlist && b.state === "quoted")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return list.find((b) => b.durationMin <= window) ?? list[0] ?? null;
  }

  // ---- planner (rules) ------------------------------------------------

  action(type: PlanActionType, booking: Booking, params: Record<string, unknown> = {}, feasible = true, infeasibleReason: string | null = null): PlanAction {
    const moneyAmount: Partial<Record<PlanActionType, string>> = {
      void: booking.depositAmount,
      capture: booking.depositAmount,
      refund: (params.amount as string | undefined) ?? booking.depositAmount,
      send_invoice: booking.balanceAmount,
      send_reminder: "0.00",
    };
    const amount = moneyAmount[type] ?? null;
    return {
      id: this.id("act"),
      type,
      bookingId: booking.id,
      params,
      feasible,
      infeasibleReason,
      amount,
      currency: amount ? booking.currency : null,
    };
  }

  promoteAction(w: Booking, slot: { resourceId: string; startAt: string }, excludeId?: string) {
    const c = this.conflicts({ id: w.id, resourceId: slot.resourceId, startAt: slot.startAt, durationMin: w.durationMin }).filter(
      (msg) => !excludeId || !msg.includes(this.bookings.get(excludeId)?.customerName ?? "\u0000"),
    );
    return this.action("promote", w, { startAt: slot.startAt, resourceId: slot.resourceId }, c.length === 0, c[0] ?? null);
  }

  buildPlan(trigger: MoneyEventType | "manual", b: Booking, eventId: string | null): Plan | null {
    const tz = this.tz;
    const at = formatTime(b.startAt, tz);
    const van = this.resources.find((r) => r.id === b.resourceId)?.name ?? "the van";
    const options: PlanOption[] = [];
    const drafts: Plan["draftMessages"] = [];
    let summary = "";
    const opt = (title: string, rationale: string, actions: PlanAction[]): PlanOption => ({ id: this.id("opt"), title, rationale, actions });

    const state = b.state;
    if (state === "declined") {
      const w = this.waitlistFor(b);
      summary = `${b.customerName}'s ${money(b.depositAmount)} deposit capture was declined. The ${at} slot on ${van} is at risk${w ? ` and ${w.customerName} is waiting for it` : ""}.`;
      if (w) {
        const promote = this.promoteAction(w, { resourceId: b.resourceId!, startAt: b.startAt }, b.id);
        options.push(
          opt(`Promote ${firstName(w.customerName)} to ${at}, void ${firstName(b.customerName)}'s hold`, `${w.customerName} asked for ${at} and fits the ${b.durationMin}-minute window. Voiding releases ${b.customerName}'s failed authorization so nothing stays pending on their card; ${firstName(w.customerName)} pays a fresh deposit through the booking link.`, [
            this.action("void", b),
            promote,
            this.action("message", b, { channel: "email" }),
            this.action("message", w, { channel: "sms" }),
          ]),
        );
        drafts.push(
          { bookingId: b.id, channel: "email", subject: "Your Slotline repair today", body: `Hi ${firstName(b.customerName)}, PayPal couldn't capture the deposit for your ${at} repair, so we've released the hold and nothing will be charged. Reply here and we'll find you a new time.` },
          { bookingId: w.id, channel: "sms", subject: null, body: `Slotline: good news ${firstName(w.customerName)}, ${at} today just opened up. Tap to hold it with a ${money(w.depositAmount)} PayPal deposit: {booking_link}` },
        );
      }
      options.push(
        opt(`Keep ${firstName(b.customerName)}, ask for a new payment method`, `${firstName(b.customerName)} keeps the slot. A balance invoice lets them pay by any PayPal funding source before the van arrives; the declined hold is retried once.`, [
          this.action("message", b, { channel: "email" }),
          this.action("send_invoice", b, {}, b.balanceState !== "invoiced", b.balanceState === "invoiced" ? "Balance invoice already sent" : null),
          this.action("capture", b, { retry: true }),
        ]),
      );
      const later = this.nextFreeSlot(b);
      if (later && w) {
        options.push(
          opt(`Move ${firstName(b.customerName)} to ${formatTime(later.startAt, tz)}, give ${at} to ${firstName(w.customerName)}`, `Both customers are served today. ${firstName(b.customerName)} moves to the next feasible slot and pays on site; ${firstName(w.customerName)} takes ${at}.`, [
            this.action("move", b, later),
            this.promoteAction(w, { resourceId: b.resourceId!, startAt: b.startAt }, b.id),
            this.action("send_invoice", b, {}, b.balanceState !== "invoiced", b.balanceState === "invoiced" ? "Balance invoice already sent" : null),
          ]),
        );
      }
      drafts.push({ bookingId: b.id, channel: "email", subject: "Quick payment update needed", body: `Hi ${firstName(b.customerName)}, your bank declined the ${money(b.depositAmount)} deposit for today's ${at} repair. You can pay the visit by PayPal invoice instead: {invoice_link}` });
    } else if (state === "refunded" || state === "released") {
      const w = this.waitlistFor(b);
      summary = `${b.customerName} was ${state}; ${van} has a free ${b.durationMin}-minute window at ${at}.`;
      if (w) {
        options.push(
          opt(`Promote ${firstName(w.customerName)} into ${at}`, `${w.customerName} has waited longest and fits the window. They still pay their own deposit.`, [
            this.promoteAction(w, { resourceId: b.resourceId!, startAt: b.startAt }, b.id),
            this.action("message", w, { channel: "sms" }),
          ]),
        );
        drafts.push({ bookingId: w.id, channel: "sms", subject: null, body: `Slotline: ${at} today is free now, ${firstName(w.customerName)}. Hold it with a ${money(w.depositAmount)} PayPal deposit: {booking_link}` });
      }
      const after = [...this.bookings.values()]
        .filter((o) => o.resourceId === b.resourceId && this.onTimeline(o) && o.startAt > b.startAt && o.state !== "confirmed")
        .sort((x, y) => x.startAt.localeCompare(y.startAt))[0];
      if (after) {
        const c = this.conflicts({ id: after.id, resourceId: after.resourceId!, startAt: b.startAt, durationMin: after.durationMin });
        options.push(
          opt(`Pull ${firstName(after.customerName)} forward to ${at}`, `Closes the gap on ${van} so Dana finishes earlier. Moves stay within two hours of the agreed time.`, [
            this.action("move", after, { startAt: b.startAt, resourceId: b.resourceId }, c.length === 0, c[0] ?? null),
            this.action("message", after, { channel: "sms" }),
          ]),
        );
      }
    } else if (state === "disputed") {
      summary = `${b.customerName} opened a PayPal dispute${b.paypalDisputeId ? ` (${b.paypalDisputeId})` : ""}. The job stays on the timeline, flagged, while evidence is assembled.`;
      options.push(
        opt("Assemble the evidence pack and reply", "Order, authorization, capture, invoice and the full event log go into one printable pack for the dispute response.", [
          this.action("flag_dispute", b),
          this.action("message", b, { channel: "email" }),
        ]),
      );
      if (b.paypalCaptureId) {
        options.push(
          opt(`Refund ${money(b.depositAmount)} and close it`, "Cheaper than contesting a deposit-sized dispute; the slot is released.", [
            this.action("refund", b, { amount: b.depositAmount }),
            this.action("message", b, { channel: "email" }),
          ]),
        );
      }
      drafts.push({ bookingId: b.id, channel: "email", subject: "About your PayPal dispute", body: `Hi ${firstName(b.customerName)}, we saw the dispute on your ${SERVICE_META[b.service].label.toLowerCase()} deposit. Here is what we have on record; reply and we'll sort it out directly.` });
    } else {
      summary = `Manual re-plan for ${b.customerName} (${state}).`;
      const later = this.nextFreeSlot(b);
      if (later && b.resourceId) {
        options.push(opt(`Move ${firstName(b.customerName)} to ${formatTime(later.startAt, tz)}`, "Next feasible slot with the travel buffer respected.", [this.action("move", b, later), this.action("message", b, { channel: "sms" })]));
      }
      if (b.paypalAuthorizationId && ["held", "pending", "declined"].includes(state)) {
        options.push(opt(`Capture ${firstName(b.customerName)}'s deposit now`, "The job is firm; capture before the van leaves.", [this.action("capture", b)]));
      }
    }

    const kept = options.filter((o) => o.actions.some((a) => a.feasible)).slice(0, 3);
    if (!kept.length) return null;
    return {
      id: this.id("PLN"),
      createdAt: new Date().toISOString(),
      trigger: { eventType: trigger, bookingId: b.id, eventId },
      provider: "rules",
      summary,
      options: kept,
      draftMessages: drafts,
      status: "proposed",
      chosenOptionId: null,
      grantId: null,
      error: null,
    };
  }

  /** maybePlan is fire-and-forget; in instant mode it settles within a few microtasks. */
  maybePlanSettled() {
    return new Promise<void>((r) => setTimeout(r, 0));
  }

  async maybePlan(type: MoneyEventType | "manual", b: Booking, eventId: string | null) {
    const triggers: (MoneyEventType | "manual")[] = ["PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "CUSTOMER.DISPUTE.CREATED", "manual"];
    if (!triggers.includes(type)) return null;
    await this.sleep(650);
    // supersede older open plans for the same booking
    for (const p of this.plans.values()) {
      if (p.status === "proposed" && p.trigger.bookingId === b.id) this.putPlan({ ...p, status: "expired" });
    }
    const plan = this.buildPlan(type, this.get(b.id), eventId);
    if (!plan) {
      this.addLog("agent", "plan.none", `No feasible options for ${b.customerName}`, b.id);
      return null;
    }
    this.putPlan(plan, true);
    this.addLog("agent", "plan.proposed", `${plan.options.length} option${plan.options.length === 1 ? "" : "s"} for ${b.customerName}: ${plan.options[0].title}`, b.id, { planId: plan.id });
    return plan;
  }

  // ---- execution under a grant ------------------------------------------

  async approve(planId: string, optionId: string): Promise<ApprovePlanResponse> {
    const plan = this.plans.get(planId);
    if (!plan) throw new ApiRequestError(404, { error: "Plan not found", code: "not_found" }, "Not found");
    if (plan.status !== "proposed") throw new ApiRequestError(409, { error: `Plan is ${plan.status}`, code: "plan_not_open" }, "Conflict");
    const option = plan.options.find((o) => o.id === optionId);
    if (!option) throw new ApiRequestError(400, { error: "Unknown option", code: "bad_option" }, "Bad request");
    const feasible = option.actions.filter((a) => a.feasible);
    const now = Date.now();
    const grant: Grant = {
      id: this.id("GRT"),
      planId,
      optionId,
      bookingIds: [...new Set(feasible.map((a) => a.bookingId))],
      allowedActions: [...new Set(feasible.map((a) => a.type))],
      maxAmount: sumAmounts(feasible.filter((a) => ["void", "capture", "refund", "send_invoice"].includes(a.type)).map((a) => a.amount)).toFixed(2),
      currency: "USD",
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15 * MIN).toISOString(),
      approvedBy: "operator",
      status: "active",
      usedAt: null,
    };
    this.addLog("operator", "plan.approved", `Dana approved “${option.title}”`, plan.trigger.bookingId, { planId, optionId });
    this.putGrant(grant);
    this.addLog("system", "grant.minted", `Grant ${grant.id}: ${grant.allowedActions.join(", ")} on ${grant.bookingIds.length} booking${grant.bookingIds.length === 1 ? "" : "s"}, max ${money(grant.maxAmount)}, expires ${formatTime(grant.expiresAt, this.tz)}`, plan.trigger.bookingId, { grantId: grant.id, planId });
    this.putPlan({ ...plan, status: "approved", chosenOptionId: optionId, grantId: grant.id });

    const results: ApprovePlanResponse["results"] = [];
    for (const a of option.actions) {
      if (!a.feasible) {
        results.push({ actionId: a.id, ok: false, detail: `Skipped: ${a.infeasibleReason ?? "infeasible"}`, refs: {} });
        continue;
      }
      await this.sleep(450);
      try {
        const r = await this.execute(a, grant);
        results.push({ actionId: a.id, ok: true, detail: r.detail, refs: r.refs });
      } catch (err) {
        results.push({ actionId: a.id, ok: false, detail: err instanceof Error ? err.message : String(err), refs: {} });
      }
    }
    const usedGrant: Grant = { ...grant, status: "used", usedAt: new Date().toISOString() };
    this.putGrant(usedGrant);
    const ok = results.every((r) => r.ok || r.detail.startsWith("Skipped"));
    const finalPlan: Plan = { ...this.plans.get(planId)!, status: ok ? "executed" : "failed", error: ok ? null : results.find((r) => !r.ok)?.detail ?? null };
    this.putPlan(finalPlan);
    this.addLog("system", "grant.used", `Grant ${grant.id} used: ${results.filter((r) => r.ok).length}/${results.length} actions done`, plan.trigger.bookingId, { grantId: grant.id, planId });
    return { plan: finalPlan, grant: usedGrant, results };
  }

  async execute(a: PlanAction, grant: Grant): Promise<{ detail: string; refs: Record<string, string> }> {
    if (!grant.allowedActions.includes(a.type) || !grant.bookingIds.includes(a.bookingId)) throw new Error("Outside grant scope");
    const b = this.get(a.bookingId);
    const g = { grantId: grant.id };
    switch (a.type) {
      case "void": {
        this.addLog("system", "paypal.call", `POST /v2/payments/authorizations/${b.paypalAuthorizationId}/void → 204`, b.id, { ...g, authorizationId: b.paypalAuthorizationId ?? "" });
        await this.moneyEvent("PAYMENT.AUTHORIZATION.VOIDED", b.id, "api", { authorizationId: b.paypalAuthorizationId ?? "" });
        return { detail: `Voided ${money(b.depositAmount)} hold`, refs: { authorizationId: b.paypalAuthorizationId ?? "" } };
      }
      case "capture": {
        const captureId = this.ppId("CAPTURE");
        this.addLog("system", "paypal.call", `POST /v2/payments/authorizations/${b.paypalAuthorizationId}/capture → 201 COMPLETED`, b.id, { ...g, captureId });
        await this.moneyEvent("PAYMENT.CAPTURE.COMPLETED", b.id, "api", { captureId }, { paypalCaptureId: captureId });
        return { detail: `Captured ${money(b.depositAmount)}`, refs: { captureId } };
      }
      case "refund": {
        const refundId = this.ppId("REFUND");
        this.addLog("system", "paypal.call", `POST /v2/payments/captures/${b.paypalCaptureId}/refund → 201`, b.id, { ...g, refundId });
        await this.moneyEvent("PAYMENT.CAPTURE.REFUNDED", b.id, "api", { refundId }, { paypalRefundId: refundId });
        return { detail: `Refunded ${money(a.amount)}`, refs: { refundId } };
      }
      case "send_invoice": {
        const invoiceId = b.paypalInvoiceId ?? this.ppId("INV");
        this.addLog("system", "paypal.call", `POST /v2/invoicing/invoices + /${invoiceId}/send → 202`, b.id, { ...g, invoiceId });
        this.put({ ...b, paypalInvoiceId: invoiceId, balanceState: "invoiced" });
        return { detail: `Invoice ${invoiceId} sent for ${money(b.balanceAmount)}`, refs: { invoiceId } };
      }
      case "send_reminder": {
        this.addLog("system", "paypal.call", `POST /v2/invoicing/invoices/${b.paypalInvoiceId}/remind → 202`, b.id, { ...g, invoiceId: b.paypalInvoiceId ?? "" });
        return { detail: "Reminder sent", refs: { invoiceId: b.paypalInvoiceId ?? "" } };
      }
      case "promote":
      case "move": {
        const startAt = String(a.params.startAt);
        const resourceId = String(a.params.resourceId);
        const c = this.conflicts({ id: b.id, resourceId, startAt, durationMin: b.durationMin });
        if (c.length) throw new Error(c[0]);
        const endAt = new Date(new Date(startAt).getTime() + b.durationMin * MIN).toISOString();
        this.put({ ...b, startAt, endAt, resourceId, waitlist: false });
        const vanName = this.resources.find((r) => r.id === resourceId)?.name ?? resourceId;
        this.addLog("system", a.type === "promote" ? "booking.promoted" : "booking.moved", `${b.customerName} ${a.type === "promote" ? "promoted from the waitlist" : "moved"} to ${formatTime(startAt, this.tz)} on ${vanName}`, b.id, g);
        return { detail: `${a.type === "promote" ? "Promoted" : "Moved"} to ${formatTime(startAt, this.tz)}`, refs: {} };
      }
      case "message": {
        const channel = String(a.params.channel ?? "email");
        this.addLog("agent", "message.sent", `${channel === "sms" ? "SMS" : "Email"} to ${b.customerName} (simulated)`, b.id, g);
        return { detail: `${channel} sent`, refs: {} };
      }
      case "flag_dispute": {
        this.addLog("system", "evidence.assembled", `Evidence pack ready for ${b.customerName}`, b.id, { ...g, disputeId: b.paypalDisputeId ?? "" });
        return { detail: "Evidence pack assembled", refs: { evidence: `/evidence/${b.id}` } };
      }
    }
  }

  // ---- booking flow ------------------------------------------------------

  createBooking(req: { customerName: string; customerEmail?: string; service: Service; startAt: string; resourceId?: string }): Booking {
    const durationMin = DEMO_DURATION[req.service];
    const van = req.resourceId && this.conflicts({ resourceId: req.resourceId, startAt: req.startAt, durationMin }).length === 0 ? req.resourceId : this.firstFeasibleVan(req.startAt, durationMin);
    const now = new Date().toISOString();
    const b: Booking = {
      id: `bk-${rid().slice(0, 6)}`,
      resourceId: van,
      waitlist: !van,
      customerName: req.customerName,
      customerEmail: req.customerEmail ?? null,
      service: req.service,
      startAt: req.startAt,
      endAt: new Date(new Date(req.startAt).getTime() + durationMin * MIN).toISOString(),
      durationMin,
      depositAmount: DEMO_PRICES[req.service].deposit,
      balanceAmount: DEMO_PRICES[req.service].balance,
      currency: "USD",
      state: "quoted",
      balanceState: "none",
      paypalOrderId: null,
      paypalAuthorizationId: null,
      paypalCaptureId: null,
      paypalRefundId: null,
      paypalInvoiceId: null,
      paypalDisputeId: null,
      notes: null,
      createdAt: now,
      updatedAt: now,
    };
    this.bookings.set(b.id, b);
    this.emit({ type: "booking.updated", booking: b });
    this.addLog("customer", "booking.created", `${b.customerName} booked ${SERVICE_META[b.service].label.toLowerCase()} for ${formatTime(b.startAt, this.tz)}${van ? "" : ": no van free, added to the waitlist"}`, b.id);
    return b;
  }

  async createOrder(id: string) {
    const b = this.get(id);
    const orderId = this.ppId("ORDER");
    await this.sleep(250);
    this.addLog("system", "paypal.call", `POST /v2/checkout/orders intent=AUTHORIZE ${money(b.depositAmount)} custom_id=${b.id} → 201`, b.id, { orderId });
    this.put({ ...b, paypalOrderId: orderId });
    return { orderId };
  }

  async authorize(id: string, orderId: string) {
    const b = this.get(id);
    if (b.paypalOrderId && b.paypalOrderId !== orderId) throw new ApiRequestError(400, { error: "Order does not belong to this booking", code: "order_mismatch" }, "Bad request");
    this.addLog("customer", "paypal.approved", `${b.customerName} approved the ${money(b.depositAmount)} hold in PayPal (simulated)`, b.id, { orderId });
    await this.moneyEvent("CHECKOUT.ORDER.APPROVED", b.id, "api", { orderId }, { paypalOrderId: orderId });
    await this.sleep(300);
    const authorizationId = this.ppId("AUTH");
    this.addLog("system", "paypal.call", `POST /v2/checkout/orders/${orderId}/authorize → 201`, b.id, { orderId, authorizationId });
    const booking = await this.moneyEvent("PAYMENT.AUTHORIZATION.CREATED", b.id, "api", { authorizationId }, { paypalAuthorizationId: authorizationId });
    return { booking, authorizationId };
  }

  async moneyAction(id: string, action: MoneyAction, mockResponse?: string, amount?: string): Promise<MoneyActionResponse> {
    const b = this.get(id);
    const dev = { devTools: "1" };
    this.addLog("operator", "dev.action", `Dev tools: ${action}${mockResponse ? ` with PayPal-Mock-Response ${mockResponse}` : ""} on ${b.customerName}`, b.id, dev);
    await this.sleep(250);
    switch (action) {
      case "capture": {
        if (!b.paypalAuthorizationId) throw new ApiRequestError(409, { error: "No authorization to capture", code: "no_authorization" }, "Conflict");
        if (mockResponse) {
          this.addLog("system", "paypal.call", `POST /v2/payments/authorizations/${b.paypalAuthorizationId}/capture → 422 ${mockResponse}`, b.id, { authorizationId: b.paypalAuthorizationId, mockResponse });
          const booking = await this.moneyEvent("PAYMENT.CAPTURE.DENIED", b.id, "api", { authorizationId: b.paypalAuthorizationId });
          return { booking, refs: { authorizationId: b.paypalAuthorizationId } };
        }
        const captureId = this.ppId("CAPTURE");
        this.addLog("system", "paypal.call", `POST /v2/payments/authorizations/${b.paypalAuthorizationId}/capture → 201 COMPLETED`, b.id, { captureId });
        const booking = await this.moneyEvent("PAYMENT.CAPTURE.COMPLETED", b.id, "api", { captureId }, { paypalCaptureId: captureId });
        return { booking, refs: { captureId } };
      }
      case "void": {
        this.addLog("system", "paypal.call", `POST /v2/payments/authorizations/${b.paypalAuthorizationId}/void → 204`, b.id, { authorizationId: b.paypalAuthorizationId ?? "" });
        const booking = await this.moneyEvent("PAYMENT.AUTHORIZATION.VOIDED", b.id, "api");
        return { booking, refs: {} };
      }
      case "refund": {
        const refundId = this.ppId("REFUND");
        this.addLog("system", "paypal.call", `POST /v2/payments/captures/${b.paypalCaptureId}/refund ${money(amount ?? b.depositAmount)} → 201`, b.id, { refundId });
        const booking = await this.moneyEvent("PAYMENT.CAPTURE.REFUNDED", b.id, "api", { refundId }, { paypalRefundId: refundId });
        return { booking, refs: { refundId } };
      }
      case "invoice": {
        const invoiceId = b.paypalInvoiceId ?? this.ppId("INV");
        this.addLog("system", "paypal.call", `POST /v2/invoicing/invoices + /send ${money(b.balanceAmount)} → 202`, b.id, { invoiceId });
        const booking = this.put({ ...b, paypalInvoiceId: invoiceId, balanceState: "invoiced" });
        return { booking, refs: { invoiceId } };
      }
      case "remind": {
        this.addLog("system", "paypal.call", `POST /v2/invoicing/invoices/${b.paypalInvoiceId}/remind → 202`, b.id, { invoiceId: b.paypalInvoiceId ?? "" });
        return { booking: b, refs: {} };
      }
    }
  }

  lastWebhook: { eventId: string; type: MoneyEventType; bookingId: string } | null = null;

  async inject(fixture: DevFixture, id: string): Promise<DevInjectResponse> {
    const b = this.get(id);
    const type = FIXTURE_EVENT[fixture];
    this.addLog("system", "dev.inject", `Injected fixture ${fixture} for ${b.customerName}`, b.id, { devTools: "1" });
    await this.sleep(200);
    const patch: Partial<Booking> = {};
    if (fixture === "dispute.created" && !b.paypalDisputeId) patch.paypalDisputeId = this.ppId("DISPUTE");
    if (fixture === "capture.refunded" && !b.paypalRefundId) patch.paypalRefundId = this.ppId("REFUND");
    if (fixture === "capture.pending" && !b.paypalCaptureId) patch.paypalCaptureId = this.ppId("CAPTURE");
    const before = b.state;
    const booking = await this.moneyEvent(type, b.id, "webhook", {}, patch);
    const eventId = this.log.find((l) => l.kind === "webhook.received" && l.bookingId === b.id)?.refs.eventId ?? "";
    this.lastWebhook = { eventId, type, bookingId: b.id };
    const illegal = !TRANSITIONS[type][before];
    return { eventId, outcome: illegal ? "illegal" : before === booking.state && type !== "INVOICING.INVOICE.PAID" ? "idempotent" : "applied", booking, plan: null };
  }

  async replay(): Promise<DevReplayResponse> {
    const last = this.lastWebhook ?? (() => {
      const l = this.log.find((e) => e.kind === "webhook.received" && e.refs.eventId);
      return l ? { eventId: l.refs.eventId, type: l.message.split(" ")[0] as MoneyEventType, bookingId: l.bookingId ?? "" } : null;
    })();
    if (!last) throw new ApiRequestError(404, { error: "No webhook recorded yet", code: "no_event" }, "Not found");
    await this.sleep(200);
    this.addLog("paypal", "webhook.replayed", `${last.type} replayed: event id ${last.eventId} already seen, ignored (200)`, last.bookingId || null, { eventId: last.eventId });
    return { eventId: last.eventId, outcome: "duplicate", httpStatus: 200 };
  }

  move(id: string, startAt: string, resourceId: string, durationMin?: number): MoveOutcome {
    const b = this.get(id);
    if (b.state === "disputed") return { ok: false, conflicts: ["Disputed jobs are frozen until the dispute closes"], booking: b, message: "Move refused" };
    // The server keeps service durations; the demo honours resizes to show the flow.
    const dur = durationMin && durationMin >= 15 ? durationMin : b.durationMin;
    const c = this.conflicts({ id, resourceId, startAt, durationMin: dur });
    if (c.length) {
      this.addLog("system", "booking.move_refused", `Move of ${b.customerName} refused: ${c[0]}`, b.id);
      return { ok: false, conflicts: c, booking: b, message: "Move refused" };
    }
    const endAt = new Date(new Date(startAt).getTime() + dur * MIN).toISOString();
    const saved = this.put({ ...b, startAt, endAt, durationMin: dur, resourceId, waitlist: false });
    const vanName = this.resources.find((r) => r.id === resourceId)?.name ?? resourceId;
    this.addLog("operator", "booking.moved", `Dana moved ${b.customerName} to ${formatRange(startAt, endAt, this.tz)} on ${vanName}`, b.id);
    return { ok: true, booking: saved };
  }

  evidence(id: string): EvidencePack {
    const b = this.get(id);
    const timeline = this.log.filter((l) => l.bookingId === id).slice().reverse();
    const amount = { currency_code: b.currency, value: b.depositAmount };
    return {
      booking: b,
      generatedAt: new Date().toISOString(),
      order: b.paypalOrderId ? { id: b.paypalOrderId, intent: "AUTHORIZE", status: "COMPLETED", purchase_units: [{ custom_id: b.id, invoice_id: `SLOT-${b.id}`, amount, description: SERVICE_META[b.service].label }] } : null,
      authorization: b.paypalAuthorizationId ? { id: b.paypalAuthorizationId, status: b.paypalCaptureId ? "CAPTURED" : "CREATED", amount } : null,
      capture: b.paypalCaptureId ? { id: b.paypalCaptureId, status: b.state === "refunded" ? "REFUNDED" : "COMPLETED", amount, final_capture: true } : null,
      refund: b.paypalRefundId ? { id: b.paypalRefundId, status: "COMPLETED", amount } : null,
      invoice: b.paypalInvoiceId ? { id: b.paypalInvoiceId, status: b.balanceState === "paid" ? "PAID" : "SENT", amount: { currency_code: b.currency, value: b.balanceAmount } } : null,
      dispute: b.paypalDisputeId ? { dispute_id: b.paypalDisputeId, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "OPEN", dispute_amount: amount } : null,
      timeline,
    };
  }
}

function clone<T>(v: T): T {
  return typeof structuredClone === "function" ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T);
}

async function applyScene(sim: DemoSim, scene: string | undefined) {
  if (!scene) return;
  sim.instant = true;
  try {
    if (scene === "declined" || scene === "reflowed") {
      await sim.moneyAction("bk-ahmed", "capture", "INSTRUMENT_DECLINED");
      await sim.maybePlanSettled();
      if (scene === "reflowed") {
        const plan = [...sim.plans.values()].find((p) => p.status === "proposed");
        if (plan) await sim.approve(plan.id, plan.options[0].id);
      }
    } else if (scene === "dispute") {
      await sim.inject("dispute.created", "bk-priya");
      await sim.maybePlanSettled();
    } else if (scene === "refund") {
      await sim.inject("capture.refunded", "bk-sofia");
      await sim.maybePlanSettled();
    }
  } finally {
    sim.instant = false;
  }
}

export async function createDemoBackend(scene?: string): Promise<SlotlineBackend> {
  const sim = new DemoSim();
  await applyScene(sim, scene);

  const backend: SlotlineBackend = {
    kind: "demo",
    state: async () => sim.snapshot(),
    publicConfig: async () => ({ paypalClientId: null, currency: "USD", mode: { paypal: "mock", llm: "rules", devTools: true }, timeZone: sim.tz }),
    subscribe(handlers) {
      const l: Listener = (e) => handlers.onEvent(e);
      sim.listeners.add(l);
      handlers.onStatus("demo");
      queueMicrotask(() => handlers.onOpen());
      return () => {
        sim.listeners.delete(l);
      };
    },
    createBooking: async (req) => {
      await sim.sleep(300);
      return { booking: sim.createBooking(req) };
    },
    createOrder: (id) => sim.createOrder(id),
    authorize: (id, req) => sim.authorize(id, req.orderId),
    moneyAction: (id, action, req) => sim.moneyAction(id, action, req.mockResponse, req.amount),
    moveBooking: async (id, req) => {
      await sim.sleep(350);
      return sim.move(id, req.startAt, req.resourceId, req.durationMin);
    },
    evidence: async (id) => sim.evidence(id),
    approvePlan: (id, req) => sim.approve(id, req.optionId),
    rejectPlan: async (id) => {
      const plan = sim.plans.get(id);
      if (!plan) return null;
      const next: Plan = { ...plan, status: "rejected" };
      sim.putPlan(next);
      sim.addLog("operator", "plan.rejected", "Dana rejected the proposal", plan.trigger.bookingId, { planId: id });
      return next;
    },
    proposePlan: async (req) => {
      if (!req.bookingId) return null;
      sim.addLog("operator", "plan.requested", "Dana asked the agent for options", req.bookingId);
      return sim.maybePlan("manual", sim.get(req.bookingId), null);
    },
    devSeed: async () => {
      sim.reset();
      sim.addLog("system", "seed", "Demo day reset to the seed", null, { devTools: "1" });
      return { ok: true };
    },
    devInject: (_secret, req) => sim.inject(req.fixture, req.bookingId),
    devReplay: () => sim.replay(),
    booking: async (id) => sim.bookings.get(id) ?? null,
    availability: async (day, service) => sim.availability(day, service),
  };
  return backend;
}
