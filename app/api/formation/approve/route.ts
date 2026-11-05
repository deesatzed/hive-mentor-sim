import { z } from "zod";
import { getDb } from "@/lib/council/db";
import { approveFormation, FormationError } from "@/lib/hive/formation";

export async function POST(req: Request) {
  const b = z.object({ version: z.number().int().positive() }).safeParse(await req.json().catch(() => null));
  if (!b.success) return Response.json({ error: "version is required" }, { status: 400 });
  try {
    return Response.json(await approveFormation(getDb(), b.data.version));
  } catch (e) {
    if (e instanceof FormationError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
