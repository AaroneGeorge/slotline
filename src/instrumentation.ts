/**
 * Runs once when a Next.js server starts (`next start`, `next dev`; skipped
 * during `next build`). Production refuses to start with missing or public
 * secrets; development only warns. See src/server/startup.ts.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { enforceStartupConfig } = await import("./server/startup");
    enforceStartupConfig();
  }
}
