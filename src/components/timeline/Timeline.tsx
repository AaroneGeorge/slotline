"use client";

/**
 * Dana's day on Bryntum Scheduler Pro. Loaded with next/dynamic `ssr:false`
 * (the Bryntum bundle touches `window` at import). Data is pushed into the
 * stores imperatively so that a state change is an in-place record update,
 * which Scheduler Pro animates (`transition.changeEvent`), instead of a
 * reload. Times are converted to the operator's wall clock (see time.ts).
 */
import "@bryntum/schedulerpro/fontawesome/css/fontawesome.css";
import "@bryntum/schedulerpro/fontawesome/css/solid.css";
import "@bryntum/schedulerpro/schedulerpro.css";
import "@bryntum/schedulerpro/stockholm-light.css";
import "./timeline.css";

import { EventModel, ResourceModel, StringHelper } from "@bryntum/schedulerpro";
import { BryntumSchedulerPro, type BryntumSchedulerProProps } from "@bryntum/schedulerpro-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Booking, Resource } from "@/shared/types";
import type { MoveOutcome } from "@/lib/client/api";
import { BALANCE_LABEL, firstName, money, paypalRefs, SERVICE_META, STATE_META } from "@/lib/client/format";
import {
  DAY_END_HOUR,
  DAY_START_HOUR,
  dayWall,
  formatRange,
  isoToWall,
  wallToIso,
  WORK_END_HOUR,
  WORK_START_HOUR,
} from "@/lib/client/time";

export const WAITLIST_ROW = "__waitlist";
const WAITLIST_ROW_HEIGHT = 84;
const BUFFER_MIN = 30;

class BookingEventModel extends EventModel {
  static $name = "BookingEventModel";
  static fields = [
    { name: "state", type: "string" },
    { name: "rev", type: "string" },
  ];
}

class VanResourceModel extends ResourceModel {
  static $name = "VanResourceModel";
  static fields = [
    { name: "subtitle", type: "string" },
    { name: "kind", type: "string" },
  ];
}

const PROJECT = { eventModelClass: BookingEventModel, resourceModelClass: VanResourceModel };

const VIEW_PRESET = {
  base: "hourAndDay",
  tickWidth: 64,
  displayDateFormat: "h:mm A",
  timeResolution: { unit: "minute", increment: 15 },
  headers: [{ unit: "hour", dateFormat: "h A" }],
};

const TRANSITION = { changeEvent: true, removeEvent: true, insertRecord: true, removeRecord: true };

const enc = (v: string | number) => StringHelper.encodeHtml(String(v));

type Rec = {
  id: string | number;
  resourceId?: string | number | null;
  startDate: Date | string;
  endDate: Date | string;
  get(field: string): unknown;
  set(data: Record<string, unknown>): void;
};

type Props = BryntumSchedulerProProps;
type Fn<K extends keyof Props> = Extract<NonNullable<Props[K]>, (...args: never[]) => unknown>;
type Arg<K extends keyof Props> = Parameters<Fn<K>>[0];

const sameInstant = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();

const time = (d: Date | string | undefined) => (d instanceof Date ? d.getTime() : d ? new Date(d).getTime() : NaN);

interface EventData {
  id: string;
  resourceId: string;
  startDate: Date;
  endDate: Date;
  name: string;
  cls: string;
  state: string;
  rev: string;
  manuallyScheduled: true;
  draggable: boolean;
  resizable: boolean | string;
}

export interface TimelineProps {
  resources: Resource[];
  bookings: Booking[];
  day: string;
  timeZone: string;
  lastChange: Record<string, number>;
  selectedId: string | null;
  onSelect: (bookingId: string | null) => void;
  onMove: (bookingId: string, startAt: string, resourceId: string, durationMin?: number) => Promise<MoveOutcome>;
  onRefused: (message: string) => void;
  onMenu: (action: "replan" | "evidence" | "log", bookingId: string) => void;
}

