import "server-only";
import { normalizeClaim } from "./attention";

/**
 * Conclave mathematics (docs/CONCLAVE_MATH.md §1, §3–§5; sent2 §7, v1.2 §3.8). Deterministic code.
 * Change from sent2: the lexicographic option filter of §7.3 is removed; every option goes to the ballot (owner decision).
 */

// ---------------------------------------------------------------- §1 weights

/** w_i(q) = max over the question's domain tags of the Voice's relevance profile. */
export function relevanceWeight(profile: Record<string, number>, domains: readonly string[]): number {
  return Math.max(0, ...domains.map((d) => profile[d] ?? 0));
}

/** α_i = w_i · c_i */
export const alpha = (w: number, c: number) => w * c;

// ---------------------------------------------------------------- §3 conflict trigger

export interface ContraPair {
  alphaI: number;
  alphaJ: number;
  contradicts: boolean;
  cI: number;
  cJ: number;
}

/** κ = Σ α_i α_j 1[contra] / Σ α_i α_j over pairs i<j; 0 when there is no weight. */
export function conflictKappa(pairs: ContraPair[]): number {
  const den = pairs.reduce((s, p) => s + p.alphaI * p.alphaJ, 0);
  if (den === 0) return 0;
  return pairs.reduce((s, p) => s + (p.contradicts ? p.alphaI * p.alphaJ : 0), 0) / den;
}

/** Conclave triggers iff κ > τ_κ, or any contradicting pair has both confidences > 0.6; always in ruling mode. */
export function shouldConvene(args: { kappa: number; pairs: ContraPair[]; tauKappa: number; mode: "chat" | "ruling" | "calibration" }): boolean {
  if (args.mode !== "chat") return true;
  if (args.kappa > args.tauKappa) return true;
  return args.pairs.some((p) => p.contradicts && p.cI > 0.6 && p.cJ > 0.6);
}

// ---------------------------------------------------------------- §4 options

export interface ConclaveOption {
  option_id: string;
  claim: string;
  evidence_refs: string[];
  uncertainty: string;
  proposed_by: string;
  status: "proposal" | "verified" | "contested" | "rejected";
}

/** Chat mode: options from contradicting claims, deduplicated by normalized text; ids opt_<taskId>_<n>. */
export function buildOptions(
  taskId: string,
  claims: { voice: string; claim: string; evidence_refs?: string[]; uncertainty?: string }[],
): ConclaveOption[] {
  const seen = new Set<string>();
  const out: ConclaveOption[] = [];
  for (const c of claims) {
    const key = normalizeClaim(c.claim);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      option_id: `opt_${taskId}_${out.length + 1}`,
      claim: c.claim,
      evidence_refs: c.evidence_refs ?? [],
      uncertainty: c.uncertainty ?? "",
      proposed_by: c.voice,
      status: "proposal",
    });
  }
  return out;
}

/** Ruling mode: the situation's own options, ids kept as given. */
export function situationOptions(options: { id: string; text: string }[]): ConclaveOption[] {
  return options.map((o) => ({ option_id: o.id, claim: o.text, evidence_refs: [], uncertainty: "", proposed_by: "situation", status: "proposal" }));
}

// ---------------------------------------------------------------- §4 aggregation and decision rule

export interface Ballot {
  voice: string;
  /** relevance weight w_i(q) */
  w: number;
  /** confidence c_i from WHISPER_RATING */
  c: number;
  /** s_i(o) by option_id; ignored when abstained */
  scores: Record<string, number>;
  /** BALLOT decision failed: excluded from every sum */
  abstained?: boolean;
}

export interface ConclaveParams {
  tauPass: number;
  tauMargin: number;
  qMin: number;
  antiEchoMinGuilds: number;
  guilds: Record<string, string[]>;
}

export type ConclaveDecision = "PASS" | "ESCALATE_QUORUM" | "ESCALATE_THRESHOLD" | "ESCALATE_MARGIN" | "ESCALATE_ANTI_ECHO";

export interface ConclaveOutcome {
  totals: Record<string, number>;
  weights: Record<string, { w: number; c: number; alpha: number }>;
  sumAlpha: number;
  winner: string | null;
  margin: number | null;
  decision: ConclaveDecision;
  /** Voices with s_i(o*) ≥ 0.5 */
  coalition: string[];
  guildsInWinningCoalition: string[];
  abstained: string[];
  dissent: { option_id: string; voice: string; reason: string }[];
}

/** A Voice's top option (highest s; ties broken by option order). */
export function topOption(scores: Record<string, number>, optionIds: string[]): string | null {
  let best: string | null = null;
  for (const o of optionIds) if (scores[o] !== undefined && (best === null || scores[o] > scores[best])) best = o;
  return best;
}

