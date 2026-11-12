"use client";

import { useState } from "react";

/** A PayPal / Slotline reference rendered as a click-to-copy chip. */
export function RefChip({ name, value, tone = "default" }: { name: string; value: string; tone?: "default" | "paypal" }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1100);
    } catch {
      // clipboard blocked (http, iframe): the value is still selectable
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${name}: ${value}`}
      className={`group inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-[1px] font-mono text-[10.5px] leading-4 transition-colors ${
        tone === "paypal"
          ? "border-paypal/25 bg-paypal/[0.06] text-paypal hover:bg-paypal/[0.12]"
          : "border-line bg-surface-2 text-ink-2 hover:bg-surface-3"
      }`}
    >
      <span className="text-ink-3">{name}</span>
      <span className="truncate">{copied ? "copied" : value}</span>
    </button>
  );
}

const PAYPAL_KEYS = new Set([
  "orderId",
  "authorizationId",
  "captureId",
  "refundId",
  "invoiceId",
  "disputeId",
  "eventId",
  "webhookId",
]);

export function RefChips({ refs }: { refs: Record<string, string> }) {
  const entries = Object.entries(refs).filter(([, v]) => v);
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <RefChip key={k} name={k} value={v} tone={PAYPAL_KEYS.has(k) ? "paypal" : "default"} />
      ))}
    </div>
  );
}
