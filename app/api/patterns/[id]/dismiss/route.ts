import type { NextRequest } from "next/server";
import { getDb } from "@/lib/council/db";
import { hiveConfig } from "@/lib/hive/config";
import { dismissPattern } from "@/lib/hive/signalStore";
import { serverProviders } from "@/lib/hive/serverProviders";

/** Hides a pattern card for signals.dismiss_days (30 by default). */
export async function POST(_req: NextRequest, ctx: RouteContext<"/api/patterns/[id]/dismiss">) {
  const { id } = await ctx.params;
  try {
    return Response.json(await dismissPattern(getDb(), serverProviders().ledger, hiveConfig(), id));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}
