/**
 * Per-booking async mutex (single process). Serialises money actions on one
 * booking so a double click cannot send two captures past the state check
 * before the first PayPal call returns.
 */
const g = globalThis as unknown as { __slotlineLocks?: Map<string, Promise<unknown>> };

function locks(): Map<string, Promise<unknown>> {
  if (!g.__slotlineLocks) g.__slotlineLocks = new Map();
  return g.__slotlineLocks;
}

export async function withBookingLock<T>(bookingId: string, fn: () => Promise<T>): Promise<T> {
  const m = locks();
  const prev = m.get(bookingId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  m.set(bookingId, tail);
  try {
    return await run;
  } finally {
    if (m.get(bookingId) === tail) m.delete(bookingId);
  }
}
