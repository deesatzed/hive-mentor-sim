/**
 * pnpm eval:regrade [--report <scenarios-live-….json>]
 *
 * Re-grades the stored replies of a live eval report with the current live grader (scripts/eval/rubric.ts)
 * and measures agreement with the owner's grades (owner decision 2026-11-07, decision 1 A). Half of the
 * owner-graded cards are shown to the grader as examples; agreement is reported on the other half only,
 * which the grader never saw graded. Live: costs money (measured and printed). Writes local/grades/regrade-*.json.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getProviders } from "@/lib/council/providers";
import { hiveConfig } from "@/lib/hive/config";
import { GRADER_VERSION, gradeQuestions, gradeState, LEVEL_NAMES, ownerExamples, splitHalf } from "./rubric";
import { liveView, ScenarioSchema, type Scenario } from "./types";

try {
  process.loadEnvFile(".env");
} catch {
  /* env may come from the shell */
}

const flag = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const reportsDir = path.join(process.cwd(), "reports", "eval");
const gradesDir = process.env.HIVE_GRADES_DIR ?? path.join(process.cwd(), "local", "grades");
const level = (x: number) => Math.max(0, Math.min(2, Math.round(x)));

async function main() {
  const cfg = hiveConfig();
  const report =
    flag("--report") ??
    readdirSync(reportsDir)
      .filter((f) => /^scenarios-live-.*\.json$/.test(f) && !f.includes("subset") && !f.includes("candidate"))
      .sort()
      .at(-1);
  if (!report) throw new Error("no live eval report");
  const rows = (JSON.parse(readFileSync(path.join(reportsDir, report), "utf8")) as { results: { id: string; skipped: boolean; outputs: string[]; rubric: { scores: Record<string, number> } | null }[] }).results;
  const owner = JSON.parse(readFileSync(path.join(gradesDir, report.replace(/\.json$/, ".grades.json")), "utf8")) as { cards: Record<string, { grades: Record<string, number> }> };
  const dir = path.join(process.cwd(), cfg.eval.scenarios_dir);
  const scenarios = new Map<string, Scenario>(
    readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => liveView(ScenarioSchema.parse(YAML.parse(readFileSync(path.join(dir, f), "utf8")))))
      .map((s) => [s.id, s]),
  );
  const { examples: exampleIds, holdout } = splitHalf(Object.keys(owner.cards));
  const examples = ownerExamples(scenarios, (id) => exampleIds.has(id));
  const p = getProviders(process.env, { models: cfg.models });

  let cost = 0;
  const judged: { card: string; quality: string; set: "holdout" | "example"; owner: number; v1: number; v2: number; v2Score: number }[] = [];
  for (const r of rows) {
    const s = scenarios.get(r.id);
    const own = owner.cards[r.id]?.grades;
    if (!s || r.skipped || !r.rubric || !own) continue;
    // an example card is never graded with its own grade in view
    const shown = examples.filter((e) => e.scenario !== s.title);
    const d = await p.decider.decide(gradeState(s, r.outputs, shown), gradeQuestions(s), { purpose: "eval_regrade" });
    cost += d.costUsd;
    for (const [q, o] of Object.entries(own)) {
      if (r.rubric.scores[q] === undefined) continue;
      const v2Score = d.score(`r_${q}`);
      judged.push({ card: r.id, quality: q, set: holdout.has(r.id) ? "holdout" : "example", owner: o, v1: level(r.rubric.scores[q]), v2: level(v2Score), v2Score: Math.round(v2Score * 100) / 100 });
    }
    process.stdout.write(".");
  }
  console.log();

  const summarize = (set: "holdout" | "example") => {
    const xs = judged.filter((j) => j.set === set);
    const byQuality: Record<string, { n: number; v1: number; v2: number }> = {};
    for (const j of xs) {
      const b = (byQuality[j.quality] ??= { n: 0, v1: 0, v2: 0 });
      b.n++;
      if (j.v1 === j.owner) b.v1++;
      if (j.v2 === j.owner) b.v2++;
    }
    return {
      judgments: xs.length,
      v1Match: xs.filter((j) => j.v1 === j.owner).length,
      v2Match: xs.filter((j) => j.v2 === j.owner).length,
      v2Higher: xs.filter((j) => j.v2 > j.owner).length,
      v2Lower: xs.filter((j) => j.v2 < j.owner).length,
      byQuality,
    };
  };
  const out = { report, grader: GRADER_VERSION, model: cfg.models.grader, at: new Date().toISOString(), costUsd: cost, holdout: summarize("holdout"), examples: summarize("example"), judged, levels: LEVEL_NAMES };
  mkdirSync(gradesDir, { recursive: true });
  const file = path.join(gradesDir, `regrade-${report.replace(/\.json$/, "")}-${out.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  const pct = (a: number, n: number) => (n ? `${a}/${n} (${((a / n) * 100).toFixed(1)}%)` : "-");
  console.log(`held-out (grader never saw these graded): v1 ${pct(out.holdout.v1Match, out.holdout.judgments)} · v2 ${pct(out.holdout.v2Match, out.holdout.judgments)} · v2 higher ${out.holdout.v2Higher}, lower ${out.holdout.v2Lower}`);
  for (const [q, b] of Object.entries(out.holdout.byQuality)) console.log(`  ${q}: v1 ${b.v1}/${b.n} · v2 ${b.v2}/${b.n}`);
  console.log(`example half (shown to the grader, not a fair test): v1 ${pct(out.examples.v1Match, out.examples.judgments)} · v2 ${pct(out.examples.v2Match, out.examples.judgments)}`);
  console.log(`measured cost: $${cost.toFixed(6)} · ${file}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
