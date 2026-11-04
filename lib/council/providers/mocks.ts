import "server-only";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { Decider, DecideOpts, DecisionResult, Question, RawAnswer } from "./decisions";
import { makeDecisionResult } from "./decisions";
import type { Embedder } from "./embeddings";
import type { LLM, GenerateOpts } from "./llm";
import { GenerationError } from "./llm";
import type { CostMeter } from "./costMeter";

/**
 * MOCK PROVIDERS — for offline tests and mock-mode eval only.
 * Approved by the owner's original handoff (docs/TEST_PLAN.md "Mock conventions").
 * Every result is labeled: model "mock:*", calibrated: false.
 * Never used when USE_MOCK_PROVIDERS is not "true".
 */

// ---------------------------------------------------------------- MockDecider

/** A rule answers one question name, given the state as text. */
export type MockRule = (stateText: string, q: Question) => RawAnswer;

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

function stateToText(state: unknown): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

export class MockDecider implements Decider {
  /** Rules keyed by exact question name, or by prefix ending in "*" (e.g. "x_*"). */
  constructor(private readonly rules: Record<string, MockRule> = {}, private readonly meter?: CostMeter) {}

  private ruleFor(name: string): MockRule | undefined {
    if (this.rules[name]) return this.rules[name];
    for (const [key, rule] of Object.entries(this.rules)) {
      if (key.endsWith("*") && name.startsWith(key.slice(0, -1))) return rule;
    }
    return undefined;
  }

  async decide(state: unknown, qs: Record<string, Question>, _opts: DecideOpts): Promise<DecisionResult> {
    this.meter?.check();
    const text = stateToText(state);
    const answers: Record<string, RawAnswer> = {};
    for (const [name, q] of Object.entries(qs)) {
      const rule = this.ruleFor(name);
      answers[name] = rule ? rule(text, q) : neutralAnswer(q);
    }
    this.meter?.add("mock:decider", 0);
    return makeDecisionResult({
      answers,
      model: "mock:decider",
      costUsd: 0,
      latencyMs: 0,
      provider: "mock",
      calibrated: false,
    });
  }
}

// ---------------------------------------------------------------- MockLLM

/**
 * Canned JSON per prompt id, from tests/fixtures/llm/<PROMPT_ID>.json.
 * File shape: { "default": <output>, "variants": { "<variantKey>": <output> } }.
 * The variant key is read from vars.mockVariant, then vars.voice, then vars.scenarioId.
 */
export type LlmFixture = { default?: unknown; variants?: Record<string, unknown> };

export class MockLLM implements LLM {
  constructor(
    private readonly fixtureDir = path.join(process.cwd(), "tests", "fixtures", "llm"),
    private readonly inline: Record<string, LlmFixture> = {},
    private readonly meter?: CostMeter,
  ) {}

  private load(promptId: string): LlmFixture {
    if (this.inline[promptId]) return this.inline[promptId];
    const file = path.join(this.fixtureDir, `${promptId}.json`);
    if (!existsSync(file)) throw new GenerationError(`MockLLM: no fixture for prompt '${promptId}' (${file})`);
    return JSON.parse(readFileSync(file, "utf8")) as LlmFixture;
  }

  async generate<T>(promptId: string, vars: Record<string, unknown>, schema: z.ZodType<T>, opts: GenerateOpts) {
    this.meter?.check();
    const fx = this.load(promptId);
    const key = [vars.mockVariant, vars.voice, vars.scenarioId].find((v) => typeof v === "string") as
      | string
      | undefined;
    const raw = key && fx.variants && key in fx.variants ? fx.variants[key] : fx.default;
    if (raw === undefined) throw new GenerationError(`MockLLM: fixture '${promptId}' has no output for '${key ?? "default"}'`);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new GenerationError(`MockLLM: fixture '${promptId}' fails schema: ${parsed.error.message}`);
    const model = `mock:llm:${opts.tier}`;
    this.meter?.add(model, 0);
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
