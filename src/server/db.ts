/**
 * SQLite persistence (better-sqlite3, synchronous, WAL). One process, one
 * connection, cached on globalThis so Next.js route bundles and HMR share it.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  Actor,
  BalanceState,
  Booking,
  BookingState,
  Grant,
  LogEntry,
  MoneyEvent,
  MoneyEventType,
  Plan,
  PlanActionType,
  PublicBookingView,
  Resource,
  Service,
} from "@/shared/types";
import { databasePath } from "./config";

type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  resource_id TEXT,
  waitlist INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT NOT NULL,
  customer_email TEXT,
  service TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  deposit_amount TEXT NOT NULL,
  balance_amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  state TEXT NOT NULL,
  balance_state TEXT NOT NULL,
  paypal_order_id TEXT,
  paypal_authorization_id TEXT,
  paypal_capture_id TEXT,
  paypal_refund_id TEXT,
  paypal_invoice_id TEXT,
  paypal_dispute_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_order ON bookings(paypal_order_id);
CREATE INDEX IF NOT EXISTS bookings_auth ON bookings(paypal_authorization_id);
CREATE INDEX IF NOT EXISTS bookings_capture ON bookings(paypal_capture_id);
CREATE INDEX IF NOT EXISTS bookings_invoice ON bookings(paypal_invoice_id);
CREATE INDEX IF NOT EXISTS bookings_dispute ON bookings(paypal_dispute_id);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  verified INTEGER NOT NULL,
  booking_id TEXT,
  resource_json TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'received',
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_booking ON events(booking_id);
CREATE TABLE IF NOT EXISTS log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  booking_id TEXT,
  refs_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_booking ON log(booking_id);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  summary TEXT NOT NULL,
  options_json TEXT NOT NULL,
  drafts_json TEXT NOT NULL,
  status TEXT NOT NULL,
  chosen_option_id TEXT,
  grant_id TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  option_id TEXT,
  booking_ids_json TEXT NOT NULL,
  allowed_actions_json TEXT NOT NULL,
  max_amount TEXT NOT NULL,
  spent_amount TEXT NOT NULL DEFAULT '0.00',
  currency TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  status TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  paypal_invoice_id TEXT,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  qr_png_base64 TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invoices_booking ON invoices(booking_id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mock_objects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL
);
`;

const g = globalThis as unknown as { __slotlineDb?: { db: DB; path: string } };

export function getDb(): DB {
  const wanted = databasePath();
  if (g.__slotlineDb && g.__slotlineDb.path === wanted && g.__slotlineDb.db.open) return g.__slotlineDb.db;
  if (g.__slotlineDb?.db.open) g.__slotlineDb.db.close();
  if (wanted !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(wanted)), { recursive: true });
  const db = new Database(wanted);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  g.__slotlineDb = { db, path: wanted };
  return db;
}

/** Tests: drop the cached connection and start from an empty database. */
export function resetDbForTests(): DB {
  if (g.__slotlineDb?.db.open) g.__slotlineDb.db.close();
  g.__slotlineDb = undefined;
  return getDb();
}

export function tx<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

// ---------------------------------------------------------------- helpers

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- resources

interface ResourceRow {
  id: string;
  name: string;
  color: string | null;
  sort: number;
}

export function listResources(): Resource[] {
  const rows = getDb().prepare("SELECT * FROM resources ORDER BY sort, id").all() as ResourceRow[];
  return rows.map((r) => ({ id: r.id, name: r.name, ...(r.color ? { color: r.color } : {}) }));
}

export function upsertResource(r: Resource, sort = 0): void {
  getDb()
    .prepare("INSERT INTO resources (id, name, color, sort) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, sort=excluded.sort")
    .run(r.id, r.name, r.color ?? null, sort);
}

// ---------------------------------------------------------------- bookings

