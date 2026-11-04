import "server-only";
import type { Ledger } from "../ledger";
import type { CostMeter } from "./costMeter";
import { LiveModeNotConfiguredError } from "./errors";
import type { FetchLike, Sleep } from "./http";
import { errorDetail, isAuthStatus, postJsonWithRetry, ProviderAuthError, ProviderHttpError, realSleep } from "./http";

/** Embedding interface (docs/ARCHITECTURE.md). `dim` is 0 until the first successful call. */
export interface Embedder {
  model: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

interface LiveEmbedderOpts {
  meter: CostMeter;
  ledger: Ledger;
  fetch?: FetchLike;
  sleep?: Sleep;
}

/** Cloud embeddings. The model comes from OPENAI_EMBED_MODEL (owner-chosen). */
export class OpenAIEmbeddings implements Embedder {
  dim = 0;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;

  constructor(private readonly o: LiveEmbedderOpts & { apiKey: string; model: string; url?: string }) {
    this.fetchImpl = o.fetch ?? ((u, i) => fetch(u, i));
    this.sleep = o.sleep ?? realSleep;
  }

  get model() {
    return this.o.model;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    this.o.meter.check();
    const t0 = Date.now();
    const res = await postJsonWithRetry(this.fetchImpl, this.sleep, this.o.url ?? OPENAI_EMBEDDINGS_URL, { Authorization: `Bearer ${this.o.apiKey}` }, {
      model: this.o.model,
      input: texts,
    });
    if (isAuthStatus(res.status)) throw new ProviderAuthError(res.status, await errorDetail(res));
    if (!res.ok) throw new ProviderHttpError(res.status, await errorDetail(res));
    const body = (await res.json()) as {
      data: { index: number; embedding: number[] }[];
      model?: string;
      usage?: { prompt_tokens?: number };
    };
    const out = [...body.data].sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
    if (out.length !== texts.length) throw new Error(`embeddings: expected ${texts.length} vectors, got ${out.length}`);
    this.dim = out[0].length;
    // OpenAI's embeddings response reports tokens but no cost; cost is recorded as 0 and flagged unreported.
    this.o.meter.add(this.o.model, 0);
    await this.o.ledger.record({
      kind: "embed.batch",
      model: body.model ?? this.o.model,
      latencyMs: Date.now() - t0,
      payload: { n: texts.length, dim: this.dim, promptTokens: body.usage?.prompt_tokens ?? null, costReported: false },
    });
    return out;
  }
}

/** PROVIDER_MODE=local: Ollama embeddings (POST /api/embed). */
export class OllamaEmbeddings implements Embedder {
  dim = 0;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;

  constructor(private readonly o: LiveEmbedderOpts & { baseUrl: string; model: string }) {
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

/** Stands in when no embedding provider is configured: fails on use, naming what is missing. */
export class UnconfiguredEmbedder implements Embedder {
  readonly model = "unconfigured";
  readonly dim = 0;
  constructor(private readonly missing: string[]) {}
  async embed(): Promise<Float32Array[]> {
    throw new LiveModeNotConfiguredError(this.missing);
  }
}
