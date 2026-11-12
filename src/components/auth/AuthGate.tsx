"use client";

/**
 * Operator sign-in gate for `/` and `/evidence/:id`. Asks GET /api/auth/me
 * first; when the browser has no operator session it shows a password form
 * (POST /api/auth/login sets the HttpOnly cookie) instead of the page. Pages
 * call `useAuth().signedOut()` when an API call answers 401, which brings the
 * form back and unmounts the page (closing its stream). `?demo=1` skips it.
 */
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthMeResponse } from "@/shared/types";
import { api, errorMessage } from "@/lib/client/api";
import { Logo } from "@/components/ui/Logo";

interface AuthValue {
  /** "password" when sign-in is required (show a sign-out button), "open" in development without a password; null in demo mode */
  mode: AuthMeResponse["mode"] | null;
  /** an API call answered 401: show the sign-in form again */
  signedOut: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue>({ mode: null, signedOut: () => {}, signOut: async () => {} });

export function useAuth(): AuthValue {
  return useContext(AuthContext);
}

type Status = "checking" | "in" | "out";

export function AuthGate({ demo, purpose, children }: { demo: boolean; purpose: string; children: ReactNode }) {
  const [status, setStatus] = useState<Status>(demo ? "in" : "checking");
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    api
      .authMe()
      .then((m) => {
        if (cancelled) return;
        setMe(m);
        setStatus(m.authenticated ? "in" : "out");
      })
      .catch(() => {
        // Server unreachable: let the page show its own "can't reach the API" state.
        if (!cancelled) setStatus("in");
      });
    return () => {
      cancelled = true;
    };
  }, [demo]);

  const signedOut = useCallback(() => {
    setReason("Your operator session ended. Sign in again to continue.");
    setStatus("out");
  }, []);

  const signOut = useCallback(async () => {
    try {
      setMe(await api.logout());
    } catch {
      // the cookie is cleared server-side or already gone; show the form either way
    }
    setReason(null);
    setStatus("out");
  }, []);

  const value = useMemo<AuthValue>(() => ({ mode: demo ? null : (me?.mode ?? null), signedOut, signOut }), [demo, me, signedOut, signOut]);

  if (status === "checking") return <div className="flex min-h-dvh items-center justify-center text-[13px] text-ink-3">Checking operator sign-in…</div>;
  if (status === "out") {
    return (
      <LoginForm
        mode={me?.mode ?? "password"}
        purpose={purpose}
        reason={reason}
        onSignedIn={(m) => {
          setMe(m);
          setReason(null);
          setStatus("in");
        }}
      />
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function LoginForm({ mode, purpose, reason, onSignedIn }: { mode: AuthMeResponse["mode"]; purpose: string; reason: string | null; onSignedIn: (m: AuthMeResponse) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = mode === "locked";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      // Confirm the browser kept the cookie: in production it is Secure, so plain http (other than localhost) drops it.
      const m = await api.authMe();
      if (m.authenticated) onSignedIn(m);
      else setError("The password was right, but this browser did not keep the session cookie. Open the site over HTTPS (or localhost) and allow cookies.");
    } catch (err) {
      setError(errorMessage(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <main className="w-full max-w-[360px] rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="flex items-center gap-2.5">
          <Logo size={26} />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold text-ink">Slotline</div>
            <div className="text-[11px] text-ink-3">Operator sign-in for {purpose}</div>
          </div>
        </div>

        {reason && <p className="mt-4 rounded-md bg-surface-2 px-3 py-2 text-[12px] text-ink-2">{reason}</p>}

        {locked ? (
          <p className="mt-4 rounded-md border border-st-disputed/30 bg-st-disputed/5 px-3 py-2 text-[12px] leading-snug text-st-disputed">
            Operator sign-in is not configured on this server: <code className="font-mono">OPERATOR_PASSWORD</code> is unset, so every operator route is locked.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-2">
              Operator password
              <input
                type="password"
                required
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-md border border-line-2 px-2.5 py-2 text-[14px] font-normal text-ink outline-none focus:border-accent"
              />
            </label>
            {error && <p className="text-[12px] text-st-disputed">{error}</p>}
            <button
              type="submit"
              disabled={!password || busy}
              className="rounded-lg bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[12px]">
          <Link href="/book" className="font-semibold text-accent hover:underline">
            Customer booking page
          </Link>
          <Link href="/?demo=1" className="font-semibold text-accent hover:underline">
            Demo day (no server)
          </Link>
        </div>
      </main>
    </div>
  );
}
