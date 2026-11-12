"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { AuthorizeResponse, AvailabilityResponse, PublicBookingView, PublicConfig, Service } from "@/shared/types";
import { errorMessage } from "@/lib/client/api";
import { getBackend, type SlotlineBackend } from "@/lib/client/backend";
import { money, SERVICE_META, SERVICES, STATE_META } from "@/lib/client/format";
import {
  dayTimeToIso,
  DEFAULT_OPERATOR_TZ,
  formatDayLong,
  formatRange,
  formatTime,
  todayInTz,
  WORK_END_HOUR,
  WORK_START_HOUR,
  zoneLabel,
} from "@/lib/client/time";
import { Logo } from "@/components/ui/Logo";
import { StatePill } from "@/components/ui/StatePill";

const PayPalCheckout = dynamic(() => import("./PayPalCheckout").then((m) => m.PayPalCheckout), {
  ssr: false,
  loading: () => <div className="h-[45px] animate-pulse rounded bg-surface-3" />,
});

type Step = "details" | "pay" | "done";

/** "08:00" … in 30-minute steps, so the job ends by closing time. */
function slotsFor(minutes: number): string[] {
  const out: string[] = [];
  for (let m = WORK_START_HOUR * 60; m + minutes <= WORK_END_HOUR * 60; m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
}

/** Start time (ms) -> does any van have room, from GET /api/availability (the solver's view, no customer data). */
function freeStarts(a: AvailabilityResponse): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const s of a.slots) {
    const t = new Date(s.startAt).getTime();
    out.set(t, (out.get(t) ?? false) || s.available);
  }
  return out;
}

/** "van-2" -> "Van 2" (the booking page has no access to the operator's resource list). */
function vanLabel(resourceId: string): string {
  const m = /^van-(\d+)$/.exec(resourceId);
  return m ? `Van ${m[1]}` : resourceId;
}

