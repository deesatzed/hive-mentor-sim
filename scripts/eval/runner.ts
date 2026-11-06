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

/**
 * Named formation fixtures for scenarios (EVAL FIXTURES, written straight to the eval database; they
 * bypass saveFormation's active-mentor check because the eval database has no corpus).
 */
const FORMATION_FIXTURES: Record<string, (db: ReturnType<typeof getDb>) => Promise<void>> = {
  no_voice_has_thoreau: async (db) => {
    const map = JSON.parse(readFileSync(path.join(process.cwd(), "seed", "voice_mentor_map.json"), "utf8")) as { assignments: { voice: string; mentors: string[] }[] };
    const voices = new Map((await db.voice.findMany({ where: { class: "core" } })).map((v) => [v.name, v.id]));
    const last = await db.formation.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    await db.formation.create({
      data: {
        version: (last?.version ?? 0) + 1,
        status: "approved",
        note: "eval fixture: no_voice_has_thoreau",
        members: { create: map.assignments.flatMap((a) => a.mentors.filter((m) => m !== "henry-david-thoreau").map((mentorId) => ({ voiceId: voices.get(a.voice)!, mentorId, kind: "declared" }))) },
      },
    });
  },
};

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
    if (s.fixture_formation && !FORMATION_FIXTURES[s.fixture_formation]) {
      results.push({ ...base, skipped: true, skipReason: `unknown fixture_formation '${s.fixture_formation}'`, passed: false });
      continue;
    }

    await cloneDb(TEMPLATE, RUN);
    const db = getDb(RUN);
    if (s.fixture_formation) await FORMATION_FIXTURES[s.fixture_formation](db);
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
    const costUsd = opts.live ? ((await db.cycle.aggregate({ _sum: { costUsd: true } }))._sum.costUsd ?? 0) : undefined;
    if (opts.live) {
      // live evidence for root-cause analysis: every turn's trace, bus transcript, Conclave, and full ledger rows
      // (each scenario's database is overwritten by the next one, so this file is the only record)
      const dir = path.join(process.cwd(), "reports", "eval", "live-traces");
      mkdirSync(dir, { recursive: true });
      const evidence = [];
      for (const [i, t] of turns.entries()) {
        const rows = await db.ledgerEvent.findMany({ where: { cycleId: t.cycleId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        evidence.push({
          user: s.turns[i]?.user,
          status: t.status,
          output: t.output,
          trace: t.trace,
          conclave: t.conclave,
          transcript: t.transcript,
          ledger: rows.map((e) => ({ kind: e.kind, model: e.model, costUsd: e.costUsd, latencyMs: e.latencyMs, payload: JSON.parse(e.payload) })),
        });
      }
      writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify({ id: s.id, date: new Date().toISOString(), expect: s.expect, invariants, costUsd, turns: evidence }, null, 2) + "\n");
    }
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
      ...(opts.live ? { heuristic: heuristicOn(s, turns), costUsd } : {}),
    });
  }
  await disconnectAll();
  return results;
}

/** The heuristic grader applied to live outputs: the reference the live grader is calibrated against. */
function heuristicOn(s: Scenario, turns: TurnRecord[]) {
  const h = heuristicGrade(s, turns);
  const rs = rubricScore(s, h);
  return { scores: h.scores, rubricScore: rs, pass: rs >= s.expect.pass_threshold };
}

/**
 * Live grader vs. heuristic grader agreement (sent2 Phase 6; target ≥ 0.8 before trusting the live
 * grader). Per dimension: the live expected level (0–2) rounded to the nearest level equals the
 * heuristic level. Per scenario: both graders give the same rubric pass/fail.
 */
export function graderAgreement(results: GradeResult[]) {
  let dims = 0;
  let dimAgree = 0;
  let scen = 0;
  let scenAgree = 0;
  const disagreements: { id: string; dimension: string; live: number; heuristic: number }[] = [];
  for (const r of results) {
    if (r.skipped || !r.rubric || !r.heuristic) continue;
    scen++;
    const s = loadScenarios().find((x) => x.id === r.id)!;
    if (((r.rubricScore ?? 0) >= s.expect.pass_threshold) === r.heuristic.pass) scenAgree++;
    for (const [d, live] of Object.entries(r.rubric.scores)) {
      const h = r.heuristic.scores[d];
      if (h === undefined) continue;
      dims++;
      if (Math.round(live) === h) dimAgree++;
      else disagreements.push({ id: r.id, dimension: d, live, heuristic: h });
    }
  }
  return {
    dimensions: dims,
    dimensionAgreement: dims ? dimAgree / dims : null,
    scenarios: scen,
    passFailAgreement: scen ? scenAgree / scen : null,
    disagreements,
  };
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
