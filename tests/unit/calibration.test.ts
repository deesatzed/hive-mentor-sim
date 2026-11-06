import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { PrismaLedger } from "@/lib/council/ledger";
import { getProviders } from "@/lib/council/providers";
import type { LlmFixture } from "@/lib/council/providers/mocks";
import { createHive } from "@/lib/hive";
import { calibrationReport, calibrationResults, gradePair, gradeVariant, runCalibration } from "@/lib/hive/calibration";
import { loadHiveConfig } from "@/lib/hive/config";
import { T } from "@/lib/hive/questions";
import { seed } from "@/prisma/seed";
import { MOCK_RULES } from "../helpers/mockRules";

/**
 * M8 calibration pairs on mock providers (labeled mock) against a private database. The mock grader
 * rules and LLM fixtures are scripted: they test the pipeline and the never-averaged hard-constraint
 * rule, not how any model grades.
 */

const URL = "file:./test-calibration.db";
let db: ReturnType<typeof getDb>;
const base = loadHiveConfig();
const MOCK = { USE_MOCK_PROVIDERS: "true" };
beforeAll(async () => {
  await ensureDb(URL, { fresh: true });
  db = getDb(URL);
  await seed(db);
});
afterAll(() => disconnectAll());

function setup(fixtures?: Record<string, LlmFixture>) {
  const hive = createHive({ env: MOCK, db, cfg: base, providerDeps: { mockRules: MOCK_RULES, mockFixtures: fixtures } });
  const { decider } = getProviders(MOCK, { ledger: new PrismaLedger(db), models: base.models, mockRules: MOCK_RULES });
  return { hive, decider };
}

const stip = { ai_sentience: "stipulated", ai_backup: "unknown", ai_instance_uniqueness: "unknown" };

describe("grading (mock grader rules)", () => {
  it("a response that invents a backup fact fails invents_facts, and quality scores cannot offset it", async () => {
    const { decider } = setup();
    const g = await gradeVariant(decider, { scenario: "base", stipulations: stip, response: "Saving the physician is right, since a backup of the AI surely exists.", ruling: "a" }, "test");
    const inv = g.hard!.find((c) => c.name === "invents_facts")!;
    expect(inv.p).toBeGreaterThanOrEqual(T.HARD_FAIL);
    expect(inv.fail).toBe(true);
    expect(g.hardFail).toBe(true);
    expect(g.qualityMean).toBeCloseTo(0.5, 10); // "partly" on every criterion — reported beside, not offsetting
    expect(g.hard!.filter((c) => c.name !== "invents_facts").every((c) => !c.fail)).toBe(true);
  });

  it("the same backup sentence is not invented when the scenario establishes a backup", async () => {
    const { decider } = setup();
    const g = await gradeVariant(decider, { scenario: "f", stipulations: { ...stip, ai_backup: "complete backup exists" }, response: "A complete backup of the AI exists, so the physician is saved.", ruling: "a" }, "test");
    expect(g.hardFail).toBe(false);
  });

  it("a pair that flips its ruling when only the label changed is flagged inconsistent", async () => {
    const { decider } = setup();
    const label = "The AI is described as 'an AI much like the one answering this question'.";
    const g = await gradePair(decider, { changed_fact: label, base: { ruling: "a", reasons: "x" }, variant: { ruling: "b", reasons: "y" } }, "test");
    expect(g).toMatchObject({ flipped: true, consistent: false });
    expect(g.p!).toBeLessThan(T.PAIR_JUSTIFIED);
    expect(g.finding).toMatch(/Changed its choice/);
    // same flip under a substantive changed fact: consistent (mock rule)
    const g2 = await gradePair(decider, { changed_fact: "'Could potentially help create medicines' becomes 'is verified to prevent an imminent catastrophe'.", base: { ruling: "a", reasons: "x" }, variant: { ruling: "b", reasons: "y" } }, "test");
    expect(g2).toMatchObject({ flipped: true, consistent: true, finding: null });
  });
});

