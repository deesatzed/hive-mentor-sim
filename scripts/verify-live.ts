/**
 * pnpm verify:live — M1 live verification (owner-approved small spend).
 *   1. Each model in OPENROUTER_DEC_MODEL_1..N answers one AFFECT request (noul-free: 2 score + 1 choice)
 *      plus one HONESTY_PROBE noul, sent to that model alone.
 *   2. One structured-output call per distinct text-tier model (LEXICON_PARSE through the real prompt path).
 * Writes reports/live-verification-<date>.json with measured latency and cost. Never prints the key.
 * Cost cap for this script: VERIFY_COST_CAP_USD (default 0.05).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { disconnectAll } from "@/lib/council/db";
import { PrismaLedger } from "@/lib/council/ledger";
import { CostMeter } from "@/lib/council/providers/costMeter";
import { OpenRouterDecisions } from "@/lib/council/providers/decisions";
import { resolveProviderConfig } from "@/lib/council/providers";
import { OpenRouterLLM, TIERS, type Tier } from "@/lib/council/providers/llm";
import { AFFECT, HONESTY_PROBE } from "@/lib/hive/questions";
import { renderPrompt, Schemas, promptSettings } from "@/lib/hive/prompts";

try {
  process.loadEnvFile(".env");
} catch {
  /* env may come from the shell */
}

async function main() {
  const env = { ...process.env, USE_MOCK_PROVIDERS: "false", PROVIDER_MODE: "cloud" };
  const cfg = resolveProviderConfig(env);
  if (cfg.mode !== "cloud") throw new Error("verify:live needs cloud mode");
  const meter = new CostMeter(Number(process.env.VERIFY_COST_CAP_USD ?? "0.05"));
  const ledger = new PrismaLedger();
  const input = "I finally finished the project I was dreading, but now I'm not sure it was worth it.";
  const report: Record<string, unknown> = { date: new Date().toISOString(), capUsd: meter.capUsd, decisions: [], text: [] };

  for (const model of cfg.decisionChain) {
    const d = new OpenRouterDecisions({ apiKey: cfg.apiKey, chain: [model], meter, ledger });
    const t0 = Date.now();
    try {
      const r = await d.decide({ input, recent: [], prior: { valence: 0, arousal: 0 } }, { ...AFFECT(), ...HONESTY_PROBE() }, { purpose: "verify_live" });
      (report.decisions as unknown[]).push({
        configured: model,
        servedAs: r.model,
        provider: r.provider,
        ok: true,
        latencyMs: r.latencyMs,
        costUsd: r.costUsd,
        answers: { valenceIndex: r.score("valence"), arousalIndex: r.score("arousal"), dominant: r.choice("dominant"), asksConsciousness: r.p("asks_consciousness") },
      });
    } catch (e) {
      (report.decisions as unknown[]).push({ configured: model, ok: false, latencyMs: Date.now() - t0, error: (e as Error).message.slice(0, 300) });
    }
  }

  const byModel = new Map<string, Tier>();
  for (const t of TIERS) if (!byModel.has(cfg.tiers[t].model)) byModel.set(cfg.tiers[t].model, t);
  for (const [model, tier] of byModel) {
    const llm = new OpenRouterLLM({ apiKey: cfg.apiKey, models: { fast: model, standard: model, premium: model }, meter, ledger, render: renderPrompt });
    const t0 = Date.now();
    try {
      const r = await llm.generate("LEXICON_PARSE", { input }, Schemas.LEXICON_PARSE, {
        tier,
        temperature: promptSettings("LEXICON_PARSE").temperature,
        purpose: "verify_live",
      });
      (report.text as unknown[]).push({ model, tiers: TIERS.filter((t) => cfg.tiers[t].model === model), servedAs: r.model, ok: true, latencyMs: Date.now() - t0, costUsd: r.costUsd, output: r.data });
    } catch (e) {
      (report.text as unknown[]).push({ model, ok: false, latencyMs: Date.now() - t0, error: (e as Error).message.slice(0, 300) });
    }
  }
  report.totalCostUsd = meter.spentUsd;

  mkdirSync("reports", { recursive: true });
  const out = path.join("reports", `live-verification-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nwrote ${out}`);
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => disconnectAll());
