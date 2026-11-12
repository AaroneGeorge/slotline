import { z } from "zod";
import type { DevInjectResponse } from "@/shared/types";
import { operatorRoute, json, readJson, requireDevSecret } from "@/server/http";
import { FIXTURES, injectFixture } from "@/server/dev";

const schema = z.object({
  fixture: z.enum(Object.keys(FIXTURES) as [keyof typeof FIXTURES, ...(keyof typeof FIXTURES)[]]),
  bookingId: z.string().min(1),
});

/** Inject a PayPal-shaped webhook fixture for a booking (header x-dev-secret). */
export const POST = operatorRoute(async (req: Request) => {
  requireDevSecret(req);
  const body = await readJson(req, schema);
  return json<DevInjectResponse>(await injectFixture(body.fixture, body.bookingId));
});
