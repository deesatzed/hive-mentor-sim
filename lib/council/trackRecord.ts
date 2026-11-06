/**
 * Track record per lens (council handoff docs/ARCHITECTURE.md "Track record"): over outcomes that were
 * checked in, n, mean rating, and the count rated ≥ 4 ("held") versus ≤ 2 ("did not"). Below n = 10
 * only counts are shown (displayMode "counts"); the caveat always goes with it.
 */

export const MIN_N_FOR_MEAN = 10;
export const CAVEAT = "Small numbers, many other factors. A hint, not a verdict.";

export interface LensStats {
  lens: string;
  n: number;
  held: number;
  didNot: number;
  /** null below MIN_N_FOR_MEAN */
  mean: number | null;
  displayMode: "counts" | "full";
  sentence: string;
}

export function lensStats(lens: string, ratings: number[]): LensStats {
  const n = ratings.length;
  const held = ratings.filter((r) => r >= 4).length;
  const didNot = ratings.filter((r) => r <= 2).length;
  const full = n >= MIN_N_FOR_MEAN;
  const mean = full ? ratings.reduce((s, r) => s + r, 0) / n : null;
  const times = `${n} time${n === 1 ? "" : "s"}`;
  const sentence = full
    ? `${lens}: ${times}, mean rating ${mean!.toFixed(1)} of 5; ${held} held, ${didNot} did not.`
    : `${lens}: ${times}: ${held} held, ${didNot} did not${n - held - didNot ? `, ${n - held - didNot} mixed` : ""}.`;
  return { lens, n, held, didNot, mean, displayMode: full ? "full" : "counts", sentence };
}

/** Groups (lens, rating) pairs; one outcome may count for several lenses. Sorted by n desc, then name. */
export function lensTable(pairs: { lens: string; rating: number }[]): LensStats[] {
  const by = new Map<string, number[]>();
  for (const p of pairs) by.set(p.lens, [...(by.get(p.lens) ?? []), p.rating]);
  return [...by].map(([lens, r]) => lensStats(lens, r)).sort((a, b) => b.n - a.n || a.lens.localeCompare(b.lens));
}
