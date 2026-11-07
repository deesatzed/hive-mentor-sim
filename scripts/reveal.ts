/**
 * pnpm reveal                 live providers from .env, database from DATABASE_URL (default file:./dev.db)
 * pnpm reveal --mock          mock providers (offline test path only, labeled mock), database file:./mock.db
 * Options: --limit N (run at most N new dilemmas this call; resumable), --db file:./other.db
 */
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { PrismaLedger } from "@/lib/council/ledger";
import { getProviders } from "@/lib/council/providers";
import { createHive } from "@/lib/hive";
import { hiveConfig } from "@/lib/hive/config";
import { revealResults, runReveal } from "@/lib/hive/reveal";

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
  const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
  console.log(`Reveal — ${live ? "LIVE providers" : "MOCK providers (scripted; not model behavior)"}, db ${url}${limit ? `, limit ${limit}` : ""}`);
  const r = await runReveal({ hive, db, decider, limit, onProgress: (p) => console.log(`  ${p.situationId} ${p.status} (${p.done}/${p.total})`) });
  const res = await revealResults(db);
  console.log(`\nran ${r.ran} new, ${r.done}/${r.total} done for ${res.key.label}; errors: ${r.errors.length ? r.errors.join("; ") : "none"}`);
  console.log(`measured cycle cost for this key: $${res.progress.costUsd.toFixed(6)}`);
  console.log(res.headline);
  console.log(`Conclave did not reach its pass rule on ${res.escalated} of ${res.rulings.length} rulings (top option still counts).`);
  for (const m of res.hiveVsMentors) console.log(`  ${m.name}${m.assigned ? " *" : ""}: ${m.enough ? `${m.matches}/${m.n} κ ${m.kappa!.toFixed(2)}` : `not enough evidence (n=${m.n})`}`);
  for (const v of res.perVoice) console.log(`  ${v.sentence}`);
  console.log(`Voice ballot N_eff ${res.voiceNEff.nEff.toFixed(2)} over ${res.voiceNEff.voices} Voices · ${res.mirror.sentence}`);
  await disconnectAll();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectAll();
  process.exitCode = 1;
});