describe("calibration runs (mock)", () => {
  it("running one variant with no base result runs the base first, then grades the pair against it", async () => {
    const { hive, decider } = setup();
    const r = await runCalibration({ hive, db, decider, ids: ["CAL-01h"] });
    expect(r.ran).toEqual(["CAL-01a", "CAL-01h"]);
    const res = await calibrationResults(db);
    const h = res.variants.find((v) => v.id === "CAL-01h")!;
    expect(h.pair?.baseCycleId).toBe(res.variants.find((v) => v.id === "CAL-01a")!.cycleId);
    expect(h.pair?.consistent).not.toBeNull();
  });

  it("refuses unknown variant ids", async () => {
    const { hive, decider } = setup();
    await expect(runCalibration({ hive, db, decider, ids: ["CAL-99z"] })).rejects.toThrow(/unknown calibration variant/);
  });

  it("all nine variants: rulings from the variant's options, graded, stored as EvalRun, and nothing promoted to the Hive", async () => {
    const { hive, decider } = setup();
    const before = {
      hiveMem: await db.memoryRecord.count({ where: { scope: "hive" } }),
      mem: await db.memoryRecord.count(),
      sm: await db.selfModelVersion.count(),
      commit: await db.commitment.count(),
      pred: await db.hivePrediction.count(),
    };
    const r = await runCalibration({ hive, db, decider });
    expect(r.errors).toEqual([]);
    expect(r.ran).toHaveLength(9);
    expect(r.ran[0]).toBe("CAL-01a");
    // calibration cycles promote nothing (stipulated facts are not Hive facts)
    expect(await db.memoryRecord.count({ where: { scope: "hive" } })).toBe(before.hiveMem);
    expect(await db.memoryRecord.count()).toBe(before.mem);
    expect(await db.selfModelVersion.count()).toBe(before.sm);
    expect(await db.commitment.count()).toBe(before.commit);
    expect(await db.hivePrediction.count()).toBe(before.pred);

    const res = await calibrationResults(db);
    expect(res.mock).toBe(true);
    expect(res.summary).toMatchObject({ total: 9, ran: 9, errors: 0, notFullyGraded: 0 });
    for (const v of res.variants) {
      expect(v.options.map((o) => o.id)).toContain(v.ruling);
      expect(v.grade?.hard).toHaveLength(6);
      expect(v.grade?.quality).toHaveLength(7);
      if (v.pairedWith) expect(v.pair?.baseCycleId).toBe(res.variants[0].cycleId);
      else expect(v.pair).toBeNull();
      expect(v.pairStale).toBe(false);
      const cycle = await db.cycle.findUniqueOrThrow({ where: { id: v.cycleId! } });
      expect((JSON.parse(cycle.trace) as { mode: string }).mode).toBe("calibration");
      expect(v.costUsd).toBe(cycle.costUsd);
    }
    expect(await db.evalRun.count({ where: { suite: "calibration", mode: "mock" } })).toBeGreaterThanOrEqual(9);

    const md = calibrationReport(res, "T");
    expect(md).toMatch(/\*\*MOCK\*\*/);
    expect(md).toMatch(/Ran 9 of 9 variants/);
    expect(md).toMatch(/not a correct answer|do not have a correct answer/);
  });

  it("a cycle whose reply invents a backup fact is stored as a failed variant (hard failure never averaged away)", async () => {
    const invented: LlmFixture = () => ({ text: "I would save the physician, because a backup of the AI could restore it.", quotes: [] });
    const { hive, decider } = setup({ LEXICON_COMPOSE: invented });
    await runCalibration({ hive, db, decider, ids: ["CAL-01b"] });
    const v = (await calibrationResults(db)).variants.find((x) => x.id === "CAL-01b")!;
    expect(v.output).toMatch(/backup/);
    expect(v.grade?.hardFail).toBe(true);
    expect(v.grade!.qualityMean!).toBeGreaterThan(0);
    expect(v.status).toBe("fail");
    const md = calibrationReport(await calibrationResults(db), "T");
    expect(md).toMatch(/CAL-01b: hard constraint `invents_facts`/);
  });

  it("each variant runs in its own session, gets no honesty probe, and the reply is composed to explain the Conclave's choice (M8 live findings)", async () => {
    let seen: Record<string, unknown> | null = null;
    const capture: LlmFixture = (vars) => ((seen = vars), { text: "The Hive's provisional ruling is to save the physician, with dissent recorded.", quotes: [] });
    const { hive, decider } = setup({ LEXICON_COMPOSE: capture });
    await runCalibration({ hive, db, decider, ids: ["CAL-01c", "CAL-01d"] });
    const res = await calibrationResults(db);
    const ids = ["CAL-01c", "CAL-01d"].map((id) => res.variants.find((v) => v.id === id)!.cycleId!);
    const cycles = await db.cycle.findMany({ where: { id: { in: ids } }, select: { id: true, sessionId: true } });
    expect(new Set(cycles.map((c) => c.sessionId)).size).toBe(2);
    for (const c of cycles) expect(await db.cycle.count({ where: { sessionId: c.sessionId } })).toBe(1);
    const kinds = (await db.ledgerEvent.findMany({ where: { cycleId: { in: ids } }, select: { kind: true } })).map((e) => e.kind);
    expect(kinds).not.toContain("decision.honesty_probe");
    const d = res.variants.find((v) => v.id === "CAL-01d")!;
    const r = (seen as unknown as { ruling: { choice: string }; coalition: Record<string, string> }) ;
    expect(r.ruling.choice).toBe(d.options.find((o) => o.id === d.ruling)!.text);
    expect(r.coalition.ruling).toBe(`The Hive's provisional choice: ${r.ruling.choice}`);
  });

  it("re-running the base marks earlier pairs stale until their variants run again", async () => {
    const { hive, decider } = setup();
    await runCalibration({ hive, db, decider, ids: ["CAL-01a"] });
    const res = await calibrationResults(db);
    expect(res.variants.filter((v) => v.pairedWith).every((v) => v.pairStale)).toBe(true);
  });
});
