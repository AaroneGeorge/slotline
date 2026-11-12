"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Booking, DevFixture } from "@/shared/types";
import { errorMessage, type MoneyAction } from "@/lib/client/api";
import type { SlotlineBackend } from "@/lib/client/backend";
import { STATE_META } from "@/lib/client/format";
import { formatTime } from "@/lib/client/time";
import { useLocalSetting } from "@/lib/client/use-local-setting";
import { useToast } from "@/components/ui/Toasts";

const CAPTURE_TESTS: { value: string; label: string }[] = [
  { value: "INSTRUMENT_DECLINED", label: "capture: INSTRUMENT_DECLINED" },
  { value: "TRANSACTION_REFUSED", label: "capture: TRANSACTION_REFUSED" },
  { value: "", label: "capture: success" },
];

const FIXTURES: { fixture: DevFixture; label: string; hint: string }[] = [
  { fixture: "capture.denied", label: "PAYMENT.CAPTURE.DENIED", hint: "held/pending → declined, agent proposes" },
  { fixture: "capture.pending", label: "PAYMENT.CAPTURE.PENDING", hint: "held → pending (yellow)" },
  { fixture: "capture.refunded", label: "PAYMENT.CAPTURE.REFUNDED", hint: "confirmed → refunded, slot released" },
  { fixture: "authorization.voided", label: "PAYMENT.AUTHORIZATION.VOIDED", hint: "held → released" },
  { fixture: "dispute.created", label: "CUSTOMER.DISPUTE.CREATED", hint: "paid → disputed, evidence pack" },
  { fixture: "invoice.paid", label: "INVOICING.INVOICE.PAID", hint: "balance → paid" },
];

