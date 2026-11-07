import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { PrismaLedger } from "@/lib/council/ledger";
import { mockChoice, type MockRule } from "@/lib/council/providers/mocks";
import { createHive } from "@/lib/hive";
import { aggregate, applyFinalCall, type Ballot } from "@/lib/hive/conclave";
import { loadHiveConfig, type HiveConfig } from "@/lib/hive/config";
import { DominantMentorError, rulingDominant, sessionDominant, setRulingDominant, setSessionDominant } from "@/lib/hive/dominant";
import { currentKey, keyLabel } from "@/lib/hive/reveal";
import { seed } from "@/prisma/seed";
import { MOCK_RULES } from "../helpers/mockRules";

/**
 * Dominant mentor's final call (owner decision 2026-11-06). Mock providers, labeled. TEST FIXTURE: Seneca is
 * marked active with two hand-written principles, because a fresh test database has no corpus.
 */

const URL = "file:./test-dominant.db";
let db: ReturnType<typeof getDb>;
const base = loadHiveConfig();
const cfg = { ...base, orchestration: { ...base.orchestration, mode: "code" as const } } as HiveConfig;
/** the dominant mentor picks the LAST option, so it overrules the vote whenever the vote picked another one */
const pickLast: MockRule = (_t, q) => (q.type === "choice" ? mockChoice(q, Object.keys(q.criteria).at(-1)!) : { type: "noul", noul: 0.5 });
const hive = () => createHive({ env: { USE_MOCK_PROVIDERS: "true" }, db, cfg, providerDeps: { mockRules: { ...MOCK_RULES, call: pickLast } } });

beforeAll(async () => {
  await ensureDb(URL, { fresh: true });
  db = getDb(URL);
  await seed(db);
  await db.mentor.update({ where: { id: "seneca" }, data: { active: true } });
  await db.mentorPrinciple.createMany({
    data: [
      { mentorId: "seneca", text: "TEST FIXTURE: anger is a brief madness; delay before acting on it.", axis: "emotion" },
      { mentorId: "seneca", text: "TEST FIXTURE: forgive what can be forgiven, but do not pretend harm was not done.", axis: "ethics" },
    ],
  });
});
afterAll(async () => {
  await disconnectAll();
});

describe("applyFinalCall (pure)", () => {
  it("replaces the vote's winner and recomputes dissent against the call", () => {
    const ballots: Ballot[] = [
      { voice: "A", w: 1, c: 1, scores: { o1: 0.9, o2: 0.1 }, abstained: false },
      { voice: "B", w: 1, c: 1, scores: { o1: 0.8, o2: 0.3 }, abstained: false },
      { voice: "C", w: 1, c: 1, scores: { o1: 0.2, o2: 0.9 }, abstained: false },
    ];
    const vote = aggregate({ optionIds: ["o1", "o2"], ballots, params: { tauPass: 0.6, tauMargin: 0.1, qMin: 0.1, antiEchoMinGuilds: 0, guilds: {} } });
    expect(vote.winner).toBe("o1");
    expect(vote.dissent.map((d) => d.voice)).toEqual(["C"]);
    const called = applyFinalCall(vote, ballots, ["o1", "o2"], "o2");
    expect(called.winner).toBe("o2");
    expect(called.dissent.map((d) => d.voice).sort()).toEqual(["A", "B"]);
    expect(called.totals).toEqual(vote.totals); // the vote stays visible
    expect(() => applyFinalCall(vote, ballots, ["o1", "o2"], "o9")).toThrow();
  });
});

describe("choosing the dominant mentor", () => {
  it("only an active mentor can be chosen, and every change is ledgered", async () => {
    const h = hive();
    const s = await h.createSession();
    const ledger = new PrismaLedger(db);
    await expect(setSessionDominant(db, ledger, s, "laozi")).rejects.toThrow(DominantMentorError); // inactive in a fresh database
    await setSessionDominant(db, ledger, s, "seneca");
    expect(await sessionDominant(db, s)).toEqual({ id: "seneca", name: "Seneca" });
    const rows = await db.ledgerEvent.findMany({ where: { kind: "session.dominant_mentor", subjectId: s } });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toEqual({ from: null, to: "seneca" });
  });
});

