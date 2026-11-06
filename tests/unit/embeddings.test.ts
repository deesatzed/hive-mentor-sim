import { describe, expect, it } from "vitest";
import { CostMeter } from "@/lib/council/providers/costMeter";
import { ChainUnavailableError, forCycle, OpenRouterEmbeddings, OpenRouterReranker, OPENROUTER_EMBEDDINGS_URL, OPENROUTER_RERANK_URL } from "@/lib/council/providers/embeddings";
import { ProviderAuthError } from "@/lib/council/providers/http";
import { MockReranker } from "@/lib/council/providers/mocks";
import { fakeFetch, MemoryLedger, noSleep } from "../helpers/fakeFetch";

// Model names are test labels, not real model IDs. Response shapes follow the live probe of 2026-11-04.
describe("OpenRouterEmbeddings", () => {
  it("posts the batch, orders vectors by index, records served model and cost", async () => {
    const f = fakeFetch([{ status: 200, body: { model: "served-v1", data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 5, cost: 0.000001 } } }]);
    const ledger = new MemoryLedger();
    const meter = new CostMeter();
    const e = new OpenRouterEmbeddings({ apiKey: "k", chain: ["emb/one"], meter, ledger, fetch: f.impl, sleep: noSleep });
    const v = await e.embed(["a", "b"]);
    expect(f.calls[0].url).toBe(OPENROUTER_EMBEDDINGS_URL);
    expect(f.calls[0].body).toEqual({ model: "emb/one", input: ["a", "b"] });
    expect(Array.from(v[0])).toEqual([1, 0]);
    expect(e.dim).toBe(2);
    expect(meter.spentUsd).toBeCloseTo(0.000001, 12);
    expect(ledger.events[0]).toMatchObject({ kind: "embed.batch", model: "emb/one (served served-v1)", costUsd: 0.000001 });
  });

  it("falls back along the chain on 404 and throws on auth errors", async () => {
    const ok = { status: 200, body: { data: [{ index: 0, embedding: [1] }], usage: { cost: 0 } } };
    const f = fakeFetch([{ status: 404, body: "no" }, ok]);
    const e = new OpenRouterEmbeddings({ apiKey: "k", chain: ["emb/a", "emb/b"], meter: new CostMeter(), ledger: new MemoryLedger(), fetch: f.impl, sleep: noSleep });
    await e.embed(["x"]);
    expect(f.calls.map((c) => c.body.model)).toEqual(["emb/a", "emb/b"]);
    expect(e.model).toBe("emb/b");
    const g = fakeFetch([{ status: 402, body: "no credit" }]);
    await expect(new OpenRouterEmbeddings({ apiKey: "k", chain: ["emb/a", "emb/b"], meter: new CostMeter(), ledger: new MemoryLedger(), fetch: g.impl, sleep: noSleep }).embed(["x"])).rejects.toBeInstanceOf(ProviderAuthError);
    const h = fakeFetch([{ status: 404, body: "no" }]);
    await expect(new OpenRouterEmbeddings({ apiKey: "k", chain: ["emb/a"], meter: new CostMeter(), ledger: new MemoryLedger(), fetch: h.impl, sleep: noSleep }).embed(["x"])).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});

describe("OpenRouterReranker", () => {
  it("posts query + documents and returns indexes by score", async () => {
    const f = fakeFetch([{ status: 200, body: { model: "rr-v1", results: [{ index: 1, relevance_score: 0.2 }, { index: 0, relevance_score: 0.9 }], usage: { cost: 0.000002 } } }]);
    const ledger = new MemoryLedger();
    const r = new OpenRouterReranker({ apiKey: "k", chain: ["rr/one"], meter: new CostMeter(), ledger, fetch: f.impl, sleep: noSleep });
    const out = await r.rerank("calm", ["a", "b"], 2);
    expect(f.calls[0].url).toBe(OPENROUTER_RERANK_URL);
    expect(f.calls[0].body).toEqual({ model: "rr/one", query: "calm", documents: ["a", "b"], top_n: 2 });
    expect(out).toEqual([{ index: 0, score: 0.9 }, { index: 1, score: 0.2 }]);
    expect(ledger.events[0].kind).toBe("rerank");
  });

  it("MockReranker is deterministic token overlap (mock)", async () => {
    const out = await new MockReranker().rerank("stay calm when wronged", ["the price of wheat", "stay calm", "when wronged, stay calm"]);
    expect(out.map((x) => x.index)).toEqual([2, 1, 0]);
  });
});

describe("forCycle (M10 finding: retrieval cost was not tied to its cycle)", () => {
  it("embed and rerank ledger rows carry the cycle id, so the per-cycle ledger sum equals the cycle cost", async () => {
    const f = fakeFetch([
      { status: 200, body: { data: [{ index: 0, embedding: [1, 0] }], usage: { cost: 0.000003 } } },
      { status: 200, body: { results: [{ index: 0, relevance_score: 0.5 }], usage: { cost: 0.000004 } } },
    ]);
    const ledger = new MemoryLedger();
    const meter = new CostMeter();
    const opts = { apiKey: "k", meter, ledger, fetch: f.impl, sleep: noSleep };
    const s = forCycle(new OpenRouterEmbeddings({ ...opts, chain: ["emb/one"] }), new OpenRouterReranker({ ...opts, chain: ["rr/one"] }), "cycle-1");
    await s.embedder.embed(["a"]);
    await s.reranker.rerank("q", ["a"], 1);
    expect(s.embedder.dim).toBe(2);
    expect(ledger.events.map((e) => [e.kind, e.cycleId])).toEqual([["embed.batch", "cycle-1"], ["rerank", "cycle-1"]]);
    expect(ledger.events.reduce((a, e) => a + (e.costUsd ?? 0), 0)).toBeCloseTo(meter.spentUsd, 12);
  });
});
