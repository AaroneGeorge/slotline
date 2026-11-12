import type { AuthMeResponse } from "@/shared/types";
import { route, json } from "@/server/http";
import { authStatus } from "@/server/auth";

/** Whether this browser holds a valid operator session (always 200; the dashboard shows a sign-in form when not). */
export const GET = route(async (req: Request) => json<AuthMeResponse>(authStatus(req)));
