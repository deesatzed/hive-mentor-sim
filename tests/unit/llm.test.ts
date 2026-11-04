import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CostMeter } from "@/lib/council/providers/costMeter";
import { ProviderAuthError } from "@/lib/council/providers/http";
import { GenerationError, isStrictCompatible, jsonSchemaFor, LocalLLM, OpenRouterLLM, OPENROUTER_CHAT_URL } from "@/lib/council/providers/llm";
import { fakeFetch, MemoryLedger, noSleep } from "../helpers/fakeFetch";

// Model names are test labels, not real model IDs.
const MODELS = { fast: "t/fast", standard: "t/std", premium: "t/prem" };
const render = (id: string, vars: Record<string, unknown>) => ({ system: `SYS ${id}`, user: `USER ${JSON.stringify(vars)}` });
const schema = z.object({ claim: z.string(), uncertainty: z.string() });
const reply = (content: string, cost = 0.00001, model = "t/fast") => ({
  status: 200,
  body: { model, choices: [{ message: { content } }], usage: { cost } },
});

function client(script: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(script);
  const ledger = new MemoryLedger();
  const meter = new CostMeter();
  const llm = new OpenRouterLLM({ apiKey: "test-key", models: MODELS, meter, ledger, render, fetch: f.impl, sleep: noSleep });
  return { llm, f, ledger, meter };
}

describe("OpenRouterLLM", () => {
  it("sends the documented request body for the tier and returns parsed data", async () => {
    const { llm, f, ledger, meter } = client([reply('{"claim":"a","uncertainty":"b"}')]);
    const r = await llm.generate("VOICE_WHISPER", { voice: "LOGOS" }, schema, { tier: "fast", temperature: 0.3, purpose: "whisper", cycleId: "c1" });
    expect(r).toEqual({ data: { claim: "a", uncertainty: "b" }, model: "t/fast", costUsd: 0.00001 });
    const body = f.calls[0].body;
    expect(f.calls[0].url).toBe(OPENROUTER_CHAT_URL);
    expect(body.model).toBe("t/fast");
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(900);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.provider).toEqual({ sort: "latency", require_parameters: true });
    const rf = body.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("VOICE_WHISPER");
    expect(rf.json_schema.strict).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "SYS VOICE_WHISPER" },
      { role: "user", content: 'USER {"voice":"LOGOS"}' },
    ]);
    expect(meter.spentUsd).toBeCloseTo(0.00001, 12);
    expect(ledger.events.map((e) => e.kind)).toEqual(["llm.VOICE_WHISPER"]);
    expect(ledger.events[0].cycleId).toBe("c1");
  });

  it("routes each tier to its model", async () => {
    const { llm, f } = client([reply('{"claim":"a","uncertainty":"b"}'), reply('{"claim":"a","uncertainty":"b"}')]);
    await llm.generate("X", {}, schema, { tier: "premium", purpose: "t" });
    await llm.generate("X", {}, schema, { tier: "standard", purpose: "t" });
    expect(f.calls.map((c) => c.body.model)).toEqual(["t/prem", "t/std"]);
  });

  it("schema failure → one retry with the validation error appended → success", async () => {
    const { llm, f, ledger, meter } = client([reply('{"claim":"a"}'), reply('```json\n{"claim":"a","uncertainty":"b"}\n```')]);
    const r = await llm.generate("X", {}, schema, { tier: "fast", purpose: "t" });
    expect(r.data.uncertainty).toBe("b");
    expect(r.costUsd).toBeCloseTo(0.00002, 12);
    expect(meter.spentUsd).toBeCloseTo(0.00002, 12);
    const retryMsgs = f.calls[1].body.messages as { role: string; content: string }[];
    expect(retryMsgs).toHaveLength(4);
    expect(retryMsgs[2]).toEqual({ role: "assistant", content: '{"claim":"a"}' });
    expect(retryMsgs[3].content).toMatch(/failed validation/);
    expect(retryMsgs[3].content).toMatch(/uncertainty/);
    expect(ledger.events.map((e) => e.kind)).toEqual(["llm.X.invalid", "llm.X"]);
  });

  it("two failures → GenerationError", async () => {
    const { llm, f } = client([reply("not json"), reply('{"claim":1}')]);
    await expect(llm.generate("X", {}, schema, { tier: "fast", purpose: "t" })).rejects.toBeInstanceOf(GenerationError);
    expect(f.calls).toHaveLength(2);
  });

  it("401 → ProviderAuthError; other HTTP failures → GenerationError", async () => {
    const a = client([{ status: 401, body: "no" }]);
    await expect(a.llm.generate("X", {}, schema, { tier: "fast", purpose: "t" })).rejects.toBeInstanceOf(ProviderAuthError);
    const b = client([{ status: 500, body: "x" }, { status: 500, body: "x" }]);
    await expect(b.llm.generate("X", {}, schema, { tier: "fast", purpose: "t" })).rejects.toBeInstanceOf(GenerationError);
    expect(b.f.calls).toHaveLength(2);
  });
});

describe("LocalLLM", () => {
  it("uses the local endpoint, json_object mode, and labels the model local:<name>", async () => {
    const f = fakeFetch([reply('{"claim":"a","uncertainty":"b"}', 0, "llama-test")]);
    const ledger = new MemoryLedger();
    const llm = new LocalLLM({ baseUrl: "http://127.0.0.1:11434/v1/", model: "llama-test", meter: new CostMeter(), ledger, render, fetch: f.impl, sleep: noSleep });
    const r = await llm.generate("X", {}, schema, { tier: "premium", purpose: "t" });
    expect(f.calls[0].url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(f.calls[0].body.response_format).toEqual({ type: "json_object" });
    expect(f.calls[0].body.reasoning).toBeUndefined();
    expect(r.model).toBe("local:llama-test");
    expect(ledger.events[0].calibrated).toBe(false);
  });
});

describe("JSON schema strictness", () => {
  it("strict only when every property is required", () => {
    expect(isStrictCompatible(jsonSchemaFor(schema))).toBe(true);
    expect(isStrictCompatible(jsonSchemaFor(z.object({ a: z.string(), b: z.string().optional() })))).toBe(false);
  });
});
