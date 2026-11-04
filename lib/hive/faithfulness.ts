import "server-only";
import type { Decider } from "@/lib/council/providers/decisions";
import { tryDecideBatched } from "./decide";
import { FAITHFUL, T } from "./questions";

/**
 * TIRELESS faithfulness pass (sent2 v1.2 §3.9; docs/ARCHITECTURE.md P6): every composed sentence
 * must trace to approved claims and guidance (decision FAITHFUL). The orchestrator regenerates once
 * with the failing sentences named; sentences still unfaithful are dropped.
 */

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface FaithfulnessCheck {
  sentences: { sentence: string; p: number | null; faithful: boolean }[];
  unavailable: boolean;
}

export async function checkFaithfulness(
  decider: Decider,
  args: { cycleId: string; approved: Record<string, string>; guidance: string; text: string },
): Promise<FaithfulnessCheck> {
  const sentences = splitSentences(args.text);
  if (sentences.length === 0) return { sentences: [], unavailable: false };
  const ns = sentences.map((_, i) => i + 1);
  const res = await tryDecideBatched(
    decider,
    { approved: args.approved, guidance: args.guidance, sentences: Object.fromEntries(sentences.map((s, i) => [`f_${i + 1}`, s])) },
    FAITHFUL(ns),
    "faithful",
    args.cycleId,
  );
  let unavailable = false;
  const out = sentences.map((sentence, i) => {
    const r = res.get(`f_${i + 1}`);
    if (!r) {
      unavailable = true;
      return { sentence, p: null, faithful: true }; // fallback: keep, mark unavailable
    }
    const p = r.p(`f_${i + 1}`);
    return { sentence, p, faithful: p >= T.FAITHFUL };
  });
  return { sentences: out, unavailable };
}
