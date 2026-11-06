import type { NextRequest } from "next/server";
import { getDb } from "@/lib/council/db";
import { busTranscript, ledgerView } from "@/lib/hive/admin";

/** GET /api/ledger?kind=decision.*&cycle=<id>&limit=100 — events, spend, and (with cycle) the bus transcript. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const cycleId = sp.get("cycle") || undefined;
  const limit = sp.get("limit") ? Number(sp.get("limit")) : undefined;
  const db = getDb();
  const view = await ledgerView(db, { kind: sp.get("kind") || undefined, cycleId, limit: Number.isFinite(limit) ? limit : undefined });
  return Response.json({ ...view, bus: cycleId ? await busTranscript(db, cycleId) : null });
}
