import Link from "next/link";
import type { AppMode } from "@/shared/types";
import type { ConnStatus } from "@/lib/client/stream";
import { formatDayLabel, zoneLabel } from "@/lib/client/time";
import { Logo } from "@/components/ui/Logo";

const CONN: Record<ConnStatus, { label: string; dot: string; hint: string }> = {
  connecting: { label: "Connecting", dot: "bg-ink-3 sl-pulse-dot", hint: "Opening GET /api/stream" },
  live: { label: "Live", dot: "bg-[#3ccf84] sl-pulse-dot", hint: "Server-sent events from GET /api/stream" },
  reconnecting: { label: "Reconnecting", dot: "bg-st-declined sl-pulse-dot", hint: "Stream dropped; retrying with backoff and polling /api/state" },
  demo: { label: "Demo data", dot: "bg-st-approved", hint: "?demo=1: in-browser simulation, no server, no PayPal calls" },
  unauthorized: { label: "Sign in", dot: "bg-st-disputed", hint: "The stream was refused (401): sign in again" },
};

function ModeBadge({ k, v, tone }: { k: string; v: string; tone: "paypal" | "agent" | "plain" }) {
  const toneCls =
    tone === "paypal"
      ? "border-paypal/30 text-paypal"
      : tone === "agent"
        ? "border-ac-agent/30 text-ac-agent"
        : "border-white/20 text-white/80";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border bg-white px-2 py-[3px] font-mono text-[11px] ${toneCls}`}>
      <span className="text-ink-3">{k}:</span>
      <span className="font-semibold">{v}</span>
    </span>
  );
}

export function Header({
  mode,
  day,
  timeZone,
  conn,
  bookHref,
  onSignOut,
}: {
  mode: AppMode | null;
  day: string | null;
  timeZone: string;
  conn: ConnStatus;
  bookHref: string;
  /** shown when operator sign-in is on (OPERATOR_PASSWORD set) */
  onSignOut?: () => void;
}) {
  const c = CONN[conn];
  return (
    <header className="flex h-[52px] flex-none items-center gap-4 border-b border-black/20 bg-accent px-4 text-white">
      <div className="flex items-center gap-2.5">
        <Logo size={24} />
        <span className="text-[16px] font-semibold tracking-tight">Slotline</span>
      </div>
      <div className="h-5 w-px bg-white/20" />
      <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
        <span className="font-medium">Dana&apos;s day</span>
        {day && <span className="font-mono text-white/80">{formatDayLabel(day)}</span>}
        <span className="truncate text-[11px] text-white/55">{zoneLabel(timeZone)}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {mode && (
          <>
            <ModeBadge k="PayPal" v={mode.paypal} tone="paypal" />
            <ModeBadge k="Planner" v={mode.llm} tone="agent" />
          </>
        )}
        <span
          className="inline-flex items-center gap-1.5 rounded-md border border-white/15 px-2 py-[3px] text-[11px] text-white/85"
          title={c.hint}
        >
          <span className={`h-2 w-2 rounded-full ${c.dot}`} />
          {c.label}
        </span>
        <Link
          href={bookHref}
          className="ml-1 inline-flex items-center gap-1 rounded-md bg-white px-2.5 py-[5px] text-[12px] font-semibold text-accent hover:bg-white/90"
        >
          Customer booking page <span aria-hidden>↗</span>
        </Link>
        {onSignOut && (
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex items-center rounded-md border border-white/25 px-2.5 py-[4px] text-[12px] font-semibold text-white/90 hover:bg-white/10"
          >
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
