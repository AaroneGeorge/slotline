/** Demo price list (USD-style decimal strings). Deposit is taken as a PayPal authorization; balance is invoiced. */
import type { Service } from "@/shared/types";

export const PRICES: Readonly<Record<Service, { label: string; deposit: string; balance: string }>> = {
  screen: { label: "Screen replacement", deposit: "40.00", balance: "89.00" },
  battery: { label: "Battery replacement", deposit: "25.00", balance: "54.00" },
  diagnostic: { label: "Diagnostic", deposit: "15.00", balance: "20.00" },
  water: { label: "Water-damage recovery", deposit: "50.00", balance: "99.00" },
};
