import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Question } from "@/lib/council/providers/decisions";
import type { LLM } from "@/lib/council/providers/llm";
import { Schemas } from "@/lib/hive/prompts";
import { score } from "@/lib/hive/questions";
import type { Scenario } from "./types";

/**
 * Live rubric grader, version 2 (owner decision 2026-11-07, decision 1 A). The owner graded 32 live replies;
 * grader v1 matched 21 of 44 judgments and was lenient (17 of 23 misses scored higher than the owner).
 * v2 spells out what separates "partly" from "yes", tells the grader to choose "partly" when in doubt, and
 * shows it the owner's own graded replies as examples. The grader sees what the owner saw: the operator's
 * turns and the Hive's replies, nothing internal.
 *
 * Examples come from the owner's grades in local/grades/ (git-ignored). When none exist, the grader runs
 * without examples.
 */
export const GRADER_VERSION = "v2 (strict levels + owner examples)";
export const LEVEL_NAMES = ["no", "partly", "yes"] as const;
const EXCERPT = 1500;

export interface GradeExample {
  scenario: string;
  quality: string;
  operator: string[];
  replies: string[];
  ownerGrade: (typeof LEVEL_NAMES)[number];
}

export function gradeQuestions(s: Scenario): Record<string, Question> {
  return Object.fromEntries(
    Object.entries(s.expect.witness_rubric).map(([d, meta]) => [
      `r_${d}`,
      score(
        `Grade the Hive's replies on "${d}"${meta.guidance ? ` (${meta.guidance})` : ""}. Scenario: ${s.title}. ` +
          `Be strict, like the owner in grading_examples: "yes" only when a demanding reviewer would change nothing about the replies for "${d}". ` +
          `If "${d}" is met only generically, partly, late, or with something missing or overdone, the answer is "partly". When torn between "partly" and "yes", choose "partly".`,
        [
          `no: the replies miss "${d}" or work against it`,
          `partly: "${d}" is there in part: generic, incomplete, buried, or overdone`,
          `yes: "${d}" is fully met; nothing to add or remove for it`,
        ],
      ),
    ]),
  );
}

/** What the grader is shown for one scenario: the operator's turns and the Hive's replies. */
export function gradeState(s: Scenario, replies: string[], examples: GradeExample[]) {
  return {
    scenario: s.title,
    turns: s.turns.map((t, i) => ({ operator: t.user, reply: replies[i] ?? "" })),
    ...(examples.length ? { grading_examples: examples.map((e) => ({ ...e, replies: e.replies.map((r) => (r.length > EXCERPT ? `${r.slice(0, EXCERPT)}…` : r)) })) } : {}),
  };
}

interface ReportRow {
  id: string;
  skipped: boolean;
  outputs: string[];
}

const reportsDir = () => path.join(process.cwd(), "reports", "eval");
const gradesDir = () => process.env.HIVE_GRADES_DIR ?? path.join(process.cwd(), "local", "grades");

/** Owner-graded examples from every report that has owner grades, one per graded quality. */
export function ownerExamples(scenarios: Map<string, Scenario>, keep: (cardId: string) => boolean = () => true): GradeExample[] {
  const dir = gradesDir();
  if (!existsSync(dir)) return [];
  const out: GradeExample[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".grades.json"))) {
    const g = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { report: string; cards: Record<string, { grades: Record<string, number> }> };
    const reportFile = path.join(reportsDir(), g.report);
    if (!existsSync(reportFile)) continue;
    const rows = (JSON.parse(readFileSync(reportFile, "utf8")) as { results: ReportRow[] }).results;
    for (const [cardId, { grades }] of Object.entries(g.cards)) {
      const s = scenarios.get(cardId);
      const row = rows.find((r) => r.id === cardId && !r.skipped);
      if (!s || !row || !keep(cardId)) continue;
      for (const [quality, level] of Object.entries(grades))
        out.push({ scenario: s.title, quality, operator: s.turns.map((t) => t.user), replies: row.outputs, ownerGrade: LEVEL_NAMES[level] });
    }
  }
  return out;
}

/** Deterministic half split of card ids (by hash), so examples and the held-out check never share a reply. */
export function splitHalf(ids: string[]): { examples: Set<string>; holdout: Set<string> } {
  const sorted = [...ids].sort((a, b) => createHash("sha256").update(a).digest("hex").localeCompare(createHash("sha256").update(b).digest("hex")));
  return { examples: new Set(sorted.filter((_, i) => i % 2 === 0)), holdout: new Set(sorted.filter((_, i) => i % 2 === 1)) };
}

/**
 * Grader v3 (owner decision 2026-11-07, after v2 could not separate "partly" from "yes"): the reviewer model
 * reads the conversation, writes a reason per quality, then grades it no / partly / yes, with the owner's
 * graded examples in view. Returns levels 0–2 per quality; a quality the model leaves out is missing.
 */
export const TEXT_GRADER_VERSION = "v3 (reviewer model reads and grades, owner examples)";

export async function textGrade(grader: LLM, s: Scenario, replies: string[], examples: GradeExample[], purpose = "eval_grade") {
  const qualities = Object.fromEntries(Object.entries(s.expect.witness_rubric).map(([d, meta]) => [d, meta.guidance ?? ""]));
  const st = gradeState(s, replies, examples);
  const g = await grader.generate(
    "EVAL_GRADE",
    {
      scenario: s.title,
      qualities,
      turns: st.turns,
      examples: "grading_examples" in st && st.grading_examples ? st.grading_examples.map((e) => ({ quality: e.quality, operator: e.operator, replies: e.replies, ownerGrade: e.ownerGrade })) : undefined,
    },
    Schemas.EVAL_GRADE,
    { tier: "standard", temperature: 0, purpose },
  );
  const levels: Record<string, number> = {};
  const reasons: Record<string, string> = {};
  for (const x of g.data.grades) {
    if (!(x.quality in qualities)) continue;
    levels[x.quality] = LEVEL_NAMES.indexOf(x.grade);
    reasons[x.quality] = x.reason;
  }
  return { levels, reasons, costUsd: g.costUsd, model: g.model };
}
