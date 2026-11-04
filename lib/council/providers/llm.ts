import "server-only";
import { z } from "zod";
import type { Ledger } from "../ledger";
import { summarizeInput } from "../ledger";
import type { CostMeter } from "./costMeter";
import type { FetchLike, Sleep } from "./http";
import { errorDetail, isAuthStatus, postJsonWithRetry, ProviderAuthError, realSleep } from "./http";

/**
 * Text generation (docs/ARCHITECTURE.md, docs/LLM_PROMPTS.md §1). LLM output never supplies a
 * number that drives control flow; numbers come from DecisionResult.
 */

export type Tier = "fast" | "standard" | "premium";
export const TIERS: readonly Tier[] = ["fast", "standard", "premium"] as const;

export interface GenerateOpts {
  tier: Tier;
  temperature?: number;
  maxTokens?: number;
  purpose: string;
  cycleId?: string;
}

export interface LLM {
  generate<T>(
    promptId: string,
    vars: Record<string, unknown>,
    schema: z.ZodType<T>,
    opts: GenerateOpts,
  ): Promise<{ data: T; model: string; costUsd: number }>;
}

export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

export interface RenderedPrompt {
  system: string;
  user: string;
}
/** Turns a prompt id + vars into messages. Supplied by lib/hive/prompts.ts. */
export type PromptRenderer = (promptId: string, vars: Record<string, unknown>) => RenderedPrompt;

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_MAX_TOKENS = 900;

type JsonSchema = Record<string, unknown>;

/** True when every object in the schema lists all its properties as required (needed for strict mode). */
export function isStrictCompatible(schema: JsonSchema): boolean {
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return true;
    if (Array.isArray(node)) return node.every(walk);
    const n = node as Record<string, unknown>;
    if (n.type === "object" && n.properties && typeof n.properties === "object") {
      const props = Object.keys(n.properties as object);
      const req = new Set((n.required as string[] | undefined) ?? []);
      if (!props.every((p) => req.has(p))) return false;
      if (n.additionalProperties !== false) return false;
    }
    return Object.values(n).every(walk);
  };
  return walk(schema);
}

/** String constraints that strict provider-side decoding enforces by cutting text mid-word (ERROR_LOG.md, M4). */
const PROVIDER_STRIPPED_KEYS = new Set(["maxLength", "minLength", "pattern"]);

function stripStringConstraints(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripStringConstraints);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node as Record<string, unknown>).filter(([k]) => !PROVIDER_STRIPPED_KEYS.has(k)).map(([k, v]) => [k, stripStringConstraints(v)]));
}

/**
 * The JSON schema sent to the provider. Length and pattern limits are removed: strict structured
 * decoding enforced them by truncating strings (41% of live whispers cut at 280 chars; an empty-reply
 * pattern produced "I"). They stay in the zod schema, so a violating output fails validation and gets
 * one retry quoting the error instead of being silently cut.
 */
export function jsonSchemaFor(schema: z.ZodType): JsonSchema {
  const js = stripStringConstraints(z.toJSONSchema(schema)) as JsonSchema;
  delete js.$schema;
  return js;
}

/** Removes a ```json ... ``` fence if a model wrapped its JSON in one. */
function stripFences(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : text.trim();
}

interface ChatClientOpts {
  url: string;
  headers: Record<string, string>;
  models: Record<Tier, string>;
  modelLabel: (served: string) => string;
  extraBody: Record<string, unknown>;
  useJsonSchema: boolean;
  meter: CostMeter;
  ledger: Ledger;
  render: PromptRenderer;
  calibrated: boolean;
  fetch?: FetchLike;
  sleep?: Sleep;
}

type ChatResponse = {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { cost?: number };
};

class ChatCompletionsLLM implements LLM {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;

  constructor(private readonly o: ChatClientOpts) {
    this.fetchImpl = o.fetch ?? ((u, i) => fetch(u, i));
    this.sleep = o.sleep ?? realSleep;
  }

