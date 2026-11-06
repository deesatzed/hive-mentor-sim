import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Ledger } from "@/lib/council/ledger";
import { density, dismissUntil, surfacePatterns, type SignalPolicy } from "@/lib/council/signals";
import type { HiveConfig } from "./config";

/**
 * Persistence for decaying signals and pattern cards (ARCHITECTURE.md "Council metrics, signals, track
 * record"; PRODUCT_SPEC.md §8). Signals: `tension` / `serves` per constitution principle from
 * PRINCIPLE_STATUS on the composed output, `dissent` per Voice whose ballot top choice ≠ the Conclave
 * winner. Pattern cards are observations, never verdicts.
 */

export const policyOf = (cfg: HiveConfig): SignalPolicy => ({
  thresholds: cfg.signals.thresholds,
  resurfaceDays: cfg.signals.resurface_days,
  resurfaceIncrease: cfg.signals.resurface_increase,
});

export interface EmittedSignal {
  type: "tension" | "serves" | "dissent";
  subjectType: "principle" | "voice";
  subjectId: string;
}

/** Writes the cycle's signals, then surfaces any pattern that now crosses its threshold (ledger `pattern.surfaced`). */
export async function emitAndSurface(db: PrismaClient, ledger: Ledger, cfg: HiveConfig, cycleId: string, signals: EmittedSignal[], now = new Date()): Promise<string[]> {
  for (const s of signals) await db.signal.create({ data: { ...s, strength: 1, halfLifeDays: cfg.signals.half_life_days, cycleId, createdAt: now } });
  return surfaceNow(db, ledger, cfg, now);
}

export async function surfaceNow(db: PrismaClient, ledger: Ledger, cfg: HiveConfig, now = new Date()): Promise<string[]> {
  const [rows, surfaces] = await Promise.all([db.signal.findMany(), db.patternSurface.findMany()]);
  const fresh = surfacePatterns(rows, surfaces, policyOf(cfg), now);
  const ids: string[] = [];
  for (const c of fresh) {
    const row = await db.patternSurface.create({ data: { subjectType: c.subjectType, subjectId: c.subjectId, type: c.type, density: c.density, createdAt: now } });
    await ledger.record({ kind: "pattern.surfaced", subjectType: c.subjectType, subjectId: c.subjectId, payload: { type: c.type, density: c.density, patternId: row.id } });
    ids.push(row.id);
  }
  return ids;
}

export async function dismissPattern(db: PrismaClient, ledger: Ledger, cfg: HiveConfig, id: string, now = new Date()) {
  const row = await db.patternSurface.findUnique({ where: { id } });
  if (!row) throw new Error(`pattern ${id} not found`);
  const until = dismissUntil(now, cfg.signals.dismiss_days);
  await db.patternSurface.update({ where: { id }, data: { dismissedUntil: until } });
  await ledger.record({ kind: "pattern.dismissed", subjectType: row.subjectType, subjectId: row.subjectId, payload: { type: row.type, patternId: id, until: until.toISOString() } });
  return { id, dismissedUntil: until };
}

/**
 * Visible pattern cards: the latest surface per subject/type, unless a dismissal is in force. The
 * sentence counts the signals behind it over the last `pattern_window_cycles` cycles (or Conclaves, for dissent).
 */
export async function patternCards(db: PrismaClient, cfg: HiveConfig, now = new Date()) {
  const [surfaces, signals, principles] = await Promise.all([
    db.patternSurface.findMany({ orderBy: { createdAt: "desc" } }),
    db.signal.findMany(),
    db.hivePrinciple.findMany({ select: { id: true, text: true } }),
  ]);
  const latest = new Map<string, (typeof surfaces)[number]>();
  for (const s of surfaces) {
    const k = `${s.subjectType}|${s.subjectId}|${s.type}`;
    if (!latest.has(k)) latest.set(k, s);
  }
  const dismissedNow = (k: string) => surfaces.some((s) => `${s.subjectType}|${s.subjectId}|${s.type}` === k && s.dismissedUntil && s.dismissedUntil > now);
  const window = cfg.signals.pattern_window_cycles;
  const recentCycles = (await db.cycle.findMany({ orderBy: { cycleNo: "desc" }, take: window, select: { id: true } })).map((c) => c.id);
  const recentConclaves = (await db.conclaveRun.findMany({ where: { cycleId: { in: recentCycles } }, select: { cycleId: true } })).map((c) => c.cycleId);
  const textOf = new Map(principles.map((p) => [p.id, p.text]));
  const cards = [];
  for (const [k, s] of latest) {
    if (dismissedNow(k)) continue;
    const mine = signals.filter((x) => x.subjectType === s.subjectType && x.subjectId === s.subjectId && x.type === s.type);
    const inWindow = mine.filter((x) => x.cycleId && recentCycles.includes(x.cycleId)).length;
    const sentence =
      s.type === "dissent"
        ? `${s.subjectId} has dissented in ${inWindow} of the last ${Math.min(window, recentConclaves.length)} Conclaves.`
        : `Principle "${textOf.get(s.subjectId) ?? s.subjectId}" has been ${s.type === "tension" ? "in tension" : "served"} ${inWindow} time${inWindow === 1 ? "" : "s"} in the last ${Math.min(window, recentCycles.length)} cycles.`;
    cards.push({
      id: s.id,
      type: s.type,
      subjectType: s.subjectType,
      subjectId: s.subjectId,
      sentence,
      densityAtSurface: s.density,
      densityNow: density(signals, s.subjectType, s.subjectId, s.type, now),
      surfacedAt: s.createdAt.toISOString(),
      cycleIds: [...new Set(mine.map((x) => x.cycleId).filter((x): x is string => !!x))].slice(-10),
    });
  }
  return cards.sort((a, b) => b.surfacedAt.localeCompare(a.surfacedAt));
}
