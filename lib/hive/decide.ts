import "server-only";
import type { Decider, DecisionResult, Question } from "@/lib/council/providers/decisions";
import { DecisionUnavailableError } from "@/lib/council/providers/decisions";
import { batchQuestions } from "./questions";

/**
 * Decision calls with the documented fallbacks: when every decision model fails
 * (DecisionUnavailableError) the caller gets null and applies its fallback, marking the number
 * unavailable. Any other error (auth, network after retries, bugs) propagates and stops the cycle.
 */
export async function tryDecide(
  decider: Decider,
  state: unknown,
  qs: Record<string, Question>,
  purpose: string,
  cycleId: string,
): Promise<DecisionResult | null> {
  try {
    return await decider.decide(state, qs, { purpose, cycleId });
  } catch (e) {
    if (e instanceof DecisionUnavailableError) return null;
    throw e;
  }
}

/** Batches a large question map into ≤ MAX_Q_PER_REQUEST requests; returns per-question results (null = unavailable). */
export async function tryDecideBatched(
  decider: Decider,
  state: unknown,
  qs: Record<string, Question>,
  purpose: string,
  cycleId: string,
): Promise<Map<string, DecisionResult | null>> {
  const out = new Map<string, DecisionResult | null>();
  for (const batch of batchQuestions(qs)) {
    const r = await tryDecide(decider, state, batch, purpose, cycleId);
    for (const name of Object.keys(batch)) out.set(name, r);
  }
  return out;
}
