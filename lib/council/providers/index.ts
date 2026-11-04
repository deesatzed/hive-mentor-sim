import "server-only";
import type { Ledger } from "../ledger";
import { PrismaLedger } from "../ledger";
import type { Decider } from "./decisions";
import { LocalLLMDecisions, OpenRouterDecisions } from "./decisions";
import type { LLM, PromptRenderer, Tier } from "./llm";
import { LocalLLM, OpenRouterLLM, TIERS } from "./llm";
import type { Embedder } from "./embeddings";
import { OllamaEmbeddings, OpenAIEmbeddings, UnconfiguredEmbedder } from "./embeddings";
import { CostMeter } from "./costMeter";
import { LiveModeNotConfiguredError } from "./errors";
import { MockDecider, MockEmbedder, MockLLM } from "./mocks";
import { renderPrompt } from "@/lib/hive/prompts";

export { LiveModeNotConfiguredError };

/**
 * Provider resolution (docs/ARCHITECTURE.md `getProviders()` table).
 *
 * | Condition                | Decider             | LLM                         | Embedder         |
 * | USE_MOCK_PROVIDERS=true  | MockDecider         | MockLLM                     | MockEmbedder     |
 * | PROVIDER_MODE=cloud      | OpenRouterDecisions | OpenRouterLLM (TIER_*)      | OpenAIEmbeddings |
 * | PROVIDER_MODE=local      | LocalLLMDecisions   | LocalLLM                    | OllamaEmbeddings |
 *
 * Model IDs come only from env (the owner's .env). Nothing is hard-coded.
 */

export type Env = Record<string, string | undefined>;

const TIER_ENV: Record<Tier, string> = {
  fast: "TIER_FAST_MODEL",
  standard: "TIER_STANDARD_MODEL",
  premium: "TIER_PREMIUM_MODEL",
};

export type ProviderMode = "mock" | "cloud" | "local";

export type ResolvedConfig =
  | { mode: "mock" }
  | {
      mode: "cloud";
      decisionChain: string[];
      apiKey: string;
      tiers: Record<Tier, { model: string; source: string }>;
      reviewerModel: string;
      /** null when OPENAI_API_KEY or OPENAI_EMBED_MODEL is missing; embedding then fails on use. */
      embeddings: { apiKey: string; model: string } | null;
      embeddingsMissing: string[];
    }
  | { mode: "local"; baseUrl: string; llmModel: string; embedModel: string };

const clean = (v: string | undefined) => {
  const t = v?.trim().replace(/^["']|["']$/g, "");
  return t ? t : undefined;
};

/** OPENROUTER_DEC_MODEL_1..N in numeric order; stops at the first gap. */
export function decisionChainFromEnv(env: Env): string[] {
  const chain: string[] = [];
  for (let i = 1; ; i++) {
    const m = clean(env[`OPENROUTER_DEC_MODEL_${i}`]);
    if (!m) break;
    chain.push(m);
  }
  return chain;
}

export function resolveProviderConfig(env: Env = process.env): ResolvedConfig {
  if (clean(env.USE_MOCK_PROVIDERS)?.toLowerCase() === "true") return { mode: "mock" };

  const mode = clean(env.PROVIDER_MODE)?.toLowerCase() ?? "cloud";
  if (mode === "local") {
    const missing: string[] = [];
    const baseUrl = clean(env.LOCAL_LLM_BASE_URL) ?? "http://127.0.0.1:11434/v1";
    const llmModel = clean(env.LOCAL_LLM_MODEL);
    const embedModel = clean(env.LOCAL_EMBED_MODEL);
    if (!llmModel) missing.push("LOCAL_LLM_MODEL");
    if (!embedModel) missing.push("LOCAL_EMBED_MODEL");
    if (missing.length) throw new LiveModeNotConfiguredError(missing);
    return { mode: "local", baseUrl, llmModel: llmModel!, embedModel: embedModel! };
  }
  if (mode !== "cloud") throw new Error(`PROVIDER_MODE must be cloud or local, got '${mode}'`);

  const missing: string[] = [];
  if (!clean(env.OPENROUTER_API_KEY)) missing.push("OPENROUTER_API_KEY");
  const decisionChain = decisionChainFromEnv(env);
  if (decisionChain.length === 0) missing.push("OPENROUTER_DEC_MODEL_1");
  const reviewer = clean(env.OPENROUTER_REVIEWER_MODEL);

  const tiers = {} as Record<Tier, { model: string; source: string }>;
  for (const tier of TIERS) {
    const own = clean(env[TIER_ENV[tier]]);
    if (own) tiers[tier] = { model: own, source: TIER_ENV[tier] };
    else if (reviewer) tiers[tier] = { model: reviewer, source: "OPENROUTER_REVIEWER_MODEL" };
    else missing.push(`${TIER_ENV[tier]} (or OPENROUTER_REVIEWER_MODEL)`);
  }
  if (missing.length) throw new LiveModeNotConfiguredError(missing);

  const openaiKey = clean(env.OPENAI_API_KEY);
  const embedModel = clean(env.OPENAI_EMBED_MODEL);
  const embeddingsMissing = [...(openaiKey ? [] : ["OPENAI_API_KEY"]), ...(embedModel ? [] : ["OPENAI_EMBED_MODEL"])];
  return {
    mode: "cloud",
    apiKey: clean(env.OPENROUTER_API_KEY)!,
    decisionChain,
    tiers,
    reviewerModel: reviewer ?? tiers.standard.model,
    embeddings: embeddingsMissing.length ? null : { apiKey: openaiKey!, model: embedModel! },
    embeddingsMissing,
  };
}

export interface Providers {
  config: ResolvedConfig;
  meter: CostMeter;
  decider: Decider;
  llm: LLM;
  embedder: Embedder;
}

export interface ProviderDeps {
  /** Prompt renderer for the LLM; defaults to lib/hive/prompts. */
  render?: PromptRenderer;
  ledger?: Ledger;
  meter?: CostMeter;
}

export function getProviders(env: Env = process.env, deps: ProviderDeps = {}): Providers {
  const config = resolveProviderConfig(env);
  const meter = deps.meter ?? new CostMeter();
  if (config.mode === "mock") {
    return {
      config,
      meter,
      decider: new MockDecider({}, meter),
      llm: new MockLLM(undefined, {}, meter),
      embedder: new MockEmbedder(),
    };
  }
  const ledger = deps.ledger ?? new PrismaLedger();
  const render = deps.render ?? defaultRenderer();
  if (config.mode === "cloud") {
    const models = Object.fromEntries(TIERS.map((t) => [t, config.tiers[t].model])) as Record<Tier, string>;
    return {
      config,
      meter,
      decider: new OpenRouterDecisions({ apiKey: config.apiKey, chain: config.decisionChain, meter, ledger }),
      llm: new OpenRouterLLM({ apiKey: config.apiKey, models, meter, ledger, render }),
      embedder: config.embeddings
        ? new OpenAIEmbeddings({ apiKey: config.embeddings.apiKey, model: config.embeddings.model, meter, ledger })
        : new UnconfiguredEmbedder(config.embeddingsMissing),
    };
  }
  return {
    config,
    meter,
    decider: new LocalLLMDecisions({ baseUrl: config.baseUrl, model: config.llmModel, meter, ledger }),
    llm: new LocalLLM({ baseUrl: config.baseUrl, model: config.llmModel, meter, ledger, render }),
    embedder: new OllamaEmbeddings({ baseUrl: config.baseUrl, model: config.embedModel, meter, ledger }),
  };
}

function defaultRenderer(): PromptRenderer {
  return renderPrompt;
}
