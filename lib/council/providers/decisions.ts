import "server-only";
import { z } from "zod";
import type { Ledger } from "../ledger";
import { summarizeInput } from "../ledger";
import type { CostMeter } from "./costMeter";
import type { FetchLike, Sleep } from "./http";
import { errorDetail, isAuthStatus, postJsonWithRetry, ProviderAuthError, ProviderHttpError, realSleep } from "./http";

/**
 * Decision-model interfaces (docs/ARCHITECTURE.md "Provider interfaces",
 * docs/DECISION_LAYER.md). Decision models judge; LLMs write.
 *
 * Live clients: OpenRouterDecisions (cloud) and LocalLLMDecisions (local emulation, uncalibrated).
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

// ---------------------------------------------------------------- live clients (M1)


export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export class TooManyQuestionsError extends Error {
  constructor(n: number) {
    super(`${n} questions in one decision request; the maximum is ${MAX_Q_PER_REQUEST}`);
    this.name = "TooManyQuestionsError";
  }
}

/** Every model in the chain failed (unserved, errors, or incomplete answers). */
export class DecisionUnavailableError extends Error {
  constructor(public readonly attempts: { model: string; reason: string }[]) {
    super(`no decision model answered: ${attempts.map((a) => `${a.model} (${a.reason})`).join("; ")}`);
    this.name = "DecisionUnavailableError";
  }
}

const probs = z.record(z.string(), z.number());
const RawAnswerSchema = z.union([
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({ type: z.literal("choice"), choice: z.string(), confidence: z.number().optional(), probabilities: probs }),
  z.object({ type: z.literal("score"), score: z.number(), confidence: z.number().optional(), probabilities: probs }),
]);
const DecisionResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ cost: z.number().optional() }).partial().optional(),
  provider: z.string().optional(),
});

/** Parses answers; returns the names that are missing or of the wrong type. */
export function parseAnswers(
  qs: Record<string, Question>,
  raw: Record<string, unknown>,
): { answers: Record<string, RawAnswer>; missing: string[] } {
  const answers: Record<string, RawAnswer> = {};
  const missing: string[] = [];
  for (const [name, q] of Object.entries(qs)) {
    const parsed = RawAnswerSchema.safeParse(raw[name]);
    if (!parsed.success || parsed.data.type !== q.type) {
      missing.push(name);
      continue;
    }
    const a = parsed.data;
    if (a.type !== "noul" && Object.keys(a.probabilities).length === 0) {
      missing.push(name);
      continue;
    }
    answers[name] = a;
  }
  return { answers, missing };
}

/** Answers reduced to numbers for the ledger: noul → p, choice → probabilities, score → expected index. */
export function compactAnswers(answers: Record<string, RawAnswer>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).map(([k, a]) => [
      k,
      a.type === "noul" ? a.noul : a.type === "choice" ? a.probabilities : expectedScoreIndex(a.probabilities),
    ]),
  );
}

export interface OpenRouterDecisionsOpts {
  apiKey: string;
  chain: string[];
  meter: CostMeter;
  ledger: Ledger;
  fetch?: FetchLike;
  sleep?: Sleep;
  url?: string;
}

const unavailableLogged = new Set<string>();

export class OpenRouterDecisions implements Decider {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly url: string;

  constructor(private readonly o: OpenRouterDecisionsOpts) {
    if (o.chain.length === 0) throw new Error("OpenRouterDecisions needs at least one model");
    this.fetchImpl = o.fetch ?? ((u, i) => fetch(u, i));
    this.sleep = o.sleep ?? realSleep;
    this.url = o.url ?? OPENROUTER_DECISIONS_URL;
  }

  async decide(state: unknown, qs: Record<string, Question>, opts: DecideOpts): Promise<DecisionResult> {
    const n = Object.keys(qs).length;
    if (n === 0) throw new Error("decide() called with no questions");
    if (n > MAX_Q_PER_REQUEST) throw new TooManyQuestionsError(n);
    const attempts: { model: string; reason: string }[] = [];

    for (const model of this.o.chain) {
      const t0 = Date.now();
      let res: Response;
      try {
        res = await postJsonWithRetry(
          this.fetchImpl,
          this.sleep,
          this.url,
          { Authorization: `Bearer ${this.o.apiKey}`, "X-Title": "hive-mentor-sim" },
          { model, state, questions: qs },
        );
      } catch (e) {
        attempts.push({ model, reason: `network: ${(e as Error).message}` });
        continue;
      }
      if (isAuthStatus(res.status)) throw new ProviderAuthError(res.status, await errorDetail(res));
      if (res.status === 400 || res.status === 404) {
        const detail = await errorDetail(res);
        attempts.push({ model, reason: `HTTP ${res.status}` });
        if (!unavailableLogged.has(model)) {
          unavailableLogged.add(model);
          await this.o.ledger.record({
            kind: "decision.model_unavailable",
            cycleId: opts.cycleId,
            model,
            payload: { status: res.status, detail },
          });
        }
        continue;
      }
      if (!res.ok) {
        attempts.push({ model, reason: new ProviderHttpError(res.status, await errorDetail(res)).message });
        continue;
      }
      const latencyMs = Date.now() - t0;
      const body = DecisionResponseSchema.safeParse(await res.json().catch(() => null));
      if (!body.success) {
        attempts.push({ model, reason: "malformed response" });
        continue;
      }
      const costUsd = body.data.usage?.cost ?? 0;
      const { answers, missing } = parseAnswers(qs, body.data.answers);
      if (missing.length) {
        // A paid but incomplete answer still counts toward the cap.
        this.o.meter.add(body.data.model, costUsd);
        attempts.push({ model, reason: `missing answers: ${missing.join(",")}` });
        continue;
      }
      const s = summarizeInput(state);
      await this.o.ledger.record({
        kind: `decision.${opts.purpose}`,
        cycleId: opts.cycleId,
        model: body.data.model,
        calibrated: true,
        costUsd,
        latencyMs,
        payload: { questions: Object.keys(qs), answers: compactAnswers(answers), stateHash: s.hash, statePreview: s.preview },
      });
      this.o.meter.add(body.data.model, costUsd);
      return makeDecisionResult({
        answers,
        model: body.data.model,
        costUsd,
        latencyMs,
        provider: body.data.provider ?? "openrouter",
        calibrated: true,
      });
    }
    throw new DecisionUnavailableError(attempts);
  }
}

