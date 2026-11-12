/** In-process pub/sub for the SSE stream. Cached on globalThis so every route bundle shares one bus. */
import { EventEmitter } from "node:events";
import type { StreamEvent } from "@/shared/types";

const g = globalThis as unknown as { __slotlineBus?: EventEmitter; __slotlineShutdownHooked?: boolean; __slotlineShuttingDown?: boolean };

function bus(): EventEmitter {
  if (!g.__slotlineBus) {
    g.__slotlineBus = new EventEmitter();
    g.__slotlineBus.setMaxListeners(200);
  }
  return g.__slotlineBus;
}

export function publish(ev: StreamEvent): void {
  bus().emit("event", ev);
}

export function subscribe(fn: (ev: StreamEvent) => void): () => void {
  const b = bus();
  b.on("event", fn);
  return () => {
    b.off("event", fn);
  };
}

export function listenerCount(): number {
  return bus().listenerCount("event");
}

/**
 * Run `fn` once when the process receives SIGTERM/SIGINT. `next start` answers
 * those signals with `server.close()`, which waits for open requests; an SSE
 * response never finishes on its own, so without this the server hangs and
 * browsers never see the stream end (and never reconnect).
 */
export function onShutdown(fn: () => void): () => void {
  const b = bus();
  if (!g.__slotlineShutdownHooked) {
    g.__slotlineShutdownHooked = true;
    const fire = () => {
      g.__slotlineShuttingDown = true;
      b.emit("shutdown");
    };
    process.once("SIGTERM", fire);
    process.once("SIGINT", fire);
  }
  b.once("shutdown", fn);
  return () => {
    b.off("shutdown", fn);
  };
}

/** True once SIGTERM/SIGINT has been received (new SSE streams are refused so the server can drain). */
export function isShuttingDown(): boolean {
  return g.__slotlineShuttingDown === true;
}
