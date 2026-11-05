import "server-only";
import { getDb } from "@/lib/council/db";
import { PrismaLedger } from "@/lib/council/ledger";
import { getProviders, type Providers } from "@/lib/council/providers";
import { hiveConfig } from "./config";

/** Providers for API routes that call models outside a cycle (constitution drafting). */
let cached: { providers: Providers; ledger: PrismaLedger } | null = null;
export function serverProviders() {
  if (!cached) {
    const ledger = new PrismaLedger(getDb());
    cached = { providers: getProviders(process.env, { ledger, models: hiveConfig().models }), ledger };
  }
  return cached;
}
