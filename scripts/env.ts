/** Minimal .env.local loader for the scripts (Next.js loads it for the app itself). */
import fs from "node:fs";
import path from "node:path";

export function loadEnvLocal(file = ".env.local"): void {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2].replace(/\s+#.*$/, "");
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function requireSandbox(): void {
  if (process.env.PAYPAL_MODE !== "sandbox") {
    console.error("Set PAYPAL_MODE=sandbox (and sandbox PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET) in .env.local first.");
    process.exit(2);
  }
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app) are required.");
    process.exit(2);
  }
}
