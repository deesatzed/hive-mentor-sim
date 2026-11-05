import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Ledger } from "@/lib/council/ledger";
import type { LLM } from "@/lib/council/providers/llm";
import { verifyQuote } from "@/lib/council/quotes";
import { activeFormation } from "./formation";
import { promptSettings, Schemas } from "./prompts";

/**
 * The Hive's constitution (docs/PRODUCT_SPEC.md /constitution, LLM_PROMPTS.md §5). Drafted only from
 * the approved formation's verified mentor principles; every receipt quote must appear verbatim in one
 * of that mentor principle's stored receipt quotes (which were themselves verified against chunks).
 * Failing receipts are dropped; a principle with no receipts is dropped and ledgered. Only the operator
 * approves: approval turns draft version N into the approved constitution and retires what it replaces.
 * The Hive never changes its constitution itself (non-negotiable 7).
 */

export class ConstitutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstitutionError";
  }
}

export interface Receipt {
  mentorPrincipleId: string;
  mentorId: string;
  chunkId: string;
  quote: string;
}

type StoredReceipt = { chunkId: string; quote: string };

/** Keeps the receipts whose quote is verbatim (normalized) inside one of the mentor principle's stored receipts. */
export function verifyReceipts(
  receipts: { mentorPrincipleId: string; quote: string }[],
  principles: Map<string, { mentorId: string; receipts: StoredReceipt[] }>,
): { kept: Receipt[]; dropped: number } {
  const kept: Receipt[] = [];
  let dropped = 0;
  for (const r of receipts) {
    const mp = principles.get(r.mentorPrincipleId);
    const match = mp?.receipts.find((s) => verifyQuote(r.quote, s.quote));
    if (!mp || !match) {
      dropped++;
      continue;
    }
    kept.push({ mentorPrincipleId: r.mentorPrincipleId, mentorId: mp.mentorId, chunkId: match.chunkId, quote: r.quote });
  }
  return { kept, dropped };
}

export async function latestVersions(db: PrismaClient) {
  const approved = await db.hivePrinciple.findFirst({ where: { status: "approved" }, orderBy: { version: "desc" }, select: { version: true } });
  const draft = await db.hivePrinciple.findFirst({ where: { status: "draft" }, orderBy: { version: "desc" }, select: { version: true } });
  return { approved: approved?.version ?? null, draft: draft?.version ?? null };
}

/** Generates draft version N+1 from the approved formation. */
export async function draftConstitution(db: PrismaClient, llm: LLM, ledger: Ledger) {
  const f = await activeFormation(db);
  if (!f || f.status !== "approved") throw new ConstitutionError("approve a formation first; the constitution is drafted from the approved formation");
  const voices = await db.voice.findMany({ where: { class: "core" }, select: { id: true, name: true } });
  const nameOf = new Map(voices.map((v) => [v.id, v.name]));
  const idOf = new Map(voices.map((v) => [v.name, v.id]));
  const mentorIds = [...new Set(Object.values(f.assignments).flat())];
  const mentors = await db.mentor.findMany({ where: { id: { in: mentorIds }, active: true }, include: { principles: { orderBy: { id: "asc" } } } });
  const byId = new Map(mentors.map((m) => [m.id, m]));

  // short labels M1..Mn for mentor principles (long ids get miscopied; M5 finding)
  const labelToId = new Map<string, string>();
  const stored = new Map<string, { mentorId: string; receipts: StoredReceipt[] }>();
  const labelOf = new Map<string, string>();
  for (const m of mentors)
    for (const p of m.principles) {
      const label = `M${labelToId.size + 1}`;
      labelToId.set(label, p.id);
      labelOf.set(p.id, label);
      stored.set(p.id, { mentorId: m.id, receipts: JSON.parse(p.receipts) as StoredReceipt[] });
    }
  if (!stored.size) throw new ConstitutionError("the approved formation's mentors have no verified principles yet (run the corpus build)");
  const formation = Object.entries(f.assignments).map(([voiceId, ms]) => ({
    voice: nameOf.get(voiceId) ?? voiceId,
    mentors: ms
      .filter((id) => byId.has(id))
      .map((id) => {
        const m = byId.get(id)!;
        return { name: m.name, principles: m.principles.map((p) => ({ id: labelOf.get(p.id)!, text: p.text, receipts: (JSON.parse(p.receipts) as StoredReceipt[]).map((r) => ({ quote: r.quote })) })) };
      }),
  }));

  const r = await llm.generate("HIVE_CONSTITUTION_DRAFT", { formation }, Schemas.HIVE_CONSTITUTION_DRAFT, { ...promptSettings("HIVE_CONSTITUTION_DRAFT"), maxTokens: 6000, purpose: "constitution_draft" });
  const { approved, draft } = await latestVersions(db);
  const version = Math.max(approved ?? 0, draft ?? 0) + 1;
  let kept = 0;
  let dropped = 0;
  let receiptsDropped = 0;
  for (const p of r.data.principles) {
    const mapped = p.receipts.map((x) => ({ mentorPrincipleId: labelToId.get(x.mentorPrincipleId.trim().replace(/^\[|\]$/g, "")) ?? "", quote: x.quote }));
    const v = verifyReceipts(mapped, stored);
    receiptsDropped += v.dropped;
    if (!v.kept.length) {
      dropped++;
      await ledger.record({ kind: "constitution.principle_dropped", subjectType: "constitution", subjectId: String(version), payload: { text: p.text.slice(0, 200), receiptsOffered: p.receipts.length } });
      continue;
    }
    await db.hivePrinciple.create({
      data: { version, text: p.text, axis: p.axis, receipts: JSON.stringify(v.kept), voiceIds: JSON.stringify(p.voices.map((n) => idOf.get(n.toUpperCase()) ?? n).filter((x) => nameOf.has(x))), status: "draft" },
    });
    kept++;
  }
  await ledger.record({ kind: "constitution.drafted", subjectType: "constitution", subjectId: String(version), model: r.model, costUsd: r.costUsd, payload: { formationVersion: f.version, proposed: r.data.principles.length, kept, dropped, receiptsDropped } });
  return { version, proposed: r.data.principles.length, kept, dropped, receiptsDropped };
}

