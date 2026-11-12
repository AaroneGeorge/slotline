"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "info" | "ok" | "warn" | "error";
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string | string[];
}

const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

const TONE: Record<ToastTone, string> = {
  info: "border-l-accent",
  ok: "border-l-st-held",
  warn: "border-l-st-declined",
  error: "border-l-st-disputed",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === "error" || t.tone === "warn" ? 7000 : 4200);
    },
    [dismiss],
  );

  const value = useMemo(() => push, [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 left-16 z-[1000] flex w-[360px] flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`sl-rise pointer-events-auto rounded-md border border-line border-l-4 bg-surface px-3 py-2.5 shadow-lg shadow-black/10 ${TONE[t.tone]}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="text-[13px] font-semibold text-ink">{t.title}</div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="-mr-1 -mt-0.5 rounded px-1 text-ink-3 hover:bg-surface-3 hover:text-ink"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
            {t.body &&
              (Array.isArray(t.body) ? (
                <ul className="mt-1 list-disc pl-4 text-[12px] leading-snug text-ink-2">
                  {t.body.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              ) : (
                <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{t.body}</div>
              ))}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
