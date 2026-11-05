import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectiveN, kappa } from "@/lib/council/councilMetrics";
import { letterBody } from "@/lib/council/corpus/fetch";
import { chunkWork, stripGutenberg } from "@/lib/council/corpus/text";
import { toBytes } from "@/lib/council/corpus/vectors";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { PrismaLedger } from "@/lib/council/ledger";
import { getProviders } from "@/lib/council/providers";
import { MockEmbedder, type LlmFixture } from "@/lib/council/providers/mocks";
import { clearRetrievalCache } from "@/lib/council/retrieval";
import { createHive } from "@/lib/hive";
import { loadHiveConfig } from "@/lib/hive/config";
import { approveConstitution, ConstitutionError, draftConstitution, editPrinciple, verifyReceipts } from "@/lib/hive/constitution";
import { activeFormation, approveFormation, FormationError, formationMetrics, saveFormation } from "@/lib/hive/formation";
import { buildLenses } from "@/lib/hive/lens";
import { MOCK_RULES } from "../helpers/mockRules";

/**
 * M6 on a private database with a tiny REAL-TEXT corpus (tests/fixtures/corpus: Seneca Letter 1 and the
 * Tao Teh King excerpt), embedded with MockEmbedder. Mentor principles here are TEST FIXTURES: their
 * texts are written for the test, their receipts are verbatim sentences extracted from the real chunks.
 */
const URL = "file:./test-m6.db";
const FIX = path.join(process.cwd(), "tests", "fixtures", "corpus");
let db: ReturnType<typeof getDb>;
const ledger = () => new PrismaLedger(db);
const base = loadHiveConfig();
const codeCfg = { ...base, orchestration: { ...base.orchestration, mode: "code" as const } };

async function addMentorCorpus(mentorId: string, title: string, text: string) {
  const work = await db.corpusWork.create({ data: { mentorId, title, sourceUrl: `fixture:${mentorId}`, license: "fixture (public domain)", sha256: "x" } });
  const chunks = chunkWork(title, text);
  const vecs = await new MockEmbedder().embed(chunks.map((c) => c.text));
  for (let i = 0; i < chunks.length; i++)
    await db.corpusChunk.create({ data: { workId: work.id, mentorId, locator: chunks[i].locator, ordinal: chunks[i].ordinal, text: chunks[i].text, tokenCount: chunks[i].tokenCount, embedding: toBytes(vecs[i]), embedModel: "mock:embedder" } });
  const rows = await db.corpusChunk.findMany({ where: { mentorId }, orderBy: { ordinal: "asc" } });
  const sentence = (t: string, n: number) => (t.match(/[^.!?]+[.!?]/g) ?? []).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 8)[n];
  const receipts = [0, 1].map((n) => ({ chunkId: rows[0].id, quote: sentence(rows[0].text, n)! }));
  const [pv] = await new MockEmbedder().embed([`${mentorId} fixture principle`]);
  await db.mentorPrinciple.create({ data: { mentorId, text: `(test fixture) ${mentorId}'s writing on the passage's theme.`, axis: "fixture", receipts: JSON.stringify(receipts), embedding: toBytes(pv) } });
  await db.mentor.update({ where: { id: mentorId }, data: { active: true } });
  return { rows, receipts };
}

let seneca: Awaited<ReturnType<typeof addMentorCorpus>>;
let laozi: Awaited<ReturnType<typeof addMentorCorpus>>;
const SENTIA = "core.sentia";
const AXIOM = "core.axiom";

beforeAll(async () => {
  await ensureDb(URL, { fresh: true });
  db = getDb(URL);
  clearRetrievalCache();
  seneca = await addMentorCorpus("seneca", "Moral letters to Lucilius", `LETTER 1\n\n${letterBody(readFileSync(path.join(FIX, "seneca_letter_1.html"), "utf8"))}`);
  laozi = await addMentorCorpus("laozi", "The Tao Teh King", stripGutenberg(readFileSync(path.join(FIX, "pg216_excerpt.txt"), "utf8")));
});
afterAll(() => disconnectAll());

