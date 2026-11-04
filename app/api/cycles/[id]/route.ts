import type { NextRequest } from "next/server";
import { getDb } from "@/lib/council/db";
import { serverHive } from "@/lib/hive/server";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/cycles/[id]">) {
  const { id } = await ctx.params;
  const c = await getDb().cycle.findUnique({ where: { id } });
  if (!c) return Response.json({ error: "no such cycle" }, { status: 404 });
  const conclave = await getDb().conclaveRun.findUnique({ where: { cycleId: id } });
  return Response.json({
    cycle: { id: c.id, cycleNo: c.cycleNo, input: c.input, output: c.output, verdict: c.verdict, status: c.status, costUsd: c.costUsd, latencyMs: c.latencyMs },
    trace: JSON.parse(c.trace),
    conclave: conclave && { ...conclave, options: JSON.parse(conclave.options), ballots: JSON.parse(conclave.ballots), weights: JSON.parse(conclave.weights), totals: JSON.parse(conclave.totals), dissent: JSON.parse(conclave.dissent), rounds: JSON.parse(conclave.rounds) },
    transcript: await serverHive().transcript(id),
  });
}