/** Test hook: forget which unavailable models were already ledgered in this process. */
export function _resetUnavailableLog(): void {
  unavailableLogged.clear();
}

// ---------------------------------------------------------------- LocalLLMDecisions

export interface LocalLLMDecisionsOpts {
  baseUrl: string;
  model: string;
  meter: CostMeter;
  ledger: Ledger;
  fetch?: FetchLike;
  sleep?: Sleep;
}

function clampRenormalize(p: Record<string, number>, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = Math.min(1, Math.max(0, Number.isFinite(p[k]) ? p[k] : 0));
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (sum <= 0) for (const k of keys) out[k] = 1 / keys.length;
  else for (const k of keys) out[k] /= sum;
  return out;
}

/** Normalizes a local model's answer into the cloud shape; null when unusable. */
export function normalizeLocalAnswer(q: Question, raw: unknown): RawAnswer | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (q.type === "noul") {
    const p = Number(r.noul ?? r.p);
    return Number.isFinite(p) ? { type: "noul", noul: Math.min(1, Math.max(0, p)) } : null;
  }
  const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
  const pr = r.probabilities;
  if (!pr || typeof pr !== "object") return null;
  const probabilities = clampRenormalize(pr as Record<string, number>, keys);
  if (q.type === "choice") {
    const choice = keys.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
    return { type: "choice", choice, probabilities };
  }
  return { type: "score", score: expectedScoreIndex(probabilities), probabilities };
}

/**
 * PROVIDER_MODE=local: emulates the Decisions contract with a local OpenAI-compatible LLM.
 * Every result is model "local:<name>", calibrated: false (DECISION_LAYER.md).
 */
export class LocalLLMDecisions implements Decider {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;

  constructor(private readonly o: LocalLLMDecisionsOpts) {
    this.fetchImpl = o.fetch ?? ((u, i) => fetch(u, i));
    this.sleep = o.sleep ?? realSleep;
  }

  async decide(state: unknown, qs: Record<string, Question>, opts: DecideOpts): Promise<DecisionResult> {
    const n = Object.keys(qs).length;
    if (n === 0) throw new Error("decide() called with no questions");
    if (n > MAX_Q_PER_REQUEST) throw new TooManyQuestionsError(n);
    const t0 = Date.now();
    const system =
      "You answer typed questions about a situation. Return only JSON: an object keyed by question name. " +
      'For type "noul" give {"type":"noul","noul":<probability true, 0-1>}. ' +
      'For "choice" give {"type":"choice","probabilities":{<option>:<p>}}. ' +
      'For "score" give {"type":"score","probabilities":{"0":<p>,"1":<p>,...}} over level indexes. ' +
      "Give probabilities, not certainty.";
    const res = await postJsonWithRetry(this.fetchImpl, this.sleep, `${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, {}, {
      model: this.o.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify({ state, questions: qs }) },
      ],
    });
    if (!res.ok) throw new ProviderHttpError(res.status, await errorDetail(res));
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(stripFences(body.choices?.[0]?.message?.content ?? "{}"));
    } catch {
      parsed = {};
    }
    const answers: Record<string, RawAnswer> = {};
    const missing: string[] = [];
    for (const [name, q] of Object.entries(qs)) {
      const a = normalizeLocalAnswer(q, parsed[name]);
      if (a) answers[name] = a;
      else missing.push(name);
    }
    if (missing.length) throw new DecisionUnavailableError([{ model: `local:${this.o.model}`, reason: `missing answers: ${missing.join(",")}` }]);
    const latencyMs = Date.now() - t0;
    const model = `local:${this.o.model}`;
    const s = summarizeInput(state);
    await this.o.ledger.record({
      kind: `decision.${opts.purpose}`,
      cycleId: opts.cycleId,
      model,
      calibrated: false,
      costUsd: 0,
      latencyMs,
      payload: { questions: Object.keys(qs), answers: compactAnswers(answers), stateHash: s.hash, statePreview: s.preview },
    });
    this.o.meter.add(model, 0);
    return makeDecisionResult({ answers, model, costUsd: 0, latencyMs, provider: "local", calibrated: false });
  }
}

/** Removes a ```json ... ``` fence if a model wrapped its JSON in one. */
export function stripFences(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : text.trim();
}
