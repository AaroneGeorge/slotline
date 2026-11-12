"use client";

import type { Booking } from "@/shared/types";
import { money, SERVICE_META } from "@/lib/client/format";
import { formatRange, relativeAgo } from "@/lib/client/time";
import { StatePill } from "@/components/ui/StatePill";

function Row({
  b,
  tz,
  onLink,
  onAsk,
}: {
  b: Booking;
  tz: string;
  onLink: (b: Booking) => void;
  onAsk: (b: Booking) => void;
}) {
  return (
    <li className="rounded-md border border-line bg-surface p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">{b.customerName}</div>
          <div className="text-[12px] text-ink-2">
            {SERVICE_META[b.service].label} · {b.waitlist ? "wants " : ""}
            <span className="font-mono">{formatRange(b.startAt, b.endAt, tz)}</span>
          </div>
        </div>
        <StatePill state={b.state} compact />
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-ink-3">
        <span>
          deposit <span className="font-mono text-ink-2">{money(b.depositAmount, b.currency)}</span>
        </span>
        <span>·</span>
        <span>asked {relativeAgo(b.createdAt)}</span>
        {b.notes && <span className="truncate">· {b.notes}</span>}
      </div>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => onLink(b)}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-accent-2"
        >
          Send booking link
        </button>
        <button
          type="button"
          onClick={() => onAsk(b)}
          className="rounded-md border border-line-2 bg-surface px-2.5 py-1 text-[12px] font-semibold text-ink-2 hover:bg-surface-3"
        >
          Ask the agent
        </button>
      </div>
    </li>
  );
}

export function WaitlistPanel({
  bookings,
  tz,
  onLink,
  onAsk,
}: {
  bookings: Booking[];
  tz: string;
  onLink: (b: Booking) => void;
  onAsk: (b: Booking) => void;
}) {
  const waiting = bookings.filter((b) => b.waitlist && !["released", "refunded"].includes(b.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const unpaid = bookings
    .filter((b) => !b.waitlist && b.resourceId && (b.state === "quoted" || b.state === "approved"))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  return (
    <div className="flex flex-col gap-3">
      <section>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          Waitlist · {waiting.length}
        </h3>
        {waiting.length === 0 ? (
          <p className="text-[12px] text-ink-3">Nobody is waiting.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {waiting.map((b) => (
              <Row key={b.id} b={b} tz={tz} onLink={onLink} onAsk={onAsk} />
            ))}
          </ol>
        )}
      </section>
      <section>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          On the board, no deposit yet · {unpaid.length}
        </h3>
        {unpaid.length === 0 ? (
          <p className="text-[12px] text-ink-3">Every job on the board has money behind it.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {unpaid.map((b) => (
              <Row key={b.id} b={b} tz={tz} onLink={onLink} onAsk={onAsk} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