export function aggregate(args: {
  optionIds: string[];
  ballots: Ballot[];
  params: ConclaveParams;
  /** Round 2 summary per Voice, used as the dissent reason. */
  reasons?: Record<string, string>;
}): ConclaveOutcome {
  const { optionIds, params } = args;
  if (optionIds.length === 0) throw new Error("aggregate: no options");
  const voting = args.ballots.filter((b) => !b.abstained);
  const abstained = args.ballots.filter((b) => b.abstained).map((b) => b.voice);
  const weights: ConclaveOutcome["weights"] = {};
  for (const b of voting) weights[b.voice] = { w: b.w, c: b.c, alpha: alpha(b.w, b.c) };
  const sumAlpha = voting.reduce((s, b) => s + weights[b.voice].alpha, 0);

  const totals: Record<string, number> = {};
  for (const o of optionIds) {
    totals[o] = sumAlpha > 0 ? voting.reduce((s, b) => s + weights[b.voice].alpha * (b.scores[o] ?? 0), 0) / sumAlpha : 0;
  }
  const winner = sumAlpha > 0 ? topOption(totals, optionIds) : null;
  const best = winner ? totals[winner] : 0;
  const others = optionIds.filter((o) => o !== winner).map((o) => totals[o]);
  const margin = winner ? best - (others.length ? Math.max(...others) : 0) : null;

  const coalition = winner ? voting.filter((b) => (b.scores[winner] ?? 0) >= 0.5).map((b) => b.voice) : [];
  const guildsInWinningCoalition = [...new Set(coalition.flatMap((v) => Object.entries(params.guilds).filter(([, m]) => m.includes(v)).map(([g]) => g)))].sort();

  let decision: ConclaveDecision = "PASS";
  if (sumAlpha < params.qMin) decision = "ESCALATE_QUORUM";
  else if (best < params.tauPass) decision = "ESCALATE_THRESHOLD";
  else if ((margin ?? 0) < params.tauMargin) decision = "ESCALATE_MARGIN";
  else if (guildsInWinningCoalition.length < params.antiEchoMinGuilds) decision = "ESCALATE_ANTI_ECHO";

  const dissent = winner
    ? voting
        .filter((b) => {
          const top = topOption(b.scores, optionIds);
          // a Voice whose best score ties the winner's is not dissenting
          return top !== null && top !== winner && (b.scores[winner] ?? 0) < b.scores[top];
        })
        .map((b) => ({ option_id: topOption(b.scores, optionIds)!, voice: b.voice, reason: args.reasons?.[b.voice] ?? "" }))
    : [];

  return { totals, weights, sumAlpha, winner, margin, decision, coalition, guildsInWinningCoalition, abstained, dissent };
}

// ---------------------------------------------------------------- §5 bloc audit

export interface BlocFlag {
  members: string[];
  meanAgreement: number;
  /** members' mean relevance weight w_i across the audited Conclaves */
  meanW: number;
}

/**
 * ρ_ij = (1/T) Σ_t 1[argmax_o s_i(o) = argmax_o s_j(o)].
 * Flags every maximal group C, |C| ≥ 3, whose mean internal ρ exceeds the threshold, once T ≥ minConclaves.
 * Exhaustive over subsets of the voices seen (2^15 at most), so the result is exact and deterministic.
 */
export class BlocAudit {
  private readonly tops: Map<string, string | null>[] = [];
  private readonly ws: Map<string, number[]> = new Map();

  record(ballots: Ballot[], optionIds: string[]): void {
    const tops = new Map<string, string | null>();
    for (const b of ballots) {
      if (b.abstained) continue;
      tops.set(b.voice, topOption(b.scores, optionIds));
      this.ws.set(b.voice, [...(this.ws.get(b.voice) ?? []), b.w]);
    }
    this.tops.push(tops);
  }

  get conclaves(): number {
    return this.tops.length;
  }

  rho(a: string, b: string): number {
    const T = this.tops.length;
    if (T === 0) return 0;
    let n = 0;
    for (const t of this.tops) {
      const ta = t.get(a);
      if (ta != null && ta === t.get(b)) n++;
    }
    return n / T;
  }

  flag(minConclaves = 5, threshold = 0.9, minSize = 3): BlocFlag[] {
    if (this.tops.length < minConclaves) return [];
    const voices = [...this.ws.keys()].sort();
    if (voices.length > 20) throw new Error("BlocAudit: too many voices for exhaustive search");
    const rho = new Map<string, number>();
    for (let i = 0; i < voices.length; i++) for (let j = i + 1; j < voices.length; j++) rho.set(`${i}|${j}`, this.rho(voices[i], voices[j]));
    const flagged: number[] = [];
    for (let mask = 1; mask < 1 << voices.length; mask++) {
      const idx = voices.map((_, i) => i).filter((i) => mask & (1 << i));
      if (idx.length < minSize) continue;
      let sum = 0;
      let pairs = 0;
      for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
        sum += rho.get(`${idx[a]}|${idx[b]}`)!;
        pairs++;
      }
      if (sum / pairs > threshold) flagged.push(mask);
    }
    const popcount = (m: number) => m.toString(2).replace(/0/g, "").length;
    flagged.sort((a, b) => popcount(b) - popcount(a) || a - b);
    const maximal: number[] = [];
    for (const m of flagged) if (!maximal.some((M) => (M & m) === m)) maximal.push(m);
    return maximal.map((mask) => {
      const members = voices.filter((_, i) => mask & (1 << i));
      let sum = 0;
      let pairs = 0;
      for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) {
        sum += this.rho(members[a], members[b]);
        pairs++;
      }
      const ws = members.flatMap((v) => this.ws.get(v) ?? []);
      return { members, meanAgreement: sum / pairs, meanW: ws.reduce((s, x) => s + x, 0) / ws.length };
    });
  }
}
