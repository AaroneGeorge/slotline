"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { Booking, Plan } from "@/shared/types";
import { errorMessage, type MoveOutcome } from "@/lib/client/api";
import { firstName } from "@/lib/client/format";
import { useSlotline } from "@/lib/client/store";
import { formatRange, formatTime } from "@/lib/client/time";
import { ToastProvider, useToast } from "@/components/ui/Toasts";
import { AuthGate, useAuth } from "@/components/auth/AuthGate";
import { AgentPanel } from "./AgentPanel";
import { BookingInspector } from "./BookingInspector";
import { DevPanel } from "./DevPanel";
import { Header } from "./Header";
import { LogPanel } from "./LogPanel";
import { Legend, MoneyStrip } from "./MoneyStrip";
import { WaitlistPanel } from "./WaitlistPanel";

const Timeline = dynamic(() => import("@/components/timeline/Timeline"), {
  ssr: false,
  loading: () => <TimelineSkeleton label="Loading Scheduler Pro…" />,
});

function TimelineSkeleton({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="h-9 border-b border-line bg-surface-2" />
      {[0, 1, 2].map((i) => (
        <div key={i} className={`flex border-b border-line ${i === 2 ? "h-[84px]" : "h-[148px]"}`}>
          <div className="w-[138px] border-r border-line bg-surface-2" />
          <div className="flex-1 animate-pulse bg-[linear-gradient(90deg,transparent,rgba(0,0,0,0.025),transparent)]" />
        </div>
      ))}
      <div className="p-3 text-[12px] text-ink-3">{label}</div>
    </div>
  );
}

type Tab = "agent" | "waitlist" | "log" | "dev";

export default function Dashboard() {
  const params = useSearchParams();
  const demo = params.get("demo") === "1";
  const scene = params.get("scene");
  return (
    <ToastProvider>
      <AuthGate demo={demo} purpose="Dana's dashboard">
        <DashboardInner demo={demo} scene={scene} />
      </AuthGate>
    </ToastProvider>
  );
}

