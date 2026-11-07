/**
 * pnpm eval                       mock providers; scenarios with milestone ≤ eval.current_milestone
 * pnpm eval --update-goldens      (mock) rewrite seed/eval/goldens/*.json; bless only after hand inspection
 * pnpm eval --only a,b            run selected scenario ids
 * pnpm eval:live                  live providers from .env / config models (costs money; measured)
 * pnpm eval:live --central <id> --tag <t>   head-to-head: <id> as the central model (manager + all text tiers);
 *                                 the grader stays the configured one, so both runs are graded alike
 * Exit code 0 only when every run scenario passes.
 */
import { resolveProviderConfig } from "@/lib/council/providers";
import { hiveConfig } from "@/lib/hive/config";
import { printTable, writeReport } from "./report";
import { graderAgreement, runAll } from "./runner";

const live = process.argv.includes("--live");
const updateGoldens = process.argv.includes("--update-goldens");
const onlyArg = process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? (process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined);
// offline `pnpm eval` is a test runner (mock providers); live runs are not
if (!live) process.env.HIVE_TEST_RUNNER = "1";
// live eval may plant labeled TEST FAULTS into real cycles (lib/hive/faults.ts; owner decision 2026-11-06)
if (live) process.env.HIVE_EVAL_FAULTS = "1";
if (live) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* env may come from the shell */
  }
}

const flag = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const central = flag("--central");
const tag = flag("--tag");

async function main() {
  const base = hiveConfig();
  if (central && !live) throw new Error("--central needs --live");
  // head-to-head: the candidate writes and orders the cycle; the grader is pinned to the configured grader
  const grader = live ? (() => {
    const r = resolveProviderConfig(process.env, base.models);
    return r.mode === "cloud" ? r.grader.model : undefined;
  })() : undefined;
  const cfg = central ? { ...base, models: { ...base.models, manager: central, fast: central, standard: central, premium: central, grader: grader ?? base.models.grader } } : base;
  const resolved = live ? resolveProviderConfig(process.env, cfg.models) : null;
  const models = resolved && resolved.mode === "cloud" ? { central: resolved.tiers.standard.model, manager: resolved.manager.model, grader: resolved.grader.model, decisionChain: resolved.decisionChain } : undefined;
  if (models) console.log(`models: central ${models.central} · manager ${models.manager} · grader ${models.grader}`);
  const results = await runAll({ live, updateGoldens, only: onlyArg?.split(","), cfg });
  const agreement = live ? graderAgreement(results) : undefined;
  const file = writeReport(results, live, cfg.eval.current_milestone, agreement, !!onlyArg, { tag, models });
  const ok = printTable(results, live);
  if (agreement) {
    const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(1)}%`);
    console.log(`grader agreement (live vs. heuristic, target ≥ 80%): per dimension ${pct(agreement.dimensionAgreement)} of ${agreement.dimensions}; pass/fail ${pct(agreement.passFailAgreement)} of ${agreement.scenarios}`);
  }
  if (live) console.log(`measured cost of the scenario cycles: $${results.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(6)} (live grading calls not included)`);
  console.log(`report: ${file}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
