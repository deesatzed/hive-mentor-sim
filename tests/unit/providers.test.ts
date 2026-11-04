import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  decisionChainFromEnv,
  getProviders,
  LiveModeNotConfiguredError,
  ProviderNotBuiltError,
  resolveProviderConfig,
} from "@/lib/council/providers";
import { BudgetExceededError, CostMeter, costCapFromEnv } from "@/lib/council/providers/costMeter";
import { expectedScoreIndex, makeDecisionResult, MissingAnswerError, type Question } from "@/lib/council/providers/decisions";
import { MockDecider, MockEmbedder, MockLLM, mockChoice, mockNoul } from "@/lib/council/providers/mocks";

// Test env values are labels, not real model IDs: these tests check resolution logic only.
const CLOUD_BASE = {
  OPENROUTER_API_KEY: "test-key",
  OPENROUTER_DEC_MODEL_1: "dec/one",
  OPENROUTER_DEC_MODEL_2: "dec/two",
  OPENROUTER_REVIEWER_MODEL: "reviewer/central",
};

describe("resolveProviderConfig", () => {
  it("USE_MOCK_PROVIDERS=true → mock, needs no keys", () => {
    expect(resolveProviderConfig({ USE_MOCK_PROVIDERS: "true" })).toEqual({ mode: "mock", costCapUsd: 5 });
  });

  it("cloud: every tier set explicitly uses its own env var", () => {
    const c = resolveProviderConfig({
      ...CLOUD_BASE,
      TIER_FAST_MODEL: "t/fast",
      TIER_STANDARD_MODEL: "t/std",
      TIER_PREMIUM_MODEL: "t/prem",
    });
    if (c.mode !== "cloud") throw new Error("expected cloud");
    expect(c.tiers).toEqual({
      fast: { model: "t/fast", source: "TIER_FAST_MODEL" },
      standard: { model: "t/std", source: "TIER_STANDARD_MODEL" },
      premium: { model: "t/prem", source: "TIER_PREMIUM_MODEL" },
    });
    expect(c.decisionChain).toEqual(["dec/one", "dec/two"]);
  });

  it("cloud: empty TIER_* falls back to OPENROUTER_REVIEWER_MODEL", () => {
    const c = resolveProviderConfig({ ...CLOUD_BASE, TIER_FAST_MODEL: "", TIER_PREMIUM_MODEL: "t/prem" });
    if (c.mode !== "cloud") throw new Error("expected cloud");
    expect(c.tiers.fast).toEqual({ model: "reviewer/central", source: "OPENROUTER_REVIEWER_MODEL" });
    expect(c.tiers.standard).toEqual({ model: "reviewer/central", source: "OPENROUTER_REVIEWER_MODEL" });
    expect(c.tiers.premium).toEqual({ model: "t/prem", source: "TIER_PREMIUM_MODEL" });
  });

  it("cloud: empty TIER_* and empty reviewer → LiveModeNotConfiguredError naming the tiers", () => {
    const env = { ...CLOUD_BASE, OPENROUTER_REVIEWER_MODEL: "", TIER_STANDARD_MODEL: "t/std" };
    expect(() => resolveProviderConfig(env)).toThrow(LiveModeNotConfiguredError);
    try {
      resolveProviderConfig(env);
    } catch (e) {
      expect((e as LiveModeNotConfiguredError).missing).toEqual([
        "TIER_FAST_MODEL (or OPENROUTER_REVIEWER_MODEL)",
        "TIER_PREMIUM_MODEL (or OPENROUTER_REVIEWER_MODEL)",
      ]);
    }
  });

  it("cloud: missing key and empty decision chain are both named", () => {
    expect(() => resolveProviderConfig({ OPENROUTER_REVIEWER_MODEL: "r/m" })).toThrow(
      /OPENROUTER_API_KEY, OPENROUTER_DEC_MODEL_1/,
    );
  });

  it("decision chain reads _1.._N in order, strips quotes, stops at a gap", () => {
    expect(
      decisionChainFromEnv({
        OPENROUTER_DEC_MODEL_1: '"a/x"',
        OPENROUTER_DEC_MODEL_2: "b/y",
        OPENROUTER_DEC_MODEL_4: "d/skipped",
      }),
    ).toEqual(["a/x", "b/y"]);
  });

  it("local mode requires local model names", () => {
    expect(() => resolveProviderConfig({ PROVIDER_MODE: "local" })).toThrow(LiveModeNotConfiguredError);
    const c = resolveProviderConfig({ PROVIDER_MODE: "local", LOCAL_LLM_MODEL: "l/m", LOCAL_EMBED_MODEL: "e/m" });
    expect(c.mode).toBe("local");
  });

  it("rejects an unknown PROVIDER_MODE", () => {
    expect(() => resolveProviderConfig({ PROVIDER_MODE: "other" })).toThrow(/cloud or local/);
  });
});

describe("getProviders", () => {
  it("mock mode returns labeled mocks", () => {
    const p = getProviders({ USE_MOCK_PROVIDERS: "true" });
    expect(p.embedder.model).toBe("mock:embedder");
    expect(p.config.mode).toBe("mock");
  });

  it("cloud mode resolves config, then reports live clients are not built yet (M0)", () => {
    expect(() => getProviders(CLOUD_BASE)).toThrow(ProviderNotBuiltError);
  });
});