function DashboardInner({ demo, scene }: { demo: boolean; scene: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const auth = useAuth();
  const { state, dispatch, backend, resync } = useSlotline(demo, scene, auth.signedOut);
  const [tab, setTab] = useState<Tab>("agent");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<string | null>(null);
  const [seenPlanId, setSeenPlanId] = useState<string | null>(null);

  // A freshly proposed plan pulls the Agent tab forward.
  if (state.latestPlanId && state.latestPlanId !== seenPlanId) {
    setSeenPlanId(state.latestPlanId);
    if (seenPlanId !== null || state.plans[state.latestPlanId]?.status === "proposed") setTab("agent");
  }

  const tz = state.timeZone;
  const bookings = useMemo(() => Object.values(state.bookings), [state.bookings]);
  const plans = useMemo(
    () =>
      Object.values(state.plans).sort((a, b) => {
        if ((a.status === "proposed") !== (b.status === "proposed")) return a.status === "proposed" ? -1 : 1;
        return b.createdAt.localeCompare(a.createdAt);
      }),
    [state.plans],
  );
  const openCount = plans.filter((p) => p.status === "proposed").length;
  const waitCount = bookings.filter((b) => b.waitlist && !["released", "refunded"].includes(b.state)).length;
  const q = demo ? `?demo=1${scene ? `&scene=${scene}` : ""}` : "";
  const selected = selectedId ? state.bookings[selectedId] ?? null : null;

  const onMove = useCallback(
    async (bookingId: string, startAt: string, resourceId: string, durationMin?: number): Promise<MoveOutcome> => {
      if (!backend) return { ok: false, conflicts: ["Not connected"], booking: null, message: "Not connected" };
      const b = state.bookings[bookingId];
      try {
        const outcome = await backend.moveBooking(bookingId, durationMin ? { startAt, resourceId, durationMin } : { startAt, resourceId });
        if (outcome.booking) dispatch({ type: "booking", booking: outcome.booking });
        if (outcome.ok && durationMin && outcome.booking.durationMin !== durationMin) {
          toast({
            tone: "info",
            title: `Kept the ${outcome.booking.durationMin}-minute ${b ? "job" : "slot"} length`,
            body: "The server sets durations by service, so the resize snapped back.",
          });
        } else if (outcome.ok) {
          toast({
            tone: "ok",
            title: `${b ? firstName(b.customerName) : "Job"} ${durationMin ? "resized" : "moved"}`,
            body: formatRange(outcome.booking.startAt, outcome.booking.endAt, tz),
          });
        } else {
          toast({ tone: "warn", title: `Can't move ${b ? firstName(b.customerName) : "the job"} to ${formatTime(startAt, tz)}`, body: outcome.conflicts });
        }
        return outcome;
      } catch (err) {
        toast({ tone: "error", title: "Move failed", body: errorMessage(err) });
        return { ok: false, conflicts: [errorMessage(err)], booking: null, message: errorMessage(err) };
      }
    },
    [backend, dispatch, state.bookings, toast, tz],
  );

  const openEvidence = useCallback(
    (bookingId: string) => {
      const href = `/evidence/${encodeURIComponent(bookingId)}${q}`;
      if (demo) router.push(href);
      else window.open(href, "_blank", "noopener");
    },
    [demo, q, router],
  );

  const askAgent = useCallback(
    async (bookingId: string) => {
      if (!backend) return;
      try {
        const plan = await backend.proposePlan({ bookingId, eventType: "manual" });
        if (plan) {
          dispatch({ type: "plan", plan });
          setTab("agent");
        } else {
          toast({ tone: "info", title: "The agent found no feasible options", body: "Nothing it could do is allowed by the solver right now." });
        }
      } catch (err) {
        toast({ tone: "error", title: "Could not ask the agent", body: errorMessage(err) });
      }
    },
    [backend, dispatch, toast],
  );

  const onMenu = useCallback(
    (action: "replan" | "evidence" | "log", bookingId: string) => {
      if (action === "replan") void askAgent(bookingId);
      else if (action === "evidence") openEvidence(bookingId);
      else {
        setLogFilter(bookingId);
        setTab("log");
      }
    },
    [askAgent, openEvidence],
  );

  const approve = useCallback(
    async (plan: Plan, optionId: string) => {
      if (!backend) return;
      dispatch({ type: "plan", plan: { ...plan, status: "approved", chosenOptionId: optionId } });
      try {
        const res = await backend.approvePlan(plan.id, { optionId });
        dispatch({ type: "approval", planId: plan.id, response: res });
        const okCount = res.results.filter((r) => r.ok).length;
        toast({
          tone: res.plan.status === "failed" ? "warn" : "ok",
          title: res.plan.status === "failed" ? "Executed with failures" : "Executed under grant",
          body: `${res.grant.id}: ${okCount}/${res.results.length} actions done`,
        });
      } catch (err) {
        dispatch({ type: "plan", plan });
        toast({ tone: "error", title: "Approval failed", body: errorMessage(err) });
        void resync();
      }
    },
    [backend, dispatch, resync, toast],
  );

  const reject = useCallback(
    async (plan: Plan) => {
      if (!backend) return;
      try {
        const next = await backend.rejectPlan(plan.id);
        dispatch({ type: "plan", plan: next ?? { ...plan, status: "rejected" } });
      } catch (err) {
        toast({ tone: "error", title: "Reject failed", body: errorMessage(err) });
      }
    },
    [backend, dispatch, toast],
  );

  const sendLink = useCallback(
    async (b: Booking) => {
      const link = `${window.location.origin}/book?booking=${encodeURIComponent(b.id)}${demo ? "&demo=1" : ""}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(link);
        copied = true;
      } catch {
        copied = false;
      }
      toast({
        tone: "ok",
        title: copied ? `Booking link for ${firstName(b.customerName)} copied` : `Booking link for ${firstName(b.customerName)}`,
        body: link,
      });
    },
    [demo, toast],
  );

  const tabs: { id: Tab; label: string; badge?: number; hot?: boolean }[] = [
    { id: "agent", label: "Agent", badge: openCount || undefined, hot: openCount > 0 },
    { id: "waitlist", label: "Waitlist", badge: waitCount || undefined },
    { id: "log", label: "Log", badge: state.log.length || undefined },
    ...(state.mode?.devTools ? [{ id: "dev" as Tab, label: "Dev" }] : []),
  ];

  return (
    <div className="flex h-dvh min-h-[640px] flex-col">
      <Header
        mode={state.mode}
        day={state.day}
        timeZone={tz}
        conn={state.conn}
        bookHref={`/book${q}`}
        onSignOut={auth.mode === "password" ? () => void auth.signOut() : undefined}
      />
      <main className="flex min-h-0 flex-1 gap-3 p-3">
        <section className="flex min-w-0 flex-[7] flex-col gap-2.5">
          <MoneyStrip bookings={bookings} />
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-surface">
            {state.status === "ready" && state.day ? (
              <Timeline
                resources={state.resources}
                bookings={bookings}
                day={state.day}
                timeZone={tz}
                lastChange={state.lastChange}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMove={onMove}
                onRefused={(m) => toast({ tone: "warn", title: "Move refused", body: m })}
                onMenu={onMenu}
              />
            ) : state.status === "error" ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <div className="text-[14px] font-semibold text-ink">Can&apos;t reach the Slotline API</div>
                <p className="max-w-md text-[12px] text-ink-2">{state.error}</p>
                <p className="max-w-md text-[12px] text-ink-3">
                  Start the server with <code className="font-mono">PAYPAL_MODE=mock pnpm dev</code>, or open the{" "}
                  <Link className="font-semibold text-accent underline" href="/?demo=1">
                    demo day
                  </Link>{" "}
                  that runs entirely in the browser.
                </p>
                <button type="button" onClick={() => void resync()} className="mt-1 rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white">
                  Retry
                </button>
              </div>
            ) : (
              <TimelineSkeleton label="Loading Dana's day…" />
            )}
          </div>
          <Legend />
        </section>

        <aside className="flex min-w-[340px] max-w-[460px] flex-[3] flex-col gap-2.5">
          {selected && (
            <BookingInspector
              booking={selected}
              resources={state.resources}
              tz={tz}
              onClose={() => setSelectedId(null)}
              onAsk={() => void askAgent(selected.id)}
              onLog={() => {
                setLogFilter(selected.id);
                setTab("log");
              }}
              onEvidence={() => openEvidence(selected.id)}
            />
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface">
            <nav className="flex flex-none border-b border-line bg-surface-2 px-1" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px] font-semibold transition-colors ${
                    tab === t.id ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {t.label}
                  {t.badge !== undefined && (
                    <span
                      className={`rounded-full px-1.5 font-mono text-[10px] leading-4 ${
                        t.hot ? "bg-ac-agent text-white" : "bg-surface-3 text-ink-2"
                      }`}
                    >
                      {t.badge}
                    </span>
                  )}
                </button>
              ))}
            </nav>
            <div className="sl-scroll min-h-0 flex-1 overflow-y-auto p-2.5" role="tabpanel">
              {tab === "agent" && (
                <AgentPanel
                  plans={plans}
                  bookings={state.bookings}
                  grants={state.grants}
                  approvals={state.approvals}
                  tz={tz}
                  onApprove={approve}
                  onReject={reject}
                />
              )}
              {tab === "waitlist" && <WaitlistPanel bookings={bookings} tz={tz} onLink={sendLink} onAsk={(b) => void askAgent(b.id)} />}
              {tab === "log" && (
                <LogPanel
                  log={state.log}
                  bookings={state.bookings}
                  tz={tz}
                  bookingFilter={logFilter}
                  onClearFilter={() => setLogFilter(null)}
                  onPickBooking={(id) => {
                    setLogFilter(id);
                    setSelectedId(id);
                  }}
                />
              )}
              {tab === "dev" && backend && (
                <DevPanel
                  backend={backend}
                  bookings={bookings}
                  selectedId={selectedId}
                  tz={tz}
                  demo={demo}
                  onAfter={() => void resync()}
                />
              )}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
