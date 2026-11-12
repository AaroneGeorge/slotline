/**
 * Typed browser client for the Slotline API (BUILD-PLAN §5). Every call goes
 * through `request`, which turns non-2xx responses into `ApiRequestError`
 * carrying the server's `{ error, code, details }` body.
 */
import type {
  ApiError,
  ApprovePlanRequest,
  ApprovePlanResponse,
  AuthMeResponse,
  AuthorizeRequest,
  AuthorizeResponse,
  AvailabilityResponse,
  Booking,
  CreateBookingRequest,
  CreateBookingResponse,
  CreateOrderResponse,
  DevInjectRequest,
  DevInjectResponse,
  DevReplayResponse,
  GrantedActionRequest,
  MoveBookingRequest,
  MoveBookingResponse,
  Plan,
  ProposePlanRequest,
  PublicBookingView,
  PublicConfig,
  Service,
  StateResponse,
} from "@/shared/types";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;
  readonly body: unknown;

  constructor(status: number, body: unknown, fallback: string) {
    const b = (body && typeof body === "object" ? body : {}) as Partial<ApiError>;
    super(typeof b.error === "string" && b.error ? b.error : fallback);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = typeof b.code === "string" ? b.code : undefined;
    this.details = b.details;
    this.body = body;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.code ? `${err.message} (${err.code})` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: "no-store",
      signal: opts.signal,
    });
  } catch (err) {
    throw new ApiRequestError(0, { error: "Network error: is the Slotline server running?", code: "network" }, String(err));
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
  }
  if (!res.ok) throw new ApiRequestError(res.status, data, `${res.status} ${res.statusText}`);
  return data as T;
}

/** Result of a drag/resize on the timeline. */
export type MoveOutcome =
  | { ok: true; booking: Booking }
  | { ok: false; conflicts: string[]; booking: Booking | null; message: string };

export type MoneyAction = "capture" | "void" | "refund" | "invoice" | "remind";

export interface MoneyActionResponse {
  booking: Booking;
  refs: Record<string, string>;
}

/** Reads the conflicts list from a 409 body, whatever exact shape the server chose. */
export function conflictsFrom(err: ApiRequestError): string[] {
  const body = (err.body ?? {}) as { conflicts?: unknown; details?: { conflicts?: unknown } | unknown };
  const list =
    (Array.isArray(body.conflicts) && body.conflicts) ||
    (body.details && typeof body.details === "object" && Array.isArray((body.details as { conflicts?: unknown }).conflicts)
      ? ((body.details as { conflicts: unknown[] }).conflicts as unknown[])
      : null);
  if (list && list.length) return list.map(String);
  return [err.message];
}

function devHeaders(secret?: string): Record<string, string> {
  return secret ? { "x-dev-secret": secret } : {};
}

export const api = {
  state: (signal?: AbortSignal) => request<StateResponse>("/api/state", { signal }),
  publicConfig: () => request<PublicConfig>("/api/config/public"),

  createBooking: (req: CreateBookingRequest) =>
    request<CreateBookingResponse>("/api/bookings", { method: "POST", body: req }),
  createOrder: (bookingId: string) =>
    request<CreateOrderResponse>(`/api/bookings/${encodeURIComponent(bookingId)}/order`, { method: "POST", body: {} }),
  authorize: (bookingId: string, req: AuthorizeRequest) =>
    request<AuthorizeResponse>(`/api/bookings/${encodeURIComponent(bookingId)}/authorize`, { method: "POST", body: req }),

  moneyAction: (bookingId: string, action: MoneyAction, req: GrantedActionRequest, devSecret?: string) =>
    request<MoneyActionResponse>(`/api/bookings/${encodeURIComponent(bookingId)}/${action}`, {
      method: "POST",
      body: req,
      headers: devHeaders(devSecret),
    }),

  async moveBooking(bookingId: string, req: MoveBookingRequest): Promise<MoveOutcome> {
    try {
      const res = await request<MoveBookingResponse>(`/api/bookings/${encodeURIComponent(bookingId)}`, {
        method: "PATCH",
        body: req,
      });
      if (res.conflicts && res.conflicts.length) {
        return { ok: false, conflicts: res.conflicts, booking: res.booking ?? null, message: "Move refused" };
      }
      return { ok: true, booking: res.booking };
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        const body = (err.body ?? {}) as { booking?: Booking };
        return { ok: false, conflicts: conflictsFrom(err), booking: body.booking ?? null, message: err.message };
      }
      throw err;
    }
  },

  evidence: (bookingId: string) => request<unknown>(`/api/bookings/${encodeURIComponent(bookingId)}/evidence`),

  plan: (planId: string) => request<{ plan: Plan } | Plan>(`/api/plans/${encodeURIComponent(planId)}`),
  approvePlan: (planId: string, req: ApprovePlanRequest) =>
    request<ApprovePlanResponse>(`/api/plans/${encodeURIComponent(planId)}/approve`, { method: "POST", body: req }),
  rejectPlan: (planId: string) =>
    request<{ plan?: Plan } | Plan>(`/api/plans/${encodeURIComponent(planId)}/reject`, { method: "POST", body: {} }),
  proposePlan: (req: ProposePlanRequest) =>
    request<{ plan: Plan }>("/api/plans/propose", { method: "POST", body: req }),

  devSeed: (secret: string) => request<unknown>("/api/dev/seed", { method: "POST", body: {}, headers: devHeaders(secret) }),
  devInject: (secret: string, req: DevInjectRequest) =>
    request<DevInjectResponse>("/api/dev/inject", { method: "POST", body: req, headers: devHeaders(secret) }),
  devReplay: (secret: string, eventId?: string) =>
    request<DevReplayResponse>("/api/dev/replay", { method: "POST", body: eventId ? { eventId } : {}, headers: devHeaders(secret) }),

  booking: (bookingId: string) => request<{ booking: PublicBookingView }>(`/api/bookings/${encodeURIComponent(bookingId)}`),
  availability: (day: string, service?: Service) =>
    request<AvailabilityResponse>(`/api/availability?day=${encodeURIComponent(day)}${service ? `&service=${encodeURIComponent(service)}` : ""}`),

  authMe: () => request<AuthMeResponse>("/api/auth/me"),
  login: (password: string) => request<AuthMeResponse>("/api/auth/login", { method: "POST", body: { password } }),
  logout: () => request<AuthMeResponse>("/api/auth/logout", { method: "POST", body: {} }),
};

/** True when the error is the operator gate's 401 (signed out or session expired). */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 401;
}

/** Plans may come back bare or wrapped as `{ plan }`. */
export function unwrapPlan(value: unknown): Plan | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { plan?: unknown; id?: unknown; options?: unknown };
  if (v.plan && typeof v.plan === "object") return v.plan as Plan;
  if (typeof v.id === "string" && Array.isArray(v.options)) return value as Plan;
  return null;
}
