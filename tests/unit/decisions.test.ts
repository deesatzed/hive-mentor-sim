import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetUnavailableLog,
  DecisionUnavailableError,
  LocalLLMDecisions,
  normalizeLocalAnswer,
  OpenRouterDecisions,
  OPENROUTER_DECISIONS_URL,
  TooManyQuestionsError,
  type Question,
} from "@/lib/council/providers/decisions";
import { BudgetExceededError, CostMeter } from "@/lib/council/providers/costMeter";
import { ProviderAuthError } from "@/lib/council/providers/http";
import { fakeFetch, MemoryLedger, noSleep } from "../helpers/fakeFetch";

// Model names below are test labels, not real model IDs.
const QS: Record<string, Question> = {
  is_x: { type: "noul", instructions: "Is it x?", criteria: { true: "x", false: "not x" } },
  mood: { type: "choice", instructions: "Mood?", criteria: { calm: "calm", anxious: "anxious" } },
  level: { type: "score", instructions: "Level?", criteria: ["low", "mid", "high"] },
};
const OK_BODY = (model = "dec/one-20261101", cost = 0.000002) => ({
  model,
  answers: {
    is_x: { type: "noul", noul: 0.83 },
    mood: { type: "choice", choice: "anxious", confidence: 0.9, probabilities: { calm: 0.1, anxious: 0.9 } },
    level: { type: "score", score: 1.4, confidence: 0.6, probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 } },
  },
  usage: { input_tokens: 100, output_tokens: 20, cost },
  provider: "TestProvider",
});

function client(script: Parameters<typeof fakeFetch>[0], chain = ["dec/one", "dec/two"], cap = 1) {
  const f = fakeFetch(script);
  const ledger = new MemoryLedger();
  const meter = new CostMeter(cap);
  const d = new OpenRouterDecisions({ apiKey: "test-key", chain, meter, ledger, fetch: f.impl, sleep: noSleep });
  return { d, f, ledger, meter };
}

beforeEach(() => _resetUnavailableLog());

