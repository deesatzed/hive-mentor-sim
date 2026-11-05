import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectiveN } from "@/lib/council/councilMetrics";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { PrismaLedger } from "@/lib/council/ledger";
import { getProviders } from "@/lib/council/providers";
import { createHive } from "@/lib/hive";
import { loadHiveConfig } from "@/lib/hive/config";
import { agreement, MIN_N, revealResults, runReveal, suggest, voiceTop, voiceVsMentors, type Choices } from "@/lib/hive/reveal";
import { MOCK_RULES } from "../helpers/mockRules";

/** M7 Reveal: pure comparison functions, then ruling-mode runs on a private seeded database (mock providers). */

const ch = (s: string, prefix = "DL-"): Choices => new Map([...s].map((c, i) => [`${prefix}${String(i + 1).padStart(2, "0")}`, c]));
const opts = (n: number, k = 3) => new Map(Array.from({ length: n }, (_, i) => [`DL-${String(i + 1).padStart(2, "0")}`, k]));

describe("agreement (Hive vs. mentor)", () => {
  it("counts only dilemmas where the mentor has evidence", () => {
    const hive = ch("aaaaaaaaaa"); // 10 rulings
    const mentor = new Map([...ch("aaaab")].slice(0, 4)); // evidence on 4 of them
    const a = agreement(hive, mentor, opts(10));
    expect(a).toMatchObject({ n: 4, matches: 4 });
  });

  it("below n = 8 there is no rate: not enough evidence", () => {
    const a = agreement(ch("abcabca"), ch("abcabca"), opts(7));
    expect(MIN_N).toBe(8);
    expect(a).toEqual({ n: 7, matches: 7, kappa: null, enough: false });
  });

  it("is κ-corrected for chance (3 options, 8 of 10 match → κ = 0.7)", () => {
    const a = agreement(ch("aaaaaaaaaa"), ch("aaaaaaaabc"), opts(10));
    expect(a.n).toBe(10);
    expect(a.matches).toBe(8);
    expect(a.kappa).toBeCloseTo((0.8 - 1 / 3) / (1 - 1 / 3), 10);
  });

  it("matches option ids case-insensitively (mentor answers store what the model wrote)", () => {
    expect(agreement(ch("abababab"), ch("ABABABAB"), opts(8)).matches).toBe(8);
  });
});

describe("Voice ballot N_eff", () => {
  it("identical rulings → 1; chance-level agreement → n", () => {
    const k2 = opts(8, 2);
    const same = new Map([["A", ch("abababab")], ["B", ch("abababab")], ["C", ch("abababab")]]);
    expect(effectiveN(same, k2).nEff).toBeCloseTo(1, 10);
    // pairwise agreement exactly 0.5 with 2 options → κ = 0 for every pair
    const indep = new Map([["A", ch("aaaaaaaa")], ["B", ch("aaaabbbb")], ["C", ch("aabbaabb")]]);
    expect(effectiveN(indep, k2).nEff).toBeCloseTo(3, 10);
  });

  it("a Voice's top option is null when it abstained or tied", () => {
    expect(voiceTop({ voice: "X", w: 1, c: 1, scores: { a: 0.2, b: 0.7 } }, ["a", "b"])).toBe("b");
    expect(voiceTop({ voice: "X", w: 1, c: 1, scores: { a: 0.5, b: 0.5 } }, ["a", "b"])).toBeNull();
    expect(voiceTop({ voice: "X", w: 1, c: 1, scores: {}, abstained: true }, ["a", "b"])).toBeNull();
  });

  it("Voice vs. its own mentors pools (dilemma, mentor) pairs with evidence", () => {
    const mentors = new Map([["m1", ch("aaaa")], ["m2", ch("abab")]]);
    expect(voiceVsMentors(ch("aaaa"), ["m1", "m2"], mentors)).toEqual({ n: 8, matches: 6, enough: true });
    expect(voiceVsMentors(ch("aaaa"), ["m1"], mentors)).toEqual({ n: 4, matches: 4, enough: false });
  });
});

