/**
 * pnpm corpus build --mentor <slug|all> [--steps fetch,chunk,...] [--force] [--bank] [--concurrency N]
 * pnpm corpus status
 * Live providers from .env (OpenRouter: decisions, deepseek text, cohere embeddings + rerank). Measured
 * cost is printed per step and stored in Mentor.corpusStats. Database: DATABASE_URL (default dev.db).
 */
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { PrismaLedger } from "@/lib/council/ledger";
import { getProviders } from "@/lib/council/providers";
import { CorpusBuilder, STEPS, type CorpusStats, type Step } from "@/lib/council/corpus/pipeline";
import { hiveConfig } from "@/lib/hive/config";

try {
  process.loadEnvFile(".env");
} catch {
  /* env may come from the shell */
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
};

async function main() {
  const cmd = process.argv[2];
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  await ensureDb(url);
  const db = getDb(url);
  const ledger = new PrismaLedger(db);
  if (cmd === "status") {
    const mentors = await db.mentor.findMany({ orderBy: { id: "asc" } });
    for (const m of mentors) {
      const s = JSON.parse(m.corpusStats || "{}") as CorpusStats;
      const steps = STEPS.map((st) => `${st}:${s.steps?.[st]?.status ?? "-"}`).join(" ");
      const cost = Object.values(s.steps ?? {}).reduce((a, x) => a + (x?.costUsd ?? 0), 0);
      console.log(`${m.active ? "ACTIVE  " : "inactive"} ${m.id.padEnd(22)} words ${String(s.authorialWords ?? "-").padStart(7)} chunks ${String(s.chunks ?? "-").padStart(5)} answered ${s.answered ?? "-"} principles ${s.principles ?? "-"} | $${cost.toFixed(4)} | ${steps}${m.inactiveReason ? ` | ${m.inactiveReason}` : ""}`);
    }
    await disconnectAll();
    return;
  }
  if (cmd !== "build") throw new Error("usage: pnpm corpus build --mentor <slug|all> [--steps a,b] [--force] [--bank] | pnpm corpus status");
  const providers = getProviders({ ...process.env, USE_MOCK_PROVIDERS: process.env.USE_MOCK_PROVIDERS ?? "false" }, { ledger, models: hiveConfig().models });
  const builder = new CorpusBuilder({
    db,
    providers,
    ledger,
    bank: process.argv.includes("--bank"),
    concurrency: Number(arg("concurrency") ?? 6),
    log: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`),
  });
  const which = arg("mentor") ?? "all";
  const ids = which === "all" ? builder.mentorIds() : which.split(",");
  const steps = arg("steps")?.split(",") as Step[] | undefined;
  for (const id of ids) await builder.build(id, { steps, force: process.argv.includes("--force") });
  const file = await builder.writeFidelityReport();
  const active = await db.mentor.count({ where: { active: true } });
  console.log(`\nactive mentors: ${active} / ${await db.mentor.count()} · measured spend this run: $${providers.meter.spentUsd.toFixed(6)} · report: ${file}`);
  await disconnectAll();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectAll();
  process.exitCode = 1;
});
