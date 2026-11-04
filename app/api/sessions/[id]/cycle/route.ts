import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/council/db";
import { serverHive } from "@/lib/hive/server";

const Body = z.object({ input: z.string().trim().min(1).max(4000) });

/** Runs one heartbeat cycle (JSON response; phase streaming over SSE is not built yet). */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/sessions/[id]/cycle">) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "input is required" }, { status: 400 });
  const session = await getDb().hiveSession.findUnique({ where: { id } });
  if (!session) return Response.json({ error: "no such session" }, { status: 404 });
  try {
    const r = await serverHive().runCycle({ sessionId: id, input: parsed.data.input });
    const sm = await getDb().selfModelVersion.findFirst({ where: { promoted: true }, orderBy: { version: "desc" } });
    return Response.json({ cycleId: r.cycleId, cycleNo: r.cycleNo, status: r.status, output: r.output, trace: r.trace, selfModel: sm ? JSON.parse(sm.body) : null });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
