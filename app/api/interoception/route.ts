import { getDb } from "@/lib/council/db";
import { hiveConfig } from "@/lib/hive/config";

/** Interoception register: affect + coherence samples, open CONFLICT markers, ego audits, commitments. */
export async function GET() {
  const db = getDb();
  const cfg = hiveConfig();
  const [samples, markers, audits, commitments] = await Promise.all([
    db.interoceptionSample.findMany({ orderBy: { cycleNo: "desc" }, take: 50 }),
    db.memoryRecord.findMany({ where: { kind: "conflict_marker" }, orderBy: { createdCycle: "desc" }, take: 50, select: { id: true, body: true, createdCycle: true, resolvedCycle: true } }),
    db.egoAudit.findMany({ orderBy: { cycleNo: "desc" }, take: 20 }),
    db.commitment.findMany({ orderBy: { cycleMade: "desc" }, take: 50 }),
  ]);
  return Response.json({
    band: cfg.coherence.inter_band,
    intraMin: cfg.coherence.intra_min,
    samples,
    markers,
    audits: audits.map((a) => ({ ...a, findings: JSON.parse(a.findings) })),
    commitments: commitments.map((c) => ({ ...c, breakageRecord: c.breakageRecord ? JSON.parse(c.breakageRecord) : null })),
  });
}
