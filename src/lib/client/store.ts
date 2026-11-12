"use client";

/**
 * Dashboard state: a reducer fed by the GET /api/state snapshot, the SSE
 * stream, and API responses (optimistic reconcile). Bookings only move
 * forward in time: an update older than what we hold is ignored, so a late
 * snapshot cannot undo a fresher stream event.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  AppMode,
  ApprovePlanResponse,
  Booking,
  Grant,
  LogEntry,
  Plan,
  Resource,
  StateResponse,
  StreamEvent,
} from "@/shared/types";
import { errorMessage, isUnauthorized } from "./api";
import { getBackend, type SlotlineBackend } from "./backend";
import type { ConnStatus } from "./stream";
import { DEFAULT_OPERATOR_TZ } from "./time";

export interface DashState {
  status: "loading" | "ready" | "error";
  error: string | null;
  resources: Resource[];
  bookings: Record<string, Booking>;
  plans: Record<string, Plan>;
  grants: Record<string, Grant>;
  log: LogEntry[];
  mode: AppMode | null;
  day: string | null;
  timeZone: string;
  conn: ConnStatus;
  approvals: Record<string, ApprovePlanResponse>;
  /** bookingId -> ms timestamp of its last state change, for the timeline flash */
  lastChange: Record<string, number>;
  /** id of the most recently created plan, to pull the Agent tab forward */
  latestPlanId: string | null;
  lastEventAt: number | null;
}

export type DashAction =
  | { type: "reset" }
  | { type: "snapshot"; state: StateResponse }
  | { type: "stream"; event: StreamEvent }
  | { type: "conn"; conn: ConnStatus }
  | { type: "error"; error: string }
  | { type: "booking"; booking: Booking }
  | { type: "plan"; plan: Plan }
  | { type: "grant"; grant: Grant }
  | { type: "approval"; planId: string; response: ApprovePlanResponse };

export const initialDashState: DashState = {
  status: "loading",
  error: null,
  resources: [],
  bookings: {},
  plans: {},
  grants: {},
  log: [],
  mode: null,
  day: null,
  timeZone: DEFAULT_OPERATOR_TZ,
  conn: "connecting",
  approvals: {},
  lastChange: {},
  latestPlanId: null,
  lastEventAt: null,
};

const LOG_CAP = 300;

function upsertBooking(state: DashState, b: Booking): DashState {
  const prev = state.bookings[b.id];
  if (prev && prev.updatedAt > b.updatedAt) return state;
  const lastChange = prev && prev.state !== b.state ? { ...state.lastChange, [b.id]: Date.now() } : state.lastChange;
  return { ...state, bookings: { ...state.bookings, [b.id]: b }, lastChange };
}

function upsertPlan(state: DashState, p: Plan, created: boolean): DashState {
  return {
    ...state,
    plans: { ...state.plans, [p.id]: p },
    latestPlanId: created ? p.id : state.latestPlanId,
  };
}

function addLog(state: DashState, entry: LogEntry): DashState {
  if (state.log.some((l) => l.id === entry.id)) return state;
  const log = [entry, ...state.log];
  log.sort((a, b) => b.at.localeCompare(a.at));
  return { ...state, log: log.slice(0, LOG_CAP) };
}

