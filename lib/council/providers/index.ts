import "server-only";
import type { Decider } from "./decisions";
import type { LLM, Tier } from "./llm";
import { TIERS } from "./llm";
import type { Embedder } from "./embeddings";
import { CostMeter, costCapFromEnv } from "./costMeter";
import { MockDecider, MockEmbedder, MockLLM } from "./mocks";

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

export class LiveModeNotConfiguredError extends Error {
  constructor(public readonly missing: string[]) {
    super(`live mode not configured; missing: ${missing.join(", ")}`);
    this.name = "LiveModeNotConfiguredError";
  }
}

/** Thrown while a live provider class has not been built yet (M0 only; removed in M1). */
export class ProviderNotBuiltError extends Error {
  constructor(what: string, milestone: string) {
    super(`${what} is not built yet (arrives in ${milestone}); set USE_MOCK_PROVIDERS=true for now`);
    this.name = "ProviderNotBuiltError";
  }
}

const TIER_ENV: Record<Tier, string> = {
  fast: "TIER_FAST_MODEL",
  standard: "TIER_STANDARD_MODEL",
  premium: "TIER_PREMIUM_MODEL",
};

export type ProviderMode = "mock" | "cloud" | "local";

export type ResolvedConfig =
  | { mode: "mock"; costCapUsd: number }
  | {
      mode: "cloud";
      costCapUsd: number;
      decisionChain: string[];
      tiers: Record<Tier, { model: string; source: string }>;
      reviewerModel: string;
    }
  | { mode: "local"; costCapUsd: number; baseUrl: string; llmModel: string; embedModel: string };

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
  const costCapUsd = costCapFromEnv(env);
  if (clean(env.USE_MOCK_PROVIDERS)?.toLowerCase() === "true") return { mode: "mock", costCapUsd };

  const mode = clean(env.PROVIDER_MODE)?.toLowerCase() ?? "cloud";
  if (mode === "local") {
    const missing: string[] = [];
    const baseUrl = clean(env.LOCAL_LLM_BASE_URL) ?? "http://127.0.0.1:11434/v1";
    const llmModel = clean(env.LOCAL_LLM_MODEL);
    const embedModel = clean(env.LOCAL_EMBED_MODEL);
    if (!llmModel) missing.push("LOCAL_LLM_MODEL");
    if (!embedModel) missing.push("LOCAL_EMBED_MODEL");
    if (missing.length) throw new LiveModeNotConfiguredError(missing);
    return { mode: "local", costCapUsd, baseUrl, llmModel: llmModel!, embedModel: embedModel! };
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

  return { mode: "cloud", costCapUsd, decisionChain, tiers, reviewerModel: reviewer ?? tiers.standard.model };
}

export interface Providers {
  config: ResolvedConfig;
  meter: CostMeter;
  decider: Decider;
  llm: LLM;
  embedder: Embedder;
}

export function getProviders(env: Env = process.env): Providers {
  const config = resolveProviderConfig(env);
  const meter = new CostMeter(config.costCapUsd);
  if (config.mode === "mock") {
    return {
      config,
      meter,
      decider: new MockDecider({}, meter),
      llm: new MockLLM(undefined, {}, meter),
      embedder: new MockEmbedder(),
    };
  }
  // M0: configuration resolves and is tested; the live clients are built in M1.
  throw new ProviderNotBuiltError(config.mode === "cloud" ? "OpenRouter providers" : "local providers", "M1");
}
