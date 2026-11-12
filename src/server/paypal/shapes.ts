/**
 * PayPal wire-format shapes (snake_case) for webhook envelopes and resources,
 * used by the MockGateway and the dev fixtures. Field names follow
 * https://developer.paypal.com/api/rest/webhooks/rest/ (envelope) and the
 * Orders v2 / Payments v2 / Invoicing v2 / Disputes v1 resource schemas.
 */
import { SANDBOX_BASE_URL } from "./client";

export interface WebhookEnvelope {
  id: string;
  event_version: string;
  create_time: string;
  resource_type: string;
  resource_version?: string;
  event_type: string;
  summary: string;
  resource: Record<string, unknown>;
  links: { href: string; rel: string; method: string }[];
}

export function webhookEnvelope(id: string, eventType: string, resourceType: string, resource: Record<string, unknown>, summary: string, resourceVersion = "2.0"): WebhookEnvelope {
  return {
    id,
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: resourceType,
    ...(resourceVersion ? { resource_version: resourceVersion } : {}),
    event_type: eventType,
    summary,
    resource,
    links: [
      { href: `${SANDBOX_BASE_URL}/v1/notifications/webhooks-events/${id}`, rel: "self", method: "GET" },
      { href: `${SANDBOX_BASE_URL}/v1/notifications/webhooks-events/${id}/resend`, rel: "resend", method: "POST" },
    ],
  };
}

export function moneyJson(value: string, currency: string) {
  return { currency_code: currency, value };
}

export function captureLinks(captureId: string, authorizationId?: string | null) {
  return [
    { href: `${SANDBOX_BASE_URL}/v2/payments/captures/${captureId}`, rel: "self", method: "GET" },
    { href: `${SANDBOX_BASE_URL}/v2/payments/captures/${captureId}/refund`, rel: "refund", method: "POST" },
    ...(authorizationId ? [{ href: `${SANDBOX_BASE_URL}/v2/payments/authorizations/${authorizationId}`, rel: "up", method: "GET" }] : []),
  ];
}

export function refundLinks(refundId: string, captureId: string) {
  return [
    { href: `${SANDBOX_BASE_URL}/v2/payments/refunds/${refundId}`, rel: "self", method: "GET" },
    { href: `${SANDBOX_BASE_URL}/v2/payments/captures/${captureId}`, rel: "up", method: "GET" },
  ];
}

/** Webhook resource_type for each event we use. */
export const RESOURCE_TYPE: Record<string, string> = {
  "CHECKOUT.ORDER.APPROVED": "checkout-order",
  "PAYMENT.AUTHORIZATION.CREATED": "authorization",
  "PAYMENT.AUTHORIZATION.VOIDED": "authorization",
  "PAYMENT.CAPTURE.COMPLETED": "capture",
  "PAYMENT.CAPTURE.DECLINED": "capture",
  "PAYMENT.CAPTURE.DENIED": "capture",
  "PAYMENT.CAPTURE.PENDING": "capture",
  "PAYMENT.CAPTURE.REFUNDED": "refund",
  "INVOICING.INVOICE.PAID": "invoices",
  "CUSTOMER.DISPUTE.CREATED": "dispute",
};
