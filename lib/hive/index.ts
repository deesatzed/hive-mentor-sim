import "server-only";
import type { EvalFaults } from "./faults";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { getDb } from "@/lib/council/db";
import { PrismaLedger } from "@/lib/council/ledger";
import { getProviders, type Env, type ProviderDeps } from "@/lib/council/providers";
import { hiveConfig, type HiveConfig } from "./config";
import { Hive } from "./orchestrator";
import { loadPermissions, PolicyEngine } from "./permissions";
import { loadVoices } from "./voices";

export { Hive } from "./orchestrator";
export type { CycleRequest, CycleResult } from "./orchestrator";

export function mentorNames(): string[] {
  const roster = JSON.parse(readFileSync(path.join(/*turbopackIgnore: true*/ process.cwd(), "seed", "mentor_roster.json"), "utf8")) as { mentors: { name: string }[] };
  return roster.mentors.map((m) => m.name);
}

/** Builds a Hive from env + config/hive.yaml. Mock providers when USE_MOCK_PROVIDERS=true. */
export function createHive(opts: { env?: Env; db?: PrismaClient; cfg?: HiveConfig; providerDeps?: ProviderDeps; faults?: EvalFaults } = {}): Hive {
  const db = opts.db ?? getDb();
  const ledger = new PrismaLedger(db);
  const cfg = opts.cfg ?? hiveConfig();
  const providers = getProviders(opts.env ?? process.env, { ledger, models: cfg.models, ...opts.providerDeps });
  return new Hive({ db, ledger, providers, cfg, voices: loadVoices(cfg), policy: new PolicyEngine(loadPermissions()), mentorNames: mentorNames(), faults: opts.faults });
}
