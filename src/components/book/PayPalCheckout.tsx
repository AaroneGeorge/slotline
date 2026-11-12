"use client";

/**
 * Sandbox checkout with the PayPal JS SDK (react-paypal-js, PayPalScriptProvider
 * + PayPalButtons). intent=authorize: the buyer approves a hold for the
 * deposit; our server creates the order (POST /order) and authorizes it
 * (POST /authorize). Nothing is captured here.
 */
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import type { AuthorizeResponse, PublicBookingView } from "@/shared/types";
import { errorMessage } from "@/lib/client/api";
import type { SlotlineBackend } from "@/lib/client/backend";

export function PayPalCheckout({
  clientId,
  currency,
  booking,
  backend,
  onAuthorized,
  onError,
  onCancel,
}: {
  clientId: string;
  currency: string;
  booking: Pick<PublicBookingView, "id">;
  backend: SlotlineBackend;
  onAuthorized: (res: AuthorizeResponse) => void;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  return (
    <PayPalScriptProvider options={{ clientId, intent: "authorize", currency, components: "buttons" }}>
      <PayPalButtons
        style={{ layout: "vertical", shape: "rect", color: "gold", label: "paypal", height: 45 }}
        forceReRender={[booking.id, currency]}
        createOrder={async () => {
          const { orderId } = await backend.createOrder(booking.id);
          return orderId;
        }}
        onApprove={async (data) => {
          try {
            const res = await backend.authorize(booking.id, { orderId: data.orderID });
            onAuthorized(res);
          } catch (err) {
            onError(errorMessage(err));
          }
        }}
        onCancel={() => onCancel()}
        onError={(err) => onError(err instanceof Error ? err.message : String(err))}
      />
    </PayPalScriptProvider>
  );
}
