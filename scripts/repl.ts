/**
 * pnpm dev:repl            live providers from .env, database from DATABASE_URL (default file:./dev.db)
 * pnpm dev:repl --mock     mock providers (offline test path only, labeled mock), database file:./mock.db
 * Options: --trace (print the full trace JSON after each reply), --code (code ordering instead of the manager)
 * Piped input works: echo "I'm thinking of quitting my job." | pnpm dev:repl
 */
import readline from "node:readline";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { createHive } from "@/lib/hive";
import { hiveConfig } from "@/lib/hive/config";

// live by default (owner decision 2026-11-06); --mock is the offline test path only and is labeled as such
const live = !process.argv.includes("--mock");
if (!live) process.env.HIVE_TEST_RUNNER = "1";
const showTrace = process.argv.includes("--trace");
const codeOrder = process.argv.includes("--code");
try {
  process.loadEnvFile(".env");
} catch {
  /* env may come from the shell */
}

async function main() {
  const url = live ? (process.env.DATABASE_URL ?? "file:./dev.db") : "file:./mock.db";
  await ensureDb(url);
  const env = { ...process.env, USE_MOCK_PROVIDERS: live ? "false" : "true" };
  const base = hiveConfig();
  const cfg = codeOrder ? { ...base, orchestration: { ...base.orchestration, mode: "code" as const } } : base;
  const hive = createHive({ env, db: getDb(url), cfg });
  const sessionId = await hive.createSession("chat", "repl");
  console.log(`Mentor Hive REPL — ${live ? "LIVE providers" : "MOCK providers (scripted; not model behavior)"}, ordering: ${cfg.orchestration.mode}, db ${url}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  if (process.stdin.isTTY) {
    rl.setPrompt("you > ");
    rl.prompt();
  }
  for await (const line of rl) {
    const input = line.trim();
    if (!input) continue;
    if (input === "/quit") break;
    const r = await hive.runCycle({ sessionId, input });
    const t = r.trace;
    console.log(`\nhive > ${r.status === "done" ? r.output : `[cycle error in ${t.error?.phase}: ${t.error?.message}]`}`);
    const cost = Object.values(t.phases).reduce((s, p) => s + p.costUsd, 0);
    console.log(
      `  [cycle ${r.cycleNo} ${r.cycleId} | ${t.orchestration.steps.map((s) => `${s.phase}(${s.by})`).join(" → ")} | ${t.whispers.length} whispers | awareness: ${t.awareness.text} | conclave: ${t.conclaveId ? "yes" : "no"} | arbiter ${t.arbiter.decision} | cost $${cost.toFixed(6)}]\n`,
    );
    if (showTrace) console.log(JSON.stringify(t, null, 2));
    if (process.stdin.isTTY) rl.prompt();
  }
  await disconnectAll();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectAll();
  process.exitCode = 1;
});
