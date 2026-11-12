/** GET /api/state assembly, plus first-run / new-day auto-seeding. */
import type { StateResponse } from "@/shared/types";
import { getMeta, listGrantsForPlan, listLog, listPlansForState, listResources, publicGrant } from "./db";
import { appMode, operatorTz } from "./config";
import { bookingsForDay, currentDay } from "./planner/context";
import { seedDemoDay } from "./seed";

const g = globalThis as unknown as { __slotlineSeeding?: Promise<unknown> | null };

/** AUTO_RESEED (default "daily"): "daily" reseeds when the operator day changes, "empty" only seeds an empty database, "off" never. */
function autoReseedMode(): "daily" | "empty" | "off" {
  const v = process.env.AUTO_RESEED?.trim();
  return v === "off" || v === "empty" ? v : "daily";
}

export async function ensureSeeded(): Promise<void> {
  const mode = autoReseedMode();
  if (mode === "off") return;
  const empty = listResources().length === 0;
  const stale = mode === "daily" && getMeta("seedDay") !== currentDay();
  if (!empty && !stale) return;
  if (!g.__slotlineSeeding) {
    g.__slotlineSeeding = seedDemoDay().finally(() => {
      g.__slotlineSeeding = null;
    });
  }
  await g.__slotlineSeeding;
}

export async function getState(): Promise<StateResponse> {
  await ensureSeeded();
  const day = currentDay();
  const plans = listPlansForState(10);
  return {
    resources: listResources(),
    bookings: bookingsForDay(day, operatorTz()),
    plans,
    log: listLog(200),
    mode: appMode(),
    day,
    timeZone: operatorTz(),
    grants: plans.flatMap((p) => listGrantsForPlan(p.id)).map(publicGrant),
  };
}
