import "server-only";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { Ledger } from "../ledger";
import type { CostMeter } from "./costMeter";
import type { Decider, DecideOpts, DecisionResult, Question, RawAnswer } from "./decisions";
import { makeDecisionResult } from "./decisions";
import type { Embedder } from "./embeddings";
import type { GenerateOpts, LLM } from "./llm";
import { GenerationError } from "./llm";

/**
 * MOCK PROVIDERS — for offline tests and mock-mode eval only.
 * Approved by the owner's original handoff (docs/TEST_PLAN.md "Mock conventions").
 * Every result is labeled: model "mock:*", calibrated: false. Mock eval results show the
 * pipeline works on scripted inputs; they say nothing about live model behavior.
 * Never used when USE_MOCK_PROVIDERS is not "true".
 */

// ---------------------------------------------------------------- MockDecider

/** A rule answers one question, given the state as text and as the parsed object. */
export type MockRule = (stateText: string, q: Question, name: string, state: unknown) => RawAnswer;

/** Neutral defaults (DECISION_LAYER.md "MockDecider"): noul 0.5, first choice, score 0. */
export function neutralAnswer(q: Question): RawAnswer {
  switch (q.type) {
    case "noul":
      return { type: "noul", noul: 0.5 };
    case "choice": {
      const keys = Object.keys(q.criteria);
      const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0]));
      return { type: "choice", choice: keys[0], confidence: 1, probabilities };
    }
    case "score": {
      const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 0 ? 1 : 0]));
      return { type: "score", score: 0, confidence: 1, probabilities };
    }
  }
}

/** Helper for rules: a noul answer from a keyword test. */
export function mockNoul(stateText: string, pattern: RegExp, hi = 0.9, lo = 0.1): RawAnswer {
  return { type: "noul", noul: pattern.test(stateText) ? hi : lo };
}

/** Helper for rules: a certain choice answer. */
export function mockChoice(q: Question, pick: string): RawAnswer {
  if (q.type !== "choice") throw new Error("mockChoice on non-choice question");
  if (!(pick in q.criteria)) throw new Error(`mockChoice: '${pick}' is not an option`);
  const probabilities = Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === pick ? 1 : 0]));
  return { type: "choice", choice: pick, confidence: 1, probabilities };
}

/** Helper for rules: a certain score level. */
export function mockScore(q: Question, level: number): RawAnswer {
  if (q.type !== "score") throw new Error("mockScore on non-score question");
  const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === level ? 1 : 0]));
  return { type: "score", score: level, confidence: 1, probabilities };
}

function stateToText(state: unknown): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

export class MockDecider implements Decider {
  /** Rules keyed by exact question name, or by prefix ending in "*" (longest prefix wins). */
  constructor(
    private readonly rules: Record<string, MockRule> = {},
    private readonly meter?: CostMeter,
    private readonly ledger?: Ledger,
  ) {}

  private ruleFor(name: string): MockRule | undefined {
    if (this.rules[name]) return this.rules[name];
    let best: { len: number; rule: MockRule } | undefined;
    for (const [key, rule] of Object.entries(this.rules)) {
      if (key.endsWith("*") && name.startsWith(key.slice(0, -1)) && (!best || key.length > best.len)) best = { len: key.length, rule };
    }
    return best?.rule;
  }

  async decide(state: unknown, qs: Record<string, Question>, opts: DecideOpts): Promise<DecisionResult> {
    const text = stateToText(state);
    const answers: Record<string, RawAnswer> = {};
    for (const [name, q] of Object.entries(qs)) {
      const rule = this.ruleFor(name);
      answers[name] = rule ? rule(text, q, name, state) : neutralAnswer(q);
    }
    this.meter?.add("mock:decider", 0);
    await this.ledger?.record({ kind: `decision.${opts.purpose}`, cycleId: opts.cycleId, model: "mock:decider", calibrated: false, payload: { mock: true, questions: Object.keys(qs) } });
    return makeDecisionResult({ answers, model: "mock:decider", costUsd: 0, latencyMs: 0, provider: "mock", calibrated: false });
  }
}

// ---------------------------------------------------------------- MockLLM

/**
 * Canned JSON per prompt id, from tests/fixtures/llm/<PROMPT_ID>.json:
 *   { "rules": [ { "when": { "<var>": "<regex>", "variant": "<mock_variant>" }, "output": <json> } ],
 *     "variants": { "<key>": <json> },   // keyed by context variant / vars.mockVariant / vars.voice / vars.scenarioId
 *     "default": <json> }
 * A rule matches when every `when` entry matches: a var's value (JSON for non-strings) against the
 * case-insensitive regex; "variant" against the context's mock variant; "absent:<var>" when the var
 * is empty. First matching rule wins, then variants, then default.
 * Templating in outputs: a string exactly "{{var:<name>}}" becomes that var's value (any type);
 * inside a longer string it is replaced by its text; an array element "{{spread:<name>}}" splices an array var.
 */