interface BookingRow {
  id: string;
  resource_id: string | null;
  waitlist: number;
  customer_name: string;
  customer_email: string | null;
  service: string;
  start_at: string;
  end_at: string;
  duration_min: number;
  deposit_amount: string;
  balance_amount: string;
  currency: string;
  state: string;
  balance_state: string;
  paypal_order_id: string | null;
  paypal_authorization_id: string | null;
  paypal_capture_id: string | null;
  paypal_refund_id: string | null;
  paypal_invoice_id: string | null;
  paypal_dispute_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function rowToBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    resourceId: r.resource_id,
    waitlist: r.waitlist === 1,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    service: r.service as Service,
    startAt: r.start_at,
    endAt: r.end_at,
    durationMin: r.duration_min,
    depositAmount: r.deposit_amount,
    balanceAmount: r.balance_amount,
    currency: r.currency,
    state: r.state as BookingState,
    balanceState: r.balance_state as BalanceState,
    paypalOrderId: r.paypal_order_id,
    paypalAuthorizationId: r.paypal_authorization_id,
    paypalCaptureId: r.paypal_capture_id,
    paypalRefundId: r.paypal_refund_id,
    paypalInvoiceId: r.paypal_invoice_id,
    paypalDisputeId: r.paypal_dispute_id,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getBooking(id: string): Booking | null {
  const r = getDb().prepare("SELECT * FROM bookings WHERE id = ?").get(id) as BookingRow | undefined;
  return r ? rowToBooking(r) : null;
}

/** What GET /api/bookings/:id (public) returns: no email, notes, capture/refund/invoice/dispute ids or timestamps. */
export function publicBooking(b: Booking): PublicBookingView {
  return {
    id: b.id,
    service: b.service,
    startAt: b.startAt,
    endAt: b.endAt,
    durationMin: b.durationMin,
    resourceId: b.resourceId,
    waitlist: b.waitlist,
    customerName: b.customerName,
    depositAmount: b.depositAmount,
    balanceAmount: b.balanceAmount,
    currency: b.currency,
    state: b.state,
    paypalOrderId: b.paypalOrderId,
    paypalAuthorizationId: b.paypalAuthorizationId,
  };
}

export function listBookings(): Booking[] {
  const rows = getDb().prepare("SELECT * FROM bookings ORDER BY start_at, id").all() as BookingRow[];
  return rows.map(rowToBooking);
}

export type PaypalRefField =
  | "paypal_order_id"
  | "paypal_authorization_id"
  | "paypal_capture_id"
  | "paypal_refund_id"
  | "paypal_invoice_id"
  | "paypal_dispute_id";

export function findBookingByPaypalRef(field: PaypalRefField, value: string): Booking | null {
  const r = getDb().prepare(`SELECT * FROM bookings WHERE ${field} = ? LIMIT 1`).get(value) as BookingRow | undefined;
  return r ? rowToBooking(r) : null;
}

export function saveBooking(b: Booking): void {
  getDb()
    .prepare(
      `INSERT INTO bookings (id, resource_id, waitlist, customer_name, customer_email, service, start_at, end_at, duration_min,
        deposit_amount, balance_amount, currency, state, balance_state, paypal_order_id, paypal_authorization_id, paypal_capture_id,
        paypal_refund_id, paypal_invoice_id, paypal_dispute_id, notes, created_at, updated_at)
       VALUES (@id, @resource_id, @waitlist, @customer_name, @customer_email, @service, @start_at, @end_at, @duration_min,
        @deposit_amount, @balance_amount, @currency, @state, @balance_state, @paypal_order_id, @paypal_authorization_id, @paypal_capture_id,
        @paypal_refund_id, @paypal_invoice_id, @paypal_dispute_id, @notes, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET resource_id=excluded.resource_id, waitlist=excluded.waitlist, customer_name=excluded.customer_name,
        customer_email=excluded.customer_email, service=excluded.service, start_at=excluded.start_at, end_at=excluded.end_at,
        duration_min=excluded.duration_min, deposit_amount=excluded.deposit_amount, balance_amount=excluded.balance_amount,
        currency=excluded.currency, state=excluded.state, balance_state=excluded.balance_state, paypal_order_id=excluded.paypal_order_id,
        paypal_authorization_id=excluded.paypal_authorization_id, paypal_capture_id=excluded.paypal_capture_id,
        paypal_refund_id=excluded.paypal_refund_id, paypal_invoice_id=excluded.paypal_invoice_id,
        paypal_dispute_id=excluded.paypal_dispute_id, notes=excluded.notes, updated_at=excluded.updated_at`,
    )
    .run({
      id: b.id,
      resource_id: b.resourceId,
      waitlist: b.waitlist ? 1 : 0,
      customer_name: b.customerName,
      customer_email: b.customerEmail,
      service: b.service,
      start_at: b.startAt,
      end_at: b.endAt,
      duration_min: b.durationMin,
      deposit_amount: b.depositAmount,
      balance_amount: b.balanceAmount,
      currency: b.currency,
      state: b.state,
      balance_state: b.balanceState,
      paypal_order_id: b.paypalOrderId,
      paypal_authorization_id: b.paypalAuthorizationId,
      paypal_capture_id: b.paypalCaptureId,
      paypal_refund_id: b.paypalRefundId,
      paypal_invoice_id: b.paypalInvoiceId,
      paypal_dispute_id: b.paypalDisputeId,
      notes: b.notes,
      created_at: b.createdAt,
      updated_at: b.updatedAt,
    });
}

// ---------------------------------------------------------------- events

export type EventOutcome = "received" | "applied" | "idempotent" | "stale" | "illegal" | "unmatched" | "ignored" | "error";

export interface StoredEvent extends MoneyEvent {
  receivedAt: string;
  outcome: EventOutcome;
  detail: string | null;
}

interface EventRow {
  id: string;
  type: string;
  at: string;
  source: string;
  verified: number;
  booking_id: string | null;
  resource_json: string;
  refs_json: string;
  received_at: string;
  outcome: string;
  detail: string | null;
}

function rowToEvent(r: EventRow): StoredEvent {
  return {
    id: r.id,
    type: r.type as MoneyEventType,
    at: r.at,
    source: r.source as MoneyEvent["source"],
    verified: r.verified === 1,
    bookingId: r.booking_id,
    resource: parseJson<Record<string, unknown>>(r.resource_json, {}),
    refs: parseJson<Record<string, string>>(r.refs_json, {}),
    receivedAt: r.received_at,
    outcome: r.outcome as EventOutcome,
    detail: r.detail,
  };
}

/** Inserts the event if its id is new. Returns false when the id was already recorded (replay). */
export function insertEventIfNew(e: { id: string; type: string; at: string; source: string; verified: boolean; bookingId: string | null; resource: unknown; refs: Record<string, string> }, receivedAt: string): boolean {
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO events (id, type, at, source, verified, booking_id, resource_json, refs_json, received_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
    )
    .run(e.id, e.type, e.at, e.source, e.verified ? 1 : 0, e.bookingId, JSON.stringify(e.resource ?? {}), JSON.stringify(e.refs ?? {}), receivedAt);
  return res.changes === 1;
}

export function setEventOutcome(id: string, outcome: EventOutcome, detail: string | null, bookingId?: string | null): void {
  if (bookingId !== undefined) {
    getDb().prepare("UPDATE events SET outcome = ?, detail = ?, booking_id = ? WHERE id = ?").run(outcome, detail, bookingId, id);
  } else {
    getDb().prepare("UPDATE events SET outcome = ?, detail = ? WHERE id = ?").run(outcome, detail, id);
  }
}

export function getEvent(id: string): StoredEvent | null {
  const r = getDb().prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
  return r ? rowToEvent(r) : null;
}

export function listEventsForBooking(bookingId: string): StoredEvent[] {
  const rows = getDb().prepare("SELECT * FROM events WHERE booking_id = ? ORDER BY received_at, rowid").all(bookingId) as EventRow[];
  return rows.map(rowToEvent);
}

export function latestEvent(sources: MoneyEvent["source"][]): StoredEvent | null {
  const ph = sources.map(() => "?").join(",");
  const r = getDb().prepare(`SELECT * FROM events WHERE source IN (${ph}) ORDER BY received_at DESC, rowid DESC LIMIT 1`).get(...sources) as EventRow | undefined;
  return r ? rowToEvent(r) : null;
}

export function countEvents(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}

// ---------------------------------------------------------------- log

interface LogRow {
  seq: number;
  id: string;
  at: string;
  actor: string;
  kind: string;
  message: string;
  booking_id: string | null;
  refs_json: string;
}

function rowToLog(r: LogRow): LogEntry {
  return {
    id: r.id,
    at: r.at,
    actor: r.actor as Actor,
    kind: r.kind,
    message: r.message,
    bookingId: r.booking_id,
    refs: parseJson<Record<string, string>>(r.refs_json, {}),
  };
}

export function insertLog(e: LogEntry): void {
  getDb()
    .prepare("INSERT INTO log (id, at, actor, kind, message, booking_id, refs_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(e.id, e.at, e.actor, e.kind, e.message, e.bookingId, JSON.stringify(e.refs));
}

export function listLog(limit = 200): LogEntry[] {
  const rows = getDb().prepare("SELECT * FROM log ORDER BY seq DESC LIMIT ?").all(limit) as LogRow[];
  return rows.map(rowToLog);
}

export function listLogForBooking(bookingId: string): LogEntry[] {
  const rows = getDb().prepare("SELECT * FROM log WHERE booking_id = ? ORDER BY seq ASC").all(bookingId) as LogRow[];
  return rows.map(rowToLog);
}

// ---------------------------------------------------------------- plans

interface PlanRow {
  id: string;
  created_at: string;
  trigger_json: string;
  provider: string;
  summary: string;
  options_json: string;
  drafts_json: string;
  status: string;
  chosen_option_id: string | null;
  grant_id: string | null;
  error: string | null;
}

function rowToPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    createdAt: r.created_at,
    trigger: parseJson<Plan["trigger"]>(r.trigger_json, { eventType: "manual", bookingId: null, eventId: null }),
    provider: r.provider as Plan["provider"],
    summary: r.summary,
    options: parseJson<Plan["options"]>(r.options_json, []),
    draftMessages: parseJson<Plan["draftMessages"]>(r.drafts_json, []),
    status: r.status as Plan["status"],
    chosenOptionId: r.chosen_option_id,
    grantId: r.grant_id,
    error: r.error,
  };
}

