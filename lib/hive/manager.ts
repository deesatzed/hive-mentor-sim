import "server-only";
import { z } from "zod";
import type { LLM } from "@/lib/council/providers/llm";
import { GenerationError } from "@/lib/council/providers/llm";
import { allowedNext, defaultNext, type NextStep, type PhaseId } from "./phases";
import { promptSettings } from "./prompts";

/**
 * The central manager (owner decision 2026-11-04): in `orchestration.mode: manager` the manager
 * model picks the next phase. Code computes which phases are allowed (phases.ts) and validates the
 * choice; an invalid choice or a failed call falls back to the code default and is recorded.
 * In `code` mode the default order is used and no model is called.
 */

export interface StepChoice {
  next: NextStep;
  by: "manager" | "code" | "fallback";
  allowed: NextStep[];
  reason: string;
}

export async function chooseNext(args: {
  mode: "manager" | "code";
  llm: LLM;
  ran: ReadonlySet<PhaseId>;
  input: string;
  cycleMode: string;
  progress: string;
  cycleId: string;
}): Promise<StepChoice> {
  const allowed = allowedNext(args.ran);
  const dflt = defaultNext(args.ran);
  if (args.mode === "code") return { next: dflt, by: "code", allowed, reason: "code default order" };
  if (allowed.length === 1) return { next: allowed[0], by: "code", allowed, reason: "only one allowed step" };

  const schema = z.object({ next: z.enum(allowed as [NextStep, ...NextStep[]]), reason: z.string().max(240) });
  try {
    const s = promptSettings("MANAGER_NEXT_PHASE");
    const r = await args.llm.generate(
      "MANAGER_NEXT_PHASE",
      { input: args.input, mode: args.cycleMode, progress: args.progress, allowed, defaultNext: dflt },
      schema,
      { ...s, purpose: "manager", cycleId: args.cycleId },
    );
    return { next: r.data.next, by: "manager", allowed, reason: r.data.reason };
  } catch (e) {
    if (!(e instanceof GenerationError)) throw e;
    return { next: dflt, by: "fallback", allowed, reason: `manager output unusable (${e.message.slice(0, 160)}); code default used` };
  }
}