  async generate<T>(promptId: string, vars: Record<string, unknown>, schema: z.ZodType<T>, opts: GenerateOpts) {
    const model = this.o.models[opts.tier];
    const { system, user } = this.o.render(promptId, vars);
    const messages: { role: string; content: string }[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const js = jsonSchemaFor(schema);
    const responseFormat = this.o.useJsonSchema
      ? { type: "json_schema", json_schema: { name: promptId, strict: isStrictCompatible(js), schema: js } }
      : { type: "json_object" };

    let totalCost = 0;
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      const res = await postJsonWithRetry(this.fetchImpl, this.sleep, this.o.url, this.o.headers, {
        model,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        response_format: responseFormat,
        ...this.o.extraBody,
      });
      if (isAuthStatus(res.status)) throw new ProviderAuthError(res.status, await errorDetail(res));
      if (!res.ok) throw new GenerationError(`${promptId}: HTTP ${res.status}: ${await errorDetail(res)}`);
      const body = (await res.json()) as ChatResponse;
      const latencyMs = Date.now() - t0;
      const cost = body.usage?.cost ?? 0;
      const served = this.o.modelLabel(body.model ?? model);
      totalCost += cost;
      this.o.meter.add(served, cost);
      const content = body.choices?.[0]?.message?.content ?? "";

      let candidate: unknown;
      let jsonOk = true;
      try {
        candidate = JSON.parse(stripFences(content));
      } catch (e) {
        jsonOk = false;
        lastError = `not valid JSON: ${(e as Error).message}`;
      }
      if (jsonOk) {
        const parsed = schema.safeParse(candidate);
        if (parsed.success) {
          await this.o.ledger.record({
            kind: `llm.${promptId}`,
            cycleId: opts.cycleId,
            model: served,
            calibrated: this.o.calibrated,
            costUsd: cost,
            latencyMs,
            payload: { purpose: opts.purpose, tier: opts.tier, attempt, vars: summarizeInput(vars), output: summarizeInput(content).preview },
          });
          return { data: parsed.data, model: served, costUsd: totalCost };
        }
        lastError = parsed.error.message;
      }
      await this.o.ledger.record({
        kind: `llm.${promptId}.invalid`,
        cycleId: opts.cycleId,
        model: served,
        calibrated: this.o.calibrated,
        costUsd: cost,
        latencyMs,
        payload: { purpose: opts.purpose, tier: opts.tier, attempt, error: lastError.slice(0, 300), output: content.slice(0, 200) },
      });
      messages.push(
        { role: "assistant", content },
        { role: "user", content: `Your previous output failed validation: ${lastError.slice(0, 500)}\nReturn only corrected JSON matching the schema.` },
      );
    }
    throw new GenerationError(`${promptId}: output failed schema validation twice: ${lastError.slice(0, 300)}`);
  }
}

export interface OpenRouterLLMOpts {
  apiKey: string;
  models: Record<Tier, string>;
  meter: CostMeter;
  ledger: Ledger;
  render: PromptRenderer;
  fetch?: FetchLike;
  sleep?: Sleep;
  url?: string;
}

/** Tiered OpenRouter chat client (LLM_PROMPTS.md §1). Model per tier from TIER_*_MODEL. */
export class OpenRouterLLM extends ChatCompletionsLLM {
  constructor(o: OpenRouterLLMOpts) {
    super({
      url: o.url ?? OPENROUTER_CHAT_URL,
      headers: { Authorization: `Bearer ${o.apiKey}`, "X-Title": "hive-mentor-sim" },
      models: o.models,
      modelLabel: (m) => m,
      extraBody: { reasoning: { enabled: false }, provider: { sort: "latency", require_parameters: true } },
      useJsonSchema: true,
      meter: o.meter,
      ledger: o.ledger,
      render: o.render,
      calibrated: true,
      fetch: o.fetch,
      sleep: o.sleep,
    });
  }
}

export interface LocalLLMOpts {
  baseUrl: string;
  model: string;
  meter: CostMeter;
  ledger: Ledger;
  render: PromptRenderer;
  fetch?: FetchLike;
  sleep?: Sleep;
}

/** PROVIDER_MODE=local: one local OpenAI-compatible model for every tier; labeled local:<name>. */
export class LocalLLM extends ChatCompletionsLLM {
  constructor(o: LocalLLMOpts) {
    super({
      url: `${o.baseUrl.replace(/\/$/, "")}/chat/completions`,
      headers: {},
      models: { fast: o.model, standard: o.model, premium: o.model },
      modelLabel: (m) => `local:${m}`,
      extraBody: {},
      useJsonSchema: false,
      meter: o.meter,
      ledger: o.ledger,
      render: o.render,
      calibrated: false,
      fetch: o.fetch,
      sleep: o.sleep,
    });
  }
}