export function savePlan(p: Plan): void {
  getDb()
    .prepare(
      `INSERT INTO plans (id, created_at, trigger_json, provider, summary, options_json, drafts_json, status, chosen_option_id, grant_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET summary=excluded.summary, options_json=excluded.options_json, drafts_json=excluded.drafts_json,
        status=excluded.status, chosen_option_id=excluded.chosen_option_id, grant_id=excluded.grant_id, error=excluded.error`,
    )
    .run(p.id, p.createdAt, JSON.stringify(p.trigger), p.provider, p.summary, JSON.stringify(p.options), JSON.stringify(p.draftMessages), p.status, p.chosenOptionId, p.grantId, p.error);
}

export function getPlan(id: string): Plan | null {
  const r = getDb().prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
  return r ? rowToPlan(r) : null;
}

export function listPlans(): Plan[] {
  const rows = getDb().prepare("SELECT * FROM plans ORDER BY created_at DESC, rowid DESC").all() as PlanRow[];
  return rows.map(rowToPlan);
}

/**
 * Atomically move a plan from `proposed` to `approved`. False when it is no
 * longer proposed (a concurrent approval, a rejection or a newer plan got there first).
 */
export function claimPlan(id: string, optionId: string): boolean {
  return getDb().prepare("UPDATE plans SET status = 'approved', chosen_option_id = ? WHERE id = ? AND status = 'proposed'").run(optionId, id).changes === 1;
}

