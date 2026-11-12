/** The audit log: every actor-visible step is written here and broadcast. */
import type { Actor, LogEntry } from "@/shared/types";
import { insertLog } from "./db";
import { publish } from "./bus";
import { newId, nowIso } from "./ids";

export interface LogInput {
  actor: Actor;
  kind: string;
  message: string;
  bookingId?: string | null;
  refs?: Record<string, string | null | undefined>;
}

export function cleanRefs(refs: Record<string, string | null | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!refs) return out;
  for (const [k, v] of Object.entries(refs)) {
    if (v !== null && v !== undefined && v !== "") out[k] = String(v);
  }
  return out;
}

export function writeLog(input: LogInput): LogEntry {
  const entry: LogEntry = {
    id: newId("log"),
    at: nowIso(),
    actor: input.actor,
    kind: input.kind,
    message: input.message,
    bookingId: input.bookingId ?? null,
    refs: cleanRefs(input.refs),
  };
  insertLog(entry);
  publish({ type: "log", entry });
  return entry;
}
