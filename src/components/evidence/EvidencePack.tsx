"use client";

/**
 * Printable dispute evidence pack: booking, PayPal objects and the full event
 * log for one booking, from GET /api/bookings/:id/evidence. The response is
 * normalised defensively so small shape differences on the server side still
 * render.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { use, useEffect, useState } from "react";
import type { Booking, EvidencePack as Pack, Grant, LogEntry, MoneyEvent } from "@/shared/types";
import { errorMessage, isUnauthorized } from "@/lib/client/api";
import { getBackend } from "@/lib/client/backend";
import { BALANCE_LABEL, money, paypalRefs, SERVICE_META, STATE_META } from "@/lib/client/format";
import { DEFAULT_OPERATOR_TZ, formatClock, formatDayLong, formatRange, todayInTz } from "@/lib/client/time";
import { Logo } from "@/components/ui/Logo";
import { StatePill } from "@/components/ui/StatePill";
import { AuthGate, useAuth } from "@/components/auth/AuthGate";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function normalise(raw: unknown): (Pack & { extra: [string, Obj][] }) | null {
  const root = isObj(raw) && isObj(raw.evidence) ? raw.evidence : raw;
  if (!isObj(root)) return null;
  const booking = (isObj(root.booking) ? root.booking : null) as Booking | null;
  if (!booking || typeof booking.id !== "string") return null;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (isObj(root[k])) return root[k] as Obj;
    return null;
  };
  const list = (...keys: string[]) => {
    for (const k of keys) if (Array.isArray(root[k])) return root[k] as unknown[];
    return [];
  };
  const timeline = (list("timeline", "log", "logEntries") as LogEntry[]).filter((e) => isObj(e) && typeof e.message === "string");
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  const known = new Set([
    "booking", "generatedAt", "order", "authorization", "capture", "refund", "invoice", "dispute",
    "timeline", "log", "logEntries", "events", "facts", "resource", "paypalSource", "plans", "grants",
  ]);
  const extra = Object.entries(root).filter(([k, v]) => !known.has(k) && isObj(v)) as [string, Obj][];
  return {
    booking,
    generatedAt: typeof root.generatedAt === "string" ? root.generatedAt : new Date().toISOString(),
    order: pick("order"),
    authorization: pick("authorization", "auth"),
    capture: pick("capture"),
    refund: pick("refund"),
    invoice: pick("invoice"),
    dispute: pick("dispute"),
    timeline,
    events: list("events", "moneyEvents") as MoneyEvent[],
    facts: (list("facts") as unknown[]).filter((f): f is string => typeof f === "string"),
    resource: isObj(root.resource) ? (root.resource as unknown as Pack["resource"]) : null,
    paypalSource: root.paypalSource === "api" || root.paypalSource === "events" ? root.paypalSource : undefined,
    grants: (list("grants") as Grant[]).filter((g) => isObj(g) && typeof g.id === "string"),
    extra,
  };
}

function compact(v: unknown): string {
  const text = JSON.stringify(v);
  return text.length > 90 ? `${text.slice(0, 88)}…` : text;
}

/** PayPal objects as dotted key/value rows; deep leftovers are shown as compact JSON. */
function flatten(obj: Obj, prefix = "", out: [string, string][] = [], depth = 0): [string, string][] {
  for (const [k, v] of Object.entries(obj)) {
    if (k === "links") continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) {
      if (depth < 4) flatten(v, key, out, depth + 1);
      else out.push([key, compact(v)]);
    } else if (Array.isArray(v)) {
      if (v.every((x) => !isObj(x) && !Array.isArray(x))) out.push([key, v.join(", ")]);
      else
        v.slice(0, 3).forEach((x, i) =>
          isObj(x) && depth < 4 ? flatten(x, `${key}[${i}]`, out, depth + 1) : out.push([`${key}[${i}]`, compact(x)]),
        );
    } else if (v !== null && v !== undefined && v !== "") out.push([key, String(v)]);
  }
  return out;
}

