import "server-only";

/**
 * Agreement and effective diversity (docs/CONCLAVE_MATH.md §8, from the council handoff):
 *   κ_ij = (a_ij − 1/k̄) / (1 − 1/k̄), clipped to [0, 1], over ≥ 5 shared items (else 0.5),
 *     a_ij = share of shared items where i and j chose the same option, k̄ = mean option count;
 *   N_eff = (Σ_i S_ii)² / Σ_ij S_ij², with S_ii = 1 and S_ij = κ_ij.
 * Used for mentors (shared answered dilemmas) and Voices (shared Reveal ballots).
 */

export const MIN_SHARED = 5;

/** choices: subject → item → chosen option; optionCount: item → number of options. */
export function kappa(a: Map<string, string>, b: Map<string, string>, optionCount: Map<string, number>): { kappa: number; shared: number } {
  const shared = [...a.keys()].filter((k) => b.has(k));
  if (shared.length < MIN_SHARED) return { kappa: 0.5, shared: shared.length };
  const agree = shared.filter((k) => a.get(k) === b.get(k)).length / shared.length;
  const kbar = shared.reduce((s, k) => s + (optionCount.get(k) ?? 2), 0) / shared.length;
  const chance = 1 / kbar;
  const k = (agree - chance) / (1 - chance);
  return { kappa: Math.min(1, Math.max(0, k)), shared: shared.length };
}

export interface DiversityReport {
  nEff: number;
  subjects: string[];
  kappa: Record<string, Record<string, number>>;
}

export function effectiveN(choices: Map<string, Map<string, string>>, optionCount: Map<string, number>): DiversityReport {
  const subjects = [...choices.keys()].sort();
  const K: Record<string, Record<string, number>> = {};
  let sumSq = 0;
  for (const i of subjects) {
    K[i] = {};
    for (const j of subjects) {
      const s = i === j ? 1 : kappa(choices.get(i)!, choices.get(j)!, optionCount).kappa;
      K[i][j] = s;
      sumSq += s * s;
    }
  }
  const n = subjects.length;
  return { nEff: n === 0 ? 0 : (n * n) / sumSq, subjects, kappa: K };
}
