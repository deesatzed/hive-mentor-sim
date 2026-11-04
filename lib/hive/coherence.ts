import "server-only";
import type { Embedder } from "@/lib/council/providers/embeddings";

/**
 * Coherence (docs/CONCLAVE_MATH.md §7; sent2 v1.3 §3.2). Decomposed, never a single composite:
 *   C_intra(t) = 1 − mean_i D(v_i(t), v_i(t−1))   self-consistency; low = pathology → WITNESS flag
 *   C_inter(t) = mean_{i≠j} D(v_i(t), v_j(t))     pluralism; healthy inside a band
 * v_i = mean embedding of Voice i's claims in the cycle; D = cosine distance. Voices that said PASS in
 * either cycle are excluded from C_intra for that pair. Uses the configured Embedder (MockEmbedder in
 * mock mode); with no embedding provider configured, coherence is reported unavailable.
 */

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
export const divergence = (a: Float32Array, b: Float32Array) => 1 - cosine(a, b);

export interface CoherenceReport {
  cIntra: number | null;
  cInter: number | null;
  perVoiceDrift: Record<string, number>;
  flags: string[];
  unavailable: boolean;
}

type Claims = { voice: string; claim: string }[];

async function voiceVectors(embedder: Embedder, claims: Claims): Promise<Map<string, Float32Array>> {
  const spoken = claims.filter((c) => c.claim.trim() && c.claim.trim().toUpperCase() !== "PASS");
  if (!spoken.length) return new Map();
  const vecs = await embedder.embed(spoken.map((c) => c.claim));
  const by = new Map<string, Float32Array[]>();
  spoken.forEach((c, i) => by.set(c.voice, [...(by.get(c.voice) ?? []), vecs[i]]));
  const out = new Map<string, Float32Array>();
  for (const [v, list] of by) {
    const m = new Float32Array(list[0].length);
    for (const x of list) for (let i = 0; i < m.length; i++) m[i] += x[i] / list.length;
    out.set(v, m);
  }
  return out;
}

export async function measureCoherence(args: {
  embedder: Embedder;
  current: Claims;
  previous: Claims | null;
  intraMin: number;
  interBand: [number, number];
}): Promise<CoherenceReport> {
  let cur: Map<string, Float32Array>;
  let prev: Map<string, Float32Array>;
  try {
    cur = await voiceVectors(args.embedder, args.current);
    prev = args.previous ? await voiceVectors(args.embedder, args.previous) : new Map();
  } catch (e) {
    return { cIntra: null, cInter: null, perVoiceDrift: {}, flags: [`coherence unavailable: ${(e as Error).message.slice(0, 120)}`], unavailable: true };
  }
  const drift: Record<string, number> = {};
  for (const [v, vec] of cur) {
    const p = prev.get(v);
    if (p) drift[v] = divergence(vec, p);
  }
  const ds = Object.values(drift);
  const cIntra = ds.length ? 1 - ds.reduce((a, b) => a + b, 0) / ds.length : null;

  const vs = [...cur.values()];
  let cInter: number | null = null;
  if (vs.length >= 2) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < vs.length; i++)
      for (let j = i + 1; j < vs.length; j++) {
        sum += divergence(vs[i], vs[j]);
        n++;
      }
    cInter = sum / n;
  }

  const flags: string[] = [];
  if (cIntra !== null && cIntra < args.intraMin) {
    const [worst, d] = Object.entries(drift).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    flags.push(`C_intra ${cIntra.toFixed(2)} < ${args.intraMin}: a Voice is inconsistent with its own prior claim (worst drift ${worst}, D=${d.toFixed(2)})`);
  }
  if (cInter !== null) {
    const [lo, hi] = args.interBand;
    if (cInter < lo) flags.push(`C_inter ${cInter.toFixed(2)} < ${lo}: echo-chamber risk`);
    if (cInter > hi) flags.push(`C_inter ${cInter.toFixed(2)} > ${hi}: incoherence, no shared frame this cycle`);
  }
  return { cIntra, cInter, perVoiceDrift: drift, flags, unavailable: false };
}
