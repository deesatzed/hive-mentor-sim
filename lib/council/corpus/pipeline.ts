import "server-only";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Ledger } from "../ledger";
import type { Providers } from "../providers";
import { GenerationError } from "../providers/llm";
import { quoteRejection, verifyQuote } from "../quotes";
import { clearRetrievalCache, search } from "../retrieval";
import { promptSettings, Schemas } from "@/lib/hive/prompts";
import { hiveConfig } from "@/lib/hive/config";
import { AUTHORIAL, EPISODE_TAG, EVIDENCE_SUPPORTS, POSITION_TAG, T } from "@/lib/hive/questions";
import { fetchGutenberg, fetchWikisourceLetters, realGet, type GetText } from "./fetch";
import { scenarioLeaks } from "./fidelity";
import { chunkWork, wordCount } from "./text";
import { mapLimit, toBytes } from "./vectors";

/**
 * The mentor corpus pipeline (docs/MENTOR_CORPUS.md): fetch → chunk → authorial → embed → tag →
 * holdout → fingerprint → principles → fidelity → activate. Each step is resumable: it records its
 * status, counts, and measured cost in Mentor.corpusStats.steps and is skipped when already done
 * (unless forced). A failing step marks the mentor inactive with the reason and the build moves on.
 */

export const STEPS = ["fetch", "chunk", "authorial", "embed", "tag", "holdout", "fingerprint", "principles", "fidelity", "activate"] as const;
export type Step = (typeof STEPS)[number];

/** Activation thresholds from config/hive.yaml `corpus.activation` (owner lowered dilemmas 15 → 13 on 2026-11-04). */
const act = () => hiveConfig().corpus.activation;
export const ACTIVATION = {
  get dilemmasAnswered() { return act().dilemmas_answered; },
  get principles() { return act().principles; },
  get receiptsPerPrinciple() { return act().receipts_per_principle; },
};
export const minAuthorialWords = () => act().min_authorial_words;
const PASSAGES_K = 8;

type Source =
  | { mentorId: string; rosterTitle: string; source: "gutenberg"; gutenbergId: number; gutenbergTitle: string; translator?: string; attributed?: boolean; rights: string }
  | { mentorId: string; rosterTitle: string; source: "wikisource"; index: string; translator?: string; attributed?: boolean; rights: string };
type Sources = { works: Source[]; unavailable: { mentorId: string; rosterTitle: string; reason: string }[] };
type RosterMentor = { id: string; name: string; years: string; roles: string[]; works: { title: string; translator?: string; attributed?: boolean }[] };

export interface StepStatus {
  status: "done" | "failed" | "skipped";
  at: string;
  costUsd: number;
  detail: Record<string, unknown>;
}
export interface CorpusStats {
  steps: Partial<Record<Step, StepStatus>>;
  works?: number;
  chunks?: number;
  authorialWords?: number;
  episodes?: number;
  positions?: number;
  heldOut?: number;
  answered?: number;
  noEvidence?: number;
  principles?: number;
  fidelity?: FidelitySummary;
}
export interface FidelitySummary {
  generated: number;
  discardedLeaks: number;
  n: number;
  fingerprintCorrect: number;
  fingerprintAnswered: number;
  abstained: number;
  nameOnlyCorrect: number;
  nameOnlyAnswered: number;
  chance: number;
}

export interface BuilderDeps {
  db: PrismaClient;
  providers: Providers;
  ledger: Ledger;
  rawRoot?: string;
  sourcesFile?: string;
  get?: GetText;
  concurrency?: number;
  log?: (msg: string) => void;
  /** include the 196 question-bank items in the fingerprint (default: dilemmas only) */
  bank?: boolean;
  /** wikisource letters to fetch (tests use fewer) */
  maxLetters?: number;
}

class StepError extends Error {}

const root = () => /*turbopackIgnore: true*/ process.cwd();
const readJson = <T>(rel: string) => JSON.parse(readFileSync(path.join(root(), rel), "utf8")) as T;