function onTimelineOrWaitlist(b: Booking): boolean {
  if (b.state === "released" || b.state === "refunded") return false;
  if (b.waitlist || !b.resourceId) return b.state === "quoted" || b.state === "approved";
  return STATE_META[b.state].onTimeline;
}

/** Free windows of >= 45 min inside working hours, after the travel buffer. */
function openWindows(bookings: Booking[], resources: Resource[], day: string, tz: string) {
  const out: { id: string; resourceId: string; startDate: Date; endDate: Date; name: string; cls: string }[] = [];
  const dayStart = dayWall(day, WORK_START_HOUR).getTime();
  const dayEnd = dayWall(day, WORK_END_HOUR).getTime();
  for (const r of resources) {
    const jobs = bookings
      .filter((b) => b.resourceId === r.id && !b.waitlist && STATE_META[b.state].onTimeline)
      .map((b) => [isoToWall(b.startAt, tz).getTime(), isoToWall(b.endAt, tz).getTime()] as const)
      .sort((a, b) => a[0] - b[0]);
    let cursor = dayStart;
    const gaps: [number, number][] = [];
    for (const [s, e] of jobs) {
      const gapEnd = s - BUFFER_MIN * 60_000;
      if (gapEnd - cursor >= 45 * 60_000) gaps.push([cursor, gapEnd]);
      cursor = Math.max(cursor, e + BUFFER_MIN * 60_000);
    }
    if (dayEnd - cursor >= 45 * 60_000) gaps.push([cursor, dayEnd]);
    gaps.forEach(([s, e], i) => {
      const mins = Math.round((e - s) / 60_000);
      const label = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}` : `${mins}m`;
      out.push({ id: `open-${r.id}-${i}`, resourceId: r.id, startDate: new Date(s), endDate: new Date(e), name: `Open ${label}`, cls: "sl-open" });
    });
  }
  return out;
}

export default function Timeline(props: TimelineProps) {
  const { resources, bookings, day, lastChange } = props;
  const ref = useRef<BryntumSchedulerPro>(null);
  const propsRef = useRef(props);
  const bookingsById = useRef(new Map<string, Booking>());
  const prevState = useRef(new Map<string, string>());
  const flashUntil = useRef(new Map<string, number>());

  useEffect(() => {
    propsRef.current = props;
  });

  // Van rows share whatever height the panel has; the waitlist lane stays compact.
  const boxRef = useRef<HTMLDivElement>(null);
  const [vanRow, setVanRow] = useState(148);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      const next = Math.max(118, Math.min(230, Math.floor((h - 40 - WAITLIST_ROW_HEIGHT - 4) / Math.max(1, resources.length))));
      setVanRow((v) => (Math.abs(v - next) > 2 ? next : v));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [resources.length]);

  const startDate = useMemo(() => dayWall(day, DAY_START_HOUR), [day]);
  const endDate = useMemo(() => dayWall(day, DAY_END_HOUR), [day]);

  const visible = useMemo(() => bookings.filter(onTimelineOrWaitlist), [bookings]);

  // ---- push data into the Bryntum stores --------------------------------
  const sync = useCallback(() => {
    const scheduler = ref.current?.instance;
    if (!scheduler || scheduler.isDestroyed) return;
    const tz = propsRef.current.timeZone;
    const now = Date.now();

    bookingsById.current = new Map(bookings.map((b) => [b.id, b]));

    // resources: vans + the waitlist lane
    const counts = new Map<string, { jobs: number; held: number }>();
    for (const b of visible) {
      const key = b.waitlist || !b.resourceId ? WAITLIST_ROW : b.resourceId;
      const c = counts.get(key) ?? { jobs: 0, held: 0 };
      c.jobs += 1;
      if (["held", "pending", "confirmed"].includes(b.state)) c.held += Number(b.depositAmount);
      counts.set(key, c);
    }
    const resourceData = [
      ...resources.map((r) => {
        const c = counts.get(r.id) ?? { jobs: 0, held: 0 };
        return {
          id: r.id,
          name: r.name,
          kind: "van",
          subtitle: `${c.jobs} job${c.jobs === 1 ? "" : "s"} · ${money(c.held)} secured`,
          cls: "sl-row-van",
          rowHeight: vanRow,
        };
      }),
      {
        id: WAITLIST_ROW,
        name: "Waitlist",
        kind: "waitlist",
        subtitle: `${counts.get(WAITLIST_ROW)?.jobs ?? 0} waiting · requested times`,
        cls: "sl-row-waitlist",
        rowHeight: WAITLIST_ROW_HEIGHT,
      },
    ];
    const rStore = scheduler.resourceStore;
    const wantedR = new Set(resourceData.map((r) => r.id));
    const staleR = rStore.records.filter((r) => !wantedR.has(String(r.id)));
    if (staleR.length) rStore.remove(staleR);
    for (const r of resourceData) {
      const rec = rStore.getById(r.id) as unknown as Rec | undefined;
      if (!rec) rStore.add(r);
      else if (rec.get("subtitle") !== r.subtitle || rec.get("name") !== r.name || rec.get("rowHeight") !== r.rowHeight) {
        rec.set({ name: r.name, subtitle: r.subtitle, rowHeight: r.rowHeight });
      }
    }

    // events
    const items: EventData[] = visible.map((b) => {
      const prev = prevState.current.get(b.id);
      if (prev && prev !== b.state) flashUntil.current.set(b.id, now + 1800);
      const recent = (lastChange[b.id] ?? 0) > now - 1800;
      if (recent && !flashUntil.current.has(b.id)) flashUntil.current.set(b.id, now + 1800);
      const flashing = (flashUntil.current.get(b.id) ?? 0) > now;
      const lane = b.waitlist || !b.resourceId ? WAITLIST_ROW : b.resourceId;
      const cls = [
        `sl-state-${b.state}`,
        lane === WAITLIST_ROW ? "sl-waiting" : "",
        flashing ? "sl-flash" : "",
        b.balanceState === "paid" ? "sl-balance-paid" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return {
        id: b.id,
        resourceId: lane,
        startDate: isoToWall(b.startAt, tz),
        endDate: isoToWall(b.endAt, tz),
        name: b.customerName,
        cls,
        state: b.state,
        rev: `${b.updatedAt}|${b.state}|${b.balanceState}|${cls}|${b.paypalCaptureId ?? ""}|${b.paypalInvoiceId ?? ""}`,
        manuallyScheduled: true,
        draggable: b.state !== "disputed",
        resizable: lane === WAITLIST_ROW ? false : "end",
      };
    });
    for (const b of visible) prevState.current.set(b.id, b.state);

    const store = scheduler.eventStore;
    const wanted = new Set(items.map((i) => i.id));
    const stale = store.records.filter((r) => !wanted.has(String(r.id)));
    if (stale.length) store.remove(stale);
    const toAdd: EventData[] = [];
    for (const item of items) {
      const rec = store.getById(item.id) as unknown as Rec | undefined;
      if (!rec) {
        toAdd.push(item);
        continue;
      }
      const moved =
        String(rec.resourceId ?? rec.get("resourceId")) !== item.resourceId ||
        time(rec.startDate) !== item.startDate.getTime() ||
        time(rec.endDate) !== item.endDate.getTime();
      if (moved || rec.get("rev") !== item.rev) {
        rec.set({
          startDate: item.startDate,
          endDate: item.endDate,
          resourceId: item.resourceId,
          name: item.name,
          cls: item.cls,
          state: item.state,
          rev: item.rev,
          draggable: item.draggable,
          resizable: item.resizable,
        });
      }
    }
    if (toAdd.length) store.add(toAdd);

    // shaded off-hours + "open" windows
    const offHours = [
      { id: "pre", startDate: dayWall(day, DAY_START_HOUR), endDate: dayWall(day, WORK_START_HOUR), name: "", cls: "sl-offhours" },
      { id: "post", startDate: dayWall(day, WORK_END_HOUR), endDate: dayWall(day, DAY_END_HOUR), name: "", cls: "sl-offhours" },
    ];
    const nowWall = isoToWall(new Date(now).toISOString(), tz);
    if (nowWall > dayWall(day, DAY_START_HOUR) && nowWall < dayWall(day, DAY_END_HOUR)) {
      offHours.push({ id: "now", startDate: nowWall, endDate: nowWall, name: "now", cls: "sl-now" });
    }
    if (scheduler.timeRangeStore) scheduler.timeRangeStore.data = offHours;
    const rtr = scheduler.resourceTimeRangeStore;
    if (rtr) rtr.data = openWindows(bookings, resources, day, tz);

    // clear flashes once they have played
    const pending = [...flashUntil.current.entries()].filter(([, until]) => until > now);
    flashUntil.current = new Map(pending);
    return pending.length ? Math.max(...pending.map(([, u]) => u)) - now + 30 : 0;
  }, [bookings, visible, resources, day, lastChange, vanRow]);

  // finalize(true) after a drag/resize writes Bryntum's own values into the record; reconcile
  // with the server's booking right after, in case the server kept a different time or length.
  const syncRef = useRef(sync);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);
  const reconcileSoon = useCallback(() => {
    setTimeout(() => syncRef.current(), 0);
  }, []);

  useEffect(() => {
    const wait = sync();
    if (!wait) return;
    const t = setTimeout(() => sync(), wait);
    return () => clearTimeout(t);
  }, [sync]);

  // keep the "now" line moving
  useEffect(() => {
    const t = setInterval(() => sync(), 60_000);
    return () => clearInterval(t);
  }, [sync]);

  // ---- renderers ----------------------------------------------------------
  const eventRenderer = useCallback(({ eventRecord }: Arg<"eventRenderer">) => {
    const b = bookingsById.current.get(String(eventRecord.id));
    if (!b) return enc(String(eventRecord.get("name") ?? ""));
    const meta = STATE_META[b.state];
    const tz = propsRef.current.timeZone;
    const waiting = b.waitlist || !b.resourceId;
    const line2 = `${SERVICE_META[b.service].label} · ${formatRange(b.startAt, b.endAt, tz)}`;
    const amount = money(b.depositAmount, b.currency);
    const status = waiting ? `Waitlist · wants ${formatRange(b.startAt, b.endAt, tz)}` : `${meta.label}${b.balanceState !== "none" ? ` · ${BALANCE_LABEL[b.balanceState]}` : ""}`;
    return (
      `<div class="sl-ev">` +
      `<div class="sl-ev-top"><i class="sl-ev-icon fa ${meta.fa}" aria-hidden="true"></i>` +
      `<span class="sl-ev-name">${enc(b.customerName)}</span><span class="sl-ev-first">${enc(firstName(b.customerName))}</span>` +
      `<span class="sl-ev-amt">${enc(amount)}</span></div>` +
      `<div class="sl-ev-line">${enc(line2)}</div>` +
      `<div class="sl-ev-status">${enc(status)}</div>` +
      `</div>`
    );
  }, []);

  const tooltip = useMemo(
    () => ({
      allowOver: true,
      hideDelay: 120,
      template: ({ eventRecord }: { eventRecord: { id: string | number } }) => {
        const b = bookingsById.current.get(String(eventRecord.id));
        if (!b) return "";
        const tz = propsRef.current.timeZone;
        const meta = STATE_META[b.state];
        const refs = paypalRefs(b);
        const ids = refs.length
          ? refs.map((r) => `<div class="sl-tip-id"><span>${enc(r.label)}</span><code>${enc(r.value)}</code></div>`).join("")
          : `<div class="sl-tip-id sl-tip-muted">No PayPal objects yet: customer has not paid a deposit</div>`;
        return (
          `<div class="sl-tip">` +
          `<div class="sl-tip-head"><strong>${enc(b.customerName)}</strong><span class="sl-tip-state sl-tip-${b.state}"><i class="fa ${meta.fa}"></i> ${enc(meta.label)}</span></div>` +
          `<div class="sl-tip-sub">${enc(SERVICE_META[b.service].label)} · ${enc(formatRange(b.startAt, b.endAt, tz))}${b.waitlist ? " · waitlist" : ""}</div>` +
          `<div class="sl-tip-money"><div><span>Deposit</span><b>${enc(money(b.depositAmount, b.currency))}</b><em>${enc(meta.money)}</em></div>` +
          `<div><span>Balance</span><b>${enc(money(b.balanceAmount, b.currency))}</b><em>${enc(BALANCE_LABEL[b.balanceState])}</em></div></div>` +
          `<div class="sl-tip-ids"><div class="sl-tip-label">PayPal</div>${ids}</div>` +
          (b.notes ? `<div class="sl-tip-note">${enc(b.notes)}</div>` : "") +
          `<div class="sl-tip-foot">${enc(b.id)}${b.customerEmail ? ` · ${enc(b.customerEmail)}` : ""}</div>` +
          `</div>`
        );
      },
    }),
    [],
  );

  const columns = useMemo(
    () => [
      {
        field: "name",
        text: "Vans",
        width: 138,
        htmlEncode: false,
        sortable: false,
        renderer: ({ record }: { record: Rec }) => {
          const kind = record.get("kind");
          const icon = kind === "waitlist" ? "fa-hourglass-half" : "fa-van-shuttle";
          return (
            `<div class="sl-res sl-res-${enc(String(kind))}"><i class="fa ${icon}" aria-hidden="true"></i>` +
            `<div><div class="sl-res-name">${enc(String(record.get("name") ?? ""))}</div>` +
            `<div class="sl-res-sub">${enc(String(record.get("subtitle") ?? ""))}</div></div></div>`
          );
        },
      },
    ],
    [],
  );

  const eventMenu = useMemo(
    () => ({
      processItems: ({ eventRecord, items }: { eventRecord: Rec; items: Record<string, unknown> }) => {
        const b = bookingsById.current.get(String(eventRecord.id));
        for (const key of Object.keys(items)) {
          if (!["replan", "log", "evidence"].includes(key)) items[key] = false;
        }
        if (b?.state !== "disputed") items.evidence = false;
      },
      items: {
        replan: {
          text: "Ask the agent for options",
          icon: "fa fa-wand-magic-sparkles",
          weight: 100,
          onItem: ({ eventRecord }: { eventRecord: Rec }) => propsRef.current.onMenu("replan", String(eventRecord.id)),
        },
        log: {
          text: "Show this job in the log",
          icon: "fa fa-list",
          weight: 110,
          onItem: ({ eventRecord }: { eventRecord: Rec }) => propsRef.current.onMenu("log", String(eventRecord.id)),
        },
        evidence: {
          text: "Open evidence pack",
          icon: "fa fa-file-shield",
          weight: 120,
          onItem: ({ eventRecord }: { eventRecord: Rec }) => propsRef.current.onMenu("evidence", String(eventRecord.id)),
        },
      },
    }),
    [],
  );

  const dragFeature = useMemo(() => ({ constrainDragToTimeline: true, showExactDropPosition: true }), []);
  const resizeFeature = useMemo(() => ({ showExactResizePosition: true }), []);
  const timeRanges = useMemo(() => ({ showCurrentTimeLine: false, showHeaderElements: true }), []);

  // ---- drag & resize -> PATCH, revert on refusal ------------------------------
  const onBeforeEventDropFinalize = useCallback(
    ({ context }: Arg<"onBeforeEventDropFinalize">) => {
      const p = propsRef.current;
      const rec = context.eventRecord as unknown as Rec;
      const finalize = context.finalize as (ok: boolean) => void;
      const target = context.newResource ? String(context.newResource.id) : String(rec.resourceId ?? "");
      if (target === WAITLIST_ROW) {
        finalize(false);
        p.onRefused("Drop a job onto a van. To free a slot, ask the agent instead.");
        return;
      }
      context.async = true;
      const startAt = wallToIso(context.startDate, p.timeZone);
      p.onMove(String(rec.id), startAt, target)
        // keep Bryntum's drop only if the server took exactly that; otherwise revert and let the store apply the server's booking
        .then((o) => finalize(o.ok && sameInstant(o.booking.startAt, startAt) && o.booking.resourceId === target))
        .catch(() => finalize(false))
        .finally(reconcileSoon);
    },
    [reconcileSoon],
  );

  const onBeforeEventResizeFinalize = useCallback(
    async (event: Arg<"onBeforeEventResizeFinalize">) => {
      const ctx = ((event.context as object | undefined) ?? event) as { async: boolean; finalize: (ok: boolean) => void; eventRecord?: Rec; startDate: Date; endDate: Date };
      const rec = (ctx.eventRecord ?? (event.eventRecord as unknown as Rec)) as Rec;
      const p = propsRef.current;
      ctx.async = true;
      const startAt = wallToIso(ctx.startDate, p.timeZone);
      const durationMin = Math.round((ctx.endDate.getTime() - ctx.startDate.getTime()) / 60_000);
      p.onMove(String(rec.id), startAt, String(rec.resourceId ?? rec.get("resourceId")), durationMin)
        .then((o) => ctx.finalize(o.ok && sameInstant(o.booking.startAt, startAt) && o.booking.durationMin === durationMin))
        .catch(() => ctx.finalize(false))
        .finally(reconcileSoon);
    },
    [reconcileSoon],
  );

  const onEventClick = useCallback(({ eventRecord }: Arg<"onEventClick">) => {
    propsRef.current.onSelect(String(eventRecord.id));
  }, []);

  const onScheduleClick = useCallback(() => propsRef.current.onSelect(null), []);

  return (
    <div ref={boxRef} className="slotline-timeline h-full w-full">
      <BryntumSchedulerPro
        ref={ref}
        project={PROJECT}
        startDate={startDate}
        endDate={endDate}
        viewPreset={VIEW_PRESET}
        forceFit
        rowHeight={vanRow}
        barMargin={10}
        resourceMargin={10}
        eventStyle="bordered"
        eventLayout="stack"
        columns={columns}
        transition={TRANSITION}
        transitionDuration={520}
        zoomOnMouseWheel={false}
        zoomOnTimeAxisDoubleClick={false}
        allowOverlap
        eventRenderer={eventRenderer}
        eventTooltipFeature={tooltip}
        eventDragFeature={dragFeature}
        eventResizeFeature={resizeFeature}
        eventMenuFeature={eventMenu}
        timeRangesFeature={timeRanges}
        resourceTimeRangesFeature
        stripeFeature={false}
        eventDragCreateFeature={false}
        taskEditFeature={false}
        eventEditFeature={false}
        dependenciesFeature={false}
        dependencyEditFeature={false}
        scheduleMenuFeature={false}
        cellMenuFeature={false}
        headerMenuFeature={false}
        timeAxisHeaderMenuFeature={false}
        cellEditFeature={false}
        sortFeature={false}
        onEventClick={onEventClick}
        onScheduleClick={onScheduleClick}
        onBeforeEventDropFinalize={onBeforeEventDropFinalize}
        onBeforeEventResizeFinalize={onBeforeEventResizeFinalize}
      />
    </div>
  );
}
