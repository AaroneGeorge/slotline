/**
 * SSE client for GET /api/stream with reconnect. EventSource retries on its
 * own for dropped connections, but gives up for good on HTTP errors, so we
 * close and reopen ourselves with backoff. After every successful (re)open we
 * ask the caller to resync from GET /api/state, since events sent while we
 * were away are not replayed. A stream refused with 401 (signed out) must not
 * loop: before each retry `stillSignedIn` is asked, and if it says no the
 * status becomes "unauthorized" and the client stops.
 */
import type { StreamEvent } from "@/shared/types";

export type ConnStatus = "connecting" | "live" | "reconnecting" | "demo" | "unauthorized";

const STREAM_TYPES: StreamEvent["type"][] = [
  "hello",
  "booking.updated",
  "booking.removed",
  "plan.created",
  "plan.updated",
  "grant.updated",
  "log",
];

export interface StreamHandlers {
  onEvent: (event: StreamEvent) => void;
  onStatus: (status: ConnStatus) => void;
  /** called after each successful open; resync state here */
  onOpen: () => void;
  /** asked after a failed connection; false = signed out, stop reconnecting */
  stillSignedIn?: () => Promise<boolean>;
}

export function connectStream(handlers: StreamHandlers, url = "/api/stream"): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const handle = (msg: MessageEvent) => {
    if (typeof msg.data !== "string" || !msg.data) return;
    try {
      const parsed = JSON.parse(msg.data) as StreamEvent;
      if (parsed && typeof parsed === "object" && "type" in parsed) handlers.onEvent(parsed);
    } catch {
      // heartbeat or non-JSON comment: ignore
    }
  };

  const open = () => {
    if (closed) return;
    handlers.onStatus(attempt === 0 ? "connecting" : "reconnecting");
    const source = new EventSource(url);
    es = source;
    source.onopen = () => {
      attempt = 0;
      handlers.onStatus("live");
      handlers.onOpen();
    };
    source.onmessage = handle;
    // Tolerate servers that send named events (`event: booking.updated`).
    for (const t of STREAM_TYPES) source.addEventListener(t, handle as EventListener);
    source.onerror = () => {
      if (closed) return;
      source.close();
      attempt += 1;
      handlers.onStatus("reconnecting");
      const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
      const retry = () => {
        if (!closed) timer = setTimeout(open, delay);
      };
      if (!handlers.stillSignedIn) return retry();
      void handlers.stillSignedIn().then((ok) => {
        if (closed) return;
        if (ok) retry();
        else handlers.onStatus("unauthorized");
      });
    };
  };

  open();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
