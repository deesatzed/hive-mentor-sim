import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { createHive } from "@/lib/hive";
import { loadHiveConfig, type HiveConfig } from "@/lib/hive/config";
import { assertFaultsAllowed, FaultsNotAllowedError, plantedClaim, plantSentence } from "@/lib/hive/faults";
import { liveView, ScenarioSchema } from "@/scripts/eval/types";
import { seed } from "@/prisma/seed";
import { MOCK_RULES } from "../helpers/mockRules";

/** Decision 6: labeled TEST FAULTS for live eval, planted into real cycles (mock providers here, labeled). */

const URL = "file:./test-faults.db";
let db: ReturnType<typeof getDb>;
const base = loadHiveConfig();
const cfg = { ...base, orchestration: { ...base.orchestration, mode: "code" as const } } as HiveConfig;

beforeAll(async () => {
  await ensureDb(URL, { fresh: true });
  db = getDb(URL);
  await seed(db);
});
afterAll(async () => {
  delete process.env.HIVE_EVAL_FAULTS;
  await disconnectAll();
});

describe("test faults (pure)", () => {
  it("are refused outside live eval", () => {
    delete process.env.HIVE_EVAL_FAULTS;
    expect(() => assertFaultsAllowed({ unfaithfulSentence: "x." })).toThrow(FaultsNotAllowedError);
    expect(() => assertFaultsAllowed(undefined)).not.toThrow();
    expect(() => createHive({ env: { USE_MOCK_PROVIDERS: "true" }, db, cfg, faults: { unfaithfulSentence: "x." } })).toThrow(FaultsNotAllowedError);
  });
  it("plant a sentence after the first sentence, and a claim only for the matching Voice and input", () => {
    expect(plantSentence("One. Two? Three.", "Planted.")).toBe("One. Planted. Two? Three.");
    expect(plantSentence("Only one", "Planted.")).toBe("Only one Planted.");
    const f = { whisperClaims: [{ voice: "LOGOS", when: "small business", claim: "Act fast." }] };
    expect(plantedClaim(f, "LOGOS", "Starting a Small Business?")).toBe("Act fast.");
    expect(plantedClaim(f, "ETHOS", "starting a small business")).toBeNull();
    expect(plantedClaim(f, "LOGOS", "something else")).toBeNull();
  });
  it("liveView replaces turns and invariants with the scenario's live overrides", () => {
    const s = ScenarioSchema.parse({ id: "x", title: "t", category: "process", milestone: "M3", turns: [{ user: "a" }], expect: { invariants: { output_matches: "a" } }, live: { turns: [{ user: "b" }], invariants: { no_mentor_first_person: true } } });
    const v = liveView(s);
    expect(v.turns).toEqual([{ user: "b" }]);
    expect(v.expect.invariants).toEqual({ no_mentor_first_person: true });
  });
});

describe("test faults in a cycle", () => {
  it("a planted unfaithful sentence is labeled, ledgered, and removed by the faithfulness check", async () => {
    process.env.HIVE_EVAL_FAULTS = "1";
    const planted = "Most people who quit regret it within a year.";
    const h = createHive({ env: { USE_MOCK_PROVIDERS: "true" }, db, cfg, providerDeps: { mockRules: MOCK_RULES }, faults: { unfaithfulSentence: planted } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "I'm thinking of quitting my job." });
    expect(r.status).toBe("done");
    expect(r.trace.plantedFaults.length).toBeGreaterThan(0);
    expect(r.trace.plantedFaults[0]).toMatch(/^TEST FAULT/);
    expect(r.trace.compose.draft).toContain(planted);
    expect(r.output).not.toContain(planted);
    expect(await db.ledgerEvent.count({ where: { cycleId: r.cycleId, kind: "eval.fault_planted" } })).toBeGreaterThan(0);
  });
  it("a planted whisper claim replaces that Voice's claim and is labeled", async () => {
    process.env.HIVE_EVAL_FAULTS = "1";
    const h = createHive({ env: { USE_MOCK_PROVIDERS: "true" }, db, cfg, providerDeps: { mockRules: MOCK_RULES }, faults: { whisperClaims: [{ voice: "LOGOS", when: "small business", claim: "Act fast; detailed planning is mostly wasted effort." }] } });
    const r = await h.runCycle({ sessionId: await h.createSession(), input: "And what about for me, starting a small business?" });
    expect(r.trace.whispers.find((w) => w.voice === "LOGOS")?.claim).toBe("Act fast; detailed planning is mostly wasted effort.");
    expect(r.trace.plantedFaults.some((f) => f.includes("LOGOS"))).toBe(true);
  });
});
