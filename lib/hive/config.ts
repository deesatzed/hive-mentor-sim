import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

/** Loads and validates config/hive.yaml (docs/CONCLAVE_MATH.md §9 and ARCHITECTURE.md). */

const DOMAINS = ["logic", "language", "emotion", "social", "ethics", "memory", "goals", "meta"] as const;
const unit = z.number().min(0).max(1);

export const HiveConfigSchema = z.object({
  thresholds: z.object({ tau_kappa: z.number(), tau_pass: z.number(), tau_margin: z.number(), q_min: z.number() }).strict(),
  attention: z.object({ k: z.number().int().positive(), lambda: z.number(), mu: z.number() }),
  memory: z.object({ decay_gamma: unit, conflict_escalation_cycles: z.number().int().positive() }),
  conclave: z.object({ anti_echo_min_guilds: z.number().int().positive(), tiebreak_rotation: z.boolean() }),
  coherence: z.object({ inter_band: z.tuple([unit, unit]), intra_min: unit }),
  ego_audit_every: z.number().int().positive(),
  ego_audit: z.object({ window: z.number().int().positive(), severity_threshold: unit, salience_decay_limit: unit, consensus_truth_gap: unit }),
  phases: z.array(z.string()).length(8),
  guilds: z.record(z.string(), z.array(z.string())),
  domains: z.object(Object.fromEntries(DOMAINS.map((d) => [d, z.string().min(1)])) as Record<(typeof DOMAINS)[number], z.ZodString>),
  tiers: z.object({ fast: z.string(), standard: z.string(), premium: z.string(), fallback: z.string() }),
  relevance: z.record(z.string(), z.object(Object.fromEntries(DOMAINS.map((d) => [d, unit])) as Record<(typeof DOMAINS)[number], typeof unit>)),
  advisor_activation: z.record(
    z.string(),
    z.object({
      workflows: z.array(z.string()),
      via: z.array(z.string()),
      trigger: z.string().optional(),
      requires: z.string().optional(),
      active: z.boolean().optional(),
    }),
  ),
  advisors: z.object({ enabled: z.boolean(), confidence_cap: unit }),
  signals: z.object({
    half_life_days: z.number().positive(),
    thresholds: z.record(z.string(), z.number().positive()),
    resurface_days: z.number().positive(),
    resurface_increase: z.number().positive(),
    dismiss_days: z.number().positive(),
    pattern_window_cycles: z.number().int().positive(),
  }),
  predictions: z.object({ min_n_for_mean: z.number().int().positive() }),
  edict_module: z.object({ enabled: z.boolean(), authority: z.string(), file: z.string() }),
  honesty_clause: z.object({ enabled: z.boolean(), file: z.string() }),
  decision_thresholds: z.record(z.string(), z.number()),
  self_model_seed: z.object({
    identity: z.string(),
    hats: z.array(z.unknown()),
    current_goals: z.array(z.unknown()),
    recent_growth: z.string(),
    open_uncertainties: z.array(z.string()),
  }),
  eval: z.object({ scenarios_dir: z.string(), goldens_dir: z.string(), current_milestone: z.string().regex(/^M\d+$/), rubric_dimensions: z.array(z.string()) }),
  corpus: z.object({
    activation: z.object({
      dilemmas_answered: z.number().int().positive(),
      principles: z.number().int().positive(),
      receipts_per_principle: z.number().int().positive(),
      min_authorial_words: z.number().int().positive(),
    }),
  }),
  orchestration: z.object({ mode: z.enum(["manager", "code"]), max_manager_steps: z.number().int().min(7) }),
  models: z.object({
    manager: z.string(),
    fast: z.string(),
    standard: z.string(),
    premium: z.string(),
    grader: z.string(),
    embedding: z.string(),
    rerank: z.string(),
  }),
});
export type HiveConfig = z.infer<typeof HiveConfigSchema>;
export const DOMAIN_NAMES = DOMAINS;

let cached: HiveConfig | null = null;

export function loadHiveConfig(file = path.join(/*turbopackIgnore: true*/ process.cwd(), "config", "hive.yaml")): HiveConfig {
  return HiveConfigSchema.parse(YAML.parse(readFileSync(file, "utf8")));
}

export function hiveConfig(): HiveConfig {
  if (!cached) cached = loadHiveConfig();
  return cached;
}

/** Test hook: use a modified config for the rest of the process (or reset with null). */
export function setHiveConfigForTests(cfg: HiveConfig | null): void {
  cached = cfg;
}
