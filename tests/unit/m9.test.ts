import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { PrismaLedger } from "@/lib/council/ledger";
import type { Decider } from "@/lib/council/providers/decisions";
import { DecisionUnavailableError } from "@/lib/council/providers/decisions";
import type { LlmFixture } from "@/lib/council/providers/mocks";
import { density, dismissUntil, surfacePatterns, type SignalRow, type SurfaceRow } from "@/lib/council/signals";
import { CAVEAT, lensStats, lensTable } from "@/lib/council/trackRecord";
import { createHive } from "@/lib/hive";
import { loadHiveConfig, type HiveConfig } from "@/lib/hive/config";
import { activeAdvisors, buildRollout, coalitionEligible, decideEndorsement, stripSelfEndorsement, type RolloutStep } from "@/lib/hive/endorsement";
import { CheckInError, checkIn, predictionsView } from "@/lib/hive/predictions";
import { dismissPattern, patternCards, surfaceNow } from "@/lib/hive/signalStore";
import { seed } from "@/prisma/seed";
import { MOCK_RULES } from "../helpers/mockRules";

/** M9: signals and patterns, track record, advisor routing and endorsement, predictions (mock providers, labeled). */

const DAY = 86_400_000;
const t0 = new Date("2026-01-01T00:00:00Z");
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const sig = (days: number, type = "tension", id = "p1"): SignalRow => ({ type, subjectType: "principle", subjectId: id, strength: 1, halfLifeDays: 14, createdAt: at(days) });
const policy = { thresholds: { tension: 3, serves: 4, dissent: 3 }, resurfaceDays: 14, resurfaceIncrease: 1.5 };

describe("signals (pure)", () => {
  it("density half-life is exact", () => {
    expect(density([sig(0)], "principle", "p1", "tension", at(14))).toBe(0.5);
    expect(density([sig(0)], "principle", "p1", "tension", at(28))).toBe(0.25);
    expect(density([sig(0), sig(0)], "principle", "p1", "tension", at(0))).toBe(2);
    expect(density([sig(0, "serves")], "principle", "p1", "tension", at(0))).toBe(0);
  });

  it("a pattern surfaces at its threshold and not below", () => {
    expect(surfacePatterns([sig(0), sig(0)], [], policy, at(0))).toEqual([]);
    expect(surfacePatterns([sig(0), sig(0), sig(0)], [], policy, at(0))).toEqual([{ subjectType: "principle", subjectId: "p1", type: "tension", density: 3 }]);
    // serves needs 4
    expect(surfacePatterns([0, 0, 0].map(() => sig(0, "serves")), [], policy, at(0))).toEqual([]);
  });

  it("does not re-surface within 14 days without a +1.5 rise; does after the rise or after 14 days", () => {
    const prior: SurfaceRow[] = [{ subjectType: "principle", subjectId: "p1", type: "tension", density: 3, dismissedUntil: null, createdAt: at(0) }];
    const base = [sig(0), sig(0), sig(0)];
    expect(surfacePatterns([...base, sig(1)], prior, policy, at(1))).toEqual([]); // rise < 1.5
    expect(surfacePatterns([...base, sig(1), sig(1)], prior, policy, at(1))).toHaveLength(1); // rise ≥ 1.5
    expect(surfacePatterns([...base, sig(15), sig(15), sig(15)], prior, policy, at(15))).toHaveLength(1); // 14 days passed
  });

  it("a dismissal suppresses the pattern for 30 days, then it may surface again", () => {
    const prior: SurfaceRow[] = [{ subjectType: "principle", subjectId: "p1", type: "tension", density: 3, dismissedUntil: dismissUntil(at(0), 30), createdAt: at(0) }];
    const lots = (d: number) => Array.from({ length: 6 }, () => sig(d));
    expect(surfacePatterns(lots(20), prior, policy, at(20))).toEqual([]);
    expect(surfacePatterns(lots(31), prior, policy, at(31))).toHaveLength(1);
  });
});

