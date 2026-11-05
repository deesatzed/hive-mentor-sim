import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { cosineSim, fromBytes } from "./corpus/vectors";
import type { Embedder, Reranker } from "./providers/embeddings";

/**
 * Corpus retrieval. Held-out chunks are NEVER returned (they exist only for the fidelity eval).
 * Only chunks embedded with the current embedding model are searched; retrieval refuses to mix
 * models (chunks embedded with another model are counted as skipped). Optional reranking narrows
 * the embedding candidates with the configured reranker.
 */

export interface RetrievedChunk {
  id: string;
  mentorId: string;
  workId: string;
  workTitle: string;
  locator: string;
  text: string;
  score: number;
}

export interface SearchResult {
  chunks: RetrievedChunk[];
  skippedOtherModel: number;
}

type Cached = { id: string; mentorId: string; workId: string; workTitle: string; locator: string; text: string; vec: Float32Array };
const cache = new Map<string, Cached[]>();

/** Clears the in-process vector cache (after re-embedding or between tests). */
export function clearRetrievalCache(): void {
  cache.clear();
}

async function load(db: PrismaClient, mentorId: string, model: string): Promise<{ rows: Cached[]; skipped: number }> {
  const key = `${mentorId}|${model}`;
  const hit = cache.get(key);
  const skipped = await db.corpusChunk.count({ where: { mentorId, heldOut: false, embedding: { not: null }, NOT: { embedModel: model } } });
  if (hit) return { rows: hit, skipped };
  const rows = await db.corpusChunk.findMany({
    where: { mentorId, heldOut: false, embedModel: model, embedding: { not: null } },
    select: { id: true, mentorId: true, workId: true, locator: true, text: true, embedding: true, work: { select: { title: true } } },
    orderBy: { ordinal: "asc" },
  });
  const out = rows.map((r) => ({ id: r.id, mentorId: r.mentorId, workId: r.workId, workTitle: r.work.title, locator: r.locator, text: r.text, vec: fromBytes(r.embedding!) }));
  cache.set(key, out);
  return { rows: out, skipped };
}

export async function search(args: {
  db: PrismaClient;
  embedder: Embedder;
  reranker?: Reranker | null;
  mentorIds: string[];
  query: string;
  k: number;
  /** embedding candidates passed to the reranker (default 3k) */
  candidates?: number;
  /** a precomputed embedding of `query` (same embedder), to embed once per cycle */
  queryVec?: Float32Array;
}): Promise<SearchResult> {
  if (args.k <= 0 || !args.mentorIds.length) return { chunks: [], skippedOtherModel: 0 };
  const q = args.queryVec ?? (await args.embedder.embed([args.query]))[0];
  const model = args.embedder.model;
  let skipped = 0;
  const pool: RetrievedChunk[] = [];
  for (const m of args.mentorIds) {
    const { rows, skipped: s } = await load(args.db, m, model);
    skipped += s;
    for (const r of rows) pool.push({ id: r.id, mentorId: r.mentorId, workId: r.workId, workTitle: r.workTitle, locator: r.locator, text: r.text, score: cosineSim(q, r.vec) });
  }
  pool.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const cand = pool.slice(0, args.reranker ? (args.candidates ?? args.k * 3) : args.k);
  if (!args.reranker || cand.length <= 1) return { chunks: cand.slice(0, args.k), skippedOtherModel: skipped };
  const ranked = await args.reranker.rerank(args.query, cand.map((c) => c.text), args.k);
  return { chunks: ranked.slice(0, args.k).map((r) => ({ ...cand[r.index], score: r.score })), skippedOtherModel: skipped };
}