/** Open (proposed) plans first, then the last `others` non-open plans. */
export function listPlansForState(others = 10): Plan[] {
  const all = listPlans();
  const open = all.filter((p) => p.status === "proposed");
  const rest = all.filter((p) => p.status !== "proposed").slice(0, others);
  return [...open, ...rest];
}

// ---------------------------------------------------------------- grants

export interface StoredGrant extends Grant {
  spentAmount: string;
}

interface GrantRow {
  id: string;
  plan_id: string | null;
  option_id: string | null;
  booking_ids_json: string;
  allowed_actions_json: string;
  max_amount: string;
  spent_amount: string;
  currency: string;
  issued_at: string;
  expires_at: string;
  approved_by: string;
  status: string;
  used_at: string | null;
}

function rowToGrant(r: GrantRow): StoredGrant {
  return {
    id: r.id,
    planId: r.plan_id ?? "",
    optionId: r.option_id ?? "",
    bookingIds: parseJson<string[]>(r.booking_ids_json, []),
    allowedActions: parseJson<PlanActionType[]>(r.allowed_actions_json, []),
    maxAmount: r.max_amount,
    spentAmount: r.spent_amount,
    currency: r.currency,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    approvedBy: "operator",
    status: r.status as Grant["status"],
    usedAt: r.used_at,
  };
}

export function saveGrant(gr: StoredGrant): void {
  getDb()
    .prepare(
      `INSERT INTO grants (id, plan_id, option_id, booking_ids_json, allowed_actions_json, max_amount, spent_amount, currency, issued_at, expires_at, approved_by, status, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET spent_amount=excluded.spent_amount, status=excluded.status, used_at=excluded.used_at`,
    )
    .run(gr.id, gr.planId, gr.optionId, JSON.stringify(gr.bookingIds), JSON.stringify(gr.allowedActions), gr.maxAmount, gr.spentAmount, gr.currency, gr.issuedAt, gr.expiresAt, gr.approvedBy, gr.status, gr.usedAt);
}

/**
 * Consume a grant atomically: one UPDATE that only matches an active,
 * unexpired grant. Exactly one caller wins; everyone else gets null.
 * ISO-8601 UTC strings from toISOString() compare correctly as text.
 */
export function claimGrant(id: string, now = new Date()): StoredGrant | null {
  const at = now.toISOString();
  const res = getDb().prepare("UPDATE grants SET status = 'used', used_at = ? WHERE id = ? AND status = 'active' AND expires_at > ?").run(at, id, at);
  return res.changes === 1 ? getGrant(id) : null;
}

