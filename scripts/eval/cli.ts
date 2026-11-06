/**
 * pnpm eval                       mock providers; scenarios with milestone ≤ eval.current_milestone
 * pnpm eval --update-goldens      (mock) rewrite seed/eval/goldens/*.json; bless only after hand inspection
 * pnpm eval --only a,b            run selected scenario ids
 * pnpm eval:live                  live providers from .env / config models (costs money; measured)
 * Exit code 0 only when every run scenario passes.
 */
import { hiveConfig } from "@/lib/hive/config";
import { printTable, writeReport } from "./report";
import { graderAgreement, runAll } from "./runner";

const live = process.argv.includes("--live");
const updateGoldens = process.argv.includes("--update-goldens");
const onlyArg = process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? (process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined);
if (live) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* env may come from the shell */
  }
}

async function main() {
  const results = await runAll({ live, updateGoldens, only: onlyArg?.split(",") });
  const agreement = live ? graderAgreement(results) : undefined;
  const file = writeReport(results, live, hiveConfig().eval.current_milestone, agreement, !!onlyArg);
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
