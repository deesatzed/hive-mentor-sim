/**
 * pnpm check:prompts — the prompt-layer integrity gate.
 * Ported from reference/sent2.md (scripts/check-prompts.ts), minus the guardian and harm checks
 * removed by owner decision. Exit 0 = all green; exit 1 = violations, one per line.
 *
 *   1. Every entity prompt parses (frontmatter + non-empty body).
 *   2. Required frontmatter: voice, model_tier ∈ {fast, standard, premium}, temperature ∈ [0, 2].
 *   3. Voice names unique.
 *   4. Counts: 15 core + 1 governance + 1 procedure + 16 advisors = 33.
 *   5. Every roster entity has its prompt file; tier/temperature match the roster.
 *   6. config/hive.yaml: relevance row per Core voice (all 8 domains in [0,1]) and vice versa;
 *      advisor_activation entry per advisor; pairings point at Core voices.
 *   7. constitution/permissions.yaml keys (minus default and wildcards) match a roster entity.
 *   8. Advisor bodies state the advisory-only rule.
 *   9. prompts/_shared.md has the mentor rules and the Honesty Clause / Edict toggles.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import YAML from "yaml";

export interface CheckResult {
  ok: string[];
  violations: string[];
}

const TIERS = new Set(["fast", "standard", "premium"]);
const DOMAINS = ["logic", "language", "emotion", "social", "ethics", "memory", "goals", "meta"];

interface PromptInfo {
  file: string;
  cls: "core" | "governance" | "procedure" | "advisor";
  voice: string;
  tier?: unknown;
  temperature?: unknown;
  body: string;
}

type RosterEntity = { id: string; name: string; class: string; tier: string; temperature: number; prompt: string; pairs_with?: string[] };

export function checkPrompts(root: string): CheckResult {
  const violations: string[] = [];
  const ok: string[] = [];
  const P = path.join(root, "prompts");

  const load = (cls: PromptInfo["cls"], rel: string): PromptInfo | null => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      violations.push(`MISSING: ${rel}`);
      return null;
    }
    try {
      const { data, content } = matter(readFileSync(abs, "utf8"));
      return { file: rel, cls, voice: String(data.voice ?? ""), tier: data.model_tier, temperature: data.temperature, body: content.trim() };
    } catch (e) {
      violations.push(`UNPARSEABLE: ${rel} — ${(e as Error).message}`);
      return null;
    }
  };
  const loadDir = (cls: PromptInfo["cls"], dir: string) => {
    const abs = path.join(P, dir);
    if (!existsSync(abs)) {
      violations.push(`MISSING DIR: prompts/${dir}`);
      return [];
    }
    return readdirSync(abs)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => load(cls, path.join("prompts", dir, f)))
      .filter((x): x is PromptInfo => x !== null);
  };

  const core = loadDir("core", "core");
  const governance = loadDir("governance", "governance");
  const procedure = [load("procedure", "prompts/conclave.md")].filter((x): x is PromptInfo => x !== null);
  const advisors = loadDir("advisor", "advisors");
  const all = [...core, ...governance, ...procedure, ...advisors];

  // 1–2
  for (const p of all) {
    if (!p.body) violations.push(`EMPTY BODY: ${p.file}`);
    if (!p.voice) violations.push(`MISSING voice: ${p.file}`);
    if (typeof p.tier !== "string" || !TIERS.has(p.tier)) violations.push(`BAD/MISSING model_tier: ${p.file} (got "${String(p.tier)}")`);
    if (typeof p.temperature !== "number" || p.temperature < 0 || p.temperature > 2)
      violations.push(`BAD/MISSING temperature: ${p.file} (got ${String(p.temperature)})`);
  }
  // 3
  const seen = new Map<string, string>();
  for (const p of all) {
    if (seen.has(p.voice)) violations.push(`DUPLICATE voice "${p.voice}": ${seen.get(p.voice)} and ${p.file}`);
    seen.set(p.voice, p.file);
  }
  // 4
  const counts = { core: core.length, governance: governance.length, procedure: procedure.length, advisors: advisors.length };
  const expected = { core: 15, governance: 1, procedure: 1, advisors: 16 };
  for (const k of Object.keys(expected) as (keyof typeof expected)[])
    if (counts[k] !== expected[k]) violations.push(`COUNT ${k}: expected ${expected[k]}, found ${counts[k]}`);

  // 5
  const roster = JSON.parse(readFileSync(path.join(root, "seed/voice_roster.json"), "utf8")) as { entities: RosterEntity[] };
  const byVoice = new Map(all.map((p) => [p.voice, p]));
  for (const e of roster.entities) {
    const p = byVoice.get(e.name);
    if (!p) {
      violations.push(`roster entity ${e.id} (${e.name}) has no prompt file`);
      continue;
    }
    if (p.file !== e.prompt) violations.push(`roster ${e.id} expects ${e.prompt}, found ${p.file}`);
    if (p.tier !== e.tier) violations.push(`${p.file}: model_tier ${String(p.tier)} ≠ roster ${e.tier}`);
    if (p.temperature !== e.temperature) violations.push(`${p.file}: temperature ${String(p.temperature)} ≠ roster ${e.temperature}`);
  }
  for (const p of all) if (!roster.entities.some((e) => e.name === p.voice)) violations.push(`${p.file}: voice ${p.voice} not in roster`);

  // 6
  const cfg = YAML.parse(readFileSync(path.join(root, "config/hive.yaml"), "utf8"));
  const relevance: Record<string, Record<string, number>> = cfg.relevance ?? {};
  for (const v of core) {
    const row = relevance[v.voice];
    if (!row) {
      violations.push(`NO relevance row for Core voice ${v.voice} in config/hive.yaml`);
      continue;
    }
    for (const d of DOMAINS)
      if (typeof row[d] !== "number" || row[d] < 0 || row[d] > 1) violations.push(`relevance.${v.voice}.${d} missing or outside [0,1]`);
  }
  for (const name of Object.keys(relevance)) if (!core.some((c) => c.voice === name)) violations.push(`relevance row "${name}" has no Core prompt file`);
  const activation: Record<string, { via: string[] }> = cfg.advisor_activation ?? {};
  for (const a of advisors) if (!activation[a.voice.toLowerCase()]) violations.push(`advisor ${a.voice} missing from advisor_activation`);
  for (const [name, act] of Object.entries(activation)) {
    if (!advisors.some((a) => a.voice.toLowerCase() === name)) violations.push(`advisor_activation.${name} has no prompt file`);
    for (const v of act.via ?? []) if (!core.some((c) => c.voice === v)) violations.push(`advisor_activation.${name} pairs with unknown Core voice "${v}"`);
  }

  // 7
  const perms = YAML.parse(readFileSync(path.join(root, "constitution/permissions.yaml"), "utf8")) ?? {};
  const ids = new Set(roster.entities.map((e) => e.id));
  for (const key of Object.keys(perms)) {
    if (key === "default" || key.endsWith(".*")) continue;
    if (!ids.has(key)) violations.push(`permissions.yaml entry "${key}" matches no roster entity`);
  }

  // 8
  for (const a of advisors) if (!/advisory/i.test(a.body)) violations.push(`ADVISOR WITHOUT ADVISORY RULE: ${a.file}`);

  // 9
  const sharedPath = path.join(P, "_shared.md");
  if (!existsSync(sharedPath)) violations.push("MISSING: prompts/_shared.md");
  else {
    const shared = readFileSync(sharedPath, "utf8");
    const need: [RegExp, string][] = [
      [/MENTOR RULES/, "mentor rules"],
      [/Never speak as a mentor/, "no mentor first person"],
      [/at least 8 consecutive words/, "quote rule"],
      [/\{\{#HONESTY_CLAUSE\}\}[\s\S]*HONESTY CLAUSE[\s\S]*\{\{\/HONESTY_CLAUSE\}\}/, "Honesty Clause toggle block"],
      [/\{\{#EDICT_MODULE\}\}[\s\S]*\{\{\/EDICT_MODULE\}\}/, "Edict module toggle block"],
      [/<untrusted>/, "untrusted-data rule"],
    ];
    for (const [re, label] of need) if (!re.test(shared)) violations.push(`_shared.md missing: ${label}`);
  }

  ok.push(`entities: ${core.length} core, ${governance.length} governance, ${procedure.length} procedure, ${advisors.length} advisors (${all.length} total)`);
  return { ok, violations };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const { ok, violations } = checkPrompts(process.cwd());
  console.log("check:prompts");
  for (const line of ok) console.log(`  ok  ${line}`);
  if (violations.length) {
    for (const v of violations) console.error(`  FAIL ${v}`);
    console.error(`\n${violations.length} violation(s).`);
    process.exit(1);
  }
  console.log("  ok  all checks pass");
}
