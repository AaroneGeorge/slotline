"use client";

import { useMemo, useState } from "react";
import type { Actor, Booking, LogEntry } from "@/shared/types";
import { ACTOR_META, ACTORS } from "@/lib/client/format";
import { formatClock } from "@/lib/client/time";
import { RefChips } from "@/components/ui/RefChip";

const ACTOR_CLS: Record<Actor, { dot: string; text: string; bar: string }> = {
  customer: { dot: "bg-ac-customer", text: "text-ac-customer", bar: "border-l-ac-customer" },
  operator: { dot: "bg-ac-operator", text: "text-ac-operator", bar: "border-l-ac-operator" },
  agent: { dot: "bg-ac-agent", text: "text-ac-agent", bar: "border-l-ac-agent" },
  system: { dot: "bg-ac-system", text: "text-ac-system", bar: "border-l-ac-system" },
  paypal: { dot: "bg-ac-paypal", text: "text-ac-paypal", bar: "border-l-ac-paypal" },
};

export function LogPanel({
  log,
  bookings,
  tz,
  bookingFilter,
  onClearFilter,
  onPickBooking,
}: {
  log: LogEntry[];
  bookings: Record<string, Booking>;
  tz: string;
  bookingFilter: string | null;
  onClearFilter: () => void;
  onPickBooking: (id: string) => void;
}) {
  const [hidden, setHidden] = useState<Set<Actor>>(new Set());
  const counts = useMemo(() => {
    const c: Record<Actor, number> = { customer: 0, operator: 0, agent: 0, system: 0, paypal: 0 };
    for (const e of log) if (!bookingFilter || e.bookingId === bookingFilter) c[e.actor] = (c[e.actor] ?? 0) + 1;
    return c;
  }, [log, bookingFilter]);
  const rows = log.filter((e) => !hidden.has(e.actor) && (!bookingFilter || e.bookingId === bookingFilter));
  const toggle = (a: Actor) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(a)) n.delete(a);
      else n.add(a);
      return n;
    });

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {ACTORS.map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => toggle(a)}
            title={ACTOR_META[a].hint}
            aria-pressed={!hidden.has(a)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[2px] text-[11px] font-semibold transition-opacity ${
              hidden.has(a) ? "border-line bg-surface text-ink-3 opacity-50" : `border-line bg-surface ${ACTOR_CLS[a].text}`
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${ACTOR_CLS[a].dot}`} />
            {ACTOR_META[a].label}
            <span className="font-mono font-normal text-ink-3">{counts[a]}</span>
          </button>
        ))}
        {bookingFilter && (
          <button
            type="button"
            onClick={onClearFilter}
            className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-[2px] text-[11px] font-semibold text-white"
          >
            {bookings[bookingFilter]?.customerName ?? bookingFilter} <span aria-hidden>×</span>
          </button>
        )}
      </div>
      <ol className="flex flex-col">
        {rows.length === 0 && <li className="py-6 text-center text-[12px] text-ink-3">Nothing logged for this filter yet.</li>}
        {rows.map((e) => {
          const b = e.bookingId ? bookings[e.bookingId] : null;
          return (
            <li key={e.id} className={`sl-rise border-l-2 py-1.5 pl-2.5 pr-1 ${ACTOR_CLS[e.actor].bar} border-b border-b-line/70`}>
              <div className="flex items-baseline gap-2 text-[11px]">
                <span className="font-mono text-ink-3">{formatClock(e.at, tz)}</span>
                <span className={`font-semibold ${ACTOR_CLS[e.actor].text}`}>{e.actor}</span>
                <span className="truncate font-mono text-[10.5px] text-ink-3">{e.kind}</span>
                {b && (
                  <button
                    type="button"
                    onClick={() => onPickBooking(b.id)}
                    className="ml-auto flex-none truncate text-[11px] text-ink-2 underline decoration-line-2 underline-offset-2 hover:text-ink"
                  >
                    {b.customerName}
                  </button>
                )}
              </div>
              <div className="mt-0.5 text-[12px] leading-snug text-ink">{e.message}</div>
              {Object.keys(e.refs).length > 0 && (
                <div className="mt-1">
                  <RefChips refs={e.refs} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
