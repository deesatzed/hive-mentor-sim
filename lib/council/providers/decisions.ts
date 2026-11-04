import "server-only";

/**
 * Decision-model interfaces (docs/ARCHITECTURE.md "Provider interfaces",
 * docs/DECISION_LAYER.md). Decision models judge; LLMs write.
 *
 * M0: interfaces and the result helper only. The live client
 * (OpenRouterDecisions) and LocalLLMDecisions arrive in M1.
 */

export type NoulQ = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
export type ChoiceQ = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQ = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQ | ChoiceQ | ScoreQ;

/** Max questions batched into one decision request (DECISION_LAYER.md). */
export const MAX_Q_PER_REQUEST = 12;

/** Raw per-question answer as returned by the Decisions API (or a mock). */
export type RawAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence?: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence?: number; probabilities: Record<string, number> };

export interface DecisionResult {
  answers: Record<string, RawAnswer>;
  model: string;
  costUsd: number;
  latencyMs: number;
  provider: string;
  /** false for LocalLLMDecisions and MockDecider */
  calibrated: boolean;
  p(name: string): number;
  choice(name: string): string;
  probs(name: string): Record<string, number>;
  /** Expected level index, computed from probabilities (never trusts the `score` field's type). */
  score(name: string): number;
}

export interface DecideOpts {
  purpose: string;
  cycleId?: string;
}

export interface Decider {
  decide(state: unknown, qs: Record<string, Question>, opts: DecideOpts): Promise<DecisionResult>;
}

export class MissingAnswerError extends Error {
  constructor(public readonly question: string, public readonly expected: string) {
    super(`decision answer '${question}' missing or not of type ${expected}`);
    this.name = "MissingAnswerError";
  }
}

/** Expected index from a score answer's probabilities: sum(level * p) / sum(p). */
export function expectedScoreIndex(probabilities: Record<string, number>): number {
  let num = 0;
  let den = 0;
  for (const [level, p] of Object.entries(probabilities)) {
    const idx = Number(level);
    if (!Number.isFinite(idx) || !Number.isFinite(p)) continue;
    num += idx * p;
    den += p;
  }
  if (den <= 0) throw new Error("score probabilities sum to zero");
  return num / den;
}

export function makeDecisionResult(fields: {
  answers: Record<string, RawAnswer>;
  model: string;
  costUsd: number;
  latencyMs: number;
  provider: string;
  calibrated: boolean;
}): DecisionResult {
  const get = <T extends RawAnswer["type"]>(name: string, type: T) => {
    const a = fields.answers[name];
    if (!a || a.type !== type) throw new MissingAnswerError(name, type);
    return a as Extract<RawAnswer, { type: T }>;
  };
  return {
    ...fields,
    p: (name) => get(name, "noul").noul,
    choice: (name) => get(name, "choice").choice,
    probs: (name) => {
      const a = fields.answers[name];
      if (!a || a.type === "noul") throw new MissingAnswerError(name, "choice|score");
      return a.probabilities;
    },
    score: (name) => expectedScoreIndex(get(name, "score").probabilities),
  };
}
