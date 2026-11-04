import "server-only";

/**
 * Kernel attention (docs/CONCLAVE_MATH.md §2; sent2 v1.2 §3.5). Deterministic code, never an LLM.
 *
 *   A(m) = s·c − λ·dup(m) + μ·|v|
 *
 * Moral-salience-flagged whispers bypass ranking and are always on the shortlist.
 * Shortlist = bypass ∪ top-k by A; the rest are `decayed` (returned so the trace and WITNESS can
 * audit both layers of dropping). sent2's urgency bypass is removed (owner decision).
 * Ties are broken by id so the result never depends on input order.
 */

export interface AttentionItem {
  id: string;
  claim: string;
  salience: number;
  confidence: number;
  valence: number;
}

export interface AttentionOpts {
  k: number;
  lambda: number;
  mu: number;
  moralFlagged?: ReadonlySet<string>;
  /** Normalized claims already stored in memory (dup = 1 when a claim repeats one of them). */
  seenClaims?: ReadonlySet<string>;
}

export interface AttentionResult {
  scores: Record<string, number>;
  shortlist: string[];
  bypass: string[];
  decayed: string[];
}

export const normalizeClaim = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function attentionScore(m: AttentionItem, dup: 0 | 1, lambda: number, mu: number): number {
  return m.salience * m.confidence - lambda * dup + mu * Math.abs(m.valence);
}

export function rank(items: AttentionItem[], o: AttentionOpts): AttentionResult {
  const moral = o.moralFlagged ?? new Set<string>();
  const seen = o.seenClaims ?? new Set<string>();
  const scores: Record<string, number> = {};
  const bypass: string[] = [];
  const pool: { id: string; A: number }[] = [];
  for (const m of items) {
    const A = attentionScore(m, seen.has(normalizeClaim(m.claim)) ? 1 : 0, o.lambda, o.mu);
    scores[m.id] = A;
    if (moral.has(m.id)) bypass.push(m.id);
    else pool.push({ id: m.id, A });
  }
  pool.sort((a, b) => b.A - a.A || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  bypass.sort();
  return {
    scores,
    bypass,
    shortlist: [...bypass, ...pool.slice(0, o.k).map((p) => p.id)],
    decayed: pool.slice(o.k).map((p) => p.id),
  };
}
