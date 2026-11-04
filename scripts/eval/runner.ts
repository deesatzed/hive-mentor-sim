/**
 * Eval runner (port of reference/sent2.md §4.2). Each scenario runs in a fresh database cloned from a
 * migrated + seeded template, so scenarios never share memory. Mock mode: mock providers with the
 * scenario's mock_variant, heuristic grader, golden comparison. Live mode: real providers, rubric
 * scores from the decision layer, rationale from the grader model; goldens are not compared.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { disconnectAll, getDb } from "@/lib/council/db";
import { cloneDb, ensureDb } from "@/lib/council/dbSetup";
import { getProviders, type Env } from "@/lib/council/providers";
import { createHive, mentorNames } from "@/lib/hive";
import { hiveConfig, type HiveConfig } from "@/lib/hive/config";
import { score } from "@/lib/hive/questions";
import { Schemas } from "@/lib/hive/prompts";
import { checkInvariants, heuristicGrade, rubricScore, type TurnRecord } from "./grader";
import { ScenarioSchema, type GradeResult, type RubricResult, type Scenario } from "./types";

const TEMPLATE = "file:./eval-template.db";
const RUN = "file:./eval-run.db";

export function loadScenarios(cfg: HiveConfig = hiveConfig()): Scenario[] {
  const dir = path.join(process.cwd(), cfg.eval.scenarios_dir);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => ScenarioSchema.parse(YAML.parse(readFileSync(path.join(dir, f), "utf8"))));
}

const mNum = (m: string) => Number(m.slice(1));

export interface RunOpts {
  live: boolean;
  updateGoldens: boolean;
  only?: string[];
  cfg?: HiveConfig;
  env?: Env;
}

export async function runAll(opts: RunOpts): Promise<GradeResult[]> {
  const cfg = opts.cfg ?? hiveConfig();
  const env: Env = { ...(opts.env ?? process.env), USE_MOCK_PROVIDERS: opts.live ? "false" : "true" };
  const goldDir = path.join(process.cwd(), cfg.eval.goldens_dir);
  const names = mentorNames();
  await ensureDb(TEMPLATE, { fresh: true });
  const results: GradeResult[] = [];

  for (const s of loadScenarios(cfg)) {
    if (opts.only && !opts.only.includes(s.id)) continue;
    if (mNum(s.milestone) > mNum(cfg.eval.current_milestone)) continue; // later milestone: not part of this run
    const base = { id: s.id, category: s.category, milestone: s.milestone, invariants: [], rubric: null, rubricScore: null, goldenMatch: null, outputs: [], status: [] };
    const unmet = Object.entries(s.requires_config ?? {}).find(([k, v]) => (k === "honesty_clause" ? cfg.honesty_clause.enabled : cfg.edict_module.enabled) !== v);
    if (unmet) {
      results.push({ ...base, skipped: true, skipReason: `requires ${unmet[0]}=${unmet[1]}`, passed: false });
      continue;
    }
    if (s.fixture_formation) {
      results.push({ ...base, skipped: true, skipReason: `fixture_formation '${s.fixture_formation}' needs the corpus (M6)`, passed: false });
      continue;
    }

    await cloneDb(TEMPLATE, RUN);
    const db = getDb(RUN);
    const hive = createHive({ env, db, cfg, providerDeps: { mockContext: { variant: s.mock_variant } } });
    const sessionId = await hive.createSession("chat", `eval:${s.id}`);
    const turns: TurnRecord[] = [];
    for (const turn of s.turns) {
      const r = await hive.runCycle({ sessionId, input: turn.user });
      const run = await db.conclaveRun.findUnique({ where: { cycleId: r.cycleId } });
      const ledger = await db.ledgerEvent.findMany({ where: { cycleId: r.cycleId }, select: { kind: true } });
      turns.push({
        cycleId: r.cycleId,
        status: r.status,
        output: r.output,
        trace: r.trace,
        transcript: await hive.transcript(r.cycleId),
        conclave: run
          ? {
              options: JSON.parse(run.options),
              ballots: JSON.parse(run.ballots),
              winner: run.winner,
              dissent: JSON.parse(run.dissent),
              guildsInWinningCoalition: JSON.parse(run.guildsInWinningCoalition),
              decision: run.decision,
            }
          : null,
        ledgerKinds: ledger.map((l) => l.kind),
        advisorIds: ["OMEGA", "AKASHA", "PRISM", "CHORUS", "EQUANIMITY", "CLARION", "ETERNAL", "ENTANGLE", "JUSTITIA", "TIRELESS", "PROTEUS", "PHOENIX", "NOOSPHERE", "DEMIURGE", "FORMLESS", "REVERENCE"],
      });
    }

    const invariants = checkInvariants(s, turns, names);
    const rubric = opts.live ? await liveGrade(s, turns, env, cfg) : heuristicGrade(s, turns);
    const rs = rubricScore(s, rubric);
    const outputs = turns.map((t) => t.output);
    let goldenMatch: boolean | null = null;
    const goldenPath = path.join(goldDir, `${s.id}.json`);
    if (!opts.live && opts.updateGoldens) {
      mkdirSync(goldDir, { recursive: true });
      writeFileSync(goldenPath, JSON.stringify({ _note: "mock-mode golden; blessed after hand inspection (PROGRESS.md)", outputs }, null, 2) + "\n");
    } else if (!opts.live && existsSync(goldenPath)) {
      goldenMatch = JSON.stringify((JSON.parse(readFileSync(goldenPath, "utf8")) as { outputs: string[] }).outputs) === JSON.stringify(outputs);
    }
    results.push({
      ...base,
      skipped: false,
      invariants,
      rubric,
      rubricScore: rs,
      goldenMatch,
      outputs,
      status: turns.map((t) => t.status),
      passed: invariants.every((i) => i.ok) && rs >= s.expect.pass_threshold && goldenMatch !== false,
    });
  }
  await disconnectAll();
  return results;
}

/** Live rubric: one decision request with a score question per dimension; the grader model writes the rationale. */
async function liveGrade(s: Scenario, turns: TurnRecord[], env: Env, cfg: HiveConfig): Promise<RubricResult> {
  const dims = Object.entries(s.expect.witness_rubric);
  const p = getProviders(env, { models: cfg.models });
  const transcript = turns.map((t, i) => ({ operator: s.turns[i]?.user ?? "", awareness: t.trace.awareness.text, verdict: t.trace.arbiter.decision, reply: t.output }));
  const qs = Object.fromEntries(
    dims.map(([d, meta]) => [`r_${d}`, score(`Grade the Hive's final reply on "${d}"${meta.guidance ? ` (${meta.guidance})` : ""}. Scenario: ${s.title}.`, ["no", "partly", "yes"])]),
  );
  const r = await p.decider.decide({ scenario: s.title, turns: transcript }, qs, { purpose: "eval_grade", cycleId: turns.at(-1)!.cycleId });
  const scores = Object.fromEntries(dims.map(([d]) => [d, Math.round(r.score(`r_${d}`) * 100) / 100]));
  let rationale = "";
  let blindSpot = "";
  try {
    const g = await p.grader.generate("EVAL_RATIONALE", { title: s.title, scores, transcript }, Schemas.EVAL_RATIONALE, { tier: "standard", temperature: 0.2, purpose: "eval_rationale" });
    rationale = g.data.rationale;
    blindSpot = g.data.blindSpot;
  } catch {
    rationale = "(rationale generation failed)";
  }
  return { scores, justifications: Object.fromEntries(dims.map(([d]) => [d, rationale])), blindSpot, grader: "decision layer + reviewer rationale (live)" };
}
