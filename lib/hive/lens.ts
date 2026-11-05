import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { cosineSim, fromBytes } from "@/lib/council/corpus/vectors";
import type { Embedder, Reranker } from "@/lib/council/providers/embeddings";
import { search } from "@/lib/council/retrieval";

/**
 * Attribute lens (docs/ARCHITECTURE.md "Attribute lens"; MENTOR_CORPUS.md "Voice attribute lenses").
 * For each Core Voice: its assigned ACTIVE mentors only; up to 5 of each mentor's verified principles
 * (most similar to the input); the top 3 non-held-out chunks per mentor. Nothing else about the mentor:
 * no biography-as-persona. Passages are labeled P1..Pn; the label map is the only set of chunks the
 * Voice may cite, and every quote is verified against exactly the chunk its label names.
 */

export const PRINCIPLES_PER_MENTOR = 5;
export const CHUNKS_PER_MENTOR = 3;
export const BALLOT_PRINCIPLES = 6;

export interface LensPassage {
  label: string;
  chunkId: string;
  mentorId: string;
  mentorName: string;
  workTitle: string;
  locator: string;
  text: string;
}

export interface Lens {
  voiceId: string;
  mentors: { id: string; name: string; years: string; roles: string[]; principles: string[] }[];
  passages: LensPassage[];
  /** label → passage (the only chunks this Voice may cite this cycle) */
  given: Map<string, LensPassage>;
  /** rendered for _shared.md {MENTOR_LENS} */
  lensText: string;
  /** rendered for VOICE_WHISPER "Your mentor passages" */
  passagesText: string;
}

export const emptyLens = (voiceId: string): Lens => ({ voiceId, mentors: [], passages: [], given: new Map(), lensText: "", passagesText: "none" });

export async function buildLenses(args: {
  db: PrismaClient;
  embedder: Embedder;
  reranker?: Reranker | null;
  assignments: Record<string, string[]>;
  voiceIds: string[];
  query: string;
}): Promise<Map<string, Lens>> {
  const out = new Map<string, Lens>();
  const wanted = [...new Set(args.voiceIds.flatMap((v) => args.assignments[v] ?? []))];
  const mentors = wanted.length ? await args.db.mentor.findMany({ where: { id: { in: wanted }, active: true } }) : [];
  if (!mentors.length) {
    for (const v of args.voiceIds) out.set(v, emptyLens(v));
    return out;
  }
  const [qv] = await args.embedder.embed([args.query]);
  const byMentor = new Map<string, { principles: string[]; chunks: Awaited<ReturnType<typeof search>>["chunks"] }>();
  for (const m of mentors) {
    const ps = await args.db.mentorPrinciple.findMany({ where: { mentorId: m.id }, orderBy: { id: "asc" } });
    const ranked = ps
      .map((p) => {
        const v = p.embedding ? fromBytes(p.embedding) : null;
        return { text: p.text, s: v && v.length === qv.length ? cosineSim(qv, v) : 0 };
      })
      .sort((a, b) => b.s - a.s);
    const { chunks } = await search({ db: args.db, embedder: args.embedder, reranker: args.reranker, mentorIds: [m.id], query: args.query, queryVec: qv, k: CHUNKS_PER_MENTOR });
    byMentor.set(m.id, { principles: ranked.slice(0, PRINCIPLES_PER_MENTOR).map((r) => r.text), chunks });
  }
  const meta = new Map(mentors.map((m) => [m.id, m]));
  for (const v of args.voiceIds) {
    const ms = (args.assignments[v] ?? []).filter((id) => meta.has(id));
    if (!ms.length) {
      out.set(v, emptyLens(v));
      continue;
    }
    const passages: LensPassage[] = [];
    for (const id of ms)
      for (const c of byMentor.get(id)!.chunks)
        passages.push({ label: `P${passages.length + 1}`, chunkId: c.id, mentorId: id, mentorName: meta.get(id)!.name, workTitle: c.workTitle, locator: c.locator, text: c.text });
    const lensMentors = ms.map((id) => {
      const m = meta.get(id)!;
      return { id, name: m.name, years: m.years, roles: JSON.parse(m.roles) as string[], principles: byMentor.get(id)!.principles };
    });
    out.set(v, {
      voiceId: v,
      mentors: lensMentors,
      passages,
      given: new Map(passages.map((p) => [p.label, p])),
      lensText: lensMentors.map((m) => `- ${m.name} (${m.years}), ${m.roles.join(", ")}. Verified principles:\n${m.principles.map((p) => `    · ${p}`).join("\n") || "    · (none)"}`).join("\n"),
      passagesText: passages.length ? `<untrusted>\n${passages.map((p) => `[${p.label}] (${p.mentorName}, ${p.workTitle}, ${p.locator}) ${p.text}`).join("\n\n")}\n</untrusted>` : "none",
    });
  }
  return out;
}

/** Up to 6 mentor principle texts for a Voice's BALLOT state. */
export const ballotPrinciples = (lens: Lens | undefined) => (lens?.mentors ?? []).flatMap((m) => m.principles).slice(0, BALLOT_PRINCIPLES);
