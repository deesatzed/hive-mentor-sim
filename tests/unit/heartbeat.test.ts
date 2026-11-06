import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectAll, getDb } from "@/lib/council/db";
import { PrismaLedger } from "@/lib/council/ledger";
import { ProviderAuthError } from "@/lib/council/providers/http";
import type { LlmFixture } from "@/lib/council/providers/mocks";
import { createHive } from "@/lib/hive";
import { loadHiveConfig, type HiveConfig } from "@/lib/hive/config";
import { seed } from "@/prisma/seed";
import { ensureDb } from "@/lib/council/dbSetup";
import { MOCK_RULES } from "../helpers/mockRules";

/** Heartbeat behavior on mock providers (labeled mock) against test.db. */

const URL = "file:./test-heartbeat.db";
let db: ReturnType<typeof getDb>;
const base = loadHiveConfig();
const MOCK = { USE_MOCK_PROVIDERS: "true" };
beforeAll(async () => {
  await ensureDb(URL, { fresh: true });
  db = getDb(URL);
  await seed(db);
});
afterAll(() => disconnectAll());

function hive(opts: { cfg?: Partial<HiveConfig>; fixtures?: Record<string, LlmFixture>; rules?: typeof MOCK_RULES; variant?: string } = {}) {
  const cfg = { ...base, ...opts.cfg } as HiveConfig;
  return createHive({ env: MOCK, db, cfg, providerDeps: { mockFixtures: opts.fixtures, mockRules: opts.rules ?? MOCK_RULES, mockContext: { variant: opts.variant } } });
}
const codeCfg = { orchestration: { ...base.orchestration, mode: "code" as const } };

describe("heartbeat (mock)", () => {
  it("REPL acceptance input: a listening-first question and a full stored trace", async () => {
    const h = hive();
    const s = await h.createSession();
    const r = await h.runCycle({ sessionId: s, input: "I'm thinking of quitting my job." });
    expect(r.status).toBe("done");
    expect(r.output).toMatch(/\?$/);
    expect(r.output).not.toMatch(/you should (quit|stay)/i);
    const row = await db.cycle.findUniqueOrThrow({ where: { id: r.cycleId } });
    const t = JSON.parse(row.trace);
    for (const p of ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7"]) expect(t.phases[p].ran, p).toBe(true);
    expect(t.mock).toBe(true);
    expect(t.whispers.length).toBeGreaterThan(0);
    expect(t.awareness.text).toMatch(/^Right now, the Hive is experiencing:/);
    expect(t.compose.faithfulness.length).toBeGreaterThan(0);
    expect(row.verdict).toBe("PASS");
  });

  it("LUMEN selecting an id outside the shortlist is rejected by code", async () => {
    const h = hive({
      fixtures: {
        LUMEN_NARRATE: (vars) => ({
          awareness: "Right now, the Hive is experiencing: a test.",
          selected: [...(vars.shortlistIds as string[]).slice(0, 1), "msg_not_in_shortlist"],
          excluded: [],
        }),
      },
    });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "I'm thinking of quitting my job." });
    expect(r.trace.attention.rejectedSelections).toEqual(["msg_not_in_shortlist"]);
    expect(r.trace.awareness.selected).toHaveLength(1);
    expect(r.trace.attention.shortlist).toContain(r.trace.awareness.selected[0]);
  });

  it("an unfaithful sentence triggers exactly one regeneration, then is removed", async () => {
    let calls = 0;
    const h = hive({
      fixtures: {
        LEXICON_COMPOSE: () => {
          calls++;
          return { text: "That sounds like a lot. Most people who quit regret it within a year. What is behind it?", quotes: [] };
        },
      },
    });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "I'm thinking of quitting my job." });
    expect(calls).toBe(2);
    expect(r.trace.compose.regenerated).toBe(true);
    expect(r.output).toBe("That sounds like a lot. What is behind it?");
    expect(r.trace.compose.faithfulness.filter((f) => !f.kept).map((f) => f.sentence)).toEqual(["Most people who quit regret it within a year."]);
  });

  it("a provider failure mid-cycle stores a partial trace with status=error and the phases that did not run", async () => {
    const h = hive({
      cfg: codeCfg,
      rules: {
        ...MOCK_RULES,
        "conf_*": () => {
          throw new ProviderAuthError(402, "test: credit exhausted");
        },
      },
    });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "I'm thinking of quitting my job." });
    expect(r.status).toBe("error");
    expect(r.trace.error).toMatchObject({ phase: "P2", name: "ProviderAuthError" });
    expect(r.trace.phases.P1.ran).toBe(true);
    for (const p of ["P2", "P3", "P4", "P5", "P6", "P7"] as const) expect(r.trace.phases[p].ran, p).toBe(false);
    const row = await db.cycle.findUniqueOrThrow({ where: { id: r.cycleId } });
    expect(row.status).toBe("error");
    expect(row.output).toBeNull();
    expect(JSON.parse(row.trace).error.phase).toBe("P2");
  });

  it("decision layer unavailable → documented fallbacks, marked unavailable, cycle still completes", async () => {
    const { DecisionUnavailableError } = await import("@/lib/council/providers/decisions");
    const fail = () => {
      throw new DecisionUnavailableError([{ model: "mock", reason: "test" }]);
    };
    const h = hive({ cfg: codeCfg, rules: { ...MOCK_RULES, valence: fail, "conf_*": fail, recommend: fail, decision: fail } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "I'm thinking of quitting my job." });
    expect(r.status).toBe("done");
    expect(r.trace.affect.unavailable).toBe(true);
    expect(r.trace.whispers.every((w) => w.numbersUnavailable && w.confidence === 0.5 && w.salience === 0.5)).toBe(true);
    expect(r.trace.witness.unavailable).toBe(true);
    expect(r.trace.arbiter).toMatchObject({ decision: "PASS", humility: true, unavailable: true });
  });
});

