import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { PrismaLedger } from "@/lib/council/ledger";
import { getProviders } from "@/lib/council/providers";
import { CorpusBuilder } from "@/lib/council/corpus/pipeline";
import { scenarioLeaks, shingles } from "@/lib/council/corpus/fidelity";
import { gutenbergUrl, letterBody } from "@/lib/council/corpus/fetch";
import { chunkWork, splitParagraph, stripGutenberg, wikisourceText, wordCount } from "@/lib/council/corpus/text";
import { toBytes } from "@/lib/council/corpus/vectors";
import { MockEmbedder } from "@/lib/council/providers/mocks";
import { clearRetrievalCache, search } from "@/lib/council/retrieval";
import { verifyQuote } from "@/lib/council/quotes";
import type { LlmFixture } from "@/lib/council/providers/mocks";
import { MOCK_RULES } from "../helpers/mockRules";

/** Fixtures are real public-domain text (tests/fixtures/corpus/README.md). Providers are mocks (labeled). */
const FIX = path.join(process.cwd(), "tests", "fixtures", "corpus");
const pg216 = readFileSync(path.join(FIX, "pg216_excerpt.txt"), "utf8");
const letter1 = readFileSync(path.join(FIX, "seneca_letter_1.html"), "utf8");

describe("Gutenberg header/footer strip", () => {
  it("keeps only the text between the START and END markers", () => {
    const t = stripGutenberg(pg216);
    expect(t).not.toMatch(/\*\*\* ?(START|END) OF/);
    expect(t).not.toMatch(/Project Gutenberg License|Release date/i);
    expect(t).toMatch(/The Tao that can be trodden is not the enduring/);
  });
  it("throws when markers are missing", () => {
    expect(() => stripGutenberg("no markers here")).toThrow(/markers/);
  });
});

