import { getDb } from "@/lib/council/db";
import { BlocAudit, type Ballot } from "@/lib/hive/conclave";
import { hiveConfig } from "@/lib/hive/config";
import { patternCards } from "@/lib/hive/signalStore";

/** Interoception register: affect + coherence samples, open CONFLICT markers, ego audits, commitments, pattern cards, bloc audit. */
export async function GET() {
  const db = getDb();
  const cfg = hiveConfig();
  const [samples, markers, audits, commitments] = await Promise.all([
    db.interoceptionSample.findMany({ orderBy: { cycleNo: "desc" }, take: 50 }),
    db.memoryRecord.findMany({ where: { kind: "conflict_marker" }, orderBy: { createdCycle: "desc" }, take: 50, select: { id: true, body: true, createdCycle: true, resolvedCycle: true } }),
    db.egoAudit.findMany({ orderBy: { cycleNo: "desc" }, take: 20 }),
    db.commitment.findMany({ orderBy: { cycleMade: "desc" }, take: 50 }),
  ]);
  // bloc audit (CONCLAVE_MATH.md §5): Voices voting in lockstep, ρ̄ > 0.9 over ≥ 5 Conclaves (last 50)
  const runs = await db.conclaveRun.findMany({ orderBy: { id: "desc" }, take: 50, select: { options: true, ballots: true, weights: true } });
  const bloc = new BlocAudit();
  for (const r of runs) {
    const optionIds = (JSON.parse(r.options) as { option_id: string }[]).map((o) => o.option_id);
    const weights = JSON.parse(r.weights) as Record<string, { w?: number }>;
    const ballots: Ballot[] = Object.entries(JSON.parse(r.ballots) as Record<string, Record<string, number> | { abstained: true }>).map(([voice, b]) =>
      "abstained" in b ? { voice, w: weights[voice]?.w ?? 0, c: 0, scores: {}, abstained: true } : { voice, w: weights[voice]?.w ?? 0, c: 0, scores: b as Record<string, number>, abstained: false },
    );
    bloc.record(ballots, optionIds);
  }
  return Response.json({
    patterns: await patternCards(db, cfg),
    bloc: { conclaves: bloc.conclaves, flags: bloc.flag() },
    band: cfg.coherence.inter_band,
    intraMin: cfg.coherence.intra_min,
    samples,
    markers,
    audits: audits.map((a) => ({ ...a, findings: JSON.parse(a.findings) })),
    commitments: commitments.map((c) => ({ ...c, breakageRecord: c.breakageRecord ? JSON.parse(c.breakageRecord) : null })),
  });
}
