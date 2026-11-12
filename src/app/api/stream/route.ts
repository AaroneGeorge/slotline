import type { StreamEvent } from "@/shared/types";
import { operatorRoute } from "@/server/http";
import { isShuttingDown, onShutdown, subscribe } from "@/server/bus";
import { appMode } from "@/server/config";
import { onSessionRevoked, sessionFromRequest } from "@/server/auth";

const HEARTBEAT_MS = 25_000;

/**
 * Server-sent events: one JSON StreamEvent per `data:` line; a comment heartbeat every 25 s.
 * Operator only. The stream ends when its session expires or is signed out,
 * so an open connection never outlives the sign-in (the client then shows "Sign in").
 */
export const GET = operatorRoute(async (req: Request) => {
  // A browser reconnecting over a kept-alive socket during shutdown would otherwise open a stream nothing closes.
  if (isShuttingDown()) return new Response("shutting down", { status: 503, headers: { "retry-after": "2", connection: "close" } });
  const encoder = new TextEncoder();
  const session = sessionFromRequest(req); // null when sign-in is off (development without OPERATOR_PASSWORD)
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const send = (ev: StreamEvent) => write(`data: ${JSON.stringify(ev)}\n\n`);
      write("retry: 3000\n\n");
      send({ type: "hello", mode: appMode() });
      const unsubscribe = subscribe(send);
      const offShutdown = onShutdown(() => cleanup());
      const heartbeat = setInterval(() => write(`: heartbeat ${new Date().toISOString()}\n\n`), HEARTBEAT_MS);
      const expiry = session ? setTimeout(() => cleanup(), Math.max(0, session.exp - Date.now())) : null;
      const offRevoked = session ? onSessionRevoked(session.nonce, () => cleanup()) : () => {};
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (expiry) clearTimeout(expiry);
        unsubscribe();
        offShutdown();
        offRevoked();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
