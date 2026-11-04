import "server-only";
import type { z } from "zod";

/**
 * Text-generation interface (docs/ARCHITECTURE.md). LLM output never supplies a
 * number that drives control flow; numbers come from DecisionResult.
 *
 * M0: interface only. OpenRouterLLM (tiered) and LocalLLM arrive in M1.
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
