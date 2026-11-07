import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/council/db";
import { PrismaLedger } from "@/lib/council/ledger";
import { dominantChoices, DominantMentorError, rulingDominant, setRulingDominant } from "@/lib/hive/dominant";

/** Active mentors that can make the final call, and the operator's choice for Reveal and calibration. */
export async function GET() {
  await connection();
  const db = getDb();
  return Response.json({ choices: await dominantChoices(db), ruling: await rulingDominant(db) });
}

const Body = z.object({ mentorId: z.string().min(1).nullable() });

/** Sets (or clears, with null) the dominant mentor for Reveal and calibration. Ledgered. */
export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "mentorId (string or null) is required" }, { status: 400 });
  try {
    const db = getDb();
    return Response.json({ ruling: await setRulingDominant(db, new PrismaLedger(db), parsed.data.mentorId) });
  } catch (e) {
    if (e instanceof DominantMentorError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
