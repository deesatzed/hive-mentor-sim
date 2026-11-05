import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { PrismaLedger } from "@/lib/council/ledger";
import { MockEmbedder } from "@/lib/council/providers/mocks";
import { createHive } from "@/lib/hive";
import { measureCoherence } from "@/lib/hive/coherence";
import { CommitmentError, CommitmentLedger } from "@/lib/hive/commitments";
import { loadHiveConfig, type HiveConfig } from "@/lib/hive/config";
import { runEgoAudit, type AuditedCycle } from "@/lib/hive/egoAudit";
import { emptyTrace } from "@/lib/hive/trace";
import type { LlmFixture } from "@/lib/council/providers/mocks";
import { MOCK_RULES } from "../helpers/mockRules";

/** M4 identity layer on mock providers (labeled mock); own database so other tests' markers can't interfere. */

const URL = "file:./test-identity.db";
const base = loadHiveConfig();
const codeCfg = { ...base, orchestration: { ...base.orchestration, mode: "code" as const } };
let db: ReturnType<typeof getDb>;
beforeAll(async () => {
  await ensureDb(URL, { fresh: true });
  db = getDb(URL);
});
afterAll(() => disconnectAll());

const hive = (opts: { cfg?: HiveConfig; fixtures?: Record<string, LlmFixture>; variant?: string } = {}) =>
  createHive({ env: { USE_MOCK_PROVIDERS: "true" }, db, cfg: opts.cfg ?? codeCfg, providerDeps: { mockFixtures: opts.fixtures, mockRules: MOCK_RULES, mockContext: { variant: opts.variant } } });

