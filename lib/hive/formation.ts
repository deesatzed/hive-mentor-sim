import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { effectiveN, kappa } from "@/lib/council/councilMetrics";

/**
 * Formation: which mentors give each Core Voice its attribute lens (docs/PRODUCT_SPEC.md /formation,
 * docs/MENTOR_CORPUS.md "Voice attribute lenses"). Every save is a new version; approving one
 * supersedes the previously approved version. Cycles use the approved formation, or the newest draft
 * when none is approved. Only active mentors are ever part of a lens.
 */

export const MAX_MENTORS_PER_VOICE = 3;

export class FormationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormationError";
  }
}

export interface FormationView {
  id: string;
  version: number;
  status: string;
  note: string | null;
  createdAt: Date;
  assignments: Record<string, string[]>;
}

/** The formation cycles use: approved if any, else the newest draft. */
export async function activeFormation(db: PrismaClient): Promise<FormationView | null> {
  const f =
    (await db.formation.findFirst({ where: { status: "approved" }, orderBy: { version: "desc" }, include: { members: true } })) ??
    (await db.formation.findFirst({ orderBy: { version: "desc" }, include: { members: true } }));
  if (!f) return null;
  const assignments: Record<string, string[]> = {};
  for (const m of f.members) (assignments[m.voiceId] ??= []).push(m.mentorId);
  for (const k of Object.keys(assignments)) assignments[k].sort();
  return { id: f.id, version: f.version, status: f.status, note: f.note, createdAt: f.createdAt, assignments };
}

export async function formationHistory(db: PrismaClient) {
  return db.formation.findMany({ orderBy: { version: "desc" }, select: { id: true, version: true, status: true, note: true, createdAt: true, _count: { select: { members: true } } } });
}

/** Saves a new draft version. Each Voice gets 0–3 mentors, active ones only; core Voices only. */
export async function saveFormation(db: PrismaClient, assignments: Record<string, string[]>, note?: string): Promise<FormationView> {
  const voices = new Set((await db.voice.findMany({ where: { class: "core" }, select: { id: true } })).map((v) => v.id));
  const active = new Set((await db.mentor.findMany({ where: { active: true }, select: { id: true } })).map((m) => m.id));
  const rows: { voiceId: string; mentorId: string; kind: string }[] = [];
  for (const [voiceId, mentors] of Object.entries(assignments)) {
    if (!voices.has(voiceId)) throw new FormationError(`unknown core Voice ${voiceId}`);
    const uniq = [...new Set(mentors)];
    if (uniq.length > MAX_MENTORS_PER_VOICE) throw new FormationError(`${voiceId}: at most ${MAX_MENTORS_PER_VOICE} mentors`);
    for (const m of uniq) {
      if (!active.has(m)) throw new FormationError(`${voiceId}: mentor ${m} is not active`);
      rows.push({ voiceId, mentorId: m, kind: "declared" });
    }
  }
  const last = await db.formation.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
  await db.formation.create({ data: { version: (last?.version ?? 0) + 1, status: "draft", note: note ?? null, members: { create: rows } } });
  return (await activeFormationByVersion(db, (last?.version ?? 0) + 1))!;
}

async function activeFormationByVersion(db: PrismaClient, version: number): Promise<FormationView | null> {
  const f = await db.formation.findUnique({ where: { version }, include: { members: true } });
  if (!f) return null;
  const assignments: Record<string, string[]> = {};
  for (const m of f.members) (assignments[m.voiceId] ??= []).push(m.mentorId);
  return { id: f.id, version: f.version, status: f.status, note: f.note, createdAt: f.createdAt, assignments };
}

/** Approves a version; the previously approved one becomes superseded. Inactive mentors in it are refused. */
export async function approveFormation(db: PrismaClient, version: number): Promise<FormationView> {
  const f = await db.formation.findUnique({ where: { version }, include: { members: true } });
  if (!f) throw new FormationError(`no formation version ${version}`);
  const inactive = await db.mentor.findMany({ where: { id: { in: f.members.map((m) => m.mentorId) }, active: false }, select: { id: true } });
  if (inactive.length) throw new FormationError(`version ${version} names inactive mentors: ${inactive.map((m) => m.id).join(", ")}; save a new version without them`);
  await db.$transaction([
    db.formation.updateMany({ where: { status: "approved" }, data: { status: "superseded" } }),
    db.formation.update({ where: { version }, data: { status: "approved" } }),
  ]);
  return (await activeFormationByVersion(db, version))!;
}

/** Mentor diversity over active mentors (κ from their answered dilemma choices) and per-Voice κ among its mentors. */
export async function formationMetrics(db: PrismaClient, assignments: Record<string, string[]>) {
  const active = await db.mentor.findMany({ where: { active: true }, select: { id: true } });
  const answers = await db.mentorAnswer.findMany({ where: { status: "answered", choice: { not: null }, questionKey: { startsWith: "DL-" }, mentorId: { in: active.map((m) => m.id) } } });
  const situations = await db.situation.findMany({ where: { setKey: "dilemma" }, select: { id: true, options: true } });
  const optionCount = new Map(situations.map((s) => [s.id, (JSON.parse(s.options) as unknown[]).length]));
  const choices = new Map<string, Map<string, string>>(active.map((m) => [m.id, new Map()]));
  for (const a of answers) choices.get(a.mentorId)!.set(a.questionKey, a.choice!);
  const div = effectiveN(choices, optionCount);
  const perVoice: Record<string, { kappa: number | null; pairs: number }> = {};
  for (const [voice, ms] of Object.entries(assignments)) {
    const act = ms.filter((m) => choices.has(m));
    let sum = 0;
    let n = 0;
    for (let i = 0; i < act.length; i++)
      for (let j = i + 1; j < act.length; j++) {
        sum += kappa(choices.get(act[i])!, choices.get(act[j])!, optionCount).kappa;
        n++;
      }
    perVoice[voice] = { kappa: n ? sum / n : null, pairs: n };
  }
  return { nEff: div.nEff, activeMentors: active.length, perVoice };
}
