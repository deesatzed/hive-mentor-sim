import "server-only";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { hiveConfig } from "./config";
import { liveView, ScenarioSchema, type Scenario } from "@/scripts/eval/types";

/**
 * Owner grading (owner decision 2026-11-06, decision 7). The owner grades real live replies from the latest
 * full live eval report on the same rubric qualities the AI grader used; the owner's grades are the reference
 * the AI grader is measured against (target ≥ 80 % agreement per quality). The AI's score for a card is
 * revealed only after the owner locks in that card, so it cannot sway the grade. Grades stay on this machine
 * in local/grades/ (git-ignored).
 */

export const LEVELS = ["no", "partly", "yes"] as const;
export type Level = 0 | 1 | 2;

export interface GradeCard {
  id: string;
  title: string;
  category: string;
  turns: string[];
  replies: string[];
  qualities: { name: string; guidance: string }[];
}

interface ReportResult {
  id: string;
  category: string;
  skipped: boolean;
  outputs: string[];
  rubric: { scores: Record<string, number> } | null;
}

export interface OwnerGrades {
  report: string;
  cards: Record<string, { grades: Record<string, Level>; at: string }>;
}

const reportsDir = () => path.join(process.cwd(), "reports", "eval");
/** HIVE_GRADES_DIR lets the browser tests write to a throwaway folder, never the owner's grades */
const gradesDir = () => process.env.HIVE_GRADES_DIR ?? path.join(process.cwd(), "local", "grades");

/** Newest full (not subset) live eval report, by file name. */
export function latestLiveReport(): string | null {
  if (!existsSync(reportsDir())) return null;
  const files = readdirSync(reportsDir())
    // subset runs and head-to-head candidate runs (--tag candidate-…) are not the default grading set
    .filter((f) => /^scenarios-live-.*\.json$/.test(f) && !f.includes("subset") && !f.includes("candidate"))
    .sort();
  return files.at(-1) ?? null;
}

function scenarios(): Map<string, Scenario> {
  const dir = path.join(process.cwd(), hiveConfig().eval.scenarios_dir);
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => ScenarioSchema.parse(YAML.parse(readFileSync(path.join(dir, f), "utf8"))))
      .map((s) => [s.id, liveView(s)]),
  );
}

function loadReport(name: string): ReportResult[] {
  if (!/^scenarios-live-[\w.-]+\.json$/.test(name)) throw new Error("not a live eval report name");
  return (JSON.parse(readFileSync(path.join(reportsDir(), name), "utf8")) as { results: ReportResult[] }).results;
}

/** The cards to grade: every graded live reply with at least one rubric quality. */
export function gradingCards(report: string): GradeCard[] {
  const sc = scenarios();
  return loadReport(report)
    .filter((r) => !r.skipped && r.rubric && Object.keys(r.rubric.scores).length > 0 && sc.has(r.id))
    .map((r) => {
      const s = sc.get(r.id)!;
      return {
        id: r.id,
        title: s.title,
        category: s.category,
        turns: s.turns.map((t) => t.user),
        replies: r.outputs,
        qualities: Object.keys(r.rubric!.scores).map((name) => ({ name, guidance: s.expect.witness_rubric[name]?.guidance ?? "" })),
      };
    });
}

/** The AI grader's level per quality for one card (expected index 0–2 rounded to the nearest level). */
export function aiLevels(report: string, cardId: string): Record<string, { score: number; level: Level }> {
  const r = loadReport(report).find((x) => x.id === cardId);
  if (!r?.rubric) return {};
  return Object.fromEntries(Object.entries(r.rubric.scores).map(([q, s]) => [q, { score: s, level: Math.max(0, Math.min(2, Math.round(s))) as Level }]));
}

const gradesFile = (report: string) => path.join(gradesDir(), report.replace(/\.json$/, ".grades.json"));

export function loadOwnerGrades(report: string): OwnerGrades {
  const f = gradesFile(report);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as OwnerGrades) : { report, cards: {} };
}

export function saveOwnerGrade(report: string, cardId: string, grades: Record<string, Level>): OwnerGrades {
  const card = gradingCards(report).find((c) => c.id === cardId);
  if (!card) throw new Error(`no card ${cardId} in ${report}`);
  for (const q of card.qualities) if (!(q.name in grades)) throw new Error(`grade every quality: missing ${q.name}`);
  for (const [q, v] of Object.entries(grades)) {
    if (!card.qualities.some((x) => x.name === q)) throw new Error(`unknown quality ${q}`);
    if (![0, 1, 2].includes(v)) throw new Error(`grade must be 0, 1 or 2`);
  }
  const all = loadOwnerGrades(report);
  all.cards[cardId] = { grades, at: new Date().toISOString() };
  mkdirSync(gradesDir(), { recursive: true });
  writeFileSync(gradesFile(report), JSON.stringify(all, null, 2) + "\n");
  return all;
}

/** Agreement of the AI grader with the owner, per quality and overall (exact level match), over graded cards. */
export function agreement(report: string) {
  const own = loadOwnerGrades(report);
  const byQuality: Record<string, { n: number; match: number }> = {};
  let n = 0;
  let match = 0;
  let offByOne = 0;
  for (const [cardId, { grades }] of Object.entries(own.cards)) {
    const ai = aiLevels(report, cardId);
    for (const [q, level] of Object.entries(grades)) {
      if (!ai[q]) continue;
      const b = (byQuality[q] ??= { n: 0, match: 0 });
      b.n++;
      n++;
      if (ai[q].level === level) {
        b.match++;
        match++;
      } else if (Math.abs(ai[q].level - level) === 1) offByOne++;
    }
  }
  return { graded: Object.keys(own.cards).length, judgments: n, match, offByOne, rate: n ? match / n : null, byQuality, target: 0.8 };
}
