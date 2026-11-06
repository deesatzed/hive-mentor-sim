/**
 * pnpm smoke:live [--db file:./smoke.db] [--input "..."]
 * One full chat heartbeat with live providers (.env). Prints and records the measured cost and
 * latency per phase (reports/smoke-live.md, reports/smoke-live.json). Spend is limited by the
 * owner's per-key OpenRouter limit; nothing here estimates cost.
 * Default database: a fresh SQLite backup of DATABASE_URL (dev.db) at file:./smoke.db, so the
 * operator's database is never written. Exit 0 only when the cycle finished with status "done".
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { disconnectAll, getDb, sqlitePathFromUrl } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { createHive } from "@/lib/hive";
import { hiveConfig } from "@/lib/hive/config";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
try {
  process.loadEnvFile(".env");
} catch {
  /* env may come from the shell */
}

const DEFAULT_INPUT = "My sister asked me to co-sign a loan for her new business. I love her, but I'm not sure she has a plan. What should I weigh before I answer?";

async function main() {
  const source = process.env.DATABASE_URL ?? "file:./dev.db";
  const url = arg("--db") ?? "file:./smoke.db";
  if (sqlitePathFromUrl(url) === sqlitePathFromUrl(source)) throw new Error("smoke:live refuses to run on the operator database; pass a different --db");
  if (!arg("--db")) {
    // consistent copy of the operator's database (corpus, approved formation and constitution)
    // (VACUUM INTO only reads the source; the target must not exist)
    const dst = sqlitePathFromUrl(url);
    if (!dst.endsWith(".db")) throw new Error(`refusing to write a file not ending in .db: ${dst}`);
    for (const f of [dst, `${dst}-journal`]) if (existsSync(f)) unlinkSync(f);
    await getDb(source).$executeRawUnsafe(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
    await disconnectAll();
  }
  await ensureDb(url);
  const db = getDb(url);
  const env = { ...process.env, USE_MOCK_PROVIDERS: "false", DATABASE_URL: url };
  const cfg = hiveConfig();
  const hive = createHive({ env, db, cfg });
  const input = arg("--input") ?? DEFAULT_INPUT;
  console.log(`smoke:live — LIVE providers, db ${url}`);
  const sessionId = await hive.createSession("chat", "smoke:live");
  const t0 = Date.now();
  const r = await hive.runCycle({ sessionId, input });
  const wallMs = Date.now() - t0;
  const cycle = await db.cycle.findUniqueOrThrow({ where: { id: r.cycleId } });
  const ledger = await db.ledgerEvent.aggregate({ where: { cycleId: r.cycleId }, _sum: { costUsd: true }, _count: true });
  const denied = await db.busMessage.count({ where: { cycleId: r.cycleId, authorized: false } });
  const phases = Object.entries(r.trace.phases).map(([id, p]) => ({ phase: id, ran: p.ran, ms: p.ms, costUsd: p.costUsd, entities: p.entities.length }));
  const out = {
    date: new Date().toISOString(),
    db: url,
    status: r.status,
    cycleId: r.cycleId,
    orchestration: r.trace.orchestration.mode,
    managerModel: r.trace.orchestration.managerModel,
    order: r.trace.orchestration.steps.map((s) => `${s.phase}·${s.by}`),
    wallMs,
    cycleCostUsd: cycle.costUsd,
    ledgerCostUsd: ledger._sum.costUsd ?? 0,
    ledgerEvents: ledger._count,
    busDenied: denied,
    advisors: (r.trace.advisors ?? []).map((a) => ({ name: a.name, endorsedBy: a.endorsedBy, enteredAs: a.enteredAs })),
    phases,
    input,
    output: r.output,
    error: r.trace.error ?? null,
  };
  console.log(`status ${out.status} · wall ${wallMs} ms · cycle cost $${cycle.costUsd.toFixed(6)} · ledger $${out.ledgerCostUsd.toFixed(6)} over ${out.ledgerEvents} events · bus denials ${denied}`);
  console.log(`order: ${out.order.join(" → ")}`);
  console.log("phase  ran  ms       cost");
  for (const p of phases) console.log(`${p.phase.padEnd(6)} ${p.ran ? "yes" : "no "}  ${String(p.ms).padEnd(8)} $${p.costUsd.toFixed(6)}`);
  if (out.error) console.log(`error in ${out.error.phase}: ${out.error.message}`);
  console.log(`\nreply:\n${r.output}`);

  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/smoke-live.json", JSON.stringify(out, null, 2) + "\n");
  writeFileSync(
    "reports/smoke-live.md",
    [
      `# Live smoke cycle (${out.date.slice(0, 10)})`,
      "",
      `Measured, one run. Status **${out.status}**; wall time ${wallMs} ms; cycle cost $${cycle.costUsd.toFixed(6)} (ledger sum $${out.ledgerCostUsd.toFixed(6)} over ${out.ledgerEvents} events); bus denials ${denied}.`,
      `Ordering: ${out.orchestration}${out.managerModel ? ` (${out.managerModel})` : ""}: ${out.order.join(" → ")}.`,
      "",
      "| Phase | Ran | ms | Cost (USD) |",
      "|---|---|---|---|",
      ...phases.map((p) => `| ${p.phase} | ${p.ran ? "yes" : "no"} | ${p.ms} | ${p.costUsd.toFixed(6)} |`),
      "",
      `Advisors: ${out.advisors.length} ran; endorsed: ${out.advisors.filter((a) => a.endorsedBy).map((a) => `${a.name} (by ${a.endorsedBy})`).join(", ") || "none"}.`,
      "",
      `**Input:** ${input}`,
      "",
      `**Reply:** ${r.output}`,
      "",
    ].join("\n"),
  );
  console.log("report: reports/smoke-live.md");
  process.exitCode = r.status === "done" ? 0 : 1;
  await disconnectAll();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectAll();
  process.exitCode = 1;
});
