import "server-only";
import type { Ledger } from "../ledger";
import { PrismaLedger } from "../ledger";
import type { Decider } from "./decisions";
import { LocalLLMDecisions, OpenRouterDecisions } from "./decisions";
import type { LLM, PromptRenderer, Tier } from "./llm";
import { LocalLLM, OpenRouterLLM, TIERS } from "./llm";
import type { Embedder, Reranker } from "./embeddings";
import { IdentityReranker, OllamaEmbeddings, OpenRouterEmbeddings, OpenRouterReranker, UnconfiguredEmbedder, UnconfiguredReranker } from "./embeddings";
import { CostMeter } from "./costMeter";
import { LiveModeNotConfiguredError, MockModeNotAllowedError } from "./errors";
import { MockDecider, MockEmbedder, MockLLM, MockReranker, type LlmFixture, type MockContext, type MockRule } from "./mocks";
import { renderPrompt } from "@/lib/hive/prompts";
import { hiveConfig } from "@/lib/hive/config";
import { MOCK_RULES } from "@/tests/helpers/mockRules";

export { LiveModeNotConfiguredError, MockModeNotAllowedError };

/** True only inside a test runner (vitest, Playwright's dev server, offline `pnpm eval`), which sets HIVE_TEST_RUNNER=1. */
export const inTestRunner = (env: Env = process.env) => clean(env.HIVE_TEST_RUNNER) === "1" || clean(process.env.HIVE_TEST_RUNNER) === "1";

/**
 * Provider resolution (docs/ARCHITECTURE.md `getProviders()` table).
 *
 * | Condition                | Decider             | LLM                         | Embedder         |
 * | USE_MOCK_PROVIDERS=true  | MockDecider         | MockLLM                     | MockEmbedder     |
 * | PROVIDER_MODE=cloud      | OpenRouterDecisions | OpenRouterLLM (TIER_*)      | OpenRouterEmbeddings + OpenRouterReranker |
 * | PROVIDER_MODE=local      | LocalLLMDecisions   | LocalLLM                    | OllamaEmbeddings (no reranker)            |
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
      /** the central manager that orders the cycle (orchestration.mode = manager) */
      manager: { model: string; source: string };
      /** the live eval grader's rationale writer */
      grader: { model: string; source: string };
      /** OPENROUTER_EMB_MODEL_1..N (config `models.embedding` first); empty → embedding fails on use */
      embeddingChain: string[];
      /** OPENROUTER_RETRIEVAL_MODEL_1..N (config `models.rerank` first); empty → reranking fails on use */
      rerankChain: string[];
    }
  | { mode: "local"; baseUrl: string; llmModel: string; embedModel: string };