describe("OpenRouterDecisions", () => {
  it("sends the documented request body and parses all three answer types", async () => {
    const { d, f, ledger, meter } = client([{ status: 200, body: OK_BODY() }]);
    const r = await d.decide({ input: "hello" }, QS, { purpose: "affect", cycleId: "c1" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(OPENROUTER_DECISIONS_URL);
    expect(f.calls[0].body).toEqual({ model: "dec/one", state: { input: "hello" }, questions: QS });
    expect(f.calls[0].headers.Authorization).toBe("Bearer test-key");
    expect(f.calls[0].headers["X-Title"]).toBe("hive-mentor-sim");
    expect(r.p("is_x")).toBe(0.83);
    expect(r.choice("mood")).toBe("anxious");
    expect(r.score("level")).toBeCloseTo(1.4, 10); // from probabilities, not the score field
    expect(r.model).toBe("dec/one-20261101");
    expect(r.calibrated).toBe(true);
    expect(meter.spentUsd).toBeCloseTo(0.000002, 12);
    expect(ledger.events).toHaveLength(1);
    const ev = ledger.events[0];
    expect(ev.kind).toBe("decision.affect");
    expect(ev.cycleId).toBe("c1");
    expect(ev.model).toBe("dec/one-20261101");
    expect(ev.costUsd).toBe(0.000002);
    const payload = ev.payload as { stateHash: string; statePreview: string; questions: string[]; answers: Record<string, unknown> };
    expect(payload.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.statePreview.length).toBeLessThanOrEqual(200);
    expect(payload.questions).toEqual(["is_x", "mood", "level"]);
    expect(payload.answers.is_x).toBe(0.83);
  });

  it("caps the ledger preview at 200 characters for large states", async () => {
    const { d, ledger } = client([{ status: 200, body: OK_BODY() }]);
    await d.decide({ input: "y".repeat(5000) }, QS, { purpose: "affect" });
    expect((ledger.events[0].payload as { statePreview: string }).statePreview).toHaveLength(200);
  });

  it("503 → one retry on the same model → success", async () => {
    const { d, f } = client([
      { status: 503, body: "busy" },
      { status: 200, body: OK_BODY() },
    ]);
    await d.decide("s", QS, { purpose: "t" });
    expect(f.calls.map((c) => c.body.model)).toEqual(["dec/one", "dec/one"]);
  });

  it("503 twice → falls back to the next model", async () => {
    const { d, f } = client([
      { status: 503, body: "busy" },
      { status: 503, body: "busy" },
      { status: 200, body: OK_BODY("dec/two-1") },
    ]);
    const r = await d.decide("s", QS, { purpose: "t" });
    expect(f.calls.map((c) => c.body.model)).toEqual(["dec/one", "dec/one", "dec/two"]);
    expect(r.model).toBe("dec/two-1");
  });

  it("network error twice → next model", async () => {
    const { d, f } = client([{ throws: new Error("ECONNRESET") }, { throws: new Error("ECONNRESET") }, { status: 200, body: OK_BODY() }]);
    await d.decide("s", QS, { purpose: "t" });
    expect(f.calls).toHaveLength(3);
  });

  it("404 (not served) → next model, ledgered once per process per model", async () => {
    const notFound = { status: 404, body: { error: { message: "No endpoints found", code: 404 } } };
    const { d, f, ledger } = client([notFound, { status: 200, body: OK_BODY() }, notFound, { status: 200, body: OK_BODY() }]);
    await d.decide("s", QS, { purpose: "t" });
    await d.decide("s", QS, { purpose: "t" });
    expect(f.calls.map((c) => c.body.model)).toEqual(["dec/one", "dec/two", "dec/one", "dec/two"]);
    expect(ledger.events.filter((e) => e.kind === "decision.model_unavailable")).toHaveLength(1);
  });

  it("400 → next model", async () => {
    const { d, f } = client([{ status: 400, body: "bad" }, { status: 200, body: OK_BODY() }]);
    await d.decide("s", QS, { purpose: "t" });
    expect(f.calls).toHaveLength(2);
  });

  it.each([401, 402, 403])("%i → throws immediately, no fallback", async (status) => {
    const { d, f } = client([{ status, body: "no" }]);
    await expect(d.decide("s", QS, { purpose: "t" })).rejects.toBeInstanceOf(ProviderAuthError);
    expect(f.calls).toHaveLength(1);
  });

  it("missing answers → next model; the paid call still counts toward the cap", async () => {
    const partial = OK_BODY("dec/one-1", 0.00001);
    delete (partial.answers as Record<string, unknown>).level;
    const { d, f, meter } = client([{ status: 200, body: partial }, { status: 200, body: OK_BODY("dec/two-1", 0.00002) }]);
    const r = await d.decide("s", QS, { purpose: "t" });
    expect(f.calls).toHaveLength(2);
    expect(r.model).toBe("dec/two-1");
    expect(meter.spentUsd).toBeCloseTo(0.00003, 12);
  });

  it("a wrong answer type counts as missing", async () => {
    const wrong = OK_BODY();
    (wrong.answers as Record<string, unknown>).is_x = { type: "score", score: 1, probabilities: { "0": 1 } };
    const { d, f } = client([{ status: 200, body: wrong }, { status: 200, body: OK_BODY() }]);
    await d.decide("s", QS, { purpose: "t" });
    expect(f.calls).toHaveLength(2);
  });

  it("every model failing → DecisionUnavailableError listing each attempt", async () => {
    const { d } = client([{ status: 404, body: "x" }, { status: 404, body: "x" }]);
    await expect(d.decide("s", QS, { purpose: "t" })).rejects.toThrow(DecisionUnavailableError);
  });

  it("rejects more than 12 questions per request and empty requests", async () => {
    const many: Record<string, Question> = {};
    for (let i = 0; i < 13; i++) many[`q${i}`] = QS.is_x;
    const { d, f } = client([]);
    await expect(d.decide("s", many, { purpose: "t" })).rejects.toBeInstanceOf(TooManyQuestionsError);
    await expect(d.decide("s", {}, { purpose: "t" })).rejects.toThrow(/no questions/);
    expect(f.calls).toHaveLength(0);
  });

  it("checks the budget before calling", async () => {
    const { d, f } = client([], ["dec/one"], 0);
    await expect(d.decide("s", QS, { purpose: "t" })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f.calls).toHaveLength(0);
  });

  it("strips anything resembling a key from error details it ledgers", async () => {
    const { d, ledger } = client([{ status: 404, body: "bad key sk-test-abcdefghijklmnop" }, { status: 200, body: OK_BODY() }]);
    await d.decide("s", QS, { purpose: "t" });
    const ev = ledger.events.find((e) => e.kind === "decision.model_unavailable")!;
    expect(JSON.stringify(ev.payload)).not.toContain("abcdefghijklmnop");
  });
});

describe("LocalLLMDecisions", () => {
  it("normalizes answers, renormalizes probabilities, and labels results uncalibrated", async () => {
    const content = JSON.stringify({
      is_x: { type: "noul", noul: 1.4 },
      mood: { type: "choice", probabilities: { calm: 0.2, anxious: 0.6 } },
      level: { type: "score", probabilities: { "0": 0, "1": 1, "2": 1 } },
    });
    const f = fakeFetch([{ status: 200, body: { choices: [{ message: { content: "```json\n" + content + "\n```" } }] } }]);
    const ledger = new MemoryLedger();
    const d = new LocalLLMDecisions({ baseUrl: "http://127.0.0.1:11434/v1", model: "llama-test", meter: new CostMeter(1), ledger, fetch: f.impl, sleep: noSleep });
    const r = await d.decide("s", QS, { purpose: "affect" });
    expect(f.calls[0].url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(r.p("is_x")).toBe(1);
    expect(r.probs("mood").calm).toBeCloseTo(0.25, 10);
    expect(r.probs("mood").anxious).toBeCloseTo(0.75, 10);
    expect(r.choice("mood")).toBe("anxious");
    expect(r.score("level")).toBeCloseTo(1.5, 10);
    expect(r.model).toBe("local:llama-test");
    expect(r.calibrated).toBe(false);
    expect(ledger.events[0].calibrated).toBe(false);
  });

  it("clamps out-of-range probabilities to [0,1] before renormalizing", () => {
    const a = normalizeLocalAnswer(QS.mood, { probabilities: { calm: 2, anxious: -1 } });
    expect(a).toEqual({ type: "choice", choice: "calm", probabilities: { calm: 1, anxious: 0 } });
  });

  it("normalizeLocalAnswer rejects unusable answers", () => {
    expect(normalizeLocalAnswer(QS.is_x, { noul: "x" })).toBeNull();
    expect(normalizeLocalAnswer(QS.mood, { choice: "calm" })).toBeNull();
    expect(normalizeLocalAnswer(QS.level, null)).toBeNull();
  });
});
