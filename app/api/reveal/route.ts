import type { NextRequest } from "next/server";
import { getDb } from "@/lib/council/db";
import { revealResults } from "@/lib/hive/reveal";
import { revealStatus, startReveal } from "@/lib/hive/revealServer";

export async function GET() {
  try {
    return Response.json({ ...(await revealResults(getDb())), run: revealStatus() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Starts or resumes the Reveal run in the background (body may carry {limit}). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { limit?: unknown };
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : undefined;
  const r = startReveal(limit);
  return Response.json({ ...r, run: revealStatus() }, { status: r.started ? 202 : 409 });
}
