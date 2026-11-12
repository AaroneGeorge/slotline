import type { AuthMeResponse } from "@/shared/types";
import { route, json } from "@/server/http";
import { authMode, clearSessionCookie, readCookie, revokeSession } from "@/server/auth";
import { writeLog } from "@/server/log";

/** Sign out: revokes the session token and clears the cookie. */
export const POST = route(async (req: Request) => {
  if (revokeSession(readCookie(req.headers.get("cookie")))) writeLog({ actor: "operator", kind: "auth.logout", message: "Operator signed out" });
  const mode = authMode();
  return json<AuthMeResponse>({ authenticated: mode === "open", mode, expiresAt: null }, 200, { "set-cookie": clearSessionCookie() });
});
