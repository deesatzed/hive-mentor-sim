import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Ledger } from "@/lib/council/ledger";
import { CAVEAT, lensTable } from "@/lib/council/trackRecord";

/**
 * Hive predictions, operator check-ins, and track record (PRODUCT_SPEC.md §7). ADAPT records checkable
 * predictions in P7 with a check-in date; the operator rates the outcome 1–5 once. Track record is
 * per Voice that proposed the prediction and per mentor lens whose verified evidence it rested on;
 * below n = 10 only counts are shown, always with the caveat.
 */

export class CheckInError extends Error {}

export async function checkIn(db: PrismaClient, ledger: Ledger, id: string, rating: number, note: string | null, now = new Date()) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new CheckInError("rating must be an integer from 1 to 5");
  const p = await db.hivePrediction.findUnique({ where: { id } });
  if (!p) throw new CheckInError(`prediction ${id} not found`);
  if (p.checkedInAt) throw new CheckInError("this prediction was already checked in");
  const trimmed = note?.trim().slice(0, 1000) || null;
  const row = await db.hivePrediction.update({ where: { id }, data: { outcomeRating: rating, outcomeNote: trimmed, checkedInAt: now } });
  await ledger.record({ kind: "prediction.checked_in", cycleId: p.cycleId, subjectType: "prediction", subjectId: id, payload: { rating } });
  return row;
}

export async function predictionsView(db: PrismaClient, now = new Date()) {
  const [rows, mentors, commitments] = await Promise.all([
    db.hivePrediction.findMany({ orderBy: { checkInAt: "asc" } }),
    db.mentor.findMany({ select: { id: true, name: true } }),
    db.commitment.findMany({ orderBy: { cycleMade: "desc" } }),
  ]);
  const mentorName = new Map(mentors.map((m) => [m.id, m.name]));
  const items = rows.map((p) => ({
    id: p.id,
    cycleId: p.cycleId,
    text: p.text,
    proposedBy: p.proposedBy,
    mentors: (JSON.parse(p.mentorRefs) as string[]).map((m) => mentorName.get(m) ?? m),
    checkInAt: p.checkInAt.toISOString(),
    due: !p.checkedInAt && p.checkInAt.getTime() <= now.getTime(),
    outcomeRating: p.outcomeRating,
    outcomeNote: p.outcomeNote,
    checkedInAt: p.checkedInAt?.toISOString() ?? null,
  }));
  const rated = rows.filter((p) => p.outcomeRating !== null);
  const byVoice = lensTable(rated.map((p) => ({ lens: p.proposedBy, rating: p.outcomeRating! })));
  const byMentor = lensTable(rated.flatMap((p) => (JSON.parse(p.mentorRefs) as string[]).map((m) => ({ lens: mentorName.get(m) ?? m, rating: p.outcomeRating! }))));
  return {
    due: items.filter((i) => i.due),
    upcoming: items.filter((i) => !i.checkedInAt && !i.due),
    checkedIn: items.filter((i) => i.checkedInAt).reverse(),
    trackRecord: { byVoice, byMentor, caveat: CAVEAT },
    commitments: commitments.map((c) => ({ id: c.id, text: c.text, status: c.status, cycleMade: c.cycleMade, costType: c.costType, breakage: c.breakageRecord ? JSON.parse(c.breakageRecord) : null })),
  };
}

export const dueCount = (db: PrismaClient, now = new Date()) => db.hivePrediction.count({ where: { checkedInAt: null, checkInAt: { lte: now } } });
