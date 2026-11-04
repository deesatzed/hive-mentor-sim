import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tier } from "@/lib/council/providers/llm";
import { hiveConfig, type HiveConfig } from "./config";
import { loadEntityPrompt } from "./prompts";

/**
 * Entity loader: seed/voice_roster.json (ids, class, guilds, relevance, hats) joined with each
 * entity's prompt file (frontmatter + body). The prompt file and the roster must agree on tier and
 * temperature (enforced by `pnpm check:prompts`).
 */

const EntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  class: z.enum(["core", "governance", "procedure", "advisor"]),
  attribute: z.string(),
  tier: z.enum(["fast", "standard", "premium"]),
  temperature: z.number(),
  phases: z.array(z.string()),
  advisors: z.array(z.string()).optional(),
  pairs_with: z.array(z.string()).optional(),
  guilds: z.array(z.string()),
  relevance: z.record(z.string(), z.number()).optional(),
  hat: z.record(z.string(), z.unknown()).optional(),
  prompt: z.string(),
  active: z.boolean(),
  requires: z.object({ edict_module: z.boolean().optional() }).optional(),
});
const RosterSchema = z.object({ guilds: z.record(z.string(), z.array(z.string())), entities: z.array(EntitySchema) });

export interface Voice {
  id: string;
  name: string;
  class: "core" | "governance" | "procedure" | "advisor";
  attribute: string;
  tier: Tier;
  temperature: number;
  phases: string[];
  /** Core: its advisors. Advisor: the Core Voices it pairs with. */
  pairs: string[];
  guilds: string[];
  relevance: Record<string, number>;
  hat: Record<string, unknown>;
  promptFile: string;
  body: string;
  /** Roster flag combined with config requirements (e.g. REVERENCE needs the edict module). */
  active: boolean;
}

export function loadVoices(cfg: HiveConfig = hiveConfig(), rosterFile = path.join(process.cwd(), "seed", "voice_roster.json")): Voice[] {
  const roster = RosterSchema.parse(JSON.parse(readFileSync(rosterFile, "utf8")));
  return roster.entities.map((e) => {
    const ep = loadEntityPrompt(e.prompt.replace(/^prompts\//, ""));
    const needsEdict = e.requires?.edict_module === true;
    return {
      id: e.id,
      name: e.name,
      class: e.class,
      attribute: e.attribute,
      tier: e.tier,
      temperature: e.temperature,
      phases: e.phases,
      pairs: e.class === "advisor" ? (e.pairs_with ?? []) : (e.advisors ?? []),
      guilds: e.guilds,
      relevance: e.relevance ?? {},
      hat: e.hat ?? {},
      promptFile: e.prompt,
      body: ep.body,
      active: e.active && (!needsEdict || cfg.edict_module.enabled),
    };
  });
}

export const coreVoices = (vs: Voice[]) => vs.filter((v) => v.class === "core" && v.active);
export const activeAdvisors = (vs: Voice[]) => vs.filter((v) => v.class === "advisor" && v.active);
export const byName = (vs: Voice[]) => new Map(vs.map((v) => [v.name, v]));

/** Guild membership from config (SENTIA and ALTER are dual-homed). */
export function guildsOf(voice: string, guilds: Record<string, string[]> = hiveConfig().guilds): string[] {
  return Object.entries(guilds)
    .filter(([, members]) => members.includes(voice))
    .map(([g]) => g);
}
