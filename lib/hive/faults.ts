import "server-only";

/**
 * TEST FAULTS for live eval only (owner decision 2026-11-06, decision 6; owner-approved synthetic data,
 * on the removal list). A live model rarely makes these mistakes on cue, so the eval harness plants one
 * into the real live cycle just before the checker runs, to show the checker catches it. Every planted
 * fault is labeled in the trace (`plantedFaults`) and ledgered (`eval.fault_planted`).
 *
 * Allowed only when HIVE_EVAL_FAULTS=1, which only `pnpm eval:live` sets. The app never plants anything.
 */
export interface EvalFaults {
  /** inserted after the first sentence of every composed draft (first and regenerated) */
  unfaithfulSentence?: string;
  /** replaces a Core Voice's whisper claim when the operator input matches `when` (case-insensitive regex) */
  whisperClaims?: { voice: string; when: string; claim: string }[];
}

export class FaultsNotAllowedError extends Error {
  constructor() {
    super("test faults are allowed only in live eval (HIVE_EVAL_FAULTS=1)");
    this.name = "FaultsNotAllowedError";
  }
}

export function assertFaultsAllowed(faults: EvalFaults | undefined): void {
  if (faults && (faults.unfaithfulSentence || faults.whisperClaims?.length) && process.env.HIVE_EVAL_FAULTS !== "1") throw new FaultsNotAllowedError();
}

export const FAULT_LABEL = "TEST FAULT (planted by the eval harness, not model output)";

/** Inserts the sentence after the draft's first sentence (or at the end of a one-sentence draft). */
export function plantSentence(text: string, sentence: string): string {
  const m = text.match(/^(.+?[.!?])(\s+)([\s\S]*)$/);
  return m ? `${m[1]} ${sentence}${m[2]}${m[3]}` : `${text.trim()} ${sentence}`;
}

export function plantedClaim(faults: EvalFaults | undefined, voice: string, input: string): string | null {
  const hit = faults?.whisperClaims?.find((f) => f.voice === voice && new RegExp(f.when, "i").test(input));
  return hit ? hit.claim : null;
}