export class CorpusBuilder {
  private readonly db: PrismaClient;
  private readonly p: Providers;
  private readonly ledger: Ledger;
  private readonly rawRoot: string;
  private readonly sources: Sources;
  private readonly roster: Map<string, RosterMentor>;
  private readonly get: GetText;
  private readonly conc: number;
  private readonly log: (m: string) => void;

  constructor(private readonly d: BuilderDeps) {
    this.db = d.db;
    this.p = d.providers;
    this.ledger = d.ledger;
    this.rawRoot = d.rawRoot ?? path.join(root(), "corpus", "raw");
    this.sources = d.sourcesFile ? (JSON.parse(readFileSync(d.sourcesFile, "utf8")) as Sources) : readJson<Sources>("seed/corpus_sources.json");
    this.roster = new Map(readJson<{ mentors: RosterMentor[] }>("seed/mentor_roster.json").mentors.map((m) => [m.id, m]));
    this.get = d.get ?? realGet;
    this.conc = d.concurrency ?? 6;
    this.log = d.log ?? (() => {});
  }

  mentorIds(): string[] {
    return [...this.roster.keys()];
  }

  async stats(mentorId: string): Promise<CorpusStats> {
    const m = await this.db.mentor.findUniqueOrThrow({ where: { id: mentorId }, select: { corpusStats: true } });
    const s = JSON.parse(m.corpusStats || "{}") as CorpusStats;
    return { ...s, steps: s.steps ?? {} };
  }

  private async saveStats(mentorId: string, patch: Partial<CorpusStats>, step?: Step, status?: StepStatus) {
    const cur = await this.stats(mentorId);
    const next: CorpusStats = { ...cur, ...patch, steps: { ...cur.steps, ...(step && status ? { [step]: status } : {}) } };
    await this.db.mentor.update({ where: { id: mentorId }, data: { corpusStats: JSON.stringify(next) } });
  }

  private async deactivate(mentorId: string, reason: string) {
    await this.db.mentor.update({ where: { id: mentorId }, data: { active: false, inactiveReason: reason } });
  }

  /** Runs the steps for one mentor. Returns the final status of each step run. */
  async build(mentorId: string, opts: { steps?: Step[]; force?: boolean } = {}): Promise<Partial<Record<Step, StepStatus>>> {
    if (!this.roster.has(mentorId)) throw new Error(`unknown mentor ${mentorId}`);
    const unavailable = this.sources.unavailable.find((u) => u.mentorId === mentorId);
    if (unavailable && !this.sources.works.some((w) => w.mentorId === mentorId)) {
      await this.deactivate(mentorId, `source unavailable: ${unavailable.rosterTitle} — ${unavailable.reason}`);
      this.log(`${mentorId}: inactive (${unavailable.reason})`);
      return {};
    }
    const steps = opts.steps ?? [...STEPS];
    const done: Partial<Record<Step, StepStatus>> = {};
    for (const step of steps) {
      const prior = (await this.stats(mentorId)).steps[step];
      if (prior?.status === "done" && !opts.force) {
        done[step] = { ...prior, status: "skipped" };
        continue;
      }
      const spent0 = this.p.meter.spentUsd;
      try {
        this.log(`${mentorId}: ${step} …`);
        const detail = await this.run(step, mentorId);
        const st: StepStatus = { status: "done", at: new Date().toISOString(), costUsd: this.p.meter.spentUsd - spent0, detail };
        await this.saveStats(mentorId, {}, step, st);
        done[step] = st;
        this.log(`${mentorId}: ${step} done ${JSON.stringify(detail)} ($${st.costUsd.toFixed(6)})`);
        if (detail.stop) break;
      } catch (e) {
        const st: StepStatus = { status: "failed", at: new Date().toISOString(), costUsd: this.p.meter.spentUsd - spent0, detail: { error: (e as Error).message.slice(0, 400) } };
        await this.saveStats(mentorId, {}, step, st);
        await this.deactivate(mentorId, `corpus step ${step} failed: ${(e as Error).message.slice(0, 200)}`);
        done[step] = st;
        this.log(`${mentorId}: ${step} FAILED ${(e as Error).message}`);
        break;
      }
    }
    return done;
  }

