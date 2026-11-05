import { getDb } from "@/lib/council/db";
import { ConstitutionError, draftConstitution, latestVersions } from "@/lib/hive/constitution";
import { serverProviders } from "@/lib/hive/serverProviders";

export async function GET() {
  const db = getDb();
  const rows = await db.hivePrinciple.findMany({ where: { status: { in: ["approved", "draft"] } }, orderBy: [{ version: "desc" }, { createdAt: "asc" }] });
  const mentors = new Map((await db.mentor.findMany({ select: { id: true, name: true } })).map((m) => [m.id, m.name]));
  const shape = (r: (typeof rows)[number]) => ({
    id: r.id,
    version: r.version,
    text: r.text,
    axis: r.axis,
    status: r.status,
    voiceIds: JSON.parse(r.voiceIds),
    receipts: (JSON.parse(r.receipts) as { mentorId: string; chunkId: string; quote: string }[]).map((x) => ({ ...x, mentor: mentors.get(x.mentorId) ?? x.mentorId })),
  });
  const v = await latestVersions(db);
  return Response.json({ versions: v, approved: rows.filter((r) => r.status === "approved").map(shape), draft: rows.filter((r) => r.status === "draft" && r.version === v.draft).map(shape) });
}

/** Generates a new draft version from the approved formation. */
export async function POST() {
  try {
    const { providers, ledger } = serverProviders();
    return Response.json(await draftConstitution(getDb(), providers.llm, ledger));
  } catch (e) {
    if (e instanceof ConstitutionError) return Response.json({ error: e.message }, { status: 400 });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
