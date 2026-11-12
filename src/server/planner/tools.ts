/**
 * The "planning grant": read-only PayPal tools the model may call while it
 * plans (sandbox mode only). They wrap the gateway's read methods as AI SDK 7
 * tools; nothing here can move money. (@paypal/agent-toolkit 1.11.0's AI-SDK
 * adapter is built on ai@4 / zod@3 and uses the v4 `parameters` key, which AI
 * SDK 7 ignores, so it is not used directly; see REPORT-backend.md.)
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getGateway } from "../paypal";
import { normalizePaypalError } from "../paypal/errors";
import { writeLog } from "../log";

function trim(o: unknown, max = 6000): unknown {
  const s = JSON.stringify(o);
  return s.length <= max ? o : { truncated: true, json: s.slice(0, max) };
}

async function run(name: string, args: Record<string, unknown>, fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    writeLog({ actor: "agent", kind: "agent.tool", message: `planning tool ${name} (read-only)`, refs: { tool: name, ...Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])) } });
    return trim(out);
  } catch (e) {
    const err = normalizePaypalError(e);
    return { error: err.issue, status: err.status };
  }
}

export function planningTools(): ToolSet {
  const gw = getGateway();
  return {
    get_order: tool({
      description: "Read a PayPal order (Orders v2) by id. Read-only.",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => run("get_order", { orderId }, () => gw.getOrder(orderId)),
    }),
    get_invoice: tool({
      description: "Read a PayPal invoice (Invoicing v2) by id. Read-only.",
      inputSchema: z.object({ invoiceId: z.string() }),
      execute: async ({ invoiceId }) => run("get_invoice", { invoiceId }, async () => (await gw.getInvoice(invoiceId)).raw),
    }),
    list_invoices: tool({
      description: "List recent PayPal invoices for the merchant (id, status, amount). Read-only.",
      inputSchema: z.object({}),
      execute: async () => run("list_invoices", {}, async () => (await gw.listInvoices({ pageSize: 20 })).map((i) => ({ id: i.invoiceId, status: i.status, amount: i.amount }))),
    }),
    get_dispute: tool({
      description: "Read a PayPal dispute (Disputes v1) by id. Read-only.",
      inputSchema: z.object({ disputeId: z.string() }),
      execute: async ({ disputeId }) => run("get_dispute", { disputeId }, async () => (await gw.getDispute(disputeId)).raw),
    }),
  };
}
