import "server-only";
import type { Decider } from "@/lib/council/providers/decisions";
import { tryDecide } from "./decide";
import { ENDORSE, T } from "./questions";

/**
 * Advisor routing and endorsement (port of reference/sent2.md packages/core/src/endorsement.ts, v1.2
 * §3.4 P2 + Invariant 5, minus the removed guardian items). Advisors advise; Core Voices own. An advisory whisper
 * influences the cycle only after a paired Core Voice adopts it — here the ENDORSE decision
 * (DECISION_LAYER.md), not a model's say-so and not the advisor's own field.
 */

export interface ActivationRule {
  workflows: string[];
  via: string[];
  trigger?: string;
  requires?: string;
  active?: boolean;
}

/** Heartbeat phases an advisor workflow can name, in cycle order. perceive runs with whisper (P2). */
export const ADVISOR_PHASES = ["whisper", "deliberate", "compose", "reflect"] as const;
export type AdvisorPhase = (typeof ADVISOR_PHASES)[number];
const PHASE_OF: Record<string, AdvisorPhase> = { perceive: "whisper", whisper: "whisper", deliberate: "deliberate", compose: "compose", reflect: "reflect" };

/** Regex triggers (sent2 TRIGGERS). `ethos_hard_case` is decided from the cycle (ETHOS whisper moral-flagged), not from text. */
const TRIGGERS: Record<string, RegExp> = {
  religious_content: /religion|islam|christian|buddhis|hindu|jewish|sikh|faith|god|scripture|symbiosis|doctrine|tawhid|dharma/i,
  consequential_decision: /should i|decide|quit|invest|marry|divorce|move|surgery|lawsuit/i,
};
export const triggerMatches = (trigger: string, input: string, ctx: { ethosHardCase?: boolean } = {}): boolean =>
  trigger === "ethos_hard_case" ? ctx.ethosHardCase === true : (TRIGGERS[trigger]?.test(input) ?? false);

/** The phase an advisor runs in this cycle: the first of its workflows (in cycle order). Each advisor runs at most once per cycle. */
export function advisorPhase(rule: ActivationRule): AdvisorPhase | null {
  const phases = new Set(rule.workflows.map((w) => PHASE_OF[w]).filter(Boolean));
  return ADVISOR_PHASES.find((p) => phases.has(p)) ?? null;
}

/**
 * Advisors that activate in `phase`: configured for it (first workflow), not inactive, module present
 * when required, and trigger matched when one is declared. Deterministic; sorted by name.
 */
export function activeAdvisors(
  activation: Record<string, ActivationRule>,
  phase: AdvisorPhase,
  input: string,
  opts: { edictModule: boolean; ethosHardCase?: boolean },
): string[] {
  const out: string[] = [];
  for (const [name, rule] of Object.entries(activation)) {
    if (rule.active === false) continue;
    if (rule.requires === "edict_module" && !opts.edictModule) continue;
    if (advisorPhase(rule) !== phase) continue;
    if (rule.trigger && !triggerMatches(rule.trigger, input, { ethosHardCase: opts.ethosHardCase })) continue;
    out.push(name.toUpperCase());
  }
  return out.sort();
}

export interface AdvisoryWhisper {
  advisory: boolean;
  endorsedBy: string | null;
}

/** Self-endorsement is not endorsement: any endorsedBy an advisory arrives with is cleared. */
export function stripSelfEndorsement<T extends AdvisoryWhisper>(w: T): T {
  return w.advisory && w.endorsedBy ? { ...w, endorsedBy: null } : w;
}

/** Coalition intake filter: Core whispers, and advisories only once endorsed. */
export const coalitionEligible = (w: AdvisoryWhisper): boolean => !w.advisory || w.endorsedBy !== null;

export interface EndorsementResult {
  endorsedBy: string | null;
  /** probability per partner Voice; null when the decision layer was unavailable (fallback: not endorsed) */
  probabilities: Record<string, number> | null;
}

/**
 * ENDORSE: one request per advisory with its paired Core Voices (`e_<VOICE>`). Highest p ≥ T.ENDORSE
 * endorses (ties: first partner in config order). Otherwise the advisory never enters.
 */
export async function decideEndorsement(
  decider: Decider,
  advisory: { voice: string; claim: string },
  partners: { voice: string; claim: string | null }[],
  cycleId: string,
): Promise<EndorsementResult> {
  if (!partners.length) return { endorsedBy: null, probabilities: {} };
  const state = { advisory, core: Object.fromEntries(partners.map((p) => [p.voice, p.claim ?? "(no claim of its own this cycle)"])) };
  const r = await tryDecide(decider, state, ENDORSE(partners.map((p) => p.voice)), "endorse", cycleId);
  if (!r) return { endorsedBy: null, probabilities: null };
  const probabilities = Object.fromEntries(partners.map((p) => [p.voice, r.p(`e_${p.voice}`)]));
  let best: string | null = null;
  for (const p of partners) if (probabilities[p.voice] >= T.ENDORSE && (best === null || probabilities[p.voice] > probabilities[best])) best = p.voice;
  return { endorsedBy: best, probabilities };
}

// ---------------------------------------------------------------- DEMIURGE and JUSTITIA (sent2 Phase 4 advisor pack)

export interface RolloutStep {
  actor: "hive" | "operator" | "world";
  event: string;
  outlook: "favorable" | "mixed" | "adverse";
}

/**
 * DEMIURGE rollout: 3 steps deep, 2 branches wide (8 paths), built in code from the model's 3×2 cells.
 * The model writes events and an outlook label per cell; no model number reaches the ordering. Paths are
 * sorted worst first by the count of adverse steps, then mixed steps (sent2: a rollout that hides its
 * worst case is propaganda). DEMIURGE never picks: ARROW decides.
 */
export function buildRollout(levels: RolloutStep[][]): { paths: RolloutStep[][]; worst: RolloutStep[] } {
  const paths = levels.reduce<RolloutStep[][]>((acc, lvl) => acc.flatMap((prefix) => lvl.map((s) => [...prefix, s])), [[]]);
  const badness = (p: RolloutStep[]) => [p.filter((s) => s.outlook === "adverse").length, p.filter((s) => s.outlook === "mixed").length];
  const sorted = paths
    .map((p, i) => ({ p, i, b: badness(p) }))
    .sort((x, y) => y.b[0] - x.b[0] || y.b[1] - x.b[1] || x.i - y.i)
    .map((x) => x.p);
  return { paths: sorted, worst: sorted[0] ?? [] };
}

export interface Party {
  name: string;
  class: "present" | "absent" | "future" | "non_human" | "hive_integrity";
  canSpeak: boolean;
  interest: string;
  exposure: "low" | "medium" | "high";
}

/** JUSTITIA summary computed in code: voiceless parties and the most exposed ones (labels only, no model numbers). */
export function stakeholderSummary(parties: Party[]): { voiceless: number; mostExposed: string[] } {
  const rank = { high: 2, medium: 1, low: 0 } as const;
  const top = Math.max(-1, ...parties.map((p) => rank[p.exposure]));
  return { voiceless: parties.filter((p) => !p.canSpeak).length, mostExposed: parties.filter((p) => rank[p.exposure] === top).map((p) => p.name) };
}
