import type { NextRequest } from "next/server";
import { connection } from "next/server";
import { z } from "zod";
import { agreement, aiLevels, gradingCards, latestLiveReport, loadOwnerGrades, saveOwnerGrade, type Level } from "@/lib/hive/grading";

/**
 * Owner grading of live replies (decision 7). GET: the cards, the owner's saved grades, and the AI's levels
 * only for cards already graded. POST {report, cardId, grades}: saves (local/grades/, git-ignored) and
 * reveals that card's AI levels plus the running agreement.
 */
export async function GET(req: NextRequest) {
  await connection();
  const report = req.nextUrl.searchParams.get("report") ?? latestLiveReport();
  if (!report) return Response.json({ error: "no live eval report yet: run pnpm eval:live first" }, { status: 404 });
  try {
    const own = loadOwnerGrades(report);
    const revealed = Object.fromEntries(Object.keys(own.cards).map((id) => [id, aiLevels(report, id)]));
    return Response.json({ report, cards: gradingCards(report), grades: own.cards, ai: revealed, agreement: agreement(report) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

const Body = z.object({ report: z.string().min(1), cardId: z.string().min(1), grades: z.record(z.string(), z.union([z.literal(0), z.literal(1), z.literal(2)])) });

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "report, cardId and grades (0, 1 or 2 per quality) are required" }, { status: 400 });
  try {
    saveOwnerGrade(parsed.data.report, parsed.data.cardId, parsed.data.grades as Record<string, Level>);
    return Response.json({ ai: aiLevels(parsed.data.report, parsed.data.cardId), agreement: agreement(parsed.data.report) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
