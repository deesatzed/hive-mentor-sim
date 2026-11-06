import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/council/db";
import { CheckInError, checkIn } from "@/lib/hive/predictions";
import { serverProviders } from "@/lib/hive/serverProviders";

const Body = z.object({ rating: z.number().int().min(1).max(5), note: z.string().max(1000).optional() });

/** The operator rates a prediction's outcome 1–5 (once). */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/predictions/[id]/checkin">) {
  const { id } = await ctx.params;
  const b = Body.safeParse(await req.json().catch(() => null));
  if (!b.success) return Response.json({ error: "rating must be an integer from 1 to 5" }, { status: 400 });
  try {
    const row = await checkIn(getDb(), serverProviders().ledger, id, b.data.rating, b.data.note ?? null);
    return Response.json({ ok: true, id: row.id, outcomeRating: row.outcomeRating });
  } catch (e) {
    if (e instanceof CheckInError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
