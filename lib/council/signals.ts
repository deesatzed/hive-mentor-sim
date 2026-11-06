/**
 * Decaying signals and pattern surfacing (council handoff docs/ARCHITECTURE.md "Signals", the quorum
 * primitive from hatrack; hive-sim ARCHITECTURE.md "Council metrics, signals, track record").
 *
 *   density(subject, type, now) = Σ strength · 0.5^(ageDays / halfLifeDays)
 *
 * A pattern surfaces when its density reaches the type's threshold. The same subject and type surface
 * again only after `resurfaceDays` or a density increase ≥ `resurfaceIncrease`, and never while a
 * dismissal is in force. Pure functions: callers load rows and persist results.
 */

export type SignalType = "tension" | "serves" | "dissent";

export interface SignalRow {
  type: string;
  subjectType: string;
  subjectId: string;
  strength: number;
  halfLifeDays: number;
  createdAt: Date;
}

export interface SurfaceRow {
  subjectType: string;
  subjectId: string;
  type: string;
  density: number;
  dismissedUntil: Date | null;
  createdAt: Date;
}

export interface SignalPolicy {
  thresholds: Record<string, number>;
  resurfaceDays: number;
  resurfaceIncrease: number;
}

const DAY = 86_400_000;

/** Exact exponential decay: a signal is worth half its strength after one half-life. */
export function decayed(strength: number, halfLifeDays: number, ageMs: number): number {
  return strength * Math.pow(0.5, Math.max(0, ageMs) / DAY / halfLifeDays);
}

export function density(rows: SignalRow[], subjectType: string, subjectId: string, type: string, now: Date): number {
  let d = 0;
  for (const r of rows) {
    if (r.type !== type || r.subjectType !== subjectType || r.subjectId !== subjectId) continue;
    d += decayed(r.strength, r.halfLifeDays, now.getTime() - r.createdAt.getTime());
  }
  return d;
}

export interface Candidate {
  subjectType: string;
  subjectId: string;
  type: string;
  density: number;
}

/**
 * Patterns that should surface now: density ≥ threshold, no dismissal in force for that subject/type,
 * and (if it surfaced before) either `resurfaceDays` have passed since the last surface or the density
 * rose by ≥ `resurfaceIncrease` over the density recorded then.
 */
export function surfacePatterns(signals: SignalRow[], surfaces: SurfaceRow[], policy: SignalPolicy, now: Date): Candidate[] {
  const keys = new Map<string, { subjectType: string; subjectId: string; type: string }>();
  for (const s of signals) keys.set(`${s.subjectType}|${s.subjectId}|${s.type}`, { subjectType: s.subjectType, subjectId: s.subjectId, type: s.type });
  const out: Candidate[] = [];
  for (const k of [...keys.values()].sort((a, b) => `${a.type}|${a.subjectType}|${a.subjectId}`.localeCompare(`${b.type}|${b.subjectType}|${b.subjectId}`))) {
    const threshold = policy.thresholds[k.type];
    if (threshold === undefined) continue;
    const d = density(signals, k.subjectType, k.subjectId, k.type, now);
    if (d < threshold) continue;
    const prior = surfaces.filter((s) => s.subjectType === k.subjectType && s.subjectId === k.subjectId && s.type === k.type);
    if (prior.some((s) => s.dismissedUntil && s.dismissedUntil.getTime() > now.getTime())) continue;
    const last = prior.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (last) {
      const waited = now.getTime() - last.createdAt.getTime() >= policy.resurfaceDays * DAY;
      const rose = d - last.density >= policy.resurfaceIncrease;
      if (!waited && !rose) continue;
    }
    out.push({ ...k, density: d });
  }
  return out;
}

/** The dismissal end for a pattern dismissed at `now`. */
export const dismissUntil = (now: Date, days: number) => new Date(now.getTime() + days * DAY);