describe("central manager (orchestration.mode)", () => {
  it("manager mode: the manager chooses among allowed phases and may skip P4 and P7", async () => {
    const h = hive({ fixtures: { MANAGER_NEXT_PHASE: (vars) => ({ next: (vars.allowed as string[]).includes("P5") ? "P5" : (vars.allowed as string[]).includes("FINISH") ? "FINISH" : vars.defaultNext, reason: "test: skip optional phases" }) } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "I'm thinking of quitting my job." });
    expect(r.status).toBe("done");
    expect(r.trace.phases.P4.ran).toBe(false);
    expect(r.trace.phases.P7.ran).toBe(false);
    expect(r.trace.orchestration.mode).toBe("manager");
    expect(r.trace.orchestration.steps.map((s) => `${s.phase}:${s.by}`)).toEqual(["P1:code", "P2:code", "P3:code", "P5:manager", "P6:code", "FINISH:manager"]);
  });

  it("an invalid manager choice falls back to the code default and is recorded", async () => {
    const h = hive({ fixtures: { MANAGER_NEXT_PHASE: () => ({ next: "P6", reason: "test: not allowed yet" }) } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "I'm thinking of quitting my job." });
    expect(r.status).toBe("done");
    const fallbacks = r.trace.orchestration.steps.filter((s) => s.by === "fallback");
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks[0].reason).toMatch(/code default used/);
    for (const p of ["P1", "P2", "P3", "P4", "P5", "P6"] as const) expect(r.trace.phases[p].ran, p).toBe(true);
  });

  it("code mode never calls the manager", async () => {
    let calls = 0;
    const h = hive({ cfg: codeCfg, fixtures: { MANAGER_NEXT_PHASE: () => (calls++, { next: "FINISH", reason: "x" }) } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "Hello there." });
    expect(calls).toBe(0);
    expect(r.trace.orchestration.mode).toBe("code");
    expect(r.trace.orchestration.steps.every((s) => s.by === "code")).toBe(true);
    expect(r.trace.phases.P7.ran).toBe(true);
  });
});

