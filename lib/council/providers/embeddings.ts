import "server-only";
import type { Ledger } from "../ledger";
import type { CostMeter } from "./costMeter";
import { LiveModeNotConfiguredError } from "./errors";
import type { FetchLike, Sleep } from "./http";
import { errorDetail, isAuthStatus, postJsonWithRetry, ProviderAuthError, ProviderHttpError, realSleep } from "./http";

/**
 * Embeddings and reranking. Cloud mode uses OpenRouter for both (owner decision 2026-11-04: one key,
 * one spending limit, easy model swaps). Models come from `.env` chains OPENROUTER_EMB_MODEL_1..N and
 * OPENROUTER_RETRIEVAL_MODEL_1..N (or config/hive.yaml `models.embedding` / `models.rerank`), tried in
 * order: 4xx other than auth → next model, 401/402/403 → throw, network/429/5xx → one retry then next.
 */

/** `dim` and `model` (the model that answered) are known after the first successful call. */
export interface Embedder {
  model: string;
  dim: number;
  /** opts.cycleId ties the ledger row (and its cost) to the cycle that asked */
  embed(texts: string[], opts?: { cycleId?: string }): Promise<Float32Array[]>;
}

export interface RerankResult {
  index: number;
  score: number;
}
export interface Reranker {
  model: string;
  rerank(query: string, documents: string[], topN?: number, opts?: { cycleId?: string }): Promise<RerankResult[]>;
}

/** The same embedder and reranker, with every call's ledger row tied to one cycle. */
export function forCycle(e: Embedder, r: Reranker, cycleId: string): { embedder: Embedder; reranker: Reranker } {
  return {
    embedder: {
      get model() {
        return e.model;
      },
      get dim() {
        return e.dim;
      },
      embed: (texts) => e.embed(texts, { cycleId }),
    },
    reranker: {
      get model() {
        return r.model;
      },
      rerank: (q, docs, topN) => r.rerank(q, docs, topN, { cycleId }),
    },
  };
}

export const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
export const OPENROUTER_RERANK_URL = "https://openrouter.ai/api/v1/rerank";

export class ChainUnavailableError extends Error {
  constructor(what: string, public readonly attempts: { model: string; reason: string }[]) {
    super(`no ${what} model answered: ${attempts.map((a) => `${a.model} (${a.reason})`).join("; ")}`);
    this.name = "ChainUnavailableError";
  }
}

interface ChainOpts {
  apiKey: string;
  chain: string[];
  meter: CostMeter;
  ledger: Ledger;
  fetch?: FetchLike;
  sleep?: Sleep;
  url?: string;
}

/** POSTs to each model in the chain until one answers; returns the parsed JSON and the model that answered. */
async function postChain(o: ChainOpts, url: string, what: string, body: (model: string) => unknown) {
  const fetchImpl = o.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const sleep = o.sleep ?? realSleep;
  const attempts: { model: string; reason: string }[] = [];
  for (const model of o.chain) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await postJsonWithRetry(fetchImpl, sleep, url, { Authorization: `Bearer ${o.apiKey}`, "X-Title": "hive-mentor-sim" }, body(model));
    } catch (e) {
      attempts.push({ model, reason: `network: ${(e as Error).message}` });
      continue;
    }
    if (isAuthStatus(res.status)) throw new ProviderAuthError(res.status, await errorDetail(res));
    if (!res.ok) {
      attempts.push({ model, reason: new ProviderHttpError(res.status, await errorDetail(res)).message });
      continue;
    }
    return { json: (await res.json()) as Record<string, unknown>, model, latencyMs: Date.now() - t0 };
  }
  throw new ChainUnavailableError(what, attempts);
}

/** Cloud embeddings through OpenRouter (OpenAI-compatible /embeddings). */
export class OpenRouterEmbeddings implements Embedder {
  dim = 0;
  model: string;
  constructor(private readonly o: ChainOpts) {
    if (!o.chain.length) throw new Error("OpenRouterEmbeddings needs at least one model");
    this.model = o.chain[0];
  }