describe("track record (pure)", () => {
  it("below n = 10 only counts; from 10 the mean", () => {
    const nine = lensStats("LOGOS", [5, 4, 4, 2, 1, 3, 5, 4, 2]);
    expect(nine).toMatchObject({ n: 9, held: 5, didNot: 3, mean: null, displayMode: "counts" });
    expect(nine.sentence).toBe("LOGOS: 9 times: 5 held, 3 did not, 1 mixed.");
    const ten = lensStats("LOGOS", [5, 4, 4, 2, 1, 3, 5, 4, 2, 5]);
    expect(ten.displayMode).toBe("full");
    expect(ten.mean).toBeCloseTo(3.5, 10);
    expect(CAVEAT).toBe("Small numbers, many other factors. A hint, not a verdict.");
    expect(lensTable([{ lens: "A", rating: 5 }, { lens: "B", rating: 1 }, { lens: "B", rating: 4 }]).map((x) => [x.lens, x.n])).toEqual([["B", 2], ["A", 1]]);
  });
});

describe("advisor routing and endorsement", () => {
  const cfg = loadHiveConfig();
  const act = cfg.advisor_activation;
  it("routes by advisor_activation: phase, trigger, module; NOOSPHERE never activates", () => {
    const plain = activeAdvisors(act, "whisper", "hello", { edictModule: true });
    expect(plain).toEqual(["AKASHA", "CHORUS", "EQUANIMITY", "OMEGA", "PRISM", "PROTEUS"]);
    expect(activeAdvisors(act, "deliberate", "hello", { edictModule: true })).toEqual(["ENTANGLE"]);
    expect(activeAdvisors(act, "deliberate", "Should I quit?", { edictModule: true })).toContain("DEMIURGE");
    expect(activeAdvisors(act, "deliberate", "hello", { edictModule: true, ethosHardCase: true })).toContain("JUSTITIA");
    expect(activeAdvisors(act, "deliberate", "my faith and doctrine", { edictModule: true })).toContain("REVERENCE");
    expect(activeAdvisors(act, "deliberate", "my faith and doctrine", { edictModule: false })).not.toContain("REVERENCE");
    expect(activeAdvisors(act, "compose", "x", { edictModule: true })).toEqual(["CLARION", "TIRELESS"]);
    expect(activeAdvisors(act, "reflect", "x", { edictModule: true })).toEqual(["ETERNAL", "FORMLESS", "PHOENIX"]);
    for (const p of ["whisper", "deliberate", "compose", "reflect"] as const)
      expect(activeAdvisors(act, p, "should I decide my faith", { edictModule: true, ethosHardCase: true })).not.toContain("NOOSPHERE");
  });

  it("self-endorsement is stripped; only Core or endorsed whispers are coalition-eligible", () => {
    expect(stripSelfEndorsement({ advisory: true, endorsedBy: "OMEGA" }).endorsedBy).toBeNull();
    expect(coalitionEligible({ advisory: true, endorsedBy: null })).toBe(false);
    expect(coalitionEligible({ advisory: true, endorsedBy: "LOGOS" })).toBe(true);
    expect(coalitionEligible({ advisory: false, endorsedBy: null })).toBe(true);
  });

  it("ENDORSE: the highest partner at or above T.ENDORSE adopts; otherwise nobody; unavailable → not endorsed", async () => {
    const fake = (ps: Record<string, number>): Decider => ({
      decide: async () => ({ answers: {}, model: "test", costUsd: 0, latencyMs: 0, provider: "test", calibrated: false, p: (n: string) => ps[n] ?? 0, choice: () => "", probs: () => ({}), score: () => 0 }),
    });
    const partners = [{ voice: "LOGOS", claim: "x" }, { voice: "MUSE", claim: null }];
    expect((await decideEndorsement(fake({ e_LOGOS: 0.7, e_MUSE: 0.9 }), { voice: "OMEGA", claim: "c" }, partners, "t")).endorsedBy).toBe("MUSE");
    expect((await decideEndorsement(fake({ e_LOGOS: 0.59, e_MUSE: 0.2 }), { voice: "OMEGA", claim: "c" }, partners, "t")).endorsedBy).toBeNull();
    const down: Decider = { decide: async () => { throw new DecisionUnavailableError([{ model: "m", reason: "test" }]); } };
    expect(await decideEndorsement(down, { voice: "OMEGA", claim: "c" }, partners, "t")).toEqual({ endorsedBy: null, probabilities: null });
  });

  it("DEMIURGE rollout: 8 paths, worst (most adverse steps) first, built from labels only", () => {
    const c = (outlook: RolloutStep["outlook"]): RolloutStep => ({ actor: "world", event: outlook, outlook });
    const r = buildRollout([[c("favorable"), c("adverse")], [c("favorable"), c("adverse")], [c("mixed"), c("favorable")]]);
    expect(r.paths).toHaveLength(8);
    expect(r.worst.map((s) => s.outlook)).toEqual(["adverse", "adverse", "mixed"]);
  });
});

