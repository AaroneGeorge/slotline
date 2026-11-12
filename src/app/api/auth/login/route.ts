import { z } from "zod";
import type { AuthMeResponse } from "@/shared/types";
import { route, json, readJson, HttpError } from "@/server/http";
import { authMode, issueSession, loginRetryAfter, passwordMatches, recordLoginFailure, sessionCookie } from "@/server/auth";
import { writeLog } from "@/server/log";

const schema = z.object({ password: z.string().min(1).max(512) });

/** Operator sign-in: checks OPERATOR_PASSWORD and sets the HttpOnly session cookie. */
export const POST = route(async (req: Request) => {
  const mode = authMode();
  if (mode === "open") return json<AuthMeResponse>({ authenticated: true, mode, expiresAt: null });
  if (mode === "locked") throw new HttpError(401, "AUTH_NOT_CONFIGURED", "operator sign-in is not configured on this server (OPERATOR_PASSWORD is unset)");
  const wait = loginRetryAfter();
  if (wait > 0) return json({ error: `too many failed sign-in attempts; try again in ${wait} s`, code: "TOO_MANY_ATTEMPTS" }, 429, { "retry-after": String(wait) });
  const { password } = await readJson(req, schema);
  if (!passwordMatches(password)) {
    recordLoginFailure();
    throw new HttpError(401, "INVALID_PASSWORD", "wrong password");
  }
  const session = issueSession();
  if (!session) throw new HttpError(500, "INTERNAL", "could not issue a session");
  writeLog({ actor: "operator", kind: "auth.login", message: "Operator signed in", refs: { expiresAt: session.expiresAt } });
  return json<AuthMeResponse>({ authenticated: true, mode, expiresAt: session.expiresAt }, 200, { "set-cookie": sessionCookie(session.token) });
});