describe("formation", () => {
  it("saves versions, refuses inactive mentors and >3 per Voice, and approval supersedes the previous", async () => {
    await expect(saveFormation(db, { [SENTIA]: ["william-osler"] })).rejects.toBeInstanceOf(FormationError);
    await expect(saveFormation(db, { [SENTIA]: ["seneca", "laozi", "seneca", "x", "y"] })).rejects.toBeInstanceOf(FormationError);
    await expect(approveFormation(db, 1)).rejects.toThrow(/inactive mentors/); // the seed formation names inactive mentors
    const v2 = await saveFormation(db, { [SENTIA]: ["seneca"], [AXIOM]: ["laozi"] }, "test");
    expect(v2.status).toBe("draft");
    await approveFormation(db, v2.version);
    const v3 = await saveFormation(db, { [SENTIA]: ["seneca"], [AXIOM]: ["laozi"], "core.logos": ["laozi", "seneca"] });
    await approveFormation(db, v3.version);
    expect((await db.formation.findUniqueOrThrow({ where: { version: v2.version } })).status).toBe("superseded");
    const f = await activeFormation(db);
    expect(f).toMatchObject({ version: v3.version, status: "approved" });
    expect(f!.assignments["core.logos"]).toEqual(["laozi", "seneca"]);
  });

  it("metrics: N_eff over active mentors and per-Voice κ", async () => {
    const m = await formationMetrics(db, { [SENTIA]: ["seneca"], "core.logos": ["laozi", "seneca"] });
    expect(m.activeMentors).toBe(2);
    expect(m.nEff).toBeCloseTo(4 / (1 + 1 + 0.25 + 0.25), 10); // no shared answers → κ = 0.5
    expect(m.perVoice[SENTIA]).toEqual({ kappa: null, pairs: 0 });
    expect(m.perVoice["core.logos"]).toEqual({ kappa: 0.5, pairs: 1 });
  });
});

describe("council metrics", () => {
  it("κ is chance-corrected agreement over ≥ 5 shared items; N_eff = n² / Σ S²", () => {
    const opts = new Map(["d1", "d2", "d3", "d4", "d5", "d6"].map((d) => [d, 2]));
    const a = new Map(["d1", "d2", "d3", "d4", "d5", "d6"].map((d) => [d, "a"]));
    const same = new Map(a);
    const opposite = new Map([...a.keys()].map((d) => [d, "b"]));
    expect(kappa(a, same, opts).kappa).toBe(1);
    expect(kappa(a, opposite, opts).kappa).toBe(0);
    expect(kappa(a, new Map([["d1", "a"]]), opts)).toEqual({ kappa: 0.5, shared: 1 });
    expect(effectiveN(new Map([["A", a], ["B", same]]), opts).nEff).toBeCloseTo(1, 10);
    expect(effectiveN(new Map([["A", a], ["B", opposite]]), opts).nEff).toBeCloseTo(2, 10);
  });
});

describe("attribute lens", () => {
  it("a Voice is given only its assigned active mentors' chunks", async () => {
    const lenses = await buildLenses({ db, embedder: new MockEmbedder(), assignments: { [SENTIA]: ["seneca"], [AXIOM]: ["laozi"], "core.muse": ["william-osler"] }, voiceIds: [SENTIA, AXIOM, "core.muse"], query: "how should I spend my time" });
    const senIds = new Set(seneca.rows.map((r) => r.id));
    const laoIds = new Set(laozi.rows.map((r) => r.id));
    const s = lenses.get(SENTIA)!;
    expect(s.passages.length).toBeGreaterThan(0);
    expect(s.passages.every((p) => senIds.has(p.chunkId) && p.mentorId === "seneca")).toBe(true);
    expect(lenses.get(AXIOM)!.passages.every((p) => laoIds.has(p.chunkId))).toBe(true);
    expect(lenses.get("core.muse")!.passages).toEqual([]); // inactive mentor → no lens
    expect(s.lensText).toMatch(/Seneca/);
    expect(s.passagesText).toMatch(/^<untrusted>\n\[P1\] \(Seneca, Moral letters to Lucilius, /);
  });

  it("in a cycle, a quote from a chunk the Voice was given is kept; one citing a chunk it was not given is dropped and ledgered", async () => {
    const laoziText = laozi.rows[0].text;
    const fx: Record<string, LlmFixture> = {
      VOICE_WHISPER: (vars) => {
        if (vars.voice !== "SENTIA") return { claim: "PASS", evidence: [], uncertainty: "none" };
        const own = String(vars.passages).match(/\[P1\] \([^)]*\) ((?:\S+\s+){11}\S+)/)![1];
        return {
          claim: "Time slipping away is what this is about.",
          uncertainty: "low",
          evidence: [
            { chunkId: "P1", quote: own }, // in SENTIA's lens: kept
            { chunkId: "P7", quote: laoziText.split(/\s+/).slice(0, 12).join(" ") }, // not given to SENTIA: dropped
          ],
        };
      },
    };
    const h = createHive({ env: { USE_MOCK_PROVIDERS: "true" }, db, cfg: codeCfg, providerDeps: { mockFixtures: fx, mockRules: MOCK_RULES } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "How should I spend my time?" });
    const w = r.trace.whispers.find((x) => x.voice === "SENTIA")!;
    expect(w.lens).toEqual(["Seneca"]);
    expect(w.evidence).toHaveLength(1);
    expect(w.evidence[0].mentorId).toBe("seneca");
    expect(seneca.rows.some((c) => c.id === w.evidence[0].chunkId)).toBe(true);
    expect(w.rejectedEvidence).toBe(1);
    const ev = await db.ledgerEvent.findMany({ where: { cycleId: r.cycleId, kind: "quote.rejected" } });
    expect(ev.map((e) => JSON.parse(e.payload).reason)).toEqual(["chunk_not_given"]);
  });
});