function PaypalObject({ title, obj }: { title: string; obj: Obj | null | undefined }) {
  if (!obj) return null;
  const rows = flatten(obj).slice(0, 24);
  return (
    <section className="break-inside-avoid rounded-lg border border-line p-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</h3>
      <dl className="mt-1.5 grid grid-cols-[minmax(110px,40%)_1fr] gap-x-3 gap-y-0.5 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="break-all font-mono text-[10.5px] leading-4 text-ink-3" title={k}>
              {k}
            </dt>
            <dd className="break-all font-mono text-[11px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function EvidencePack({ params }: { params: Promise<{ id: string }> }) {
  const search = useSearchParams();
  const demo = search.get("demo") === "1";
  const scene = search.get("scene");
  return (
    <AuthGate demo={demo} purpose="the evidence pack">
      <EvidencePackInner params={params} demo={demo} scene={scene} />
    </AuthGate>
  );
}

function EvidencePackInner({ params, demo, scene }: { params: Promise<{ id: string }>; demo: boolean; scene: string | null }) {
  const { id } = use(params);
  const { signedOut } = useAuth();
  const [pack, setPack] = useState<ReturnType<typeof normalise>>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tz, setTz] = useState(DEFAULT_OPERATOR_TZ);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const backend = await getBackend(demo, scene);
        backend
          .publicConfig()
          .then((c) => !cancelled && c.timeZone && setTz(c.timeZone))
          .catch(() => {});
        const raw = await backend.evidence(id);
        const p = normalise(raw);
        if (!cancelled) {
          if (p) setPack(p);
          else setError("The evidence response did not include a booking.");
        }
      } catch (err) {
        if (!cancelled && isUnauthorized(err)) return signedOut();
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, demo, scene, signedOut]);

  const q = demo ? `?demo=1${scene ? `&scene=${scene}` : ""}` : "";

  if (loading) return <div className="flex min-h-dvh items-center justify-center text-[13px] text-ink-3">Assembling evidence for {id}…</div>;
  if (error || !pack) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-2 p-8 text-center">
        <div className="text-[15px] font-semibold text-ink">No evidence pack for {id}</div>
        <p className="text-[13px] text-ink-2">{error}</p>
        <Link href={`/${q}`} className="mt-2 text-[13px] font-semibold text-accent underline">
          Back to the dashboard
        </Link>
      </div>
    );
  }

  const b = pack.booking;
  const refs = paypalRefs(b);
  const day = b.startAt ? todayInTz(tz, new Date(b.startAt)) : null;

  return (
    <div className="min-h-dvh bg-bg py-6 print:bg-white print:py-0">
      <div className="sl-no-print mx-auto mb-3 flex max-w-[860px] items-center justify-between px-5">
        <Link href={`/${q}`} className="text-[13px] font-semibold text-accent hover:underline">
          ← Dashboard
        </Link>
        <button type="button" onClick={() => window.print()} className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-accent-2">
          Print / save as PDF
        </button>
      </div>

      <article className="mx-auto max-w-[860px] rounded-xl border border-line bg-surface px-8 py-7 shadow-sm print:max-w-none print:rounded-none print:border-0 print:px-0 print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b border-line pb-4">
          <div>
            <div className="flex items-center gap-2 text-[12px] text-ink-3">
              <Logo size={18} /> Slotline · Dana&apos;s Mobile Phone Repair
            </div>
            <h1 className="mt-2 text-[22px] font-semibold tracking-tight text-ink">Dispute evidence pack</h1>
            <p className="mt-0.5 text-[13px] text-ink-2">
              {b.customerName} · {SERVICE_META[b.service].label} · booking <span className="font-mono">{b.id}</span>
            </p>
          </div>
          <div className="text-right text-[12px] text-ink-2">
            <StatePill state={b.state} />
            <div className="mt-1.5 font-mono text-[11px] text-ink-3">generated {pack.generatedAt}</div>
            {b.paypalDisputeId && <div className="mt-0.5 font-mono text-[11px] text-st-disputed">dispute {b.paypalDisputeId}</div>}
          </div>
        </header>

        <section className="grid grid-cols-2 gap-4 border-b border-line py-4 text-[13px] sm:grid-cols-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Scheduled</div>
            <div className="mt-0.5 text-ink">{day ? formatDayLong(day) : "—"}</div>
            <div className="font-mono text-[12px] text-ink-2">{formatRange(b.startAt, b.endAt, tz)}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Customer</div>
            <div className="mt-0.5 text-ink">{b.customerName}</div>
            <div className="text-[12px] text-ink-2">{b.customerEmail ?? "no email on file"}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Deposit</div>
            <div className="mt-0.5 font-mono text-ink">{money(b.depositAmount, b.currency)}</div>
            <div className="text-[12px] text-ink-2">{STATE_META[b.state].money}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Balance</div>
            <div className="mt-0.5 font-mono text-ink">{money(b.balanceAmount, b.currency)}</div>
            <div className="text-[12px] text-ink-2">{BALANCE_LABEL[b.balanceState]}</div>
          </div>
        </section>

        {(pack.facts ?? []).length > 0 && (
          <section className="border-b border-line py-4">
            <h2 className="text-[13px] font-semibold text-ink">Statement of facts</h2>
            <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-[12.5px] leading-snug text-ink">
              {(pack.facts ?? []).map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ol>
          </section>
        )}

        {refs.length > 0 && (
          <section className="border-b border-line py-4">
            <h2 className="text-[13px] font-semibold text-ink">PayPal references</h2>
            <table className="mt-2 w-full text-[12px]">
              <tbody>
                {refs.map((r) => (
                  <tr key={r.key} className="border-b border-line/60 last:border-0">
                    <td className="w-40 py-1 text-ink-2">{r.label}</td>
                    <td className="py-1 font-mono text-paypal">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {pack.paypalSource && (
          <p className="pt-3 text-[11px] text-ink-3">
            PayPal objects below come from {pack.paypalSource === "api" ? "live PayPal API reads" : "the recorded, signature-verified event payloads"}.
          </p>
        )}
        <section className="grid gap-3 border-b border-line py-4 sm:grid-cols-2">
          <PaypalObject title="Order" obj={pack.order} />
          <PaypalObject title="Authorization" obj={pack.authorization} />
          <PaypalObject title="Capture" obj={pack.capture} />
          <PaypalObject title="Refund" obj={pack.refund} />
          <PaypalObject title="Invoice" obj={pack.invoice} />
          <PaypalObject title="Dispute" obj={pack.dispute} />
          {pack.extra.map(([k, v]) => (
            <PaypalObject key={k} title={k} obj={v} />
          ))}
          {!pack.order && !pack.authorization && !pack.capture && !pack.invoice && !pack.dispute && (
            <p className="text-[12px] text-ink-3">No PayPal objects were returned for this booking.</p>
          )}
        </section>

        {(pack.grants ?? []).length > 0 && (
          <section className="border-b border-line py-4">
            <h2 className="text-[13px] font-semibold text-ink">Operator execution grants</h2>
            <table className="mt-2 w-full text-[12px]">
              <tbody>
                {(pack.grants ?? []).map((g) => (
                  <tr key={g.id} className="border-b border-line/60 last:border-0">
                    <td className="py-1 pr-2 font-mono text-ink">{g.id}</td>
                    <td className="py-1 pr-2 text-ink-2">{g.allowedActions.join(", ")}</td>
                    <td className="py-1 pr-2 font-mono text-paypal">max {money(g.maxAmount, g.currency)}</td>
                    <td className="py-1 pr-2 text-ink-2">{g.status}</td>
                    <td className="py-1 font-mono text-[11px] text-ink-3">issued {formatClock(g.issuedAt, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="py-4">
          <h2 className="text-[13px] font-semibold text-ink">Timeline of events</h2>
          <p className="text-[11px] text-ink-3">Every customer, operator, agent, system and PayPal event recorded for this booking, oldest first ({tz}).</p>
          <table className="mt-2 w-full text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.08em] text-ink-3">
                <th className="py-1 pr-2 font-semibold">Time</th>
                <th className="py-1 pr-2 font-semibold">Actor</th>
                <th className="py-1 pr-2 font-semibold">Event</th>
                <th className="py-1 font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody>
              {(pack.timeline ?? []).map((e) => (
                <tr key={e.id} className="break-inside-avoid border-b border-line/60 align-top">
                  <td className="py-1 pr-2 font-mono text-[11px] text-ink-3">{formatClock(e.at, tz)}</td>
                  <td className="py-1 pr-2 font-semibold text-ink-2">{e.actor}</td>
                  <td className="py-1 pr-2 font-mono text-[11px] text-ink-2">{e.kind}</td>
                  <td className="py-1 text-ink">
                    {e.message}
                    {Object.keys(e.refs ?? {}).length > 0 && (
                      <div className="font-mono text-[10.5px] text-ink-3">
                        {Object.entries(e.refs)
                          .filter(([, v]) => v)
                          .map(([k, v]) => `${k}=${v}`)
                          .join("  ")}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {(pack.timeline ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-center text-ink-3">
                    No log entries returned.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <footer className="border-t border-line pt-3 text-[11px] leading-snug text-ink-3">
          Prepared by Slotline from PayPal events (webhooks count only after signature verification), PayPal API results and the operator
          log. Amounts in{" "}
          {b.currency}. Notes on file: {b.notes ?? "none"}.
        </footer>
      </article>
    </div>
  );
}
