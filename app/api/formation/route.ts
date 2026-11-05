import { z } from "zod";
import { getDb } from "@/lib/council/db";
import { activeFormation, formationHistory, formationMetrics, FormationError, saveFormation } from "@/lib/hive/formation";

export async function GET() {
  const db = getDb();
  const current = await activeFormation(db);
  const voices = await db.voice.findMany({ where: { class: "core" }, orderBy: { id: "asc" }, select: { id: true, name: true, attribute: true, tier: true, guilds: true } });
  const mentors = await db.mentor.findMany({ orderBy: { name: "asc" }, include: { works: { select: { title: true, translator: true, attributed: true, license: true } } } });
  const metrics = await formationMetrics(db, current?.assignments ?? {});
  return Response.json({
    current,
    history: await formationHistory(db),
    voices: voices.map((v) => ({ ...v, guilds: JSON.parse(v.guilds) })),
    mentors: mentors.map((m) => ({ id: m.id, name: m.name, years: m.years, roles: JSON.parse(m.roles), active: m.active, inactiveReason: m.inactiveReason, works: m.works, stats: JSON.parse(m.corpusStats || "{}") })),
    metrics,
  });
}

const Body = z.object({ assignments: z.record(z.string(), z.array(z.string())), note: z.string().max(200).optional() });

export async function PUT(req: Request) {
  const b = Body.safeParse(await req.json().catch(() => null));
  if (!b.success) return Response.json({ error: "assignments are required" }, { status: 400 });
  try {
    return Response.json(await saveFormation(getDb(), b.data.assignments, b.data.note));
  } catch (e) {
    if (e instanceof FormationError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