export default function BookingFlow() {
  const params = useSearchParams();
  const demo = params.get("demo") === "1";
  const scene = params.get("scene");
  const resumeId = params.get("booking");

  const [backend, setBackend] = useState<SlotlineBackend | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [avail, setAvail] = useState<{ key: string; free: Map<number, boolean> } | null>(null);
  const [step, setStep] = useState<Step>("details");
  const [service, setService] = useState<Service>("screen");
  const [time, setTime] = useState<string>("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [booking, setBooking] = useState<PublicBookingView | null>(null);
  const [auth, setAuth] = useState<AuthorizeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [mockTrail, setMockTrail] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getBackend(demo, scene).then(async (b) => {
      if (cancelled) return;
      setBackend(b);
      const envClientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || null;
      const envCurrency = process.env.NEXT_PUBLIC_PAYPAL_CURRENCY || "USD";
      const cfg = await b.publicConfig().catch(
        (): PublicConfig => ({
          paypalClientId: envClientId,
          currency: envCurrency,
          mode: { paypal: envClientId ? "sandbox" : "mock", llm: "rules", devTools: false },
        }),
      );
      if (cancelled) return;
      setConfig({ ...cfg, paypalClientId: cfg.paypalClientId || envClientId });
      if (resumeId) {
        const found = await b.booking(resumeId).catch(() => null);
        if (cancelled) return;
        if (found) {
          setBooking(found);
          setService(found.service);
          setName(found.customerName);
          setStep(found.state === "quoted" || found.state === "approved" || found.state === "released" ? "pay" : "done");
        } else {
          setError(`Booking ${resumeId} was not found. You can book a new time below.`);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [demo, scene, resumeId]);

  const tz = config?.timeZone || DEFAULT_OPERATOR_TZ;
  const day = useMemo(() => todayInTz(tz), [tz]);
  const minutes = SERVICE_META[service].minutes;
  const slots = useMemo(() => slotsFor(minutes), [minutes]);
  const q = demo ? `?demo=1${scene ? `&scene=${scene}` : ""}` : "";
  const paypalMode = config?.mode.paypal ?? null;

  // "Slot looks full" hints for the chosen service, refreshed whenever the time picker is shown.
  useEffect(() => {
    if (!backend || !config || step !== "details") return;
    let cancelled = false;
    backend
      .availability(day, service)
      .then((a) => !cancelled && setAvail({ key: `${day}|${service}`, free: freeStarts(a) }))
      .catch(() => {
        // hints are optional; the server decides when booking
      });
    return () => {
      cancelled = true;
    };
  }, [backend, config, day, service, step]);
  const free = avail?.key === `${day}|${service}` ? avail.free : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backend || !time || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await backend.createBooking({
        customerName: name.trim(),
        customerEmail: email.trim() || undefined,
        service,
        startAt: dayTimeToIso(day, time, tz),
      });
      setBooking(res.booking);
      setStep(res.booking.waitlist ? "done" : "pay");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const authorized = (res: AuthorizeResponse) => {
    setAuth(res);
    setBooking(res.booking);
    setStep("done");
  };

  const simulateApproval = async () => {
    if (!backend || !booking) return;
    setBusy(true);
    setError(null);
    setMockTrail(["POST /api/bookings/" + booking.id + "/order"]);
    try {
      const { orderId } = await backend.createOrder(booking.id);
      setMockTrail((t) => [...t, `order ${orderId} created (intent AUTHORIZE)`, `POST /api/bookings/${booking.id}/authorize`]);
      const res = await backend.authorize(booking.id, { orderId });
      setMockTrail((t) => [...t, `authorization ${res.authorizationId}: deposit held`]);
      authorized(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[880px] items-center gap-3 px-5 py-3">
          <Logo size={26} />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold text-ink">Dana&apos;s Mobile Phone Repair</div>
            <div className="text-[11px] text-ink-3">We come to you · booked with Slotline</div>
          </div>
          {paypalMode && (
            <span
              className={`ml-auto rounded-md border px-2 py-[3px] font-mono text-[11px] ${
                paypalMode === "mock" ? "border-st-declined/40 bg-st-declined/10 text-[#8a4b00]" : "border-paypal/30 bg-paypal/5 text-paypal"
              }`}
            >
              PayPal: {paypalMode}
            </span>
          )}
        </div>
      </header>

      <main className="mx-auto grid max-w-[880px] gap-5 px-5 py-6 md:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-4">
          <ol className="flex items-center gap-2 text-[12px] font-semibold text-ink-3" aria-label="Progress">
            {(["details", "pay", "done"] as Step[]).map((s, i) => (
              <li key={s} className={`flex items-center gap-2 ${step === s ? "text-ink" : ""}`}>
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${step === s ? "bg-accent text-white" : "bg-surface-3 text-ink-2"}`}>{i + 1}</span>
                {s === "details" ? "Choose a time" : s === "pay" ? "Hold the deposit" : "Confirmed"}
                {i < 2 && <span className="mx-1 h-px w-6 bg-line-2" />}
              </li>
            ))}
          </ol>

          {error && <div className="rounded-md border border-st-disputed/30 bg-st-disputed/5 px-3 py-2 text-[13px] text-st-disputed">{error}</div>}

          {step === "details" && (
            <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
              <fieldset>
                <legend className="mb-2 text-[13px] font-semibold text-ink">What needs fixing?</legend>
                <div className="grid grid-cols-2 gap-2">
                  {SERVICES.map((s) => (
                    <label
                      key={s}
                      className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                        service === s ? "border-accent bg-accent/[0.04] ring-1 ring-accent" : "border-line hover:border-line-2"
                      }`}
                    >
                      <input type="radio" name="service" value={s} checked={service === s} onChange={() => setService(s)} className="sr-only" />
                      <div className="text-[13px] font-semibold text-ink">{SERVICE_META[s].label}</div>
                      <div className="text-[12px] text-ink-3">
                        {SERVICE_META[s].blurb} · {SERVICE_META[s].minutes} min
                      </div>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-1 text-[13px] font-semibold text-ink">When? Today, {formatDayLong(day)}</legend>
                <p className="mb-2 text-[11px] text-ink-3">Times are {zoneLabel(tz)}. If both vans are busy you join the waitlist and pay nothing yet.</p>
                <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                  {slots.map((t) => {
                    const iso = dayTimeToIso(day, t, tz);
                    const open = free?.get(new Date(iso).getTime()) ?? true;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTime(t)}
                        aria-pressed={time === t}
                        className={`rounded-md border px-1 py-1.5 font-mono text-[12px] transition-colors ${
                          time === t
                            ? "border-accent bg-accent text-white"
                            : open
                              ? "border-line bg-surface text-ink hover:border-accent"
                              : "border-dashed border-line-2 bg-surface-2 text-ink-3 hover:border-ink-3"
                        }`}
                        title={open ? "A van looks free" : "Both vans look busy: you would join the waitlist"}
                      >
                        {formatTime(iso, tz).replace(" ", " ")}
                        {!open && <span className="block font-sans text-[9px] leading-3">waitlist</span>}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-2">
                  Your name
                  <input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className="rounded-md border border-line-2 px-2.5 py-2 text-[14px] font-normal text-ink outline-none focus:border-accent" placeholder="Lee Chen" />
                </label>
                <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-2">
                  Email (for the receipt)
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className="rounded-md border border-line-2 px-2.5 py-2 text-[14px] font-normal text-ink outline-none focus:border-accent" placeholder="you@example.com" />
                </label>
              </div>

              <button
                type="submit"
                disabled={!backend || !time || !name.trim() || busy}
                className="self-start rounded-lg bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Checking the vans…" : time ? `Book ${formatTime(dayTimeToIso(day, time, tz), tz)}` : "Pick a time"}
              </button>
            </form>
          )}

          {step === "pay" && booking && (
            <section className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
              <div>
                <h2 className="text-[16px] font-semibold text-ink">Hold your {money(booking.depositAmount, booking.currency)} deposit</h2>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                  PayPal authorizes the deposit now and only captures it on the day. The slot is yours the moment the hold exists. The
                  remaining {money(booking.balanceAmount, booking.currency)} is invoiced after the repair.
                </p>
              </div>

              {paypalMode === "mock" && (
                <div className="rounded-lg border border-dashed border-st-declined/60 bg-st-declined/[0.06] p-4">
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-[#8a4b00]">Mock mode</div>
                  <p className="mt-1 text-[12px] leading-snug text-ink-2">
                    PAYPAL_MODE=mock: no PayPal window opens. This button calls the same endpoints the real PayPal buttons do
                    (create the order, then authorize it) against the mock gateway.
                  </p>
                  <button
                    type="button"
                    onClick={simulateApproval}
                    disabled={busy}
                    className="mt-3 w-full rounded-lg bg-[#ffc439] px-4 py-3 text-[14px] font-semibold text-[#111] shadow-sm hover:brightness-95 disabled:opacity-60"
                  >
                    {busy ? "Authorizing…" : "Simulate PayPal approval (mock)"}
                  </button>
                  {mockTrail.length > 0 && (
                    <ol className="mt-2 flex flex-col gap-0.5 font-mono text-[11px] text-ink-2">
                      {mockTrail.map((l, i) => (
                        <li key={i}>→ {l}</li>
                      ))}
                    </ol>
                  )}
                </div>
              )}

              {paypalMode === "sandbox" && config?.paypalClientId && backend && (
                <div>
                  <PayPalCheckout
                    clientId={config.paypalClientId}
                    currency={config.currency || booking.currency}
                    booking={booking}
                    backend={backend}
                    onAuthorized={authorized}
                    onError={(m) => setError(`PayPal: ${m}`)}
                    onCancel={() => setNote("You closed PayPal. Nothing was held; pick it up again whenever you like.")}
                  />
                  <p className="mt-1 text-[11px] text-ink-3">PayPal sandbox: use a sandbox buyer account. No real money moves.</p>
                </div>
              )}

              {paypalMode === "sandbox" && !config?.paypalClientId && (
                <div className="rounded-md border border-st-disputed/30 bg-st-disputed/5 px-3 py-2 text-[12px] text-st-disputed">
                  Sandbox mode but no PayPal client id is configured (NEXT_PUBLIC_PAYPAL_CLIENT_ID or /api/config/public).
                </div>
              )}

              {note && <p className="text-[12px] text-ink-3">{note}</p>}
            </section>
          )}

          {step === "done" && booking && (
            <section className="sl-rise flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
              {booking.waitlist ? (
                <>
                  <h2 className="text-[18px] font-semibold text-ink">You&apos;re on the waitlist</h2>
                  <p className="text-[13px] leading-relaxed text-ink-2">
                    Both vans are busy around {formatRange(booking.startAt, booking.endAt, tz)}. Nothing has been charged or held. When a slot opens,
                    Dana sends you a link to hold it with a {money(booking.depositAmount, booking.currency)} PayPal deposit.
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-st-held text-[20px] text-white">✓</span>
                    <div>
                      <h2 className="text-[18px] font-semibold text-ink">
                        {booking.state === "held" ? "Your slot is firm" : `Booking ${STATE_META[booking.state].label.toLowerCase()}`}
                      </h2>
                      <p className="text-[13px] text-ink-2">
                        {SERVICE_META[booking.service].label} · {formatRange(booking.startAt, booking.endAt, tz)}
                        {booking.resourceId ? ` · ${vanLabel(booking.resourceId)}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="rounded-lg border border-line bg-surface-2 p-3 text-[13px] text-ink-2">
                    <div className="flex items-center justify-between">
                      <span>Status</span>
                      <StatePill state={booking.state} />
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span>Deposit</span>
                      <span className="font-mono text-ink">{money(booking.depositAmount, booking.currency)} {booking.state === "held" ? "held, not charged" : ""}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <span>Balance after the repair</span>
                      <span className="font-mono text-ink">{money(booking.balanceAmount, booking.currency)}</span>
                    </div>
                    {(booking.paypalOrderId || auth) && (
                      <div className="mt-2 border-t border-line pt-2 font-mono text-[11px] text-ink-3">
                        {booking.paypalOrderId && <div>PayPal order {booking.paypalOrderId}</div>}
                        {(auth?.authorizationId || booking.paypalAuthorizationId) && (
                          <div>Authorization {auth?.authorizationId || booking.paypalAuthorizationId}</div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setStep("details");
                    setBooking(null);
                    setAuth(null);
                    setTime("");
                    setMockTrail([]);
                  }}
                  className="rounded-lg border border-line-2 px-3 py-2 text-[13px] font-semibold text-ink-2 hover:bg-surface-3"
                >
                  Book another repair
                </button>
                <Link href={`/${q}`} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white hover:bg-accent-2">
                  See it on Dana&apos;s board
                </Link>
              </div>
            </section>
          )}
        </div>

        <aside className="flex flex-col gap-3 text-[12px] text-ink-2">
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="text-[13px] font-semibold text-ink">How the deposit works</div>
            <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-4 leading-snug">
              <li>You approve a hold in PayPal. Nothing is charged yet.</li>
              <li>The hold makes your slot firm on Dana&apos;s timeline.</li>
              <li>The deposit is captured on the day; the balance comes as a PayPal invoice.</li>
              <li>If plans change, the hold is voided or refunded and the slot is released.</li>
            </ol>
          </div>
          {booking && step !== "details" && (
            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="text-[13px] font-semibold text-ink">Your booking</div>
              <div className="mt-1 leading-snug">
                {booking.customerName}
                <br />
                {SERVICE_META[booking.service].label}
                <br />
                <span className="font-mono">{formatRange(booking.startAt, booking.endAt, tz)}</span>
              </div>
              <div className="mt-2 font-mono text-[11px] text-ink-3">{booking.id}</div>
            </div>
          )}
          {demo && (
            <p className="rounded-lg bg-st-approved/[0.07] px-3 py-2 text-[11px] leading-snug text-st-approved">
              Demo data (?demo=1): this page talks to an in-browser simulation, not the server.
            </p>
          )}
        </aside>
      </main>
    </div>
  );
}
