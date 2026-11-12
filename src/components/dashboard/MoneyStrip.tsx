import type { Booking } from "@/shared/types";
import { money, STATE_META, STATE_ORDER, sumAmounts } from "@/lib/client/format";

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-stretch gap-2.5 px-3 py-2">
      <span className={`w-[3px] flex-none rounded-full ${tone}`} aria-hidden />
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</div>
        <div className="font-mono text-[18px] font-semibold leading-6 text-ink">{value}</div>
        <div className="truncate text-[11px] text-ink-3">{sub}</div>
      </div>
    </div>
  );
}

/** What the money is doing today. Deposits only; balances are separate. */
export function MoneyStrip({ bookings }: { bookings: Booking[] }) {
  const by = (states: Booking["state"][]) => bookings.filter((b) => states.includes(b.state) && !b.waitlist);
  const held = by(["held", "pending"]);
  const captured = by(["confirmed"]);
  const atRisk = by(["declined", "disputed"]);
  const invoiced = bookings.filter((b) => b.balanceState === "invoiced");
  const paid = bookings.filter((b) => b.balanceState === "paid");
  const waiting = bookings.filter((b) => b.waitlist);
  const unpaid = by(["quoted", "approved"]);
  const n = (list: Booking[], word = "job") => `${list.length} ${word}${list.length === 1 ? "" : "s"}`;
  return (
    <div className="flex flex-none divide-x divide-line rounded-lg border border-line bg-surface">
      <Tile label="Authorized holds" value={money(sumAmounts(held.map((b) => b.depositAmount)))} sub={`${n(held)} · capture before the visit`} tone="bg-st-held" />
      <Tile label="Captured" value={money(sumAmounts(captured.map((b) => b.depositAmount)))} sub={`${n(captured)} confirmed`} tone="bg-st-confirmed" />
      <Tile label="At risk" value={money(sumAmounts(atRisk.map((b) => b.depositAmount)))} sub={atRisk.length ? `${atRisk.map((b) => b.customerName.split(" ")[0]).join(", ")}` : "nothing declined or disputed"} tone="bg-st-declined" />
      <Tile label="Balances invoiced" value={money(sumAmounts(invoiced.map((b) => b.balanceAmount)))} sub={`${n(invoiced, "invoice")} open · ${paid.length} paid`} tone="bg-paypal" />
      <Tile label="No deposit yet" value={String(unpaid.length + waiting.length)} sub={`${unpaid.length} on the board · ${waiting.length} waitlist`} tone="bg-st-quoted" />
    </div>
  );
}

export function Legend() {
  const states = STATE_ORDER.filter((s) => STATE_META[s].onTimeline);
  return (
    <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-ink-2">
      {states.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5" title={STATE_META[s].money}>
          <span className={`sl-swatch sl-swatch-${s}`} aria-hidden />
          {STATE_META[s].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5 text-ink-3" title="Released and refunded jobs leave the timeline">
        <span className="sl-swatch sl-swatch-released" aria-hidden />
        Released / refunded leave the board
      </span>
      <span className="ml-auto text-ink-3">Drag to move · drag the end to resize · right-click for the agent</span>
    </div>
  );
}
