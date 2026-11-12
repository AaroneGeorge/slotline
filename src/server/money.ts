/** Decimal-string money helpers. All arithmetic is done in integer cents. */

const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;

export function isMoney(v: unknown): v is string {
  return typeof v === "string" && MONEY_RE.test(v);
}

export function toCents(v: string): number {
  if (!isMoney(v)) throw new Error(`invalid money amount: ${JSON.stringify(v)}`);
  const neg = v.startsWith("-");
  const [whole, frac = ""] = (neg ? v.slice(1) : v).split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
}

export function fromCents(c: number): string {
  const neg = c < 0;
  const abs = Math.abs(Math.round(c));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

export function addMoney(...vs: string[]): string {
  return fromCents(vs.reduce((sum, v) => sum + toCents(v), 0));
}

export function cmpMoney(a: string, b: string): number {
  return toCents(a) - toCents(b);
}

export function normalizeMoney(v: string): string {
  return fromCents(toCents(v));
}
