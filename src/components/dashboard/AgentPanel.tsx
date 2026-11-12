"use client";

import { useEffect, useState } from "react";
import type { ApprovePlanResponse, Booking, Grant, Plan, PlanAction, PlanOption } from "@/shared/types";
import { ACTION_META, firstName, money, sumAmounts } from "@/lib/client/format";
import { countdown, formatTime, relativeAgo } from "@/lib/client/time";
import { RefChips } from "@/components/ui/RefChip";

const STATUS_STYLE: Record<Plan["status"], string> = {
  proposed: "bg-ac-agent text-white",
  approved: "bg-st-approved text-white",
  executed: "bg-st-held text-white",
  failed: "bg-st-disputed text-white",
  rejected: "bg-surface-3 text-ink-2",
  expired: "bg-surface-3 text-ink-3",
};

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function actionTarget(a: PlanAction, bookings: Record<string, Booking>, tz: string): string {
  const b = bookings[a.bookingId];
  const who = b ? firstName(b.customerName) : a.bookingId;
  if ((a.type === "move" || a.type === "promote") && typeof a.params.startAt === "string") {
    return `${who} → ${formatTime(a.params.startAt, tz)}`;
  }
  if (a.type === "message") return `${who} · ${String(a.params.channel ?? "email")}`;
  return who;
}

