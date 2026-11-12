/**
 * Sandbox smoke test (real PayPal sandbox, never live). Run:
 *   pnpm tsx scripts/sandbox-smoke.ts
 * with PAYPAL_MODE=sandbox and sandbox credentials in .env.local.
 *
 * Order A: create (AUTHORIZE) -> buyer approves -> authorize ->
 *          capture with PayPal-Mock-Response INSTRUMENT_DECLINED (expect 422) ->
 *          capture -> refund.
 * Order B: create -> buyer approves -> authorize -> void.
 * Then: Invoicing v2 create -> send -> QR, Disputes v1 list.
 * Negative testing must be switched on for the sandbox business account
 * (developer dashboard -> Sandbox -> Accounts -> business account -> Settings).
 */
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { loadEnvLocal, requireSandbox } from "./env";

async function main(): Promise<void> {
  loadEnvLocal();
  requireSandbox();

  const { SandboxGateway } = await import("@/server/paypal/sandbox");
  const { isDecline, PaypalError } = await import("@/server/paypal/errors");

  const gw = new SandboxGateway();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const currency = process.env.NEXT_PUBLIC_PAYPAL_CURRENCY || "USD";
  const run = randomUUID().slice(0, 8);
  const failures: string[] = [];

  function step(name: string) {
    console.log(`\n=== ${name}`);
  }

  async function check<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const r = await fn();
      console.log(`ok   ${name}`);
      return r;
    } catch (e) {
      const msg = e instanceof PaypalError ? `${e.status} ${e.issue} (debug_id ${e.debugId ?? "-"})` : e instanceof Error ? e.message : String(e);
      console.log(`FAIL ${name}: ${msg}`);
      failures.push(name);
      return null;
    }
  }

  async function approvedOrder(label: string, value: string): Promise<{ orderId: string; authorizationId: string } | null> {
    step(`${label}: create order (intent AUTHORIZE, ${value} ${currency})`);
    const bookingId = `smoke-${run}-${label}`;
    const order = await check("createOrder", () =>
      gw.createOrder({ bookingId, amount: { value, currency }, description: `Slotline smoke ${label}`, customId: bookingId, invoiceId: `SLOT-${bookingId}`, requestId: `order-${bookingId}`, returnUrl: "https://example.com/return", cancelUrl: "https://example.com/cancel" }),
    );
    if (!order) return null;
    console.log(`order ${order.orderId} ${order.status}`);
    console.log(`Approve it as the sandbox BUYER: ${order.approveUrl ?? "(no approve link returned)"}`);
    await rl.question("Press Enter after approving in the browser... ");
    const auth = await check("authorizeOrder", () => gw.authorizeOrder({ orderId: order.orderId, requestId: `auth-${order.orderId}` }));
    if (!auth) return null;
    console.log(`authorization ${auth.authorizationId} ${auth.authorizationStatus}, expires ${auth.expirationTime}`);
    return { orderId: order.orderId, authorizationId: auth.authorizationId };
  }

  const a = await approvedOrder("A", "1.00");
  if (a) {
    step("A: negative test capture (PayPal-Mock-Response INSTRUMENT_DECLINED)");
    try {
      const r = await gw.captureAuthorization({ authorizationId: a.authorizationId, requestId: `cap-neg-${run}`, mockResponse: "INSTRUMENT_DECLINED" });
      console.log(`FAIL expected a decline, got capture ${r.captureId} ${r.status} (is Negative Testing on for the business account?)`);
      failures.push("negative capture");
    } catch (e) {
      if (isDecline(e)) console.log(`ok   declined as expected: ${e.status} ${e.issue} (debug_id ${e.debugId})`);
      else {
        console.log(`FAIL unexpected error: ${e instanceof Error ? e.message : String(e)}`);
        failures.push("negative capture");
      }
    }
    step("A: capture");
    const cap = await check("captureAuthorization", () => gw.captureAuthorization({ authorizationId: a.authorizationId, requestId: `cap-${run}`, amount: { value: "1.00", currency } }));
    if (cap) {
      console.log(`capture ${cap.captureId} ${cap.status}`);
      const again = await check("capture replay with the same PayPal-Request-Id", () => gw.captureAuthorization({ authorizationId: a.authorizationId, requestId: `cap-${run}`, amount: { value: "1.00", currency } }));
      if (again) console.log(`idempotent replay returned capture ${again.captureId} (same: ${again.captureId === cap.captureId})`);
      if (cap.captureId) {
        step("A: refund");
        const ref = await check("refundCapture", () => gw.refundCapture({ captureId: cap.captureId!, requestId: `refund-${run}`, noteToPayer: "Slotline smoke test" }));
        if (ref) console.log(`refund ${ref.refundId} ${ref.status}`);
      }
    }
  }

  const b = await approvedOrder("B", "1.00");
  if (b) {
    step("B: void");
    const v = await check("voidAuthorization", () => gw.voidAuthorization({ authorizationId: b.authorizationId, requestId: `void-${run}` }));
    if (v) console.log(`authorization ${v.authorizationId} ${v.status}`);
  }

  step("Invoicing v2: create -> send -> QR");
  const buyerEmail = process.env.SANDBOX_BUYER_EMAIL || null;
  const inv = await check("createInvoice", () =>
    gw.createInvoice({ bookingId: `smoke-${run}`, invoiceNumber: `smoke-${run}`, reference: `smoke-${run}`, currency, note: "Slotline smoke test", recipient: { name: "Smoke Buyer", email: buyerEmail }, items: [{ name: "Smoke balance", quantity: "1", unitAmount: "1.00" }] }),
  );
  if (inv) {
    console.log(`invoice ${inv.invoiceId} ${inv.status}`);
    const sent = await check("sendInvoice", () => gw.sendInvoice(inv.invoiceId, { requestId: `send-${run}` }));
    if (sent) console.log(`sent; payer link: ${sent.payUrl ?? "(none)"}`);
    const qr = await check("invoiceQr", () => gw.invoiceQr(inv.invoiceId));
    if (qr) console.log(`QR: ${qr.pngBase64 ? `${qr.pngBase64.length} base64 chars` : "not parsed (check REPORT-backend.md: QR response format)"}`);
    await check("remindInvoice", () => gw.remindInvoice(inv.invoiceId, { subject: "Smoke reminder" }));
  }

  step("Disputes v1: list");
  const disputes = await check("listDisputes", () => gw.listDisputes({ startTime: new Date(Date.now() - 30 * 86400000).toISOString() }));
  if (disputes) console.log(`${disputes.length} dispute(s) in the last 30 days`);

  rl.close();
  console.log(failures.length ? `\n${failures.length} step(s) failed: ${failures.join(", ")}` : "\nAll sandbox steps passed.");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
