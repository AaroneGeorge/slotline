"use client";

import type { Booking, Resource } from "@/shared/types";
import { BALANCE_LABEL, money, paypalRefs, SERVICE_META } from "@/lib/client/format";
import { formatRange } from "@/lib/client/time";
import { RefChip } from "@/components/ui/RefChip";
import { StatePill } from "@/components/ui/StatePill";

export function BookingInspector({
  booking,
  resources,
  tz,
  onClose,
  onAsk,
  onLog,
  onEvidence,
}: {
  booking: Booking;
  resources: Resource[];
  tz: string;
  onClose: () => void;
  onAsk: () => void;
  onLog: () => void;
  onEvidence: () => void;
}) {
  const van = resources.find((r) => r.id === booking.resourceId)?.name ?? "Waitlist";
  const refs = paypalRefs(booking);
  return (
    <div className="sl-rise flex-none rounded-lg border border-line bg-surface p-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-ink">{booking.customerName}</span>
            <StatePill state={booking.state} />
          </div>
          <div className="mt-0.5 text-[12px] text-ink-2">
            {SERVICE_META[booking.service].label} · <span className="font-mono">{formatRange(booking.startAt, booking.endAt, tz)}</span> · {van}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-3">
            deposit <span className="font-mono text-ink-2">{money(booking.depositAmount, booking.currency)}</span> · balance{" "}
            <span className="font-mono text-ink-2">{money(booking.balanceAmount, booking.currency)}</span> {BALANCE_LABEL[booking.balanceState]}
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded px-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Close">
          ×
        </button>
      </div>
      {refs.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {refs.map((r) => (
            <RefChip key={r.key} name={r.key} value={r.value} tone="paypal" />
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" onClick={onAsk} className="rounded-md border border-ac-agent/30 bg-ac-agent/[0.06] px-2 py-1 text-[11.5px] font-semibold text-ac-agent hover:bg-ac-agent/[0.12]">
          Ask the agent
        </button>
        <button type="button" onClick={onLog} className="rounded-md border border-line-2 bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink-2 hover:bg-surface-3">
          Log for this job
        </button>
        {booking.state === "disputed" && (
          <button type="button" onClick={onEvidence} className="rounded-md border border-st-disputed/30 bg-st-disputed/[0.06] px-2 py-1 text-[11.5px] font-semibold text-st-disputed hover:bg-st-disputed/[0.12]">
            Evidence pack
          </button>
        )}
      </div>
    </div>
  );
}