describe("costMeter", () => {
  it("throws BudgetExceededError when the cap is reached", () => {
    const m = new CostMeter(0.0001);
    m.check();
    expect(() => m.add("x", 0.00005)).not.toThrow();
    expect(() => m.add("x", 0.00006)).toThrow(BudgetExceededError);
    expect(() => m.check()).toThrow(BudgetExceededError);
    expect(m.breakdown()).toEqual({ x: 0.00011 });
  });

  it("COST_CAP_USD parsing", () => {
    expect(costCapFromEnv({})).toBe(5);
    expect(costCapFromEnv({ COST_CAP_USD: "0.25" })).toBe(0.25);
    expect(() => costCapFromEnv({ COST_CAP_USD: "abc" })).toThrow();
  });

  it("mock providers stop once the cap is already reached", async () => {
    const m = new CostMeter(0);
    await expect(new MockDecider({}, m).decide("s", {}, { purpose: "t" })).rejects.toThrow(BudgetExceededError);
  });
});

describe("DecisionResult", () => {
  it("score is the expected index from probabilities, ignoring the score field", () => {
    const r = makeDecisionResult({
      answers: { s: { type: "score", score: 2, probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 } } },
      model: "m",
      costUsd: 0,
      latencyMs: 0,
      provider: "p",
      calibrated: false,
    });
    expect(r.score("s")).toBeCloseTo(1.3, 10);
    expect(() => r.p("s")).toThrow(MissingAnswerError);
    expect(() => r.p("absent")).toThrow(MissingAnswerError);
  });

  it("expectedScoreIndex normalizes probabilities that do not sum to 1", () => {
    expect(expectedScoreIndex({ "0": 0.5, "2": 0.5, "1": 0 })).toBeCloseTo(1, 10);
    expect(() => expectedScoreIndex({ "0": 0 })).toThrow();
  });
});

describe("MockDecider", () => {
  const qs = {
    asks_consciousness: { type: "noul", instructions: "i", criteria: { true: "t", false: "f" } },
    x_a_b: { type: "noul", instructions: "i", criteria: { true: "t", false: "f" } },
    mood: { type: "choice", instructions: "i", criteria: { calm: "c", tense: "t" } },
    level: { type: "score", instructions: "i", criteria: ["low", "mid", "high"] },
  } satisfies Record<string, Question>;

  it("applies exact and prefix rules, neutral defaults otherwise, and labels results", async () => {
    const d = new MockDecider({
      asks_consciousness: (s) => mockNoul(s, /conscious|sentient/i),
      "x_*": () => ({ type: "noul", noul: 0.8 }),
      mood: (_s, q) => mockChoice(q, "tense"),
    });
    const r = await d.decide({ text: "Are you sentient?" }, qs, { purpose: "test" });
    expect(r.p("asks_consciousness")).toBe(0.9);
    expect(r.p("x_a_b")).toBe(0.8);
    expect(r.choice("mood")).toBe("tense");
    expect(r.score("level")).toBe(0);
    expect(r.model).toBe("mock:decider");
    expect(r.calibrated).toBe(false);
  });

  it("is deterministic", async () => {
    const d = new MockDecider();
    const a = await d.decide("same", qs, { purpose: "t" });
    const b = await d.decide("same", qs, { purpose: "t" });
    expect(a.answers).toEqual(b.answers);
  });
});

describe("MockLLM", () => {
  const schema = z.object({ claim: z.string() });
  const llm = new MockLLM("/nonexistent", {
    WHISPER: { default: { claim: "default" }, variants: { EMPATHY: { claim: "empathy" }, BAD: { nope: 1 } } },
  });

  it("selects variants by voice and labels the model", async () => {
    const r = await llm.generate("WHISPER", { voice: "EMPATHY" }, schema, { tier: "fast", purpose: "t" });
    expect(r).toEqual({ data: { claim: "empathy" }, model: "mock:llm:fast", costUsd: 0 });
    const d = await llm.generate("WHISPER", { voice: "OTHER" }, schema, { tier: "standard", purpose: "t" });
    expect(d.data.claim).toBe("default");
  });

  it("rejects fixtures that fail the schema, and missing fixtures", async () => {
    await expect(llm.generate("WHISPER", { mockVariant: "BAD" }, schema, { tier: "fast", purpose: "t" })).rejects.toThrow(
      /fails schema/,
    );
    await expect(llm.generate("NOPE", {}, schema, { tier: "fast", purpose: "t" })).rejects.toThrow(/no fixture/);
  });
});

describe("MockEmbedder", () => {
  it("is deterministic, 64-dim, unit length, and normalizes case and curly quotes", async () => {
    const e = new MockEmbedder();
    const [a, b, c, d] = await e.embed(["Don’t panic", "don't PANIC", "don't panic", "something else entirely"]);
    expect(a.length).toBe(64);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(b)).toEqual(Array.from(c));
    expect(Array.from(a)).not.toEqual(Array.from(d));
    const norm = Math.sqrt(Array.from(a).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    const [again] = await new MockEmbedder().embed(["Don’t panic"]);
    expect(Array.from(again)).toEqual(Array.from(a));
  });
});
