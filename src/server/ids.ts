import { randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

/** Short prefixed id, e.g. newId("bk") -> "bk_3f9a1c2e". */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