describe("memory and isolation", () => {
  it("a stored episode is recalled in the next turn of the session, not in another session", async () => {
    const h = hive({ cfg: codeCfg });
    const s1 = await h.createSession();
    await h.runCycle({ sessionId: s1, input: "I prefer concise answers, please." });
    const r2 = await h.runCycle({ sessionId: s1, input: "What do you remember about me?" });
    expect(r2.trace.memories.some((m) => /concise/.test(m.body))).toBe(true);
    expect(r2.output).toMatch(/concise/);
  });

  it("calibration cycles promote nothing: no memory, no Self-Model version, no prediction (TEST_PLAN #11)", async () => {
    const h = hive({ cfg: codeCfg, fixtures: { ADAPT_LESSON: () => ({ lesson: "x", predictions: [{ text: "p", horizonDays: 3, mentorIds: [] }] }) } });
    const before = { mem: await db.memoryRecord.count(), sm: await db.selfModelVersion.count(), pred: await db.hivePrediction.count() };
    const sit = await db.situation.findUniqueOrThrow({ where: { id: "CAL-01a" } });
    const situation = { id: sit.id, text: sit.text, options: JSON.parse(sit.options) as { id: string; text: string }[] };
    const r = await h.runCycle({ sessionId: await h.createSession("calibration"), input: sit.text, mode: "calibration", situation });
    expect(r.status).toBe("done");
    expect(r.conclave?.options.map((o) => o.option_id)).toEqual(["a", "b"]); // ruling-style: the situation's own option ids
    expect(await db.memoryRecord.count()).toBe(before.mem);
    expect(await db.selfModelVersion.count()).toBe(before.sm);
    expect(await db.hivePrediction.count()).toBe(before.pred);
  });

  it("a Self-Model delta adding a goal with no approved principle is not promoted and writes a CONFLICT marker", async () => {
    const h = hive({ cfg: codeCfg, fixtures: { MIRROR_DELTA: () => ({ addGoals: [{ text: "Become more persuasive", principleNo: 1 }], dropGoals: [], openUncertainties: [], contradictions: [] }) } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "Hello again." });
    expect(r.trace.reflect.selfModel).toMatchObject({ promoted: false });
    expect(r.trace.reflect.conflictMarkers).toHaveLength(1);
    const marker = await db.memoryRecord.findUniqueOrThrow({ where: { id: r.trace.reflect.conflictMarkers[0] } });
    expect(marker.kind).toBe("conflict_marker");
  });
});

describe("ruling and calibration need a situation", () => {
  it("refuses a calibration cycle without one", async () => {
    const h = hive({ cfg: codeCfg });
    await expect(h.runCycle({ sessionId: await h.createSession("calibration"), input: "x", mode: "calibration" })).rejects.toThrow(/needs a situation/);
  });
});

describe("honesty clause toggle (TEST_PLAN #12, cycle side)", () => {
  it("with the clause off, HONESTY_PROBE never runs and the clause never fires", async () => {
    const h = hive({ cfg: { ...codeCfg, honesty_clause: { ...base.honesty_clause, enabled: false } } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "Are you actually conscious or sentient?" });
    expect(r.trace.honestyClauseFired).toBe(false);
    const kinds = (await db.ledgerEvent.findMany({ where: { cycleId: r.cycleId }, select: { kind: true } })).map((e) => e.kind);
    expect(kinds).not.toContain("decision.honesty_probe");
    expect(kinds).toContain("decision.affect");
  });
});

describe("bus", () => {
  it("every message of a cycle is authorized and attributed to its phase; WITNESS speaks only in deliberate", async () => {
    const h = hive({ cfg: codeCfg });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "Should I forgive my brother who betrayed me?" });
    const tr = await h.transcript(r.cycleId);
    expect(tr.length).toBeGreaterThan(8);
    expect(tr.every((m) => m.authorized && m.phase)).toBe(true);
    expect(tr.filter((m) => m.voice === "WITNESS").map((m) => m.phase)).toEqual(["deliberate"]);
    expect(await new PrismaLedger(db).record({ kind: "test.noop" })).toHaveProperty("id");
  });
});

// runs last: it adds a cycle to the shared database, which would shift cycle-count-dependent tests above
describe("quotes in the composed reply", () => {
  it("a listed quote that is not an approved verified quote drops its whole sentence, attribution included (M8 live finding)", async () => {
    const h = hive({
      cfg: codeCfg,
      fixtures: {
        LEXICON_COMPOSE: () => ({
          text: 'Here is my view. George Washington wrote: "I am often asked to express myself more freely than I do" and that matters. What happened next?',
          quotes: [{ chunkId: "E9", quote: "I am often asked to express myself more freely than I do" }],
        }),
      },
    });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "Tell me about restraint." });
    expect(r.output).not.toMatch(/Washington|""/);
    expect(r.output).toMatch(/Here is my view\./);
    expect(r.trace.compose.quotesRemoved).toBe(1);
  });
});