export type LlmFixture =
  | { rules?: { when: Record<string, string>; output: unknown }[]; default?: unknown; variants?: Record<string, unknown> }
  | ((vars: Record<string, unknown>, ctx: MockContext) => unknown);

export interface MockContext {
  /** Scenario mock_variant (eval) or a unit test's variant. */
  variant?: string;
}

const varText = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function applyTemplate(x: unknown, vars: Record<string, unknown>): unknown {
  if (typeof x === "string") {
    const whole = x.match(/^\{\{var:([A-Za-z0-9_]+)\}\}$/);
    if (whole) return vars[whole[1]];
    return x.replace(/\{\{var:([A-Za-z0-9_]+)\}\}/g, (_, k: string) => varText(vars[k]));
  }
  if (Array.isArray(x))
    return x.flatMap((el) => {
      const m = typeof el === "string" ? el.match(/^\{\{spread:([A-Za-z0-9_]+)\}\}$/) : null;
      return m ? ((vars[m[1]] as unknown[]) ?? []) : [applyTemplate(el, vars)];
    });
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, applyTemplate(v, vars)]));
  return x;
}

export class MockLLM implements LLM {
  private readonly cache = new Map<string, LlmFixture>();

  constructor(
    private readonly fixtureDir = path.join(/*turbopackIgnore: true*/ process.cwd(), "tests", "fixtures", "llm"),
    private readonly inline: Record<string, LlmFixture> = {},
    private readonly meter?: CostMeter,
    private ctx: MockContext = {},
    private readonly ledger?: Ledger,
  ) {}

  setContext(ctx: MockContext): void {
    this.ctx = ctx;
  }

  private load(promptId: string): LlmFixture {
    if (this.inline[promptId]) return this.inline[promptId];
    const hit = this.cache.get(promptId);
    if (hit) return hit;
    const file = path.join(this.fixtureDir, `${promptId}.json`);
    if (!existsSync(file)) throw new GenerationError(`MockLLM: no fixture for prompt '${promptId}' (${file})`);
    const fx = JSON.parse(readFileSync(file, "utf8")) as LlmFixture;
    this.cache.set(promptId, fx);
    return fx;
  }

  private select(fx: LlmFixture, vars: Record<string, unknown>): unknown {
    if (typeof fx === "function") return fx(vars, this.ctx);
    for (const r of fx.rules ?? []) {
      const ok = Object.entries(r.when).every(([k, re]) => {
        if (k === "variant") return this.ctx.variant === re;
        if (k.startsWith("absent:")) return isEmpty(vars[k.slice(7)]);
        return new RegExp(re, "i").test(varText(vars[k]));
      });
      if (ok) return r.output;
    }
    const keys = [this.ctx.variant, vars.mockVariant, vars.voice, vars.scenarioId];
    const key = keys.find((v): v is string => typeof v === "string" && !!fx.variants && v in fx.variants);
    return key ? fx.variants![key] : fx.default;
  }

  async generate<T>(promptId: string, vars: Record<string, unknown>, schema: z.ZodType<T>, opts: GenerateOpts) {
    const raw = this.select(this.load(promptId), vars);
    if (raw === undefined) throw new GenerationError(`MockLLM: fixture '${promptId}' has no matching output`);
    const parsed = schema.safeParse(applyTemplate(raw, vars));
    if (!parsed.success) throw new GenerationError(`MockLLM: fixture '${promptId}' fails schema: ${parsed.error.message}`);
    const model = `mock:llm:${opts.tier}`;
    this.meter?.add(model, 0);
    await this.ledger?.record({ kind: `llm.${promptId}`, cycleId: opts.cycleId, model, calibrated: false, payload: { mock: true, purpose: opts.purpose } });
    return { data: parsed.data, model, costUsd: 0 };
  }
}

// ---------------------------------------------------------------- MockEmbedder

export const MOCK_EMBED_DIM = 64;

function normalizeTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

/** Deterministic hash of normalized tokens into 64 dimensions, L2-normalized. */
export class MockEmbedder implements Embedder {
  readonly model = "mock:embedder";
  readonly dim = MOCK_EMBED_DIM;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      for (const tok of normalizeTokens(t)) {
        const h = createHash("sha256").update(tok).digest();
        const idx = h.readUInt32BE(0) % this.dim;
        const sign = h[4] & 1 ? 1 : -1;
        v[idx] += sign;
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
      return v;
    });
  }
}
