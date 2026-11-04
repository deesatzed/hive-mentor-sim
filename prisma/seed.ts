/**
 * Seeds reference data (docs/DATA_MODEL.md "Seeding"). Idempotent: upserts by id; Formation v1 and
 * SelfModelVersion v1 are created only if absent. Real seed files only; nothing synthetic.
 *
 *   pnpm db:seed            (uses DATABASE_URL, default file:./dev.db)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { PrismaClient } from "@/generated/prisma/client";
import { getDb, disconnectAll } from "@/lib/council/db";

const read = (f: string) => JSON.parse(readFileSync(path.join(process.cwd(), f), "utf8"));

type Situation = { id: string; setKey: string; domain: string; text: string; options: unknown[]; tags?: string[]; meta?: unknown };
type Mentor = { id: string; name: string; years: string; diedYear: number; roles: string[]; bio: string };
type Entity = {
  id: string;
  name: string;
  class: string;
  attribute: string;
  tier: string;
  temperature: number;
  phases: string[];
  guilds: string[];
  relevance?: Record<string, number>;
  hat?: Record<string, unknown>;
  active: boolean;
};

export interface SeedCounts {
  situations: number;
  mentors: number;
  voices: number;
  formationMembers: number;
  selfModelCreated: boolean;
  formationCreated: boolean;
}

export async function seed(db: PrismaClient): Promise<SeedCounts> {
  const dilemmas = read("seed/dilemmas.json") as Situation[];
  const calibration = (read("seed/calibration_pairs.json") as { situations: Situation[] }).situations;
  const situations = [...dilemmas, ...calibration];
  for (const s of situations) {
    const data = {
      setKey: s.setKey,
      domain: s.domain,
      text: s.text,
      options: JSON.stringify(s.options),
      tags: JSON.stringify(s.tags ?? []),
      meta: JSON.stringify(s.meta ?? {}),
    };
    await db.situation.upsert({ where: { id: s.id }, create: { id: s.id, ...data }, update: data });
  }

  const mentors = (read("seed/mentor_roster.json") as { mentors: Mentor[] }).mentors;
  for (const m of mentors) {
    const data = { name: m.name, years: m.years, diedYear: m.diedYear, roles: JSON.stringify(m.roles), bio: m.bio };
    // `active` is never set here: only a successful corpus build activates a mentor.
    await db.mentor.upsert({ where: { id: m.id }, create: { id: m.id, ...data }, update: data });
  }

  const entities = (read("seed/voice_roster.json") as { entities: Entity[] }).entities;
  for (const e of entities) {
    const data = {
      name: e.name,
      class: e.class,
      attribute: e.attribute,
      tier: e.tier,
      temperature: e.temperature,
      phases: JSON.stringify(e.phases),
      guilds: JSON.stringify(e.guilds),
      relevance: JSON.stringify(e.relevance ?? {}),
      hat: JSON.stringify(e.hat ?? {}),
      promptVersion: "m1",
      active: e.active,
    };
    await db.voice.upsert({ where: { id: e.id }, create: { id: e.id, ...data }, update: data });
  }

  const assignments = (read("seed/voice_mentor_map.json") as { assignments: { voice: string; mentors: string[] }[] }).assignments;
  let formationCreated = false;
  let formationMembers = 0;
  if (!(await db.formation.findUnique({ where: { version: 1 } }))) {
    const byName = new Map(entities.map((e) => [e.name, e.id]));
    const members = assignments.flatMap((a) => {
      const voiceId = byName.get(a.voice);
      if (!voiceId) throw new Error(`voice_mentor_map names unknown voice ${a.voice}`);
      return a.mentors.map((mentorId) => {
        if (!mentors.some((m) => m.id === mentorId)) throw new Error(`voice_mentor_map names unknown mentor ${mentorId}`);
        return { voiceId, mentorId, kind: "declared" };
      });
    });
    await db.formation.create({ data: { version: 1, status: "draft", note: "seed/voice_mentor_map.json", members: { create: members } } });
    formationCreated = true;
    formationMembers = members.length;
  } else {
    formationMembers = await db.formationMember.count({ where: { formation: { version: 1 } } });
  }

  let selfModelCreated = false;
  if (!(await db.selfModelVersion.findUnique({ where: { version: 1 } }))) {
    const cfg = YAML.parse(readFileSync(path.join(process.cwd(), "config/hive.yaml"), "utf8"));
    await db.selfModelVersion.create({ data: { version: 1, body: JSON.stringify(cfg.self_model_seed), promoted: true } });
    selfModelCreated = true;
  }

  return { situations: situations.length, mentors: mentors.length, voices: entities.length, formationMembers, selfModelCreated, formationCreated };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(".env");
    } catch {
      /* no .env: default URL */
    }
  }
  seed(getDb())
    .then((c) => console.log("seeded", JSON.stringify(c)))
    .finally(() => disconnectAll());
}
