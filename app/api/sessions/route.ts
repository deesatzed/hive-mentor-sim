import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/council/db";
import { PrismaLedger } from "@/lib/council/ledger";
import { DominantMentorError, setSessionDominant } from "@/lib/hive/dominant";
import { serverHive } from "@/lib/hive/server";

export async function GET() {
  const sessions = await getDb().hiveSession.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: { id: true, mode: true, title: true, dominantMentorId: true, createdAt: true } });
  return Response.json({ sessions });
}

const Body = z.object({ dominantMentorId: z.string().min(1) });

/** A new chat needs a dominant mentor, picked by the user before the first message (owner decision 2026-11-06). */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "pick a dominant mentor first (dominantMentorId)" }, { status: 400 });
  const db = getDb();
  const id = await serverHive().createSession("chat", "web");
  try {
    const mentor = await setSessionDominant(db, new PrismaLedger(db), id, parsed.data.dominantMentorId);
    return Response.json({ id, dominantMentor: mentor });
  } catch (e) {
    await db.hiveSession.delete({ where: { id } });
    if (e instanceof DominantMentorError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
