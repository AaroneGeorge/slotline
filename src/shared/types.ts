/**
 * Slotline shared contract. Both the server (API routes, services) and the
 * browser (dashboard, booking page) import from here. Change it only by
 * agreement: it is the seam between the backend and frontend work streams.
 * Amounts are decimal strings ("45.00"), times are ISO-8601 UTC strings.
 */

export type BookingState =
  | "quoted" // created, no money yet; may be on the waitlist
  | "approved" // customer approved the PayPal order, authorization not yet created
  | "held" // PAYMENT.AUTHORIZATION.CREATED: deposit is held, slot is firm
  | "pending" // PAYMENT.CAPTURE.PENDING: capture in review
  | "confirmed" // PAYMENT.CAPTURE.COMPLETED: deposit captured
  | "declined" // PAYMENT.CAPTURE.DENIED or INSTRUMENT_DECLINED: slot at risk (amber)
  | "released" // PAYMENT.AUTHORIZATION.VOIDED or cancelled before money: slot free
  | "refunded" // PAYMENT.CAPTURE.REFUNDED: slot free, customer repaid
  | "disputed"; // CUSTOMER.DISPUTE.CREATED: flagged, evidence pack

export type BalanceState = "none" | "invoiced" | "paid";

export type Service = "screen" | "battery" | "diagnostic" | "water";

export interface Resource {
  id: string; // "van-1"
  name: string; // "Van 1 (Dana)"
  color?: string;
}