export function getGrant(id: string): StoredGrant | null {
  const r = getDb().prepare("SELECT * FROM grants WHERE id = ?").get(id) as GrantRow | undefined;
  return r ? rowToGrant(r) : null;
}

export function listGrantsForPlan(planId: string): StoredGrant[] {
  const rows = getDb().prepare("SELECT * FROM grants WHERE plan_id = ? ORDER BY issued_at").all(planId) as GrantRow[];
  return rows.map(rowToGrant);
}

/** Strip internal fields before sending a grant to the browser. */
export function publicGrant(gr: StoredGrant): Grant {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { spentAmount, ...rest } = gr;
  return rest;
}

// ---------------------------------------------------------------- invoices

export interface InvoiceRecord {
  id: string;
  bookingId: string;
  paypalInvoiceId: string | null;
  amount: string;
  status: string;
  qrPngBase64: string | null;
  createdAt: string;
}

interface InvoiceRow {
  id: string;
  booking_id: string;
  paypal_invoice_id: string | null;
  amount: string;
  status: string;
  qr_png_base64: string | null;
  created_at: string;
}

function rowToInvoice(r: InvoiceRow): InvoiceRecord {
  return {
    id: r.id,
    bookingId: r.booking_id,
    paypalInvoiceId: r.paypal_invoice_id,
    amount: r.amount,
    status: r.status,
    qrPngBase64: r.qr_png_base64,
    createdAt: r.created_at,
  };
}

export function saveInvoice(i: InvoiceRecord): void {
  getDb()
    .prepare(
      `INSERT INTO invoices (id, booking_id, paypal_invoice_id, amount, status, qr_png_base64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET paypal_invoice_id=excluded.paypal_invoice_id, status=excluded.status, qr_png_base64=excluded.qr_png_base64`,
    )
    .run(i.id, i.bookingId, i.paypalInvoiceId, i.amount, i.status, i.qrPngBase64, i.createdAt);
}

export function listInvoicesForBooking(bookingId: string): InvoiceRecord[] {
  const rows = getDb().prepare("SELECT * FROM invoices WHERE booking_id = ? ORDER BY created_at, rowid").all(bookingId) as InvoiceRow[];
  return rows.map(rowToInvoice);
}

export function listOpenInvoices(): InvoiceRecord[] {
  const rows = getDb().prepare("SELECT * FROM invoices WHERE status NOT IN ('PAID','MARKED_AS_PAID','CANCELLED','REFUNDED') ORDER BY created_at").all() as InvoiceRow[];
  return rows.map(rowToInvoice);
}

export function findInvoiceByPaypalId(paypalInvoiceId: string): InvoiceRecord | null {
  const r = getDb().prepare("SELECT * FROM invoices WHERE paypal_invoice_id = ?").get(paypalInvoiceId) as InvoiceRow | undefined;
  return r ? rowToInvoice(r) : null;
}

// ---------------------------------------------------------------- meta + mock store

export function getMeta(key: string): string | null {
  const r = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

export function setMeta(key: string, value: string): void {
  getDb().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Atomically increments a named counter and returns the new value. */
export function nextCounter(name: string): number {
  return tx(() => {
    const cur = Number(getMeta(`counter:${name}`) ?? "0");
    const next = cur + 1;
    setMeta(`counter:${name}`, String(next));
    return next;
  });
}

export function getMockObject<T>(id: string): T | null {
  const r = getDb().prepare("SELECT data_json FROM mock_objects WHERE id = ?").get(id) as { data_json: string } | undefined;
  return r ? (JSON.parse(r.data_json) as T) : null;
}

export function putMockObject(id: string, kind: string, data: unknown): void {
  getDb()
    .prepare("INSERT INTO mock_objects (id, kind, data_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, kind = excluded.kind")
    .run(id, kind, JSON.stringify(data));
}

export function listMockObjects<T>(kind: string): T[] {
  const rows = getDb().prepare("SELECT data_json FROM mock_objects WHERE kind = ? ORDER BY rowid").all(kind) as { data_json: string }[];
  return rows.map((r) => JSON.parse(r.data_json) as T);
}

/** Wipe all day data (used by the seed). Resources are rewritten by the caller. */
export function wipeAll(): void {
  getDb().exec("DELETE FROM bookings; DELETE FROM events; DELETE FROM log; DELETE FROM plans; DELETE FROM grants; DELETE FROM invoices; DELETE FROM meta; DELETE FROM mock_objects; DELETE FROM resources;");
}

export function setInvoiceStatusByPaypalId(paypalInvoiceId: string, status: string): void {
  getDb().prepare("UPDATE invoices SET status = ? WHERE paypal_invoice_id = ?").run(status, paypalInvoiceId);
}