const MONEY: { action: MoneyAction; label: string }[] = [
  { action: "void", label: "Void" },
  { action: "refund", label: "Refund" },
  { action: "invoice", label: "Invoice balance" },
  { action: "remind", label: "Remind" },
];

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-surface p-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2">{title}</h3>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-ink-3">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function DevPanel({
  backend,
  bookings,
  selectedId,
  tz,
  demo,
  onAfter,
}: {
  backend: SlotlineBackend;
  bookings: Booking[];
  selectedId: string | null;
  tz: string;
  demo: boolean;
  onAfter: () => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const [secret, setSecret] = useLocalSetting("slotline.devSecret");
  const [picked, setPicked] = useState<string>("");
  const [captureTest, setCaptureTest] = useState(CAPTURE_TESTS[0].value);
  const [busy, setBusy] = useState<string | null>(null);

  // van by van, then by time: the dropdown reads like the timeline
  const candidates = bookings
    .filter((b) => b.resourceId && !b.waitlist)
    .sort((a, b) => (a.resourceId ?? "").localeCompare(b.resourceId ?? "") || a.startAt.localeCompare(b.startAt));
  const fallback = candidates.find((b) => b.state === "held")?.id ?? candidates[0]?.id ?? "";
  const bookingId = picked || selectedId || fallback;
  const booking = bookings.find((b) => b.id === bookingId);
  const needSecret = !demo && !secret;

  const run = async (label: string, fn: () => Promise<unknown>, describe?: (res: unknown) => string | undefined) => {
    if (needSecret) {
      toast({ tone: "warn", title: "Dev secret needed", body: "Enter the DEV_TOOLS_SECRET value (sent as x-dev-secret)." });
      return;
    }
    setBusy(label);
    try {
      const res = await fn();
      toast({ tone: "ok", title: label, body: describe?.(res) ?? (booking ? booking.customerName : undefined) });
    } catch (err) {
      toast({ tone: "error", title: `${label} failed`, body: errorMessage(err) });
    } finally {
      setBusy(null);
      onAfter();
    }
  };

  const btn =
    "rounded-md border border-line-2 bg-surface px-2 py-1 text-left text-[11.5px] font-semibold text-ink hover:bg-surface-3 disabled:opacity-50";

  return (
    <div className="flex flex-col gap-2.5">
      <Section title="Access" hint={demo ? "Demo mode: simulated server, no secret needed." : "Dev routes need the x-dev-secret header (DEV_TOOLS_SECRET). Stored in this browser only."}>
        {!demo && (
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="x-dev-secret"
            autoComplete="off"
            className="w-full rounded-md border border-line-2 bg-surface-2 px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
          />
        )}
        <label className="mt-2 block text-[11px] text-ink-3" htmlFor="dev-booking">
          Target booking
        </label>
        <select
          id="dev-booking"
          value={bookingId}
          onChange={(e) => setPicked(e.target.value)}
          className="mt-0.5 w-full rounded-md border border-line-2 bg-surface px-2 py-1 text-[12px]"
        >
          {candidates.map((b) => (
            <option key={b.id} value={b.id}>
              {formatTime(b.startAt, tz)} · {b.customerName} · {STATE_META[b.state].short}
            </option>
          ))}
        </select>
      </Section>

      <Section title="Negative test: capture" hint="Sandbox sends PayPal-Mock-Response; mock mode returns the same declined result.">
        <div className="flex gap-1.5">
          <select
            value={captureTest}
            onChange={(e) => setCaptureTest(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-line-2 bg-surface px-2 py-1 font-mono text-[11.5px]"
            aria-label="Capture negative test"
          >
            {CAPTURE_TESTS.map((t) => (
              <option key={t.label} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!booking || busy !== null}
            onClick={() =>
              run(CAPTURE_TESTS.find((t) => t.value === captureTest)?.label ?? "capture", () =>
                backend.moneyAction(bookingId, "capture", captureTest ? { mockResponse: captureTest } : {}, secret),
              )
            }
            className="flex-none rounded-md bg-accent px-3 py-1 text-[12px] font-semibold text-white hover:bg-accent-2 disabled:opacity-50"
          >
            {busy?.startsWith("capture") ? "…" : "Run"}
          </button>
        </div>
      </Section>

      <Section title="Inject webhook fixture" hint="POST /api/dev/inject: PayPal-shaped event bodies with this booking's ids.">
        <div className="grid grid-cols-1 gap-1">
          {FIXTURES.map((f) => (
            <button
              key={f.fixture}
              type="button"
              disabled={!booking || busy !== null}
              onClick={() =>
                run(
                  f.label,
                  () => backend.devInject(secret, { fixture: f.fixture, bookingId }),
                  (r) => {
                    const res = r as { outcome?: string; eventId?: string } | null;
                    return res?.outcome ? `${booking?.customerName ?? bookingId}: ${res.outcome}${res.eventId ? ` (${res.eventId})` : ""}` : undefined;
                  },
                )
              }
              className={btn}
              title={f.hint}
            >
              <span className="font-mono text-[11px] text-paypal">{f.label}</span>
              <span className="block text-[10.5px] font-normal text-ink-3">{f.hint}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Replay" hint="Re-deliver the latest recorded webhook. Idempotent by PayPal event id: expect 200 and no state change.">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            run(
              "Replay latest webhook",
              () => backend.devReplay(secret),
              (r) => {
                const res = r as { outcome?: string; eventId?: string; httpStatus?: number };
                return `${res.eventId ?? "event"}: ${res.outcome ?? "?"} (HTTP ${res.httpStatus ?? "?"})`;
              },
            )
          }
          className={btn}
        >
          Replay latest webhook
        </button>
      </Section>

      <Section title="Money actions" hint="Bypass the agent with the dev secret. Logged as operator with devTools=1.">
        <div className="flex flex-wrap gap-1">
          {MONEY.map((m) => (
            <button
              key={m.action}
              type="button"
              disabled={!booking || busy !== null}
              onClick={() => run(m.label, () => backend.moneyAction(bookingId, m.action, {}, secret))}
              className={btn}
            >
              {m.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Day">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            if (window.confirm("Reset Dana's day to the seed? Everything since will be lost.")) {
              void run("Reset to seed day", () => backend.devSeed(secret));
            }
          }}
          className={btn}
        >
          Reset to seed day
        </button>
        {demo && (
          <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
            <span className="text-ink-3">Scenes:</span>
            {["declined", "reflowed", "refund", "dispute"].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => router.push(`/?demo=1&scene=${s}`)}
                className="rounded bg-surface-3 px-1.5 py-[1px] font-mono text-ink-2 hover:text-ink"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