describe("the final call in a cycle", () => {
  it("chat: the dominant mentor's call replaces the vote's winner, and the vote and dissent stay recorded", async () => {
    const h = hive();
    const s = await h.createSession("chat", "t", "seneca");
    const r = await h.runCycle({ sessionId: s, input: "Should I forgive my brother who betrayed me?" });
    expect(r.status).toBe("done");
    const fc = r.trace.finalCall!;
    expect(fc).toMatchObject({ mentorId: "seneca", mentorName: "Seneca", unavailable: false, skipped: null });
    expect(r.conclave).not.toBeNull();
    const ids = r.conclave!.options.map((o) => o.option_id);
    expect(fc.choice).toBe(ids.at(-1)); // the mock rule picks the last option
    expect(r.conclave!.outcome.winner).toBe(fc.choice);
    expect(fc.overruledVote).toBe(fc.voteWinner !== null && fc.voteWinner !== fc.choice);
    expect(Object.keys(fc.soundness).sort()).toEqual([...ids].sort());
    const run = await db.conclaveRun.findUniqueOrThrow({ where: { cycleId: r.cycleId } });
    expect(run.winner).toBe(fc.choice);
    expect(JSON.parse(run.finalCall!)).toMatchObject({ mentorId: "seneca", choice: fc.choice });
    // the mentor's reason is never in the mentor's own voice
    expect(fc.reason).toMatch(/^Judged by Seneca's principles/);
    expect(fc.reason).not.toMatch(/\bI (am|think|believe|say)\b/);
    const msgs = await h.transcript(r.cycleId);
    expect(msgs.some((m) => m.body.kind === "dominant_call")).toBe(true);
  });

  it("chat without a contradiction still deliberates when a dominant mentor is set (the threshold no longer gates the choice)", async () => {
    const h = hive();
    const s = await h.createSession("chat", "t", "seneca");
    const r = await h.runCycle({ sessionId: s, input: "I keep putting off a hard conversation with my manager. How do I start it?" });
    expect(r.status).toBe("done");
    expect(r.trace.phases.P4.ran).toBe(true);
    const fc = r.trace.finalCall!;
    expect(fc.mentorId).toBe("seneca");
    // either the mentor chose between the distinct positions, or there was only one position to take
    if (fc.skipped) expect(fc.skipped).toMatch(/only one position/);
    else expect(r.conclave!.outcome.winner).toBe(fc.choice);
  });

  it("without a dominant mentor the vote alone decides (no final call recorded)", async () => {
    const h = hive();
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "Should I forgive my brother who betrayed me?" });
    expect(r.trace.finalCall).toBeUndefined();
  });

  it("Reveal and calibration use the operator's choice, and it is part of the Reveal key", async () => {
    const ledger = new PrismaLedger(db);
    expect((await currentKey(db)).dominantMentorId).toBeNull();
    await setRulingDominant(db, ledger, "seneca");
    expect(await rulingDominant(db)).toEqual({ id: "seneca", name: "Seneca" });
    const key = await currentKey(db);
    expect(key.dominantMentorId).toBe("seneca");
    expect(keyLabel(key)).toMatch(/final call Seneca/);
    const dl = await db.situation.findFirstOrThrow({ where: { setKey: "dilemma" }, orderBy: { id: "asc" } });
    const h = hive();
    const s = await h.createSession("ruling", "t", key.dominantMentorId);
    const r = await h.runCycle({ sessionId: s, input: dl.text, mode: "ruling", situation: { id: dl.id, text: dl.text, options: JSON.parse(dl.options) } });
    expect(r.trace.finalCall?.mentorId).toBe("seneca");
    expect(r.conclave!.outcome.winner).toBe(r.trace.finalCall!.choice);
    await setRulingDominant(db, ledger, null);
    expect(await rulingDominant(db)).toBeNull();
    expect(await db.ledgerEvent.count({ where: { kind: "settings.dominant_mentor" } })).toBe(2);
  });
});
