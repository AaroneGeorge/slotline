import type { BookingState } from "@/shared/types";
import { STATE_META } from "@/lib/client/format";

const TEXT: Record<BookingState, string> = {
  quoted: "text-ink-2",
  approved: "text-st-approved",
  held: "text-st-held",
  pending: "text-[#8a6d00]",
  confirmed: "text-st-confirmed",
  declined: "text-[#a65c00]",
  released: "text-ink-3",
  refunded: "text-st-refunded",
  disputed: "text-st-disputed",
};

export function StatePill({ state, compact = false }: { state: BookingState; compact?: boolean }) {
  const meta = STATE_META[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-semibold ${TEXT[state]}`}
      title={meta.money}
    >
      <span className={`sl-swatch sl-swatch-${state}`} aria-hidden />
      {compact ? meta.short : meta.label}
    </span>
  );
}