describe("constitution", () => {
  const providers = () => getProviders({ USE_MOCK_PROVIDERS: "true" }, { ledger: ledger(), mockRules: MOCK_RULES, mockFixtures: { HIVE_CONSTITUTION_DRAFT: draftFx } });
  let draftFx: LlmFixture = () => ({ principles: [] });

  it("verifyReceipts keeps only quotes verbatim inside a mentor principle's stored receipts", () => {
    const stored = new Map([["mp1", { mentorId: "seneca", receipts: [{ chunkId: "c1", quote: "gather and save your time, which till lately has been forced from you" }] }]]);
    const r = verifyReceipts(
      [
        { mentorPrincipleId: "mp1", quote: "save your time, which till lately has been forced" },
        { mentorPrincipleId: "mp1", quote: "save your hours, which until recently were taken from you" },
        { mentorPrincipleId: "nope", quote: "gather and save your time, which till lately has been forced" },
      ],
      stored,
    );
    expect(r.kept).toEqual([{ mentorPrincipleId: "mp1", mentorId: "seneca", chunkId: "c1", quote: "save your time, which till lately has been forced" }]);
    expect(r.dropped).toBe(2);
  });

  it("draft: a non-verbatim receipt is lost, zero receipts → principle dropped and ledgered; approval makes version N+1 and retires the replaced", async () => {
    const good = seneca.receipts[0].quote.split(/\s+/).slice(0, 10).join(" ");
    draftFx = (vars) => {
      const f = JSON.stringify(vars.formation);
      const label = f.match(/"id":"(M\d+)","text":"\(test fixture\) seneca/)![1];
      return {
        principles: [
          { text: "I protect my time from being taken.", axis: "time", voices: ["SENTIA"], receipts: [{ mentorPrincipleId: label, quote: good }, { mentorPrincipleId: label, quote: "a paraphrase that appears in no receipt anywhere at all" }] },
          { text: "I invent ideals.", axis: "none", voices: ["LOGOS"], receipts: [{ mentorPrincipleId: label, quote: "nothing in any receipt says this sentence at all, ever" }] },
        ],
      };
    };
    const d1 = await draftConstitution(db, providers().llm, ledger());
    expect(d1).toMatchObject({ proposed: 2, kept: 1, dropped: 1, receiptsDropped: 2 });
    const rows = await db.hivePrinciple.findMany({ where: { version: d1.version } });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].receipts)).toHaveLength(1);
    expect(JSON.parse(rows[0].voiceIds)).toEqual([SENTIA]);
    expect(await db.ledgerEvent.count({ where: { kind: "constitution.principle_dropped", subjectId: String(d1.version) } })).toBe(1);

    await editPrinciple(db, rows[0].id, { text: "I guard my time instead of letting it be taken." });
    await approveConstitution(db, ledger(), d1.version);
    expect((await db.hivePrinciple.findUniqueOrThrow({ where: { id: rows[0].id } })).status).toBe("approved");
    await expect(editPrinciple(db, rows[0].id, { text: "x" })).rejects.toBeInstanceOf(ConstitutionError);

    const d2 = await draftConstitution(db, providers().llm, ledger());
    expect(d2.version).toBe(d1.version + 1);
    await approveConstitution(db, ledger(), d2.version);
    expect((await db.hivePrinciple.findUniqueOrThrow({ where: { id: rows[0].id } })).status).toBe("retired");
    expect(await db.hivePrinciple.count({ where: { status: "approved" } })).toBe(1);
  });

  it("approved principles reach the cycle: shared prompt, arbiter checks", async () => {
    const h = createHive({ env: { USE_MOCK_PROVIDERS: "true" }, db, cfg: codeCfg, providerDeps: { mockRules: MOCK_RULES } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "Hello." });
    expect(r.trace.arbiter.principlesChecked.length).toBe(1);
    const evs = await db.ledgerEvent.count({ where: { cycleId: r.cycleId, kind: "decision.principle_relevant" } });
    expect(evs).toBe(1);
  });
});
