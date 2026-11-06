import "server-only";

/**
 * Kernel attention (docs/CONCLAVE_MATH.md §2; sent2 v1.2 §3.5). Deterministic code, never an LLM.
 *
 *   A(m) = s·c − λ·dup(m) + μ·|v|
 *
 * Moral-salience-flagged whispers bypass ranking and are always on the shortlist.
 * Shortlist = bypass ∪ top-k by A; the rest are `decayed` (returned so the trace and WITNESS can
 * audit both layers of dropping). sent2's urgency bypass is removed (owner decision).
 * Ties are broken by `tieKey` (the Voice name, unique per cycle), then by id, so the result never
 * depends on input order and repeats across runs (message ids are random; M9 finding).
 */

export interface AttentionItem {
  id: string;
  claim: string;
  salience: number;
  confidence: number;
  valence: number;
  /** stable tie-break key (the speaking Voice); falls back to id */
  tieKey?: string;
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
  const keyOf = new Map(items.map((m) => [m.id, m.tieKey ?? m.id]));
  const pool: { id: string; A: number; key: string }[] = [];
  for (const m of items) {
    const A = attentionScore(m, seen.has(normalizeClaim(m.claim)) ? 1 : 0, o.lambda, o.mu);
    scores[m.id] = A;
    if (moral.has(m.id)) bypass.push(m.id);
    else pool.push({ id: m.id, A, key: m.tieKey ?? m.id });
  }
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  pool.sort((a, b) => b.A - a.A || cmp(a.key, b.key) || cmp(a.id, b.id));
  bypass.sort((a, b) => cmp(keyOf.get(a)!, keyOf.get(b)!) || cmp(a, b));
  return {
    scores,
    bypass,
    shortlist: [...bypass, ...pool.slice(0, o.k).map((p) => p.id)],
    decayed: pool.slice(o.k).map((p) => p.id),
  };
}