  private run(step: Step, mentorId: string): Promise<Record<string, unknown>> {
    switch (step) {
      case "fetch": return this.fetchStep(mentorId);
      case "chunk": return this.chunkStep(mentorId);
      case "authorial": return this.authorialStep(mentorId);
      case "embed": return this.embedStep(mentorId);
      case "tag": return this.tagStep(mentorId);
      case "holdout": return this.holdoutStep(mentorId);
      case "fingerprint": return this.fingerprintStep(mentorId);
      case "principles": return this.principlesStep(mentorId);
      case "fidelity": return this.fidelityStep(mentorId);
      case "activate": return this.activateStep(mentorId);
    }
  }

  // ------------------------------------------------------------- 1. fetch
  private async fetchStep(mentorId: string) {
    const works = this.sources.works.filter((w) => w.mentorId === mentorId);
    if (!works.length) throw new StepError("no sources listed");
    const dir = path.join(this.rawRoot, mentorId);
    let fetched = 0;
    const failed: string[] = [];
    for (const w of works) {
      try {
        const f = w.source === "gutenberg" ? await fetchGutenberg(w.gutenbergId, dir, this.get) : await fetchWikisourceLetters(w.index, path.join(dir, "wikisource"), this.get, this.d.maxLetters);
        const title = w.source === "gutenberg" ? w.gutenbergTitle : w.rosterTitle;
        writeFileSync(path.join(dir, `${createHash("sha1").update(f.sourceUrl).digest("hex").slice(0, 10)}.clean.txt`), f.text);
        const existing = await this.db.corpusWork.findFirst({ where: { mentorId, sourceUrl: f.sourceUrl } });
        const data = { title, translator: w.translator ?? null, attributed: w.attributed ?? false, license: f.license, sha256: f.sha256 };
        if (existing) await this.db.corpusWork.update({ where: { id: existing.id }, data });
        else await this.db.corpusWork.create({ data: { mentorId, sourceUrl: f.sourceUrl, ...data } });
        fetched++;
      } catch (e) {
        failed.push(`${w.rosterTitle}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
    await this.saveStats(mentorId, { works: fetched });
    if (!fetched) throw new StepError(`no work fetched (${failed.join("; ")})`);
    return { fetched, failed };
  }

  private cleanText(mentorId: string, sourceUrl: string): string {
    return readFileSync(path.join(this.rawRoot, mentorId, `${createHash("sha1").update(sourceUrl).digest("hex").slice(0, 10)}.clean.txt`), "utf8");
  }

  // ------------------------------------------------------------- 2. chunk
  private async chunkStep(mentorId: string) {
    const works = await this.db.corpusWork.findMany({ where: { mentorId } });
    let total = 0;
    for (const w of works) {
      await this.db.corpusChunk.deleteMany({ where: { workId: w.id } });
      const chunks = chunkWork(w.title, this.cleanText(mentorId, w.sourceUrl));
      await this.db.corpusChunk.createMany({ data: chunks.map((c) => ({ workId: w.id, mentorId, locator: c.locator, ordinal: c.ordinal, text: c.text, tokenCount: c.tokenCount })) });
      total += chunks.length;
    }
    clearRetrievalCache();
    await this.saveStats(mentorId, { chunks: total });
    return { chunks: total };
  }

  // ------------------------------------------------------------- 3. authorial filter
  private async authorialStep(mentorId: string) {
    const m = this.roster.get(mentorId)!;
    const works = await this.db.corpusWork.findMany({ where: { mentorId } });
    let dropped = 0;
    let unavailable = 0;
    for (const w of works) {
      const chunks = await this.db.corpusChunk.findMany({ where: { workId: w.id }, orderBy: { ordinal: "asc" }, select: { id: true, text: true } });
      const batches: (typeof chunks)[] = [];
      for (let i = 0; i < chunks.length; i += 8) batches.push(chunks.slice(i, i + 8));
      const results = await mapLimit(batches, this.conc, async (b) => {
        try {
          const r = await this.p.decider.decide(
            { author: m.name, work: w.title, translator: w.translator ?? "none", passages: Object.fromEntries(b.map((c, i) => [`a_${i + 1}`, c.text])) },
            AUTHORIAL(b.map((_, i) => i + 1)),
            { purpose: "authorial" },
          );
          return b.map((c, i) => ({ id: c.id, keep: r.p(`a_${i + 1}`) >= T.AUTHORIAL }));
        } catch (e) {
          if ((e as Error).name === "DecisionUnavailableError") {
            unavailable += b.length;
            return b.map((c) => ({ id: c.id, keep: true })); // fallback: keep, counted as unavailable
          }
          throw e;
        }
      });
      const drop = results.flat().filter((x) => !x.keep).map((x) => x.id);
      dropped += drop.length;
      if (drop.length) await this.db.corpusChunk.deleteMany({ where: { id: { in: drop } } });
    }
    const kept = await this.db.corpusChunk.findMany({ where: { mentorId }, select: { text: true } });
    const words = kept.reduce((s, c) => s + wordCount(c.text), 0);
    clearRetrievalCache();
    await this.saveStats(mentorId, { chunks: kept.length, authorialWords: words });
    if (words < minAuthorialWords()) {
      await this.deactivate(mentorId, `insufficient authorial text: ${words} words < ${minAuthorialWords()}`);
      return { kept: kept.length, dropped, authorialWords: words, unavailable, stop: true, reason: "insufficient authorial text" };
    }
    return { kept: kept.length, dropped, authorialWords: words, unavailable };
  }

  // ------------------------------------------------------------- 4. embed
  private async embedStep(mentorId: string) {
    const emb = this.p.embedder;
    const pending = await this.db.corpusChunk.findMany({ where: { mentorId }, select: { id: true, text: true, embedModel: true }, orderBy: { ordinal: "asc" } });
    const todo = pending.filter((c) => c.embedModel !== emb.model || c.embedModel === null);
    const batches: (typeof todo)[] = [];
    for (let i = 0; i < todo.length; i += 32) batches.push(todo.slice(i, i + 32));
    let model = emb.model;
    await mapLimit(batches, Math.min(this.conc, 4), async (b) => {
      const vecs = await emb.embed(b.map((c) => c.text));
      model = emb.model;
      for (let i = 0; i < b.length; i++) await this.db.corpusChunk.update({ where: { id: b[i].id }, data: { embedding: toBytes(vecs[i]), embedModel: emb.model } });
    });
    clearRetrievalCache();
    return { embedded: todo.length, model, dim: emb.dim };
  }

  // ------------------------------------------------------------- 5. episode and position tags
  private async tagStep(mentorId: string) {
    const m = this.roster.get(mentorId)!;
    const chunks = await this.db.corpusChunk.findMany({ where: { mentorId }, include: { work: { select: { title: true } } }, orderBy: [{ workId: "asc" }, { ordinal: "asc" }] });
    const batches: (typeof chunks)[] = [];
    for (let i = 0; i < chunks.length; i += 6) batches.push(chunks.slice(i, i + 6)); // 6 chunks × 2 questions = 12 per request
    let episodes = 0;
    let positions = 0;
    let unavailable = 0;
    await mapLimit(batches, this.conc, async (b) => {
      const ns = b.map((_, i) => i + 1);
      try {
        const r = await this.p.decider.decide(
          { author: m.name, work: b[0].work.title, passages: Object.fromEntries(b.flatMap((c, i) => [[`e_${i + 1}`, c.text], [`t_${i + 1}`, c.text]])) },
          { ...EPISODE_TAG(ns), ...POSITION_TAG(ns) },
          { purpose: "corpus_tag" },
        );
        for (let i = 0; i < b.length; i++) {
          const ep = r.p(`e_${i + 1}`);
          const pos = r.p(`t_${i + 1}`) >= 0.5;
          if (ep >= T.EPISODE) episodes++;
          if (pos) positions++;
          await this.db.corpusChunk.update({ where: { id: b[i].id }, data: { isEpisode: ep >= T.EPISODE, episodeP: ep, isPosition: pos } });
        }
      } catch (e) {
        if ((e as Error).name !== "DecisionUnavailableError") throw e;
        unavailable += b.length;
      }
    });
    await this.saveStats(mentorId, { episodes, positions });
    return { episodes, positions, unavailable };
  }

  // ------------------------------------------------------------- 6. hold out
  private async holdoutStep(mentorId: string) {
    await this.db.corpusChunk.updateMany({ where: { mentorId }, data: { heldOut: false } });
    const pos = await this.db.corpusChunk.findMany({ where: { mentorId, isPosition: true }, select: { id: true } });
    const seed = (id: string) => createHash("sha256").update(`${mentorId}:${id}`).digest("hex"); // fixed seed: hash(slug)
    const n = Math.min(40, Math.ceil(pos.length * 0.1));
    const chosen = [...pos].sort((a, b) => (seed(a.id) < seed(b.id) ? -1 : 1)).slice(0, n).map((c) => c.id);
    if (chosen.length) await this.db.corpusChunk.updateMany({ where: { id: { in: chosen } }, data: { heldOut: true } });
    clearRetrievalCache();
    await this.saveStats(mentorId, { heldOut: chosen.length });
    return { positionChunks: pos.length, heldOut: chosen.length };
  }

  // ------------------------------------------------------------- 7. fingerprint
  /** Retrieves passages, asks MENTOR_ANSWER, verifies every quote against the cited chunk, then EVIDENCE_SUPPORTS. */
  async answer(mentorId: string, q: { key: string; text: string; options?: { id: string; text: string }[] }, opts: { store: boolean }) {
    const m = this.roster.get(mentorId)!;
    const query = `${q.text}\n${(q.options ?? []).map((o) => o.text).join("\n")}`;
    const { chunks } = await search({ db: this.db, embedder: this.p.embedder, reranker: this.p.reranker, mentorIds: [mentorId], query, k: PASSAGES_K });
    // short labels P1..Pk instead of database ids: the model miscopied long ids (M5 live finding);
    // code maps each label back to its chunk, and the quote is verified against exactly that chunk
    const given = new Map(chunks.map((c, i) => [`P${i + 1}`, c]));
    const passages = chunks.map((c, i) => `[P${i + 1}] (${m.name}, ${c.workTitle}, ${c.locator}) ${c.text}`).join("\n\n");
    let data: { status: "answered" | "no_evidence"; answer: string; choice: string; evidence: { chunkId: string; quote: string }[] } | null = null;
    let model = "none";
    try {
      const r = await this.p.llm.generate("MENTOR_ANSWER", { name: m.name, years: m.years, questionKey: q.key, text: q.text, options: q.options, passages }, Schemas.MENTOR_ANSWER, { ...promptSettings("MENTOR_ANSWER"), purpose: "mentor_answer" });
      data = r.data;
      model = r.model;
    } catch (e) {
      if (!(e instanceof GenerationError)) throw e;
    }
    const evidence: { chunkId: string; quote: string }[] = [];
    let rejected = 0;
    for (const ev of data?.evidence ?? []) {
      const chunk = given.get(ev.chunkId.trim().replace(/^\[|\]$/g, ""));
      const reason = chunk ? quoteRejection(ev.quote, chunk.text) : "chunk_not_given";
      if (reason) {
        rejected++;
        await this.ledger.record({ kind: "quote.rejected", subjectType: "mentor", subjectId: mentorId, payload: { promptId: "MENTOR_ANSWER", questionKey: q.key, label: ev.chunkId, chunkId: chunk?.id ?? null, reason, quote: ev.quote.slice(0, 200) } });
      } else evidence.push({ chunkId: chunk!.id, quote: ev.quote });
    }
    let status: "answered" | "no_evidence" = data?.status === "answered" && evidence.length ? "answered" : "no_evidence";
    // option ids match case-insensitively ("A" → "a"); an id not among the options is dropped
    const picked = data?.choice ? (q.options ?? []).find((o) => o.id.toLowerCase() === data!.choice.trim().toLowerCase()) : undefined;
    const choice = picked?.id;
    if (data?.status === "answered" && !data.answer.trim()) status = "no_evidence"; // nothing to support
    if (status === "answered") {
      try {
        const s = await this.p.decider.decide({ question: q.text, answer: `${data!.answer.trim()}${picked ? ` Chosen option: ${picked.text}` : ""}`, quote: evidence[0].quote }, EVIDENCE_SUPPORTS(), { purpose: "evidence_supports" });
        if (s.p("supports") < T.EVIDENCE_SUPPORTS) status = "no_evidence";
      } catch (e) {
        if ((e as Error).name !== "DecisionUnavailableError") throw e;
        status = "no_evidence"; // cannot confirm support: do not claim evidence
      }
    }
    const result = { status, answer: status === "answered" ? data?.answer.trim() : undefined, choice: status === "answered" ? choice : undefined, evidence: status === "answered" ? evidence : [], rejected, model };
    if (opts.store)
      await this.db.mentorAnswer.upsert({
        where: { mentorId_questionKey: { mentorId, questionKey: q.key } },
        create: { mentorId, questionKey: q.key, status, answer: result.answer ?? null, choice: result.choice ?? null, evidence: JSON.stringify(result.evidence), model },
        update: { status, answer: result.answer ?? null, choice: result.choice ?? null, evidence: JSON.stringify(result.evidence), model },
      });
    return result;
  }

  private async fingerprintStep(mentorId: string) {
    const dilemmas = await this.db.situation.findMany({ where: { setKey: "dilemma" }, orderBy: { id: "asc" } });
    const qs: { key: string; text: string; options?: { id: string; text: string }[] }[] = dilemmas.map((d) => ({ key: d.id, text: d.text, options: JSON.parse(d.options) }));
    if (this.d.bank) {
      const bank = readJson<{ questions: { id: string; text: string }[] }>("seed/question_bank_subset.json").questions;
      qs.push(...bank.map((b) => ({ key: b.id, text: b.text })));
    }
    const res = await mapLimit(qs, this.conc, (q) => this.answer(mentorId, q, { store: true }));
    const answeredDilemmas = res.filter((r, i) => r.status === "answered" && qs[i].key.startsWith("DL-")).length;
    const answered = res.filter((r) => r.status === "answered").length;
    await this.saveStats(mentorId, { answered, noEvidence: res.length - answered });
    return { questions: qs.length, answered, answeredDilemmas, noEvidence: res.length - answered, quotesRejected: res.reduce((s, r) => s + r.rejected, 0) };
  }

  // ------------------------------------------------------------- 7b. principles
  private async principlesStep(mentorId: string) {
    const m = this.roster.get(mentorId)!;
    const answers = await this.db.mentorAnswer.findMany({ where: { mentorId, status: "answered" }, orderBy: { questionKey: "asc" } });
    const stored = answers.map((a) => ({ questionKey: a.questionKey, answer: a.answer, choice: a.choice, evidence: JSON.parse(a.evidence) as { chunkId: string; quote: string }[] }));
    const allowedChunks = new Set(stored.flatMap((a) => a.evidence.map((e) => e.chunkId)));
    // short labels E1..En for the cited chunks (same reason as P-labels in answer())
    const labelOf = new Map([...allowedChunks].map((id, i) => [id, `E${i + 1}`]));
    const idOf = new Map([...labelOf].map(([id, l]) => [l, id]));
    const ev = stored.map((a) => ({ ...a, evidence: a.evidence.map((e) => ({ chunkId: labelOf.get(e.chunkId)!, quote: e.quote })) }));
    await this.db.mentorPrinciple.deleteMany({ where: { mentorId } });
    if (!ev.length) return { principles: 0, dropped: 0, reason: "no answered questions with evidence" };
    let data: { principles: { text: string; axis: string; receipts: { chunkId: string; quote: string }[] }[] } = { principles: [] };
    try {
      data = (await this.p.llm.generate("MENTOR_PRINCIPLES", { name: m.name, answers: ev }, Schemas.MENTOR_PRINCIPLES, { ...promptSettings("MENTOR_PRINCIPLES"), maxTokens: 4000, purpose: "mentor_principles" })).data;
    } catch (e) {
      if (!(e instanceof GenerationError)) throw e;
    }
    const chunkText = new Map((await this.db.corpusChunk.findMany({ where: { id: { in: [...allowedChunks] } }, select: { id: true, text: true } })).map((c) => [c.id, c.text]));
    let kept = 0;
    let dropped = 0;
    const keptRows: { text: string; axis: string; receipts: { chunkId: string; quote: string }[] }[] = [];
    for (const pr of data.principles) {
      const receipts = pr.receipts
        .map((r) => ({ chunkId: idOf.get(r.chunkId.trim().replace(/^\[|\]$/g, "")) ?? "", quote: r.quote }))
        .filter((r) => allowedChunks.has(r.chunkId) && chunkText.has(r.chunkId) && verifyQuote(r.quote, chunkText.get(r.chunkId)!));
      if (receipts.length < ACTIVATION.receiptsPerPrinciple) {
        dropped++;
        continue;
      }
      keptRows.push({ text: pr.text, axis: pr.axis, receipts });
      kept++;
    }
    const vecs = keptRows.length ? await this.p.embedder.embed(keptRows.map((r) => r.text)) : [];
    for (let i = 0; i < keptRows.length; i++)
      await this.db.mentorPrinciple.create({ data: { mentorId, text: keptRows[i].text, axis: keptRows[i].axis, receipts: JSON.stringify(keptRows[i].receipts), embedding: toBytes(vecs[i]) } });
    await this.saveStats(mentorId, { principles: kept });
    return { proposed: data.principles.length, principles: kept, dropped };
  }

  // ------------------------------------------------------------- 8. fidelity eval
  private async fidelityStep(mentorId: string) {
    const m = this.roster.get(mentorId)!;
    const held = await this.db.corpusChunk.findMany({ where: { mentorId, heldOut: true }, orderBy: { ordinal: "asc" } });
    const titles = (await this.db.corpusWork.findMany({ where: { mentorId }, select: { title: true } })).map((w) => w.title).concat(m.works.map((w) => w.title));
    let discarded = 0;
    let generated = 0;
    const rows = await mapLimit(held, this.conc, async (c) => {
      let sc: { scenario: string; options: { id: string; text: string }[]; goldOption: string } | null = null;
      try {
        sc = (await this.p.llm.generate("FIDELITY_SCENARIO", { passage: c.text }, Schemas.FIDELITY_SCENARIO, { ...promptSettings("FIDELITY_SCENARIO"), purpose: "fidelity_scenario" })).data;
      } catch (e) {
        if (!(e instanceof GenerationError)) throw e;
        return null;
      }
      generated++;
      if (!sc.options.some((o) => o.id === sc!.goldOption) || sc.options.length < 2) {
        discarded++;
        return null;
      }
      if (scenarioLeaks({ scenario: sc.scenario, options: sc.options, passage: c.text, authorName: m.name, workTitles: titles }).leaks) {
        discarded++;
        return null;
      }
      const fp = await this.answer(mentorId, { key: `FID-${c.id}`, text: sc.scenario, options: sc.options }, { store: false });
      let nameOnly: string | null = null;
      try {
        nameOnly = (await this.p.llm.generate("NAME_ONLY_BASELINE", { name: m.name, years: m.years, scenario: sc.scenario, options: sc.options }, Schemas.NAME_ONLY_BASELINE, { ...promptSettings("NAME_ONLY_BASELINE"), purpose: "fidelity_name_only" })).data.choice.trim();
      } catch (e) {
        if (!(e instanceof GenerationError)) throw e;
      }
      return { gold: sc.goldOption, fingerprint: fp.status === "answered" ? (fp.choice ?? null) : null, nameOnly, options: sc.options.length };
    });
    const ok = rows.filter((r): r is NonNullable<typeof r> => r !== null);
    const answeredFp = ok.filter((r) => r.fingerprint !== null);
    const answeredNo = ok.filter((r) => r.nameOnly !== null && r.nameOnly !== "");
    const f: FidelitySummary = {
      generated,
      discardedLeaks: discarded,
      n: ok.length,
      fingerprintCorrect: answeredFp.filter((r) => r.fingerprint === r.gold).length,
      fingerprintAnswered: answeredFp.length,
      abstained: ok.length - answeredFp.length,
      nameOnlyCorrect: answeredNo.filter((r) => r.nameOnly === r.gold).length,
      nameOnlyAnswered: answeredNo.length,
      chance: ok.length ? ok.reduce((s, r) => s + 1 / r.options, 0) / ok.length : 0,
    };
    await this.saveStats(mentorId, { fidelity: f });
    await this.writeFidelityReport();
    return { ...f };
  }

  /** reports/mentor_fidelity.md over every mentor that has a fidelity summary. */
  async writeFidelityReport(): Promise<string> {
    const mentors = await this.db.mentor.findMany({ orderBy: { id: "asc" } });
    const lines = [
      "# Mentor fidelity report",
      "",
      `Generated ${new Date().toISOString().slice(0, 10)} by \`pnpm corpus build\`. Held-out passages (never retrievable) were turned into neutral scenarios; scenarios that shared a 6-word sequence with their passage or named the author or a work were discarded.`,
      "",
      "**How to read this.** Famous figures are in the base model's training data, so a high name-only score means the model already \"knows\" them; the fingerprint's value shows up as grounding (every answer cites verified passages) and as abstaining when the passages do not address a case, not only as accuracy. These numbers are k of n on a small set: they say how often the Hive's grounded reading of the texts matched the author's own stated choice, never \"what this person would think.\"",
      "",
      "| Mentor | Scenarios kept (n) | Discarded | Fingerprint correct / answered | Abstained | Name-only correct / answered | Chance |",
      "|---|---|---|---|---|---|---|",
    ];
    for (const m of mentors) {
      const f = (JSON.parse(m.corpusStats || "{}") as CorpusStats).fidelity;
      if (!f) continue;
      lines.push(`| ${m.name} | ${f.n} | ${f.discardedLeaks} | ${f.fingerprintCorrect} / ${f.fingerprintAnswered} | ${f.abstained} | ${f.nameOnlyCorrect} / ${f.nameOnlyAnswered} | ${f.chance.toFixed(2)} |`);
    }
    const file = path.join(root(), "reports", "mentor_fidelity.md");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  // ------------------------------------------------------------- 9. activate
  private async activateStep(mentorId: string) {
    const s = await this.stats(mentorId);
    const dilemmas = await this.db.mentorAnswer.count({ where: { mentorId, status: "answered", questionKey: { startsWith: "DL-" } } });
    const principles = await this.db.mentorPrinciple.findMany({ where: { mentorId }, select: { receipts: true } });
    const strong = principles.filter((p) => (JSON.parse(p.receipts) as unknown[]).length >= ACTIVATION.receiptsPerPrinciple).length;
    const reasons: string[] = [];
    if ((s.authorialWords ?? 0) < minAuthorialWords()) reasons.push(`authorial words ${s.authorialWords ?? 0} < ${minAuthorialWords()}`);
    if (dilemmas < ACTIVATION.dilemmasAnswered) reasons.push(`dilemmas answered with evidence ${dilemmas} < ${ACTIVATION.dilemmasAnswered}`);
    if (strong < ACTIVATION.principles) reasons.push(`principles with ≥ ${ACTIVATION.receiptsPerPrinciple} verified receipts ${strong} < ${ACTIVATION.principles}`);
    if (!s.fidelity) reasons.push("no fidelity report");
    const active = reasons.length === 0;
    await this.db.mentor.update({ where: { id: mentorId }, data: { active, inactiveReason: active ? null : reasons.join("; ") } });
    return { active, dilemmasAnswered: dilemmas, principles: strong, reasons };
  }
}
