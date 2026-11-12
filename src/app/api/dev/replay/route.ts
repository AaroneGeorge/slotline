import { z } from "zod";
import type { DevReplayResponse } from "@/shared/types";
import { operatorRoute, json, readJson, requireDevSecret } from "@/server/http";
import { replayEvent } from "@/server/dev";

const schema = z.object({ eventId: z.string().min(1).optional() });

/** Re-deliver a recorded event (default: the latest webhook/dev event); must be a no-op. */
export const POST = operatorRoute(async (req: Request) => {
  requireDevSecret(req);
  const body = await readJson(req, schema);
  return json<DevReplayResponse>(await replayEvent(body.eventId));
});