function ActionChip({ a, bookings, tz }: { a: PlanAction; bookings: Record<string, Booking>; tz: string }) {
  const meta = ACTION_META[a.type];
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-[2px] text-[11px] leading-4 ${
        a.feasible
          ? meta.money
            ? "border-paypal/30 bg-paypal/[0.06] text-ink"
            : "border-line bg-surface text-ink"
          : "border-st-disputed/30 bg-st-disputed/[0.05] text-ink-3 line-through decoration-st-disputed/50"
      }`}
      title={a.feasible ? `${meta.label}: feasible (checked by the solver)` : `Infeasible: ${a.infeasibleReason ?? "rejected by the solver"}`}
    >
      <span className={a.feasible ? "text-st-held" : "text-st-disputed"} aria-label={a.feasible ? "feasible" : "infeasible"}>
        {a.feasible ? "✓" : "✕"}
      </span>
      <span className="font-semibold">{meta.label}</span>
      <span className="truncate text-ink-2">{actionTarget(a, bookings, tz)}</span>
      {a.amount && Number(a.amount) > 0 && (
        <span className="font-mono text-[10.5px] text-paypal">{money(a.amount, a.currency ?? "USD")}</span>
      )}
    </span>
  );
}

function OptionBlock({
  option,
  letter,
  plan,
  bookings,
  tz,
  busy,
  onApprove,
}: {
  option: PlanOption;
  letter: string;
  plan: Plan;
  bookings: Record<string, Booking>;
  tz: string;
  busy: string | null;
  onApprove: (optionId: string) => void;
}) {
  const feasible = option.actions.filter((a) => a.feasible);
  const moneyActions = feasible.filter((a) => ACTION_META[a.type].money && a.amount);
  const cap = sumAmounts(moneyActions.map((a) => a.amount));
  const allowed = [...new Set(feasible.map((a) => a.type))];
  const chosen = plan.chosenOptionId === option.id;
  const open = plan.status === "proposed";
  const infeasible = option.actions.filter((a) => !a.feasible);
  return (
    <div
      className={`rounded-md border p-2.5 ${
        chosen ? "border-st-held/50 bg-st-held/[0.04]" : "border-line bg-surface"
      } ${!open && !chosen ? "opacity-60" : ""}`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded bg-surface-3 font-mono text-[11px] font-semibold text-ink-2">
          {letter}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-snug text-ink">{option.title}</div>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{option.rationale}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {option.actions.map((a) => (
          <ActionChip key={a.id} a={a} bookings={bookings} tz={tz} />
        ))}
      </div>
      {infeasible.length > 0 && (
        <div className="mt-1.5 text-[11px] leading-snug text-st-disputed">
          {infeasible.map((a) => (
            <div key={a.id}>
              {ACTION_META[a.type].label} skipped: {a.infeasibleReason ?? "infeasible"}
            </div>
          ))}
        </div>
      )}
      {open && (
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-dashed border-line pt-2">
          <div className="min-w-0 text-[11px] leading-snug text-ink-3">
            Grant: <span className="font-mono text-ink-2">{allowed.join(", ") || "none"}</span>
            <br />
            max <span className="font-mono text-paypal">{money(cap)}</span> · 15 min · {feasible.length}/{option.actions.length} actions
          </div>
          <button
            type="button"
            disabled={busy !== null || feasible.length === 0}
            onClick={() => onApprove(option.id)}
            className="flex-none rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-accent-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === option.id ? "Executing…" : `Approve ${letter}`}
          </button>
        </div>
      )}
    </div>
  );
}

function GrantLine({ grant, now, tz }: { grant: Grant; now: number; tz: string }) {
  const left = countdown(grant.expiresAt, now);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink-2">
      <span className="font-semibold text-ink">Grant</span>
      <span className="font-mono text-ink">{grant.id}</span>
      <span className={`rounded px-1.5 py-[1px] font-semibold ${grant.status === "active" ? "bg-st-held/15 text-st-held" : "bg-surface-3 text-ink-2"}`}>
        {grant.status}
      </span>
      <span>
        {grant.allowedActions.join(", ")} · max <span className="font-mono text-paypal">{money(grant.maxAmount, grant.currency)}</span>
      </span>
      <span className="ml-auto font-mono" title={`Expires ${grant.expiresAt}`}>
        {grant.status === "active"
          ? `expires in ${left}`
          : grant.usedAt
            ? `used ${formatTime(grant.usedAt, tz)} · window to ${formatTime(grant.expiresAt, tz)}`
            : `window to ${formatTime(grant.expiresAt, tz)}`}
      </span>
    </div>
  );
}

function Results({ response, plan }: { response: ApprovePlanResponse; plan: Plan }) {
  const actions = new Map(plan.options.flatMap((o) => o.actions).map((a) => [a.id, a]));
  return (
    <ul className="flex flex-col gap-1">
      {response.results.map((r) => {
        const a = actions.get(r.actionId);
        return (
          <li key={r.actionId} className="flex flex-col gap-0.5 text-[12px]">
            <div className="flex items-baseline gap-1.5">
              <span className={r.ok ? "text-st-held" : "text-st-disputed"}>{r.ok ? "✓" : "✕"}</span>
              <span className="font-semibold text-ink">{a ? ACTION_META[a.type].label : r.actionId}</span>
              <span className="text-ink-2">{r.detail}</span>
            </div>
            {Object.keys(r.refs).length > 0 && (
              <div className="pl-4">
                <RefChips refs={r.refs} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function PlanCard({
  plan,
  bookings,
  grant,
  approval,
  tz,
  onApprove,
  onReject,
  defaultOpen,
}: {
  plan: Plan;
  bookings: Record<string, Booking>;
  grant: Grant | null;
  approval: ApprovePlanResponse | null;
  tz: string;
  onApprove: (plan: Plan, optionId: string) => Promise<void>;
  onReject: (plan: Plan) => Promise<void>;
  defaultOpen: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? (defaultOpen || plan.status === "proposed" || Boolean(approval));
  const now = useNow(plan.status === "proposed" || grant?.status === "active");
  const trigger = plan.trigger.bookingId ? bookings[plan.trigger.bookingId] : null;
  const open = plan.status === "proposed";

  const approve = async (optionId: string) => {
    setBusy(optionId);
    try {
      await onApprove(plan, optionId);
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    setBusy("reject");
    try {
      await onReject(plan);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`sl-rise rounded-lg border bg-surface-2 ${open ? "border-ac-agent/40 shadow-[0_0_0_3px_rgb(122_62_232_/_0.08)]" : "border-line"}`}>
      <button
        type="button"
        onClick={() => setOverride(!expanded)}
        className="flex w-full items-center gap-2 px-3 pt-2.5 text-left"
        aria-expanded={expanded}
      >
        <span className={`rounded px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[plan.status]}`}>
          {plan.status}
        </span>
        <span className="font-mono text-[11px] text-ink-3">{plan.id}</span>
        <span className="text-[11px] text-ink-3">· {plan.provider} · {relativeAgo(plan.createdAt, now)}</span>
        <span className="ml-auto text-[11px] text-ink-3">{expanded ? "▾" : "▸"}</span>
      </button>
      <div className="px-3 pb-3 pt-1.5">
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="rounded bg-ac-paypal/10 px-1.5 py-[1px] font-mono text-ac-paypal">{plan.trigger.eventType}</span>
          {trigger && <span className="text-ink-2">{trigger.customerName}</span>}
        </div>
        <p className="text-[13px] leading-snug text-ink">{plan.summary}</p>

        {expanded && (
          <div className="mt-2.5 flex flex-col gap-2">
            {plan.options.map((o, i) => (
              <OptionBlock
                key={o.id}
                option={o}
                letter={String.fromCharCode(65 + i)}
                plan={plan}
                bookings={bookings}
                tz={tz}
                busy={busy}
                onApprove={approve}
              />
            ))}

            {open && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] leading-snug text-ink-3">
                  The customer authorized the money in PayPal. Approving authorizes the execution: a 15-minute grant bound to these bookings, actions and amount.
                </p>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={reject}
                  className="flex-none rounded-md border border-line-2 bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-ink-2 hover:bg-surface-3 disabled:opacity-50"
                >
                  {busy === "reject" ? "Rejecting…" : "Reject"}
                </button>
              </div>
            )}

            {grant && <GrantLine grant={grant} now={now} tz={tz} />}
            {!grant && plan.grantId && (
              <div className="text-[11px] text-ink-3">
                Grant <span className="font-mono">{plan.grantId}</span>
              </div>
            )}
            {approval && <Results response={approval} plan={plan} />}
            {plan.error && <div className="rounded border border-st-disputed/30 bg-st-disputed/5 px-2 py-1 text-[12px] text-st-disputed">{plan.error}</div>}

            {plan.draftMessages.length > 0 && (
              <details className="group rounded-md border border-line bg-surface">
                <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[12px] font-semibold text-ink-2 marker:text-ink-3">
                  Draft messages ({plan.draftMessages.length})
                </summary>
                <div className="flex flex-col gap-2 border-t border-line px-2.5 py-2">
                  {plan.draftMessages.map((m, i) => {
                    const b = bookings[m.bookingId];
                    return (
                      <div key={i} className="text-[12px]">
                        <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
                          <span className="rounded bg-surface-3 px-1 font-mono uppercase">{m.channel}</span>
                          <span>to {b?.customerName ?? m.bookingId}</span>
                        </div>
                        {m.subject && <div className="mt-0.5 font-semibold text-ink">{m.subject}</div>}
                        <p className="mt-0.5 whitespace-pre-wrap leading-snug text-ink-2">{m.body}</p>
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export function AgentPanel({
  plans,
  bookings,
  grants,
  approvals,
  tz,
  onApprove,
  onReject,
}: {
  plans: Plan[];
  bookings: Record<string, Booking>;
  grants: Record<string, Grant>;
  approvals: Record<string, ApprovePlanResponse>;
  tz: string;
  onApprove: (plan: Plan, optionId: string) => Promise<void>;
  onReject: (plan: Plan) => Promise<void>;
}) {
  const open = plans.filter((p) => p.status === "proposed");
  const past = plans.filter((p) => p.status !== "proposed");
  return (
    <div className="flex flex-col gap-3">
      {open.length === 0 && (
        <div className="rounded-lg border border-dashed border-line-2 bg-surface px-4 py-5 text-center">
          <div className="text-[13px] font-semibold text-ink">No open proposals</div>
          <p className="mx-auto mt-1 max-w-[280px] text-[12px] leading-snug text-ink-3">
            The agent wakes when money misbehaves: a declined capture, a refund or a dispute. Try Dev &rarr; capture: INSTRUMENT_DECLINED.
          </p>
        </div>
      )}
      {open.map((p) => (
        <PlanCard
          key={p.id}
          plan={p}
          bookings={bookings}
          grant={p.grantId ? grants[p.grantId] ?? null : null}
          approval={approvals[p.id] ?? null}
          tz={tz}
          onApprove={onApprove}
          onReject={onReject}
          defaultOpen
        />
      ))}
      {past.length > 0 && (
        <>
          <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Earlier</div>
          {past.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              bookings={bookings}
              grant={p.grantId ? grants[p.grantId] ?? null : null}
              approval={approvals[p.id] ?? null}
              tz={tz}
              onApprove={onApprove}
              onReject={onReject}
              defaultOpen={false}
            />
          ))}
        </>
      )}
    </div>
  );
}
