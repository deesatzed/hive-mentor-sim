import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Ledger } from "@/lib/council/ledger";

/**
 * Dominant mentor (owner decision 2026-11-06, docs/CONCLAVE_MATH.md §10). One active mentor assesses the
 * Voices' positions and reasoning and makes the final call. In chat the user picks the mentor by topic,
 * before the first message, and may change it at any time (each change is ledgered). Reveal and
 * calibration use the operator's choice from /settings (OperatorSetting `dominant_mentor.ruling`).
 * The mentor judges through its own verified principles; it never speaks to the user in its own voice.
 */

export const RULING_SETTING = "dominant_mentor.ruling";

export class DominantMentorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DominantMentorError";
  }
}

export interface DominantMentor {
  id: string;
  name: string;
}

async function requireActive(db: PrismaClient, mentorId: string): Promise<DominantMentor> {
  const m = await db.mentor.findUnique({ where: { id: mentorId }, select: { id: true, name: true, active: true } });
  if (!m) throw new DominantMentorError(`unknown mentor ${mentorId}`);
  if (!m.active) throw new DominantMentorError(`${m.name} is not an active mentor`);
  return { id: m.id, name: m.name };
}

/** Active mentors a user can pick from, with their roles and a few principles to help choose by topic. */
export async function dominantChoices(db: PrismaClient) {
  const ms = await db.mentor.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, years: true, roles: true } });
  const out = [];
  for (const m of ms) {
    const ps = await db.mentorPrinciple.findMany({ where: { mentorId: m.id }, orderBy: { id: "asc" }, take: 3, select: { text: true } });
    out.push({ id: m.id, name: m.name, years: m.years, roles: JSON.parse(m.roles) as string[], principles: ps.map((p) => p.text) });
  }
  return out;
}

export async function sessionDominant(db: PrismaClient, sessionId: string): Promise<DominantMentor | null> {
  const s = await db.hiveSession.findUnique({ where: { id: sessionId }, select: { dominantMentorId: true } });
  if (!s?.dominantMentorId) return null;
  const m = await db.mentor.findUnique({ where: { id: s.dominantMentorId }, select: { id: true, name: true, active: true } });
  return m?.active ? { id: m.id, name: m.name } : null;
}

/** Sets (or changes) a session's dominant mentor; the change is ledgered. */
export async function setSessionDominant(db: PrismaClient, ledger: Ledger, sessionId: string, mentorId: string): Promise<DominantMentor> {
  const m = await requireActive(db, mentorId);
  const s = await db.hiveSession.findUnique({ where: { id: sessionId }, select: { dominantMentorId: true } });
  if (!s) throw new DominantMentorError("no such session");
  if (s.dominantMentorId === m.id) return m;
  await db.hiveSession.update({ where: { id: sessionId }, data: { dominantMentorId: m.id } });
  await ledger.record({ kind: "session.dominant_mentor", subjectType: "session", subjectId: sessionId, payload: { from: s.dominantMentorId, to: m.id } });
  return m;
}

export async function rulingDominant(db: PrismaClient): Promise<DominantMentor | null> {
  const row = await db.operatorSetting.findUnique({ where: { key: RULING_SETTING } });
  if (!row?.value) return null;
  const m = await db.mentor.findUnique({ where: { id: row.value }, select: { id: true, name: true, active: true } });
  return m?.active ? { id: m.id, name: m.name } : null;
}

/** Operator choice for Reveal and calibration (null clears it: those runs then use the vote alone). */
export async function setRulingDominant(db: PrismaClient, ledger: Ledger, mentorId: string | null): Promise<DominantMentor | null> {
  const before = (await db.operatorSetting.findUnique({ where: { key: RULING_SETTING } }))?.value ?? null;
  const m = mentorId ? await requireActive(db, mentorId) : null;
  if (m) await db.operatorSetting.upsert({ where: { key: RULING_SETTING }, create: { key: RULING_SETTING, value: m.id }, update: { value: m.id } });
  else await db.operatorSetting.deleteMany({ where: { key: RULING_SETTING } });
  if (before !== (m?.id ?? null)) await ledger.record({ kind: "settings.dominant_mentor", payload: { from: before, to: m?.id ?? null } });
  return m;
}