const clean = (v: string | undefined) => {
  const t = v?.trim().replace(/^["']|["']$/g, "");
  return t ? t : undefined;
};

/** <PREFIX>_1..N in numeric order; stops at the first gap; a repeated model ID is kept once. */
export function chainFromEnv(env: Env, prefix: string): string[] {
  const chain: string[] = [];
  for (let i = 1; ; i++) {
    const m = clean(env[`${prefix}_${i}`]);
    if (!m) break;
    if (!chain.includes(m)) chain.push(m);
  }
  return chain;
}

/** OPENROUTER_DEC_MODEL_1..N (duplicates kept once). */
export const decisionChainFromEnv = (env: Env) => chainFromEnv(env, "OPENROUTER_DEC_MODEL");

/** Owner-chosen model IDs from config/hive.yaml `models:`; empty strings mean "use .env". */
export interface ModelOverrides {
  manager?: string;
  fast?: string;
  standard?: string;
  premium?: string;
  grader?: string;
  embedding?: string;
  rerank?: string;
}

export function resolveProviderConfig(env: Env = process.env, overrides: ModelOverrides = {}): ResolvedConfig {
  if (clean(env.USE_MOCK_PROVIDERS)?.toLowerCase() === "true") {
    if (!inTestRunner(env)) throw new MockModeNotAllowedError();
    return { mode: "mock" };
  }

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
    const fromConfig = clean(overrides[tier]);
    const own = clean(env[TIER_ENV[tier]]);
    if (fromConfig) tiers[tier] = { model: fromConfig, source: `config/hive.yaml models.${tier}` };
    else if (own) tiers[tier] = { model: own, source: TIER_ENV[tier] };
    else if (reviewer) tiers[tier] = { model: reviewer, source: "OPENROUTER_REVIEWER_MODEL" };
    else missing.push(`${TIER_ENV[tier]} (or OPENROUTER_REVIEWER_MODEL)`);
  }
  if (missing.length) throw new LiveModeNotConfiguredError(missing);

  const pick = (key: "manager" | "grader") => {
    const fromConfig = clean(overrides[key]);
    if (fromConfig) return { model: fromConfig, source: `config/hive.yaml models.${key}` };
    if (reviewer) return { model: reviewer, source: "OPENROUTER_REVIEWER_MODEL" };
    return { model: tiers.standard.model, source: tiers.standard.source };
  };

  const withOverride = (o: string | undefined, chain: string[]) => {
    const first = clean(o);
    return first ? [first, ...chain.filter((m) => m !== first)] : chain;
  };
  const embeddingChain = withOverride(overrides.embedding, chainFromEnv(env, "OPENROUTER_EMB_MODEL"));
  const rerankChain = withOverride(overrides.rerank, chainFromEnv(env, "OPENROUTER_RETRIEVAL_MODEL"));
  return {
    mode: "cloud",
    apiKey: clean(env.OPENROUTER_API_KEY)!,
    decisionChain,
    tiers,
    reviewerModel: reviewer ?? tiers.standard.model,
    manager: pick("manager"),
    grader: pick("grader"),
    embeddingChain,
    rerankChain,
  };
}

export interface Providers {
  config: ResolvedConfig;
  meter: CostMeter;
  decider: Decider;
  llm: LLM;
  /** the central manager model (all tiers = the manager model) */
  manager: LLM;
  managerModel: string;
  /** the live eval grader */
  grader: LLM;
  embedder: Embedder;
  reranker: Reranker;
}

export interface ProviderDeps {
  /** Prompt renderer for the LLM; defaults to lib/hive/prompts. */
  render?: PromptRenderer;
  ledger?: Ledger;
  meter?: CostMeter;
  /** Defaults to config/hive.yaml `models:`. */
  models?: ModelOverrides;
  /** Mock mode only: decision rules and LLM fixture context (MOCK — offline tests and mock eval). */
  mockRules?: Record<string, MockRule>;
  mockContext?: MockContext;
  /** Mock mode only: inline fixtures that override files in tests/fixtures/llm (unit tests). */
  mockFixtures?: Record<string, LlmFixture>;
}

export function getProviders(env: Env = process.env, deps: ProviderDeps = {}): Providers {
  const config = resolveProviderConfig(env, deps.models ?? hiveConfig().models);
  const meter = deps.meter ?? new CostMeter();
  if (config.mode === "mock") {
    const llm = new MockLLM(undefined, deps.mockFixtures ?? {}, meter, deps.mockContext, deps.ledger);
    return {
      config,
      meter,
      decider: new MockDecider(deps.mockRules ?? MOCK_RULES, meter, deps.ledger),
      llm,
      manager: llm,
      managerModel: "mock:llm",
      grader: llm,
      embedder: new MockEmbedder(),
      reranker: new MockReranker(),
    };
  }
  const ledger = deps.ledger ?? new PrismaLedger();
  const render = deps.render ?? defaultRenderer();
  if (config.mode === "cloud") {
    const models = Object.fromEntries(TIERS.map((t) => [t, config.tiers[t].model])) as Record<Tier, string>;
    const one = (m: string) => ({ fast: m, standard: m, premium: m });
    return {
      config,
      meter,
      decider: new OpenRouterDecisions({ apiKey: config.apiKey, chain: config.decisionChain, meter, ledger }),
      llm: new OpenRouterLLM({ apiKey: config.apiKey, models, meter, ledger, render }),
      manager: new OpenRouterLLM({ apiKey: config.apiKey, models: one(config.manager.model), meter, ledger, render }),
      managerModel: config.manager.model,
      grader: new OpenRouterLLM({ apiKey: config.apiKey, models: one(config.grader.model), meter, ledger, render }),
      embedder: config.embeddingChain.length
        ? new OpenRouterEmbeddings({ apiKey: config.apiKey, chain: config.embeddingChain, meter, ledger })
        : new UnconfiguredEmbedder(["OPENROUTER_EMB_MODEL_1"]),
      reranker: config.rerankChain.length
        ? new OpenRouterReranker({ apiKey: config.apiKey, chain: config.rerankChain, meter, ledger })
        : new UnconfiguredReranker(["OPENROUTER_RETRIEVAL_MODEL_1"]),
    };
  }
  const local = new LocalLLM({ baseUrl: config.baseUrl, model: config.llmModel, meter, ledger, render });
  return {
    config,
    meter,
    decider: new LocalLLMDecisions({ baseUrl: config.baseUrl, model: config.llmModel, meter, ledger }),
    llm: local,
    manager: local,
    managerModel: `local:${config.llmModel}`,
    grader: local,
    embedder: new OllamaEmbeddings({ baseUrl: config.baseUrl, model: config.embedModel, meter, ledger }),
    reranker: new IdentityReranker(),
  };
}

function defaultRenderer(): PromptRenderer {
  return renderPrompt;
}
