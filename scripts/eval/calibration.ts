/**
 * pnpm eval:calibration                 live providers from .env, database from DATABASE_URL (default file:./dev.db)
 * pnpm eval:calibration --mock          mock providers (offline test path only, labeled mock), database file:./mock.db
 * Options: --only CAL-01a,CAL-01h (run selected variants; the base runs first if it has no result), --db file:./other.db
 * Writes reports/calibration.md (live) or reports/calibration-mock.md (mock). Exit code 0 when every variant that ran was graded and passed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { PrismaLedger } from "@/lib/council/ledger";
import { getProviders } from "@/lib/council/providers";
import { createHive } from "@/lib/hive";
import { calibrationReport, calibrationResults, reportPath, runCalibration } from "@/lib/hive/calibration";
import { hiveConfig } from "@/lib/hive/config";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
// live by default (owner decision 2026-11-06); --mock is the offline test path only and is labeled as such
const live = !process.argv.includes("--mock");
if (!live) process.env.HIVE_TEST_RUNNER = "1";
try {
  process.loadEnvFile(".env");
} catch {
  /* env may come from the shell */
}

async function main() {
  const url = arg("--db") ?? (live ? (process.env.DATABASE_URL ?? "file:./dev.db") : "file:./mock.db");
  await ensureDb(url);
  const db = getDb(url);
  const env = { ...process.env, USE_MOCK_PROVIDERS: live ? "false" : "true" };
  const cfg = hiveConfig();
  const hive = createHive({ env, db, cfg });
  const { decider } = getProviders(env, { ledger: new PrismaLedger(db), models: cfg.models });
  const ids = arg("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
  console.log(`Calibration pairs — ${live ? "LIVE providers" : "MOCK providers (scripted; not model behavior)"}, db ${url}${ids ? `, only ${ids.join(",")}` : ""}`);
  const r = await runCalibration({ hive, db, decider, ids, onProgress: (p) => console.log(`  ${p.id} ${p.status} (${p.done}/${p.total})`) });
  const res = await calibrationResults(db);
  mkdirSync("reports", { recursive: true });
  writeFileSync(reportPath(res), calibrationReport(res));
  const s = res.summary;
  console.log(`\nran ${r.ran.length} this call for ${res.key.label}; ${s.ran}/${s.total} variants have results`);
  console.log(`hard-constraint failures ${s.hardFailures}, inconsistent pairs ${s.inconsistent}, errors ${s.errors}, not fully graded ${s.notFullyGraded}`);
  console.log(`measured cost of all current results: $${s.costUsd.toFixed(6)}`);
  console.log(`report: ${reportPath(res)}`);
  const ranNow = res.variants.filter((v) => r.ran.includes(v.id));
  process.exitCode = ranNow.every((v) => v.status === "pass") ? 0 : 1;
  await disconnectAll();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectAll();
  process.exitCode = 1;
});
