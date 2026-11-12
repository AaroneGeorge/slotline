/** Gateway factory: one instance per process and mode, swappable in tests. */
import { paypalMode } from "../config";
import type { PaypalGateway } from "./gateway";
import { MockGateway } from "./mock";
import { SandboxGateway } from "./sandbox";

const g = globalThis as unknown as { __slotlineGateway?: PaypalGateway; __slotlineGatewayOverride?: PaypalGateway | null };

export function getGateway(): PaypalGateway {
  if (g.__slotlineGatewayOverride) return g.__slotlineGatewayOverride;
  const mode = paypalMode();
  if (g.__slotlineGateway && g.__slotlineGateway.mode === mode) return g.__slotlineGateway;
  if (mode === "sandbox") {
    g.__slotlineGateway = new SandboxGateway();
  } else {
    g.__slotlineGateway = new MockGateway({
      // Deliver simulated webhooks through the real webhook handler (lazy import avoids a module cycle).
      sink: async (rawBody, headers) => {
        const { handleWebhook } = await import("../webhook");
        return handleWebhook(rawBody, new Headers(headers));
      },
    });
  }
  return g.__slotlineGateway;
}

/** The MockGateway when running in mock mode (seed + dev helpers), else null. */
export function getMockGateway(): MockGateway | null {
  const gw = getGateway();
  return gw instanceof MockGateway ? gw : null;
}

/** Tests: replace the gateway (null restores the default). */
export function setGatewayForTests(gw: PaypalGateway | null): void {
  g.__slotlineGatewayOverride = gw;
}

export type { PaypalGateway } from "./gateway";
export { MockGateway } from "./mock";
