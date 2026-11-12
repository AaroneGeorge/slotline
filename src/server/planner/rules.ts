/**
 * Deterministic planner (LLM_PROVIDER=rules, and the fallback when an LLM
 * provider fails or times out). Produces the same RawPlan shape as the LLMs.
 */
import type { Booking } from "@/shared/types";
import { promoteCandidates, repack } from "../solver";
import { localHhmm } from "../time";
import type { PlanContext } from "./context";
import { solverOpts } from "./context";
import { rawAction, type RawAction, type RawOption, type RawPlan } from "./schema";

export interface Planner {
  readonly name: "anthropic" | "gemini" | "groq" | "rules";
  propose(ctx: PlanContext): Promise<RawPlan>;
}

function first(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function bookingLink(ctx: PlanContext, b: Booking): string {
  return `${ctx.appBaseUrl}/book?booking=${encodeURIComponent(b.id)}`;
}

function vanName(ctx: PlanContext, id: string | null): string {
  return ctx.resources.find((r) => r.id === id)?.name ?? id ?? "the van";
}

function msg(b: Booking, subject: string, body: string): { action: RawAction; draft: RawPlan["draftMessages"][number] } {
  return {
    action: rawAction("message", b.id, { channel: "email", subject, body }),
    draft: { bookingId: b.id, channel: "email", subject, body },
  };
}

/** Open-balance follow-up for another job today (cash-flow nudge when a deposit fails). */
function balanceFollowUp(ctx: PlanContext, exclude: string): RawAction | null {
  const open = ctx.bookings.find((b) => b.id !== exclude && b.balanceState === "invoiced" && b.paypalInvoiceId && ["held", "pending", "confirmed"].includes(b.state));
  if (open) return rawAction("send_reminder", open.id);
  const uninvoiced = ctx.bookings.find((b) => b.id !== exclude && b.balanceState === "none" && Number(b.balanceAmount) > 0 && ["held", "pending", "confirmed"].includes(b.state));
  return uninvoiced ? rawAction("send_invoice", uninvoiced.id) : null;
}

function waitlist(ctx: PlanContext): Booking[] {
  return ctx.bookings.filter((b) => b.state === "quoted" && (b.waitlist || b.resourceId === null));
}

function freedSlotOptions(ctx: PlanContext, x: Booking, reasonText: string): { options: RawOption[]; drafts: RawPlan["draftMessages"] } {
  const opts = solverOpts(ctx);
  const t = localHhmm(x.startAt, ctx.tz);
  const options: RawOption[] = [];
  const drafts: RawPlan["draftMessages"] = [];
  const others = ctx.bookings.map((b) => (b.id === x.id ? { ...b, state: "released" as const } : b));
  const freed = x.resourceId ? { resourceId: x.resourceId, startAt: x.startAt, endAt: x.endAt } : null;
  const cands = freed ? promoteCandidates(waitlist(ctx), freed, others, opts) : [];
  const xMsg = msg(x, `Your ${t} Slotline booking`, `Hi ${first(x.customerName)}, ${reasonText} If you'd like a new time, reply to this email or book again at ${ctx.appBaseUrl}/book.`);
  if (cands.length && freed) {
    const w = cands[0].booking;
    const wMsg = msg(w, `A ${t} slot just opened up`, `Hi ${first(w.customerName)}, good news: a ${w.service} slot opened at ${t} today on ${vanName(ctx, freed.resourceId)}. Pay the deposit to lock it in: ${bookingLink(ctx, w)}`);
    options.push({
      title: `Offer the freed ${t} slot to ${first(w.customerName)}`,
      rationale: `${first(w.customerName)} is first on the waitlist and the ${w.service} job fits the ${t} gap without moving anyone else. The slot is only firm once ${first(w.customerName)} pays the deposit.`,
      actions: [rawAction("promote", w.id, { startAt: freed.startAt, resourceId: freed.resourceId }), wMsg.action, xMsg.action],
    });
    drafts.push(wMsg.draft);
  }
  if (x.resourceId) {
    const moves = repack(others, x.resourceId, opts);
    if (moves.length) {
      options.push({
        title: `Close the gap on ${vanName(ctx, x.resourceId)}`,
        rationale: `Pull ${moves.length} unpaid job${moves.length > 1 ? "s" : ""} earlier (at most 2 h) so the van finishes sooner; no paid or confirmed job moves.`,
        actions: [...moves.map((m) => rawAction("move", m.bookingId, { startAt: m.toStartAt, resourceId: m.resourceId })), xMsg.action],
      });
    }
  }
  options.push({
    title: `Leave the ${t} slot open`,
    rationale: "Nothing on the waitlist fits; keep the slot free for walk-ins and tell the customer.",
    actions: [xMsg.action],
  });
  drafts.push(xMsg.draft);
  return { options, drafts };
}

export function rulesPlan(ctx: PlanContext): RawPlan {
  const x = ctx.trigger.booking;
  if (!x) return { summary: "No booking selected; nothing to plan.", options: [], draftMessages: [] };
  const t = localHhmm(x.startAt, ctx.tz);
  const opts = solverOpts(ctx);

  switch (x.state) {
    case "declined": {
      const options: RawOption[] = [];
      const drafts: RawPlan["draftMessages"] = [];
      const others = ctx.bookings.map((b) => (b.id === x.id ? { ...b, state: "released" as const } : b));
      const freed = x.resourceId ? { resourceId: x.resourceId, startAt: x.startAt, endAt: x.endAt } : null;
      const cands = freed ? promoteCandidates(waitlist(ctx), freed, others, opts) : [];
      const xRelease = msg(x, `Your ${t} booking: payment declined`, `Hi ${first(x.customerName)}, PayPal declined the deposit for your ${t} ${x.service} repair, so we've released the hold on your account and freed the slot. Rebook any time at ${ctx.appBaseUrl}/book.`);
      const xRetry = msg(x, `Your ${t} booking: please update your payment`, `Hi ${first(x.customerName)}, PayPal declined the deposit for your ${t} ${x.service} repair. Please check your PayPal funding source; we're keeping your slot and will retry the deposit shortly.`);
      if (cands.length && freed) {
        const w = cands[0].booking;
        const wMsg = msg(w, `A ${t} slot just opened up`, `Hi ${first(w.customerName)}, a ${w.service} slot opened at ${t} today on ${vanName(ctx, freed.resourceId)}. Pay the deposit to lock it in: ${bookingLink(ctx, w)}`);
        const follow = balanceFollowUp(ctx, x.id);
        options.push({
          title: `Give ${first(x.customerName)}'s ${t} slot to ${first(w.customerName)}`,
          rationale: `The deposit was declined, so the slot is at risk. ${first(w.customerName)} is first on the waitlist and fits the ${t} slot. Void ${first(x.customerName)}'s hold so no money stays locked${follow ? ", and chase today's open balance to protect cash flow" : ""}.`,
          actions: [rawAction("void", x.id), rawAction("promote", w.id, { startAt: freed.startAt, resourceId: freed.resourceId }), ...(follow ? [follow] : []), wMsg.action, xRelease.action],
        });
        drafts.push(wMsg.draft);
      }
      options.push({
        title: `Keep ${first(x.customerName)}'s slot and retry the deposit`,
        rationale: `Declines are often temporary. Ask ${first(x.customerName)} to fix the funding source and retry the capture; the slot stays amber until it succeeds.`,
        actions: [xRetry.action, rawAction("capture", x.id)],
      });
      if (!cands.length) {
        options.push({
          title: `Release ${first(x.customerName)}'s slot`,
          rationale: "Nobody on the waitlist fits, but voiding the hold frees the van for walk-ins and releases the customer's funds.",
          actions: [rawAction("void", x.id), xRelease.action],
        });
      }
      drafts.push(xRetry.draft, xRelease.draft);
      return { summary: `${x.customerName}'s ${t} deposit capture was declined by PayPal; the slot is at risk.`, options, draftMessages: drafts };
    }
    case "refunded":
    case "released": {
      const what = x.state === "refunded" ? "your deposit has been refunded through PayPal" : "the hold on your PayPal account has been released";
      const { options, drafts } = freedSlotOptions(ctx, x, `${what} and your ${t} slot is cancelled.`);
      return { summary: `${x.customerName}'s ${t} slot is free (${x.state === "refunded" ? "deposit refunded" : "authorization voided"}).`, options, draftMessages: drafts };
    }
    case "disputed": {
      const ack = msg(x, `About your PayPal dispute`, `Hi ${first(x.customerName)}, we've seen the dispute you opened about your ${t} ${x.service} repair. We've attached the job record to the case; reply here if there's anything we can fix directly.`);
      const refundMsg = msg(x, `Your refund is on its way`, `Hi ${first(x.customerName)}, we've refunded your deposit for the ${t} ${x.service} repair through PayPal. Sorry it didn't work out.`);
      return {
        summary: `${x.customerName} opened a PayPal dispute on the ${t} job.`,
        options: [
          {
            title: `Contest with the job record`,
            rationale: "The work was booked and paid through PayPal; assemble the evidence pack (order, authorization, capture, invoice, timeline) for the dispute.",
            actions: [rawAction("flag_dispute", x.id), ack.action],
          },
          {
            title: `Refund ${first(x.customerName)} and close it out`,
            rationale: "If the job really went wrong, a refund resolves the dispute fastest and frees the slot.",
            actions: [rawAction("refund", x.id), refundMsg.action],
          },
        ],
        draftMessages: [ack.draft, refundMsg.draft],
      };
    }
    default:
      return { summary: `${x.customerName}'s booking is ${x.state}; no reflow needed.`, options: [], draftMessages: [] };
  }
}

export const rulesPlanner: Planner = {
  name: "rules",
  async propose(ctx) {
    return rulesPlan(ctx);
  },
};
