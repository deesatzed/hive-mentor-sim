import { z } from "zod";
import { getDb } from "@/lib/council/db";
import { resetHiveState, ResetError } from "@/lib/hive/admin";

const Body = z.object({ confirm: z.string() });

/** POST {confirm: "reset hive state"} — backs up the database file, then clears the Hive's experience. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "confirm is required" }, { status: 400 });
  try {
    const r = await resetHiveState(getDb(), { confirm: parsed.data.confirm });
    return Response.json({ ...r, backup: r.backup.split("/").slice(-2).join("/") });
  } catch (e) {
    if (e instanceof ResetError) return Response.json({ error: e.message }, { status: 400 });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
