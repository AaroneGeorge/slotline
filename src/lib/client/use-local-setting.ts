"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function read(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** A string persisted in localStorage, safe for SSR and hydration. */
export function useLocalSetting(key: string): [string, (v: string) => void] {
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) cb();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(cb);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => "",
  );
  const set = useCallback(
    (v: string) => {
      try {
        if (v) window.localStorage.setItem(key, v);
        else window.localStorage.removeItem(key);
      } catch {
        // storage blocked: keep working for this page view only
      }
      for (const l of listeners) l();
    },
    [key],
  );
  return [value, set];
}
