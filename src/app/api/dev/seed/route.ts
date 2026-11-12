import { operatorRoute, json, requireDevSecret } from "@/server/http";
import { seedDemoDay } from "@/server/seed";
import { writeLog } from "@/server/log";

/** Reset to Dana's demo day (header x-dev-secret). */
export const POST = operatorRoute(async (req: Request) => {
  requireDevSecret(req);
  const res = await seedDemoDay();
  writeLog({ actor: "operator", kind: "dev.seed", message: `Dev tools: reset to the demo day ${res.day}`, refs: { devTools: "1" } });
  return json({ day: res.day, bookings: res.bookings });
});