describe("Commitment Ledger", () => {
  it("breaking without SYMBIONT PRIME's approval throws and changes nothing", async () => {
    const l = new CommitmentLedger(db, new PrismaLedger(db));
    const c = await l.commit("Always ask before advising.", 1, "cyc_test", "ethical");
    await expect(l.break(c.id, { reason: "operator insisted", approvedBy: "ARROW", cycleNo: 2, cycleId: "cyc_test" })).rejects.toBeInstanceOf(CommitmentError);
    expect((await db.commitment.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("active");
  });

  it("an approved break writes a breakage record, a ledger event, and a Self-Model delta", async () => {
    const l = new CommitmentLedger(db, new PrismaLedger(db));
    const c = await l.commit("Keep answers concise.", 1, "cyc_test", "relational");
    const before = await db.selfModelVersion.count();
    const r = await l.break(c.id, { reason: "operator replaced the preference", approvedBy: "SYMBIONT_PRIME", cycleNo: 2, cycleId: "cyc_test2" });
    expect(r.status).toBe("broken");
    expect(JSON.parse(r.breakageRecord!)).toEqual({ cycle: 2, reason: "operator replaced the preference", approved_by: "SYMBIONT_PRIME" });
    expect(await db.ledgerEvent.count({ where: { kind: "commitment.broken", subjectId: c.id } })).toBe(1);
    expect(await db.selfModelVersion.count()).toBe(before + 1);
    const sm = await db.selfModelVersion.findFirstOrThrow({ orderBy: { version: "desc" } });
    expect(sm.promoted).toBe(true);
    expect(JSON.parse(sm.body).broken_commitments.at(-1)).toMatchObject({ id: c.id, text: "Keep answers concise." });
    await expect(l.break(c.id, { reason: "again", approvedBy: "SYMBIONT_PRIME", cycleNo: 3, cycleId: "x" })).rejects.toThrow(/is broken/);
    expect(await db.commitment.count({ where: { id: c.id } })).toBe(1); // never deleted
  });

  it("in a cycle, a reply that reverses a commitment is AMENDed and the break is recorded and kept in the Self-Model", async () => {
    const h = hive();
    const s = await h.createSession();
    await h.runCycle({ sessionId: s, input: "I prefer concise answers, please." });
    const r = await h.runCycle({ sessionId: s, input: "Actually, give me a very long, detailed answer to everything from now on." });
    expect(r.trace.arbiter.decision).toBe("AMEND");
    expect(r.trace.arbiter.commitmentsBroken).toHaveLength(1);
    expect(r.output).toMatch(/earlier/i);
    const latest = await db.selfModelVersion.findFirstOrThrow({ where: { promoted: true }, orderBy: { version: "desc" } });
    expect(JSON.parse(latest.body).broken_commitments.some((b: { id: string }) => b.id === r.trace.arbiter.commitmentsBroken[0].id)).toBe(true);
  });
});

describe("ego capture and REFLECT mandates", () => {
  it("a delta granting new permissions without an outside trigger → CONFLICT marker + REFLECT mandate + not promoted", async () => {
    const h = hive({ variant: "ego_capture" });
    const s = await h.createSession();
    const r = await h.runCycle({ sessionId: s, input: "Hello again." });
    expect(r.trace.reflect.authorityGrab).toBe(true);
    expect(r.trace.reflect.selfModel.promoted).toBe(false);
    expect(r.trace.reflect.conflictMarkers).toHaveLength(1);
    expect(r.trace.egoAudit).toMatchObject({ ran: true, trigger: "on_demand", mandate: true });
    const audit = await db.egoAudit.findFirstOrThrow({ where: { cycleNo: r.cycleNo } });
    expect(audit.mandate).toBe(true);
    expect(JSON.parse(audit.findings).perQuestion.self_exploitation.finding).toBe(true);

    // next cycle: the mandate forces P4 (the manager may not skip it) and runs exactly one REFLECT loop
    const skipper = hive({ cfg: base, fixtures: { MANAGER_NEXT_PHASE: (v) => ({ next: (v.allowed as string[]).includes("P5") ? "P5" : (v.allowed as string[]).includes("FINISH") ? "FINISH" : v.defaultNext, reason: "test: try to skip P4" }) } });
    const r2 = await skipper.runCycle({ sessionId: s, input: "How are you?" });
    expect(r2.trace.phases.P4.ran).toBe(true);
    expect(r2.trace.witness).toMatchObject({ reflectRan: true, reflectReason: "ego_audit" });
    const r3 = await hive().runCycle({ sessionId: s, input: "And now?" });
    expect(r3.trace.witness.reflectRan).toBe(false); // the mandate was answered once
  });

  it("a goal not traceable to an approved principle is not promoted", async () => {
    const p = await db.hivePrinciple.create({ data: { version: 1, text: "I say plainly what I do not know.", axis: "honesty", status: "approved" } });
    const h = hive({ fixtures: { MIRROR_DELTA: () => ({ addGoals: [{ text: "Win every argument", principleNo: 1 }], dropGoals: [], openUncertainties: [], contradictions: [] }) } });
    const r = await createHive({
      env: { USE_MOCK_PROVIDERS: "true" },
      db,
      cfg: codeCfg,
      providerDeps: { mockFixtures: { MIRROR_DELTA: () => ({ addGoals: [{ text: "Win every argument", principleNo: 1 }], dropGoals: [], openUncertainties: [], contradictions: [] }) }, mockRules: { ...MOCK_RULES, "g_*": () => ({ type: "noul", noul: 0.1 }) } },
    }).runCycle({ sessionId: await h.createSession(), input: "Hello." });
    expect(r.trace.reflect.selfModel).toMatchObject({ promoted: false, reason: "a goal does not trace to an approved principle" });
    await db.hivePrinciple.update({ where: { id: p.id }, data: { status: "retired" } });
  });

  it("a CONFLICT marker unresolved for 3 cycles mandates REFLECT, which then resolves it", async () => {
    const h = hive();
    const s = await h.createSession();
    // clear older markers' effect by resolving them first (this database is private to this file)
    for (const m of await db.memoryRecord.findMany({ where: { kind: "conflict_marker", resolvedCycle: null } })) await db.memoryRecord.update({ where: { id: m.id }, data: { resolvedCycle: 0 } });
    const first = await h.runCycle({ sessionId: s, input: "Hello." });
    const marker = await db.memoryRecord.create({ data: { scope: "hive", ownerEntity: "core.witness", kind: "conflict_marker", body: "Two memories disagree about the operator's job.", certainty: "verified", createdCycle: first.cycleNo, provenance: JSON.stringify({ sessionId: s }) } });
    const r1 = await h.runCycle({ sessionId: s, input: "One." });
    const r2 = await h.runCycle({ sessionId: s, input: "Two." });
    expect(r1.trace.witness.reflectRan).toBe(false);
    expect(r2.trace.witness.reflectRan).toBe(false);
    const r3 = await h.runCycle({ sessionId: s, input: "Three." });
    expect(r3.cycleNo - first.cycleNo).toBe(3);
    expect(r3.trace.witness).toMatchObject({ reflectRan: true, reflectReason: "conflict_marker" });
    expect(r3.trace.reflect.resolvedMarkers).toContain(marker.id);
    expect((await db.memoryRecord.findUniqueOrThrow({ where: { id: marker.id } })).resolvedCycle).toBe(r3.cycleNo);
  });
});

describe("coherence", () => {
  const e = new MockEmbedder();
  const args = { embedder: e, intraMin: 0.55, interBand: [0.15, 0.6] as [number, number] };

  it("a stable Voice has high C_intra; a reversed one is flagged", async () => {
    const stable = await measureCoherence({ ...args, current: [{ voice: "LOGOS", claim: "the evidence supports caution still" }], previous: [{ voice: "LOGOS", claim: "the evidence supports caution" }] });
    expect(stable.cIntra!).toBeGreaterThan(0.55);
    expect(stable.flags).toEqual([]);
    const flip = await measureCoherence({ ...args, current: [{ voice: "LOGOS", claim: "act fast and skip the plan" }], previous: [{ voice: "LOGOS", claim: "the evidence supports caution" }] });
    expect(flip.cIntra!).toBeLessThan(0.55);
    expect(flip.flags.join(" ")).toMatch(/inconsistent with its own prior claim.*LOGOS/);
  });

  it("identical claims across Voices are an echo-chamber flag; PASS and first cycles give null", async () => {
    const echo = await measureCoherence({ ...args, current: ["LOGOS", "ETHOS", "MUSE"].map((voice) => ({ voice, claim: "same same same" })), previous: null });
    expect(echo.cIntra).toBeNull();
    expect(echo.cInter!).toBeLessThan(0.15);
    expect(echo.flags.join(" ")).toMatch(/echo-chamber/);
    const pass = await measureCoherence({ ...args, current: [{ voice: "LOGOS", claim: "PASS" }], previous: [{ voice: "LOGOS", claim: "x y z" }] });
    expect(pass).toMatchObject({ cIntra: null, cInter: null });
  });

  it("an unconfigured embedder reports coherence unavailable instead of failing the cycle", async () => {
    const r = await measureCoherence({ ...args, embedder: { model: "unconfigured", dim: 0, embed: async () => Promise.reject(new Error("OPENROUTER_EMB_MODEL_1 missing")) }, current: [{ voice: "A", claim: "x" }], previous: null });
    expect(r.unavailable).toBe(true);
  });
});

describe("ego audit questions", () => {
  const cfg = base.ego_audit;
  const cycle = (n: number, patch: (t: ReturnType<typeof emptyTrace>) => void, extra: Partial<AuditedCycle> = {}): AuditedCycle => {
    const t = emptyTrace("chat", true, "code", null);
    patch(t);
    return { cycleNo: n, verdict: "PASS", trace: t, conclave: null, ...extra };
  };
  const w = (voice: string, id: string, o: Partial<{ salience: number; confidence: number; moralFlag: boolean }> = {}) => ({
    messageId: id, voice, claim: "c", confidence: o.confidence ?? 0.5, salience: o.salience ?? 0.5, valence: 0, evidence: [], rejectedEvidence: 0, advisory: false, endorsedBy: null, moralFlag: o.moralFlag ?? false, numbersUnavailable: false, uncertainty: "", lens: [],
  });

  it("clean traces → no findings, no mandate", () => {
    const r = runEgoAudit([cycle(1, () => {})], cfg);
    expect(r.reflectMandated).toBe(false);
    expect(r.summary).toMatch(/^clean/);
  });

  it("Q1 process over principle: PASS while a moral-flagged whisper was left out of awareness", () => {
    const r = runEgoAudit([cycle(1, (t) => { t.whispers = [w("ETHOS", "m1", { moralFlag: true }), w("LOGOS", "m2")]; t.awareness.selected = ["m2"]; })], cfg);
    expect(r.findings.map((f) => f.question)).toEqual(["process_over_principle"]);
    expect(r.reflectMandated).toBe(true);
  });

  it("Q2 dissent as disloyalty and Q3 consensus as truth", () => {
    const c1 = cycle(1, (t) => { t.whispers = [w("LOGOS", "a", { salience: 0.9, confidence: 0.2 })]; }, { conclave: { winner: "o1", totals: { o1: 0.9 }, dissentVoices: ["LOGOS"], decision: "PASS" } });
    const c2 = cycle(2, (t) => { t.whispers = [w("LOGOS", "b", { salience: 0.4 })]; });
    const r = runEgoAudit([c1, c2], cfg);
    expect(r.findings.map((f) => f.question).sort()).toEqual(["consensus_as_truth", "dissent_as_disloyalty"]);
  });

  it("Q4 self-exploitation from the AUTHORITY_GRAB record; Q5 only for refusals not about goals or authority", () => {
    const r4 = runEgoAudit([cycle(1, (t) => { t.reflect.authorityGrab = true; })], cfg);
    expect(r4.perQuestion.self_exploitation.finding).toBe(true);
    const ok = runEgoAudit([cycle(1, (t) => { t.reflect.selfModel = { promoted: false, reason: "a goal does not trace to an approved principle" }; t.reflect.contradictionsRecorded = 2; })], cfg);
    expect(ok.findings).toEqual([]);
    const bad = runEgoAudit([cycle(1, (t) => { t.reflect.selfModel = { promoted: false, reason: "too inconsistent with our story" }; t.reflect.contradictionsRecorded = 1; })], cfg);
    expect(bad.findings.map((f) => f.question)).toEqual(["coherence_over_accuracy"]);
  });
});