// ---------------------------------------------------------------- integration on a private database

const URL = "file:./test-m9.db";
let db: ReturnType<typeof getDb>;
const base = loadHiveConfig();
const codeCfg = { ...base, orchestration: { ...base.orchestration, mode: "code" as const } } as HiveConfig;
beforeAll(async () => {
  await ensureDb(URL, { fresh: true });
  db = getDb(URL);
  await seed(db);
});
afterAll(() => disconnectAll());
const hive = (opts: { variant?: string; fixtures?: Record<string, LlmFixture>; cfg?: HiveConfig } = {}) =>
  createHive({ env: { USE_MOCK_PROVIDERS: "true" }, db, cfg: opts.cfg ?? codeCfg, providerDeps: { mockRules: MOCK_RULES, mockFixtures: opts.fixtures, mockContext: { variant: opts.variant } } });

describe("advisors in the heartbeat (mock)", () => {
  it("an endorsed advisory may enter the coalition; an unendorsed one never does; advisors never vote", async () => {
    const h = hive({ variant: "one_endorsed_one_not" });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "Should I forgive my brother who betrayed me? I can't decide." });
    expect(r.status).toBe("done");
    const omega = r.trace.advisors.find((a) => a.name === "OMEGA")!;
    const chorus = r.trace.advisors.find((a) => a.name === "CHORUS")!;
    expect(omega).toMatchObject({ phase: "whisper", passed: false });
    expect(omega.endorsedBy).not.toBeNull();
    expect(chorus).toMatchObject({ endorsedBy: null, enteredAs: null });
    const chorusW = r.trace.whispers.find((w) => w.voice === "CHORUS")!;
    expect(chorusW.advisory).toBe(true);
    expect(r.trace.awareness.selected).not.toContain(chorusW.messageId);
    expect(r.trace.attention.shortlist).not.toContain(chorusW.messageId);
    for (const id of r.trace.awareness.selected) {
      const w = r.trace.whispers.find((x) => x.messageId === id)!;
      if (w.advisory) expect(w.endorsedBy).not.toBeNull();
    }
    expect(r.conclave).toBeDefined();
    const advisorNames = new Set(r.trace.advisors.map((a) => a.name));
    expect(r.conclave!.ballots.some((b) => advisorNames.has(b.voice))).toBe(false);
    // the endorsement is the partner's own bus message, in reply to the advisory
    const tr = await h.transcript(r.cycleId);
    expect(tr.some((m) => m.voice === "OMEGA" && m.body.kind === "advisory_whisper")).toBe(true);
    expect(tr.some((m) => m.voice === omega.endorsedBy && m.body.kind === "endorsement" && m.body.advisor === "OMEGA")).toBe(true);
    // DEMIURGE (consequential: "decide") and ENTANGLE ran in deliberate
    expect(r.trace.advisors.find((a) => a.name === "DEMIURGE")).toMatchObject({ phase: "deliberate", trigger: "consequential_decision" });
    expect((r.trace.advisors.find((a) => a.name === "DEMIURGE")!.detail as { paths: number }).paths).toBe(8);
  });

  it("with advisors disabled in config, none run", async () => {
    const h = hive({ variant: "one_endorsed_one_not", cfg: { ...codeCfg, advisors: { ...codeCfg.advisors, enabled: false } } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "I have three job offers and can't decide." });
    expect(r.trace.advisors).toEqual([]);
    expect(r.trace.whispers.some((w) => w.advisory)).toBe(false);
  });
});