export function dashReducer(state: DashState, action: DashAction): DashState {
  switch (action.type) {
    case "reset":
      return initialDashState;
    case "snapshot": {
      const s = action.state;
      const bookings: Record<string, Booking> = {};
      const lastChange = { ...state.lastChange };
      for (const b of s.bookings) {
        const prev = state.bookings[b.id];
        if (prev && prev.updatedAt > b.updatedAt) {
          bookings[b.id] = prev;
          continue;
        }
        bookings[b.id] = b;
        if (prev && prev.state !== b.state) lastChange[b.id] = Date.now();
      }
      const plans: Record<string, Plan> = {};
      for (const p of s.plans) plans[p.id] = p;
      const grants = { ...state.grants };
      for (const g of s.grants ?? []) grants[g.id] = g;
      const seen = new Set<string>();
      const log = [...s.log].filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
      log.sort((a, b) => b.at.localeCompare(a.at));
      return {
        ...state,
        status: "ready",
        error: null,
        resources: s.resources,
        bookings,
        plans,
        grants,
        log: log.slice(0, LOG_CAP),
        mode: s.mode,
        day: s.day,
        timeZone: s.timeZone || state.timeZone,
        lastChange,
      };
    }
    case "stream": {
      const e = action.event;
      const next = { ...state, lastEventAt: Date.now() };
      switch (e.type) {
        case "hello":
          return { ...next, mode: e.mode };
        case "booking.updated":
          return upsertBooking(next, e.booking);
        case "booking.removed": {
          if (!next.bookings[e.bookingId]) return next;
          const bookings = { ...next.bookings };
          delete bookings[e.bookingId];
          return { ...next, bookings };
        }
        case "plan.created":
          return upsertPlan(next, e.plan, true);
        case "plan.updated":
          return upsertPlan(next, e.plan, false);
        case "grant.updated":
          return { ...next, grants: { ...next.grants, [e.grant.id]: e.grant } };
        case "log":
          return addLog(next, e.entry);
        default:
          return next;
      }
    }
    case "conn":
      return { ...state, conn: action.conn };
    case "error":
      return state.status === "ready" ? state : { ...state, status: "error", error: action.error };
    case "booking":
      return upsertBooking(state, action.booking);
    case "plan":
      return upsertPlan(state, action.plan, false);
    case "grant":
      return { ...state, grants: { ...state.grants, [action.grant.id]: action.grant } };
    case "approval": {
      const s1 = upsertPlan(state, action.response.plan, false);
      return {
        ...s1,
        grants: { ...s1.grants, [action.response.grant.id]: action.response.grant },
        approvals: { ...s1.approvals, [action.planId]: action.response },
      };
    }
  }
}

/**
 * Loads state, subscribes to the stream, and polls as a fallback while the
 * stream is down. A 401 (signed out, session expired) calls `onUnauthorized`
 * instead of retrying, so nothing loops against the operator gate.
 */
export function useSlotline(demo: boolean, scene: string | null, onUnauthorized?: () => void) {
  const [state, dispatch] = useReducer(dashReducer, initialDashState);
  const [backend, setBackend] = useState<SlotlineBackend | null>(null);
  const connRef = useRef<ConnStatus>("connecting");
  const unauthorizedRef = useRef(onUnauthorized);
  useEffect(() => {
    unauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  useEffect(() => {
    let cancelled = false;
    getBackend(demo, scene).then((b) => {
      if (!cancelled) setBackend(b);
    });
    return () => {
      cancelled = true;
    };
  }, [demo, scene]);

  const resync = useCallback(async () => {
    if (!backend) return;
    try {
      const s = await backend.state();
      dispatch({ type: "snapshot", state: s });
    } catch (err) {
      if (isUnauthorized(err)) {
        connRef.current = "unauthorized";
        dispatch({ type: "conn", conn: "unauthorized" });
        unauthorizedRef.current?.();
        return;
      }
      dispatch({ type: "error", error: errorMessage(err) });
    }
  }, [backend]);

  useEffect(() => {
    if (!backend) return;
    dispatch({ type: "reset" });
    void resync();
    const unsubscribe = backend.subscribe({
      onEvent: (event) => dispatch({ type: "stream", event }),
      onStatus: (conn) => {
        connRef.current = conn;
        dispatch({ type: "conn", conn });
        if (conn === "unauthorized") unauthorizedRef.current?.();
      },
      onOpen: () => void resync(),
    });
    return unsubscribe;
  }, [backend, resync]);

  // Fallback: if the stream is not live, poll the state so the board never goes stale.
  useEffect(() => {
    if (!backend || backend.kind === "demo") return;
    const t = setInterval(() => {
      if (connRef.current === "connecting" || connRef.current === "reconnecting") void resync();
    }, 5000);
    return () => clearInterval(t);
  }, [backend, resync]);

  return { state, dispatch, backend, resync };
}