export interface Booking {
  id: string;
  resourceId: string | null; // null while on the waitlist
  waitlist: boolean;
  customerName: string;
  customerEmail: string | null;
  service: Service;
  startAt: string;
  endAt: string;
  durationMin: number;
  depositAmount: string;
  balanceAmount: string;
  currency: string; // "USD"
  state: BookingState;
  balanceState: BalanceState;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  paypalCaptureId: string | null;
  paypalRefundId: string | null;
  paypalInvoiceId: string | null;
  paypalDisputeId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type Actor = "customer" | "operator" | "agent" | "system" | "paypal";

export interface LogEntry {
  id: string;
  at: string;
  actor: Actor;
  kind: string; // "webhook.received" | "booking.state" | "plan.proposed" | "grant.minted" | "paypal.call" | ...
  message: string;
  bookingId: string | null;
  refs: Record<string, string>; // { eventId, orderId, authorizationId, captureId, invoiceId, grantId, planId, ... }
}

/** Normalised money events. Webhook names are used verbatim; API-result events are mapped to the same names. */
export type MoneyEventType =
  | "CHECKOUT.ORDER.APPROVED"
  | "PAYMENT.AUTHORIZATION.CREATED"
  | "PAYMENT.AUTHORIZATION.VOIDED"
  | "PAYMENT.CAPTURE.COMPLETED"
  | "PAYMENT.CAPTURE.DENIED"
  | "PAYMENT.CAPTURE.PENDING"
  | "PAYMENT.CAPTURE.REFUNDED"
  | "INVOICING.INVOICE.PAID"
  | "CUSTOMER.DISPUTE.CREATED";

export interface MoneyEvent {
  id: string; // PayPal event id, or "api:<uuid>" for API-result events, or "dev:<uuid>" for injected fixtures
  type: MoneyEventType;
  at: string;
  source: "webhook" | "api" | "dev";
  verified: boolean;
  bookingId: string | null;
  resource: Record<string, unknown>; // the PayPal resource object
  refs: Record<string, string>;
}

export type PlanActionType =
  | "move" // params: { startAt, resourceId }
  | "promote" // params: { startAt, resourceId } waitlist -> timeline (customer still has to pay a deposit)
  | "void" // void the authorization (money)
  | "capture" // capture the authorization (money)
  | "refund" // params: { amount? } (money)
  | "send_invoice" // create + send the balance invoice (money-adjacent, needs grant)
  | "send_reminder" // invoice reminder (needs grant)
  | "message" // params: { channel: "email"|"sms", subject?, body }
  | "flag_dispute"; // assemble the evidence pack

export interface PlanAction {
  id: string;
  type: PlanActionType;
  bookingId: string;
  params: Record<string, unknown>;
  /** set by the solver/validator in code, never by the model */
  feasible: boolean;
  infeasibleReason: string | null;
  /** money actions carry the amount the grant must cover */
  amount: string | null;
  currency: string | null;
}

export interface PlanOption {
  id: string;
  title: string;
  rationale: string;
  actions: PlanAction[];
}

export interface DraftMessage {
  bookingId: string;
  channel: "email" | "sms";
  subject: string | null;
  body: string;
}

export type PlanStatus = "proposed" | "approved" | "executed" | "failed" | "rejected" | "expired";

export interface Plan {
  id: string;
  createdAt: string;
  trigger: { eventType: MoneyEventType | "manual"; bookingId: string | null; eventId: string | null };
  provider: "anthropic" | "gemini" | "groq" | "rules";
  summary: string;
  options: PlanOption[];
  draftMessages: DraftMessage[];
  status: PlanStatus;
  chosenOptionId: string | null;
  grantId: string | null;
  error: string | null;
}

/** An execution grant minted only by an operator approval. */
export interface Grant {
  id: string;
  planId: string;
  optionId: string;
  bookingIds: string[];
  allowedActions: PlanActionType[];
  maxAmount: string;
  currency: string;
  issuedAt: string;
  expiresAt: string; // issuedAt + 15 minutes
  approvedBy: "operator";
  status: "active" | "used" | "expired" | "revoked";
  usedAt: string | null;
}

export interface AppMode {
  paypal: "sandbox" | "mock";
  llm: "anthropic" | "gemini" | "groq" | "rules";
  devTools: boolean;
}

/** GET /api/state */
export interface StateResponse {
  resources: Resource[];
  bookings: Booking[];
  plans: Plan[]; // open (proposed) plans first, then the last 10 others
  log: LogEntry[]; // newest first, max 200
  mode: AppMode;
  day: string; // "2026-11-05" operator day shown on the timeline
  /** additive (Stream B): IANA zone of the operator day, e.g. "America/Los_Angeles"; UI falls back to that when absent */
  timeZone?: string;
  /** additive (Stream B): grants referenced by `plans`, so a reload can still show grant expiry */
  grants?: Grant[];
}

/** GET /api/stream (text/event-stream), one JSON StreamEvent per message */
export type StreamEvent =
  | { type: "hello"; mode: AppMode }
  | { type: "booking.updated"; booking: Booking }
  | { type: "booking.removed"; bookingId: string }
  | { type: "plan.created"; plan: Plan }
  | { type: "plan.updated"; plan: Plan }
  | { type: "grant.updated"; grant: Grant }
  | { type: "log"; entry: LogEntry };

/** POST /api/bookings */
export interface CreateBookingRequest {
  customerName: string;
  customerEmail?: string;
  service: Service;
  startAt: string;
  resourceId?: string; // omit = first feasible van, or waitlist
}
export interface CreateBookingResponse {
  booking: Booking;
}

/** POST /api/bookings/:id/order -> creates the PayPal order (intent AUTHORIZE) for the deposit */
export interface CreateOrderResponse {
  orderId: string;
}

/** POST /api/bookings/:id/authorize  { orderId } -> server authorizes the approved order */
export interface AuthorizeRequest {
  orderId: string;
}
export interface AuthorizeResponse {
  booking: Booking;
  authorizationId: string;
}

/** Operator money actions. Each needs an active grant unless `mode.devTools` and the x-dev-secret header are present. */
export interface GrantedActionRequest {
  grantId?: string;
  /** sandbox negative testing, capture only: e.g. "INSTRUMENT_DECLINED", "TRANSACTION_REFUSED" */
  mockResponse?: string;
  amount?: string; // refund only
}

/** PATCH /api/bookings/:id  (operator drag/drop on the timeline) */
export interface MoveBookingRequest {
  startAt: string;
  resourceId: string;
  /** additive (Stream B): sent on timeline resize; servers that ignore it keep the service duration and the UI snaps back */
  durationMin?: number;
}
export interface MoveBookingResponse {
  booking: Booking;
  conflicts: string[]; // empty when applied
}

/** POST /api/plans/:id/approve { optionId } -> mints a grant and executes the option */
export interface ApprovePlanRequest {
  optionId: string;
}
export interface ApprovePlanResponse {
  plan: Plan;
  grant: Grant;
  results: { actionId: string; ok: boolean; detail: string; refs: Record<string, string> }[];
}

/** POST /api/plans/propose { bookingId?, eventType? } manual re-plan */
export interface ProposePlanRequest {
  bookingId?: string;
  eventType?: MoneyEventType | "manual";
}

/** POST /api/dev/inject  header x-dev-secret */
export type DevFixture =
  | "capture.denied"
  | "capture.pending"
  | "capture.refunded"
  | "authorization.voided"
  | "dispute.created"
  | "invoice.paid";
export interface DevInjectRequest {
  fixture: DevFixture;
  bookingId: string;
}

/** GET /api/config/public */
export interface PublicConfig {
  paypalClientId: string | null;
  currency: string;
  mode: AppMode;
  /** additive (Stream B): operator time zone for the booking page's slot picker */
  timeZone?: string;
}

/**
 * additive (Stream B): GET /api/bookings/:id/evidence. Everything except `booking`
 * is optional; PayPal objects are passed through as returned by the API.
 */
export interface EvidencePack {
  booking: Booking;
  generatedAt?: string;
  order?: Record<string, unknown> | null;
  authorization?: Record<string, unknown> | null;
  capture?: Record<string, unknown> | null;
  refund?: Record<string, unknown> | null;
  invoice?: Record<string, unknown> | null;
  dispute?: Record<string, unknown> | null;
  /** log entries for the booking, oldest first */
  timeline?: LogEntry[];
  events?: MoneyEvent[];
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Additive (Stream A, pass 1): evidence pack and dev-tool responses.

/**
 * Additive (Stream A): extra optional fields on Stream B's EvidencePack
 * (interface merging; Stream B's declaration above is unchanged). `events`
 * items are full MoneyEvents plus receivedAt/outcome/detail.
 */
export interface EvidencePack {
  /** Human-readable facts in time order. */
  facts?: string[];
  resource?: Resource | null;
  /** Where the PayPal objects came from: live API reads, or the recorded event payloads. */
  paypalSource?: "api" | "events";
  plans?: Plan[];
  grants?: Grant[];
}

/** POST /api/dev/inject response */
export interface DevInjectResponse {
  eventId: string;
  outcome: string; // "applied" | "idempotent" | "stale" | "illegal" | "unmatched" | "duplicate"
  booking: Booking | null;
  plan: Plan | null;
}

/** POST /api/dev/replay (header x-dev-secret): re-deliver a recorded event; omit eventId for the latest webhook/dev event. */
export interface DevReplayRequest {
  eventId?: string;
}
export interface DevReplayResponse {
  eventId: string;
  outcome: string; // "duplicate" when the replay was ignored
  httpStatus: number; // what the webhook endpoint answered (200 for a replay)
}

// ---------------------------------------------------------------------------
// Additive (pass 2): operator sign-in, public availability, the customer's view of a booking.

/** GET /api/auth/me; also the body of POST /api/auth/login and POST /api/auth/logout. */
export interface AuthMeResponse {
  authenticated: boolean;
  /**
   * "password": OPERATOR_PASSWORD is set and operator routes need the session cookie.
   * "open": development without OPERATOR_PASSWORD (no sign-in needed).
   * "locked": production without OPERATOR_PASSWORD (every operator route answers 401).
   */
  mode: "password" | "open" | "locked";
  expiresAt: string | null;
}

/** POST /api/auth/login */
export interface LoginRequest {
  password: string;
}

/** One van at one start time, as the solver sees it. No customer data. */
export interface AvailabilitySlot {
  startAt: string;
  endAt: string;
  resourceId: string;
  available: boolean;
}

/** GET /api/availability?day=YYYY-MM-DD[&service=screen|battery|diagnostic|water] (public; slots last the service's duration, 30 min when omitted) */
export interface AvailabilityResponse {
  day: string;
  timeZone: string;
  slots: AvailabilitySlot[];
}

/** GET /api/bookings/:id (public, for the /book?booking=<id> resume link): the booking holder's essentials only. */
export type PublicBookingView = Pick<
  Booking,
  | "id"
  | "service"
  | "startAt"
  | "endAt"
  | "durationMin"
  | "resourceId"
  | "waitlist"
  | "customerName"
  | "depositAmount"
  | "balanceAmount"
  | "currency"
  | "state"
  | "paypalOrderId"
  | "paypalAuthorizationId"
>;
