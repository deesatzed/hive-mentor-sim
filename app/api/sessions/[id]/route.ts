import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/council/db";
import { PrismaLedger } from "@/lib/council/ledger";
import { DominantMentorError, setSessionDominant } from "@/lib/hive/dominant";

const Body = z.object({ dominantMentorId: z.string().min(1) });

/** Changes the conversation's dominant mentor (any time; the change is ledgered and applies from the next message). */
export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/sessions/[id]">) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "dominantMentorId is required" }, { status: 400 });
  const db = getDb();
  try {
    return Response.json({ dominantMentor: await setSessionDominant(db, new PrismaLedger(db), id, parsed.data.dominantMentorId) });
  } catch (e) {
    if (e instanceof DominantMentorError) return Response.json({ error: e.message }, { status: e.message === "no such session" ? 404 : 400 });
    throw e;
  }
}