/** Edits a draft principle's text or axis. Approved principles change only through a new version. */
export async function editPrinciple(db: PrismaClient, id: string, patch: { text?: string; axis?: string }) {
  const p = await db.hivePrinciple.findUnique({ where: { id } });
  if (!p) throw new ConstitutionError(`no principle ${id}`);
  if (p.status !== "draft") throw new ConstitutionError("only draft principles can be edited; approved ones change through a new version");
  const text = patch.text?.trim();
  if (patch.text !== undefined && !text) throw new ConstitutionError("principle text cannot be empty");
  return db.hivePrinciple.update({ where: { id }, data: { ...(text ? { text } : {}), ...(patch.axis?.trim() ? { axis: patch.axis.trim() } : {}) } });
}

/** Operator approval: draft version N becomes the constitution; every principle of other versions still approved is retired. */
export async function approveConstitution(db: PrismaClient, ledger: Ledger, version: number, exclude: string[] = []) {
  const drafts = await db.hivePrinciple.findMany({ where: { version, status: "draft" } });
  if (!drafts.length) throw new ConstitutionError(`no draft principles in version ${version}`);
  const keep = drafts.filter((d) => !exclude.includes(d.id));
  if (!keep.length) throw new ConstitutionError("approval needs at least one principle");
  const replaced = await db.hivePrinciple.findMany({ where: { status: "approved", version: { not: version } }, select: { id: true } });
  await db.$transaction([
    db.hivePrinciple.updateMany({ where: { id: { in: replaced.map((r) => r.id) } }, data: { status: "retired" } }),
    db.hivePrinciple.updateMany({ where: { id: { in: keep.map((k) => k.id) } }, data: { status: "approved" } }),
    db.hivePrinciple.updateMany({ where: { id: { in: exclude } }, data: { status: "retired" } }),
  ]);
  await ledger.record({ kind: "constitution.approved", subjectType: "constitution", subjectId: String(version), payload: { approved: keep.length, retiredReplaced: replaced.length, excluded: exclude.length } });
  return { version, approved: keep.length, retired: replaced.length + exclude.length };
}

export async function retirePrinciple(db: PrismaClient, ledger: Ledger, id: string) {
  const p = await db.hivePrinciple.findUnique({ where: { id } });
  if (!p) throw new ConstitutionError(`no principle ${id}`);
  await db.hivePrinciple.update({ where: { id }, data: { status: "retired" } });
  await ledger.record({ kind: "constitution.retired", subjectType: "principle", subjectId: id, payload: { version: p.version } });
}