  async embed(texts: string[], opts: { cycleId?: string } = {}): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const { json, model, latencyMs } = await postChain(this.o, this.o.url ?? OPENROUTER_EMBEDDINGS_URL, "embedding", (m) => ({ model: m, input: texts }));
    const data = (json.data as { index: number; embedding: number[] }[] | undefined) ?? [];
    const out = [...data].sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
    if (out.length !== texts.length) throw new Error(`embeddings: expected ${texts.length} vectors, got ${out.length}`);
    const usage = (json.usage as { cost?: number; prompt_tokens?: number } | undefined) ?? {};
    const served = typeof json.model === "string" ? `${model} (served ${json.model})` : model;
    this.dim = out[0].length;
    this.model = model;
    this.o.meter.add(served, usage.cost ?? 0);
    await this.o.ledger.record({ kind: "embed.batch", cycleId: opts.cycleId ?? null, model: served, costUsd: usage.cost ?? 0, latencyMs, payload: { n: texts.length, dim: this.dim, promptTokens: usage.prompt_tokens ?? null } });
    return out;
  }
}

/** Cloud reranking through OpenRouter (/rerank). Results sorted by score, highest first. */
export class OpenRouterReranker implements Reranker {
  model: string;
  constructor(private readonly o: ChainOpts) {
    if (!o.chain.length) throw new Error("OpenRouterReranker needs at least one model");
    this.model = o.chain[0];
  }

  async rerank(query: string, documents: string[], topN?: number, opts: { cycleId?: string } = {}): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const { json, model, latencyMs } = await postChain(this.o, this.o.url ?? OPENROUTER_RERANK_URL, "rerank", (m) => ({ model: m, query, documents, ...(topN ? { top_n: topN } : {}) }));
    const results = ((json.results as { index: number; relevance_score: number }[] | undefined) ?? []).map((r) => ({ index: r.index, score: r.relevance_score }));
    const usage = (json.usage as { cost?: number } | undefined) ?? {};
    const served = typeof json.model === "string" ? `${model} (served ${json.model})` : model;
    this.model = model;
    this.o.meter.add(served, usage.cost ?? 0);
    await this.o.ledger.record({ kind: "rerank", cycleId: opts.cycleId ?? null, model: served, costUsd: usage.cost ?? 0, latencyMs, payload: { n: documents.length, top: results.slice(0, 3) } });
    return results.sort((a, b) => b.score - a.score || a.index - b.index);
  }
}

/** PROVIDER_MODE=local: Ollama embeddings (POST /api/embed). */
export class OllamaEmbeddings implements Embedder {
  dim = 0;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;

  constructor(private readonly o: { baseUrl: string; model: string; meter: CostMeter; ledger: Ledger; fetch?: FetchLike; sleep?: Sleep }) {
    this.fetchImpl = o.fetch ?? ((u, i) => fetch(u, i));
    this.sleep = o.sleep ?? realSleep;
  }

  get model() {
    return `local:${this.o.model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    // LOCAL_LLM_BASE_URL is the OpenAI-compatible ".../v1" URL; Ollama's native API sits at the root.
    const root = this.o.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    const res = await postJsonWithRetry(this.fetchImpl, this.sleep, `${root}/api/embed`, {}, { model: this.o.model, input: texts });
    if (!res.ok) throw new ProviderHttpError(res.status, await errorDetail(res));
    const body = (await res.json()) as { embeddings: number[][] };
    const out = body.embeddings.map((e) => Float32Array.from(e));
    this.dim = out[0]?.length ?? 0;
    return out;
  }
}

/** Local mode (no reranker): keeps the input order. */
export class IdentityReranker implements Reranker {
  readonly model = "none";
  async rerank(_query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
    return documents.map((_, index) => ({ index, score: 1 - index / Math.max(1, documents.length) })).slice(0, topN ?? documents.length);
  }
}

/** Stand-ins when no embedding or rerank model is configured: fail on use, naming what is missing. */
export class UnconfiguredEmbedder implements Embedder {
  readonly model = "unconfigured";
  readonly dim = 0;
  constructor(private readonly missing: string[]) {}
  async embed(): Promise<Float32Array[]> {
    throw new LiveModeNotConfiguredError(this.missing);
  }
}
export class UnconfiguredReranker implements Reranker {
  readonly model = "unconfigured";
  constructor(private readonly missing: string[]) {}
  async rerank(): Promise<RerankResult[]> {
    throw new LiveModeNotConfiguredError(this.missing);
  }
}
