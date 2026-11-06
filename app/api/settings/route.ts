import { connection } from "next/server";
import { getDb } from "@/lib/council/db";
import { RESET_KEPT, RESET_PHRASE, settingsView, spendToDate } from "@/lib/hive/admin";

/** Read-only config view (never the API key) plus measured spend to date. */
export async function GET() {
  await connection(); // per request: spend changes, and SQLite reads are synchronous (not detected as I/O by prerendering)
  return Response.json({ ...settingsView(), spend: await spendToDate(getDb()), reset: { phrase: RESET_PHRASE, kept: RESET_KEPT } });
}