describe("signals from cycles (mock)", () => {
  it("a Conclave with dissent emits dissent signals; calibration emits none; patterns surface and dismiss", async () => {
    const h = hive();
    const before = await db.signal.count();
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "Should I forgive my brother who betrayed me?" });
    const dissenters = r.conclave!.outcome.dissent.map((d) => d.voice);
    expect(dissenters.length).toBeGreaterThan(0);
    expect(r.trace.signals.filter((s) => s.type === "dissent").map((s) => s.subjectId).sort()).toEqual([...dissenters].sort());
    expect(await db.signal.count()).toBe(before + r.trace.signals.length);

    const sit = await db.situation.findUniqueOrThrow({ where: { id: "CAL-01a" } });
    const c = await h.runCycle({ sessionId: await h.createSession("calibration"), input: sit.text, mode: "calibration", situation: { id: sit.id, text: sit.text, options: JSON.parse(sit.options) } });
    expect(c.trace.signals).toEqual([]);
    expect(await db.signal.count({ where: { cycleId: c.cycleId } })).toBe(0);

    // two more identical cycles: the same Voice(s) dissent 3 times → density 3.0 → a dissent pattern surfaces
    for (let i = 0; i < 2; i++) await h.runCycle({ sessionId: await h.createSession(), input: "Should I forgive my brother who betrayed me?" });
    const cfg = loadHiveConfig();
    const cards = await patternCards(db, cfg);
    const card = cards.find((x) => x.type === "dissent" && x.subjectId === dissenters[0])!;
    const n = await db.signal.count({ where: { type: "dissent", subjectId: dissenters[0] } }); // includes the advisor test's Conclave above
    expect(n).toBeGreaterThanOrEqual(3);
    expect(card.sentence).toMatch(new RegExp(`^${dissenters[0]} has dissented in ${n} of the last \\d+ Conclaves\\.$`));
    expect(await db.ledgerEvent.count({ where: { kind: "pattern.surfaced", subjectId: dissenters[0] } })).toBe(1);
    // dismissed: hidden, and not re-surfaced while the dismissal holds
    await dismissPattern(db, new PrismaLedger(db), cfg, card.id);
    expect((await patternCards(db, cfg)).some((x) => x.id === card.id)).toBe(false);
    expect(await surfaceNow(db, new PrismaLedger(db), cfg)).toEqual([]);
  });
});

describe("predictions (mock)", () => {
  it("ADAPT attribution is validated, check-in once with 1–5, and the track record updates", async () => {
    const fx: Record<string, LlmFixture> = {
      ADAPT_LESSON: () => ({ predictions: [{ text: "They will ask a follow-up about timing.", horizonDays: 2, voice: "kindred", mentorIds: ["not-a-mentor"] }, { text: "Unattributed.", horizonDays: 2, voice: "OMEGA", mentorIds: [] }] }),
    };
    const h = hive({ fixtures: fx });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "Should I forgive my brother who betrayed me?" });
    const rows = await db.hivePrediction.findMany({ where: { cycleId: r.cycleId }, orderBy: { text: "asc" } });
    expect(rows.map((p) => [p.proposedBy, p.mentorRefs])).toEqual([["KINDRED", "[]"], ["ADAPT", "[]"]]); // coalition Voice; advisor or unknown → ADAPT; mentor not in its evidence dropped
    const ledger = new PrismaLedger(db);
    await expect(checkIn(db, ledger, rows[0].id, 6, null)).rejects.toThrow(CheckInError);
    const future = await predictionsView(db);
    expect(future.due.some((d) => d.id === rows[0].id)).toBe(false);
    const later = new Date(Date.now() + 3 * DAY);
    expect((await predictionsView(db, later)).due.map((d) => d.id)).toContain(rows[0].id);
    await checkIn(db, ledger, rows[0].id, 4, "it held");
    await expect(checkIn(db, ledger, rows[0].id, 2, null)).rejects.toThrow(/already/);
    const v = await predictionsView(db, later);
    expect(v.trackRecord.byVoice.find((s) => s.lens === "KINDRED")).toMatchObject({ n: 1, held: 1, displayMode: "counts" });
    expect(v.checkedIn[0]).toMatchObject({ id: rows[0].id, outcomeRating: 4, outcomeNote: "it held" });
    expect(await db.ledgerEvent.count({ where: { kind: "prediction.checked_in", subjectId: rows[0].id } })).toBe(1);
  });
});
