/**
 * The UI talks to a `SlotlineBackend`: either the live API (fetch + SSE) or
 * the in-browser demo simulation behind `?demo=1`. Both speak the shared
 * contract in src/shared/types.ts, so components never know which one they have.
 */
import type {
  ApprovePlanRequest,
  ApprovePlanResponse,
  AuthorizeRequest,
  AuthorizeResponse,
  AvailabilityResponse,
  CreateBookingRequest,
  CreateBookingResponse,
  CreateOrderResponse,
  DevInjectRequest,
  DevInjectResponse,
  DevReplayResponse,
  GrantedActionRequest,
  MoveBookingRequest,
  Plan,
  ProposePlanRequest,
  PublicBookingView,
  PublicConfig,
  Service,
  StateResponse,
  StreamEvent,
} from "@/shared/types";
import { api, ApiRequestError, unwrapPlan, type MoneyAction, type MoneyActionResponse, type MoveOutcome } from "./api";
import { connectStream, type ConnStatus } from "./stream";

export interface SlotlineBackend {
  kind: "live" | "demo";
  state(): Promise<StateResponse>;
  publicConfig(): Promise<PublicConfig>;
  subscribe(handlers: {
    onEvent: (e: StreamEvent) => void;
    onStatus: (s: ConnStatus) => void;
    onOpen: () => void;
  }): () => void;
  createBooking(req: CreateBookingRequest): Promise<CreateBookingResponse>;
  createOrder(bookingId: string): Promise<CreateOrderResponse>;
  authorize(bookingId: string, req: AuthorizeRequest): Promise<AuthorizeResponse>;
  moneyAction(bookingId: string, action: MoneyAction, req: GrantedActionRequest, devSecret?: string): Promise<MoneyActionResponse>;
  moveBooking(bookingId: string, req: MoveBookingRequest): Promise<MoveOutcome>;
  evidence(bookingId: string): Promise<unknown>;
  approvePlan(planId: string, req: ApprovePlanRequest): Promise<ApprovePlanResponse>;
  rejectPlan(planId: string): Promise<Plan | null>;
  proposePlan(req: ProposePlanRequest): Promise<Plan | null>;
  devSeed(secret: string): Promise<unknown>;
  devInject(secret: string, req: DevInjectRequest): Promise<DevInjectResponse>;
  /** re-deliver the latest recorded webhook (or `eventId`): must be a no-op */
  devReplay(secret: string, eventId?: string): Promise<DevReplayResponse>;
  /** one booking, for the booking-link resume on /book (public: the holder's essentials only) */
  booking(bookingId: string): Promise<PublicBookingView | null>;
  /** public free/busy per van for /book (no customer data) */
  availability(day: string, service: Service): Promise<AvailabilityResponse>;
}

export const liveBackend: SlotlineBackend = {
  kind: "live",
  state: () => api.state(),
  publicConfig: () => api.publicConfig(),
  subscribe: (handlers) =>
    connectStream({
      ...handlers,
      // EventSource hides the HTTP status of a failed stream; ask whether we are still signed in before retrying.
      stillSignedIn: async () => {
        try {
          return (await api.authMe()).authenticated;
        } catch {
          return true; // server unreachable: keep retrying
        }
      },
    }),
  createBooking: (req) => api.createBooking(req),
  createOrder: (id) => api.createOrder(id),
  authorize: (id, req) => api.authorize(id, req),
  moneyAction: (id, action, req, secret) => api.moneyAction(id, action, req, secret),
  moveBooking: (id, req) => api.moveBooking(id, req),
  evidence: (id) => api.evidence(id),
  approvePlan: (id, req) => api.approvePlan(id, req),
  rejectPlan: async (id) => unwrapPlan(await api.rejectPlan(id)),
  proposePlan: async (req) => unwrapPlan(await api.proposePlan(req)),
  devSeed: (secret) => api.devSeed(secret),
  devInject: (secret, req) => api.devInject(secret, req),
  devReplay: (secret, eventId) => api.devReplay(secret, eventId),
  booking: async (id) => {
    try {
      return (await api.booking(id)).booking ?? null;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) return null;
      throw err;
    }
  },
  availability: (day, service) => api.availability(day, service),
};

let demoBackend: { scene: string; backend: Promise<SlotlineBackend> } | null = null;

/**
 * Lazily loads the demo simulation so the live bundle never pays for it. One
 * simulation per page load: client-side navigation between `/`, `/book` and
 * `/evidence` keeps it, so a demo booking shows up on the dashboard. Passing a
 * different `scene` starts a fresh one.
 */
export function getBackend(demo: boolean, scene?: string | null): Promise<SlotlineBackend> {
  if (!demo) return Promise.resolve(liveBackend);
  const key = scene ?? "";
  if (!demoBackend || (key && demoBackend.scene !== key)) {
    demoBackend = {
      scene: key,
      backend: import("./demo-backend").then((m) => m.createDemoBackend(key || undefined)),
    };
  }
  return demoBackend.backend;
}