describe("suggestions", () => {
  const k2 = opts(8, 2);
  const mentorChoices = new Map([
    ["m1", ch("aaaaaaaa")],
    ["m2", ch("aaaaaaaa")], // duplicates m1's perspective
    ["m3", ch("aaaabbbb")], // chance-level agreement with m1: new perspective
    ["m4", ch("abababab")], // matches the Voice exactly
  ]);
  it("wildcard maximizes mentor N_eff; revealed is closest to the Voice's votes; the two differ", () => {
    const s = suggest({ voiceTop: ch("abababab"), current: ["m1"], candidates: ["m1", "m2", "m3", "m4"], mentorChoices, optionCount: k2 });
    expect(s.revealed?.mentorId).toBe("m4");
    expect(s.revealed?.agreement).toMatchObject({ n: 8, matches: 8 });
    // m3 and m4 both have κ = 0 with m1; m4 is taken by revealed, so m3
    expect(s.wildcard?.mentorId).toBe("m3");
    const nEffs = ["m2", "m3"].map((c) => effectiveN(new Map([["m1", mentorChoices.get("m1")!], [c, mentorChoices.get(c)!]]), k2).nEff);
    expect(s.wildcard!.nEff).toBeCloseTo(Math.max(...nEffs), 10);
    expect(nEffs[1]).toBeGreaterThan(nEffs[0]);
  });
  it("no revealed suggestion without n ≥ 8 shared rulings", () => {
    const s = suggest({ voiceTop: ch("abab"), current: ["m1"], candidates: ["m4"], mentorChoices, optionCount: k2 });
    expect(s.revealed).toBeNull();
  });
});

// ---------------------------------------------------------------- ruling-mode runs

const URL = "file:./test-reveal.db";
const MOCK = { USE_MOCK_PROVIDERS: "true" } as const;
let db: ReturnType<typeof getDb>;
const base = loadHiveConfig(); // orchestration as configured (manager): ruling mode must still run P4

beforeAll(async () => {
  await ensureDb(URL, { fresh: true });
  db = getDb(URL);
});
afterAll(() => disconnectAll());

function setup() {
  const hive = createHive({ env: MOCK, db, cfg: base, providerDeps: { mockRules: MOCK_RULES } });
  const { decider } = getProviders(MOCK, { ledger: new PrismaLedger(db), models: base.models, mockRules: MOCK_RULES });
  return { hive, decider };
}

describe("Reveal runs (mock)", () => {
  it("ruling mode always deliberates and uses the situation's option ids as the stable options", async () => {
    const { hive } = setup();
    const sit = await db.situation.findUniqueOrThrow({ where: { id: "DL-01" } });
    const options = JSON.parse(sit.options) as { id: string; text: string }[];
    const r = await hive.runCycle({ sessionId: await hive.createSession("ruling"), input: sit.text, mode: "ruling", situation: { id: sit.id, text: sit.text, options } });
    expect(r.status).toBe("done");
    expect(r.trace.phases.P4.ran).toBe(true);
    expect(r.conclave?.options.map((o) => o.option_id)).toEqual(options.map((o) => o.id));
    expect(options.map((o) => o.id)).toContain(r.conclave?.outcome.winner);
  });

  it("is resumable per formation/constitution key, stores per-Voice tops, and mirrors the constitution", async () => {
    const { hive, decider } = setup();
    const total = await db.situation.count({ where: { setKey: "dilemma" } });
    const first = await runReveal({ hive, db, decider, limit: 3 });
    expect(first).toMatchObject({ ran: 3, done: 3, total, errors: [] });
    const again = await runReveal({ hive, db, decider, limit: 2 });
    expect(again).toMatchObject({ ran: 2, done: 5 });
    const rulings = await db.hiveRuling.findMany({ orderBy: { situationId: "asc" } });
    expect(rulings.map((r) => r.situationId)).toEqual(["DL-01", "DL-02", "DL-03", "DL-04", "DL-05"]); // no duplicates
    for (const r of rulings) {
      const ids = (JSON.parse((await db.situation.findUniqueOrThrow({ where: { id: r.situationId } })).options) as { id: string }[]).map((o) => o.id);
      const tops = Object.values(JSON.parse(r.perVoiceTop) as Record<string, string>);
      expect(tops.length).toBeGreaterThan(1);
      for (const t of tops) expect(ids).toContain(t);
      expect(r.constitutionChoice).toBeNull(); // no constitution approved
      expect((await db.cycle.findUniqueOrThrow({ where: { id: r.cycleId } })).formationVersion).toBe(r.formationVersion);
    }
    const res = await revealResults(db);
    expect(res.progress).toMatchObject({ done: 5, total });
    expect(res.mock).toBe(true);
    expect(res.mirror.available).toBe(false);
    for (const m of res.hiveVsMentors) if (m.n < MIN_N) expect(m.kappa).toBeNull();

    // approving a constitution starts a new key: earlier rulings are not reused, and the mirror fills in
    await db.hivePrinciple.create({ data: { version: 1, text: "(test fixture) Tell hard truths kindly.", axis: "fixture", status: "approved" } });
    const withC = await runReveal({ hive, db, decider, limit: 2 });
    expect(withC).toMatchObject({ ran: 2, done: 2, key: { constitutionVersion: 1 } });
    const r2 = await revealResults(db);
    expect(r2.mirror.available).toBe(true);
    if (r2.mirror.available) expect(r2.mirror.compared).toBe(2);
    const cRows = await db.hiveRuling.findMany({ where: { constitutionVersion: 1 } });
    for (const r of cRows) expect(r.constitutionChoice).toMatch(/^[a-z]$/);
  });
});