describe("Wikisource extraction", () => {
  it("returns the letter text without layout data, page numbers, or footnote markers", () => {
    const t = wikisourceText(letter1);
    expect(t).toMatch(/Greetings from Seneca to his friend Lucilius\./);
    expect(t.trim().endsWith("Farewell.")).toBe(true);
    expect(t).not.toMatch(/\[\d+\]|\{"|<|data-mw|Proofreadpage/);
    expect(verifyQuote("gather and save your time, which till lately has been forced from you", t)).toBe(true);
  });
});

describe("chunking", () => {
  const text = stripGutenberg(pg216);
  const chunks = chunkWork("The Tao Teh King, or the Tao and its Characteristics", text);

  it("chunks are 150–450 words of whole paragraphs, in order, with no overlap or loss", () => {
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(wordCount(c.text)).toBeLessThanOrEqual(450);
    expect(chunks.filter((c) => wordCount(c.text) < 150).length).toBeLessThanOrEqual(2); // only section tails may be short
    const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter((p) => wordCount(p) > 0);
    const joined = chunks.map((c) => c.text).join("\n\n");
    // every chunk paragraph is an original paragraph (or a sentence-split piece of one), never two halves glued
    for (const c of chunks) for (const p of c.text.split("\n\n")) expect(paras.some((o) => o.includes(p))).toBe(true);
    // no overlap: each original prose paragraph of ≥ 25 words appears exactly once
    for (const p of paras.filter((x) => wordCount(x) >= 25 && wordCount(x) <= 450)) expect(joined.split(p).length - 1, p.slice(0, 40)).toBe(1);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i + 1));
  });

  it("locators name the work and section", () => {
    expect(chunks[0].locator).toMatch(/^The Tao Teh King/);
    const body = letterBody(letter1);
    expect(body.startsWith("Greetings from Seneca")).toBe(true);
    const sen = chunkWork("Moral letters to Lucilius", `LETTER 1\n\n${body}`);
    expect(sen.map((c) => c.locator)).toEqual(sen.map((_, k) => `Moral letters to Lucilius, Letter 1, ¶${k + 1}`));
  });

  it("a long paragraph is split only at sentence ends", () => {
    const longPar = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ")).filter((p) => wordCount(p) > 40).slice(0, 6).join(" ");
    const pieces = splitParagraph(longPar, 50);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces.slice(0, -1)) expect(p).toMatch(/[.!?]["'’”)\]]*$/);
    expect(pieces.join(" ").replace(/\s+/g, " ")).toBe(longPar.replace(/\s+/g, " ").trim());
  });
});

describe("fidelity leak filter", () => {
  const passage = "Therefore the sage manages affairs without doing anything, and conveys his instructions without the use of speech.";
  it("discards a scenario sharing a 6-word sequence with the passage", () => {
    const r = scenarioLeaks({ scenario: "A leader manages affairs without doing anything, and stays quiet.", options: [{ text: "a" }, { text: "b" }], passage, authorName: "Laozi", workTitles: ["The Tao Teh King"] });
    expect(r.leaks).toBe(true);
    expect(r.reasons[0]).toMatch(/6-word/);
  });
  it("discards a scenario naming the author or the work, and keeps a neutral one", () => {
    expect(scenarioLeaks({ scenario: "What would Laozi advise a manager?", options: [], passage, authorName: "Laozi", workTitles: [] }).reasons).toContain("names the author");
    expect(scenarioLeaks({ scenario: "A reader of the Tao Teh King must decide.", options: [], passage, authorName: "Laozi", workTitles: ["The Tao Teh King"] }).leaks).toBe(true);
    expect(scenarioLeaks({ scenario: "A new manager must decide whether to give many orders or few.", options: [{ text: "Give detailed orders" }, { text: "Let the team work" }], passage, authorName: "Laozi", workTitles: ["The Tao Teh King"] }).leaks).toBe(false);
    expect(shingles("one two three four five six seven").size).toBe(2);
  });
});

describe("pipeline and retrieval on the test database (mock providers)", () => {
  const URL = "file:./test-corpus.db";
  let db: ReturnType<typeof getDb>;
  let rawRoot: string;
  let sourcesFile: string;
  beforeAll(async () => {
    await ensureDb(URL, { fresh: true });
    db = getDb(URL);
    rawRoot = mkdtempSync(path.join(os.tmpdir(), "hive-corpus-"));
    sourcesFile = path.join(rawRoot, "sources.json");
    writeFileSync(sourcesFile, JSON.stringify({ works: [{ mentorId: "laozi", rosterTitle: "Tao Te Ching", source: "gutenberg", gutenbergId: 216, gutenbergTitle: "The Tao Teh King, or the Tao and its Characteristics", translator: "James Legge", attributed: true, rights: "Public domain in the USA." }], unavailable: [{ mentorId: "william-osler", rosterTitle: "Aequanimitas", reason: "not on Project Gutenberg" }] }));
  });
  afterAll(() => disconnectAll());

  const builder = (fixtures: Record<string, LlmFixture> = {}) =>
    new CorpusBuilder({
      db,
      ledger: new PrismaLedger(db),
      providers: getProviders({ USE_MOCK_PROVIDERS: "true" }, { ledger: new PrismaLedger(db), mockRules: MOCK_RULES, mockFixtures: fixtures }),
      rawRoot,
      sourcesFile,
      get: async (url) => {
        if (url === gutenbergUrl(216)) return pg216; // offline: the fixture stands in for the download
        throw new Error(`unexpected fetch ${url}`);
      },
    });

  it("runs fetch → chunk → authorial offline; too little authorial text stops the build and deactivates the mentor", async () => {
    const r = await builder().build("laozi", { steps: ["fetch", "chunk", "authorial", "embed"] });
    expect(r.fetch?.status).toBe("done");
    expect(r.chunk?.status).toBe("done");
    expect(r.authorial?.detail.stop).toBe(true);
    expect(r.embed).toBeUndefined(); // stopped after authorial
    const m = await db.mentor.findUniqueOrThrow({ where: { id: "laozi" } });
    expect(m.active).toBe(false);
    expect(m.inactiveReason).toMatch(/insufficient authorial text: \d+ words < 10000/);
    const work = await db.corpusWork.findFirstOrThrow({ where: { mentorId: "laozi" } });
    expect(work.license).toMatch(/Project Gutenberg #216/);
    expect(work.attributed).toBe(true);
  });

  it("an unavailable source marks the mentor inactive with the reason, never silently dropped", async () => {
    await builder().build("william-osler");
    const m = await db.mentor.findUniqueOrThrow({ where: { id: "william-osler" } });
    expect(m.active).toBe(false);
    expect(m.inactiveReason).toMatch(/source unavailable: Aequanimitas — not on Project Gutenberg/);
  });

  it("embed / tag / holdout run on the stored chunks; retrieval never returns held-out chunks even with k > corpus size", async () => {
    const b = builder();
    const r = await b.build("laozi", { steps: ["embed", "tag", "holdout"], force: true });
    expect(r.embed?.status).toBe("done");
    // ensure some held-out chunks exist for the exclusion check
    const all = await db.corpusChunk.findMany({ where: { mentorId: "laozi" }, orderBy: { ordinal: "asc" } });
    await db.corpusChunk.update({ where: { id: all[0].id }, data: { heldOut: true } });
    clearRetrievalCache();
    const held = await db.corpusChunk.count({ where: { mentorId: "laozi", heldOut: true } });
    expect(held).toBeGreaterThan(0);
    const res = await search({ db, embedder: new MockEmbedder(), mentorIds: ["laozi"], query: "the sage manages affairs", k: 1000 });
    expect(res.chunks).toHaveLength(all.length - held);
    const heldIds = new Set((await db.corpusChunk.findMany({ where: { heldOut: true }, select: { id: true } })).map((c) => c.id));
    expect(res.chunks.some((c) => heldIds.has(c.id))).toBe(false);
  });

  it("retrieval refuses to mix embedding models", async () => {
    const c = await db.corpusChunk.findFirstOrThrow({ where: { mentorId: "laozi", heldOut: false } });
    await db.corpusChunk.update({ where: { id: c.id }, data: { embedModel: "other:model", embedding: toBytes(new Float32Array(64)) } });
    clearRetrievalCache();
    const res = await search({ db, embedder: new MockEmbedder(), mentorIds: ["laozi"], query: "the sage", k: 1000 });
    expect(res.skippedOtherModel).toBe(1);
    expect(res.chunks.some((x) => x.id === c.id)).toBe(false);
  });

  it("a fingerprint answer with a fabricated quote ends no_evidence (and is ledgered); a verbatim quote is answered", async () => {
    const fabricated: LlmFixture = (vars) => {
      const first = String(vars.passages).match(/^\[([^\]]+)\]/)![1];
      return { status: "answered", answer: "The writings favor quiet leadership.", choice: "a", evidence: [{ chunkId: first, quote: "the wise ruler always speaks very little and acts even less" }] };
    };
    const r1 = await builder({ MENTOR_ANSWER: fabricated }).answer("laozi", { key: "DL-01", text: "Should a leader give many orders?", options: [{ id: "a", text: "Few" }, { id: "b", text: "Many" }] }, { store: true });
    expect(r1).toMatchObject({ status: "no_evidence", rejected: 1, evidence: [] });
    expect((await db.mentorAnswer.findUniqueOrThrow({ where: { mentorId_questionKey: { mentorId: "laozi", questionKey: "DL-01" } } })).status).toBe("no_evidence");
    expect(await db.ledgerEvent.count({ where: { kind: "quote.rejected", subjectId: "laozi" } })).toBeGreaterThan(0);

    const verbatim: LlmFixture = (vars) => {
      const m = String(vars.passages).match(/^\[([^\]]+)\] \([^)]*\) (.+)$/m)!;
      const quote = m[2].split(/\s+/).slice(0, 12).join(" ");
      return { status: "answered", answer: "The passages favor few orders.", choice: "a", evidence: [{ chunkId: m[1], quote }] };
    };
    const r2 = await builder({ MENTOR_ANSWER: verbatim }).answer("laozi", { key: "DL-02", text: "Should a leader give many orders?", options: [{ id: "a", text: "Few" }, { id: "b", text: "Many" }] }, { store: true });
    expect(r2.status).toBe("answered");
    expect(r2.evidence).toHaveLength(1);
    expect(r2.choice).toBe("a");
  });

  it("activation lists every unmet threshold", async () => {
    const r = await builder().build("laozi", { steps: ["activate"], force: true });
    expect(r.activate?.detail.active).toBe(false);
    expect((r.activate?.detail.reasons as string[]).join(" ")).toMatch(/authorial words.*dilemmas answered.*principles/);
  });
});
