import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectAll, getDb } from "@/lib/council/db";
import { PrismaLedger } from "@/lib/council/ledger";
import { AuthenticationError, RateLimitError, SynapseBus, type Credential } from "@/lib/hive/bus";
import type { EnvelopeDraft } from "@/lib/hive/envelope";
import { loadPermissions, PermissionError, PolicyEngine, publishActions } from "@/lib/hive/permissions";
import { loadVoices } from "@/lib/hive/voices";

/**
 * Invariant 9 (ported from reference/sent2.md bus.test.ts, guardian cases removed): powers live in
 * credentials and the real constitution/permissions.yaml, not in prompt text.
 */

const db = getDb("file:./test.db");
afterAll(() => disconnectAll());
const policy = new PolicyEngine(loadPermissions());
const ids = loadVoices().map((v) => v.id);

let bus: SynapseBus;
const cred: Record<string, Credential> = {};
let cycleN = 0;

beforeEach(() => {
  bus = new SynapseBus({ policy, knownEntities: ids, db, ledger: new PrismaLedger(db) });
  for (const id of ["core.logos", "core.lumen", "core.witness", "core.ethos", "core.kindred", "advisor.omega", "governance.symbiont_prime", "procedure.conclave"])
    cred[id] = bus.register(id);
  cycleN++;
  bus.startCycle(`cyc_test_${cycleN}`, cycleN);
});

const env = (from: string, to: string, type: EnvelopeDraft["type"], body: Record<string, unknown> = { kind: "note" }): EnvelopeDraft => ({
  from,
  to,
  type,
  body,
  task_id: "t1",
  trace_id: "tr1",
  scope: "project",
  urgency: "normal",
  in_reply_to: null,
  provenance: { prompt_version: "m2", model: "mock:test", policy_version: "permissions.yaml" },
  expects_reply: false,
});
const whisper = (claim: string, extra: Record<string, unknown> = {}) => ({ kind: "whisper", claim, confidence: 0.6, ...extra });

describe("INVARIANT 9 — powers live in credentials", () => {
  it("an advisor publishing ballot.cast THROWS on the deny rule", async () => {
    await expect(bus.publish(cred["advisor.omega"], env("advisor.omega", "task/deliberation", "ballot.cast", { option_id: "opt_t1_1", s: 1 }))).rejects.toThrow(
      /deliberation\.ballot/,
    );
  });

  it("an advisor may publish an advisory whisper to task/analysis/advisory, but not into Core analysis", async () => {
    const ok = await bus.publish(cred["advisor.omega"], env("advisor.omega", "task/analysis/advisory", "assessment.published", whisper("insight", { advisory: true })));
    expect(ok.cycle_no).toBe(cycleN);
    expect(ok.message_id).toMatch(/^msg_/);
    await expect(bus.publish(cred["advisor.omega"], env("advisor.omega", "task/analysis", "evidence.shared"))).rejects.toBeInstanceOf(PermissionError);
  });

  it("LUMEN attempting memory.hive.write THROWS on the deny rule", async () => {
    const err = await bus.publish(cred["core.lumen"], env("core.lumen", "memory/hive", "memory.candidate")).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionError);
    expect((err as PermissionError).reason).toMatch(/deny rule "memory\.hive\.write"/);
  });

  it("a Core Voice whisper to task/analysis is allowed (sent2's '/' vs '.' channel bug is fixed)", async () => {
    const m = await bus.publish(cred["core.logos"], env("core.logos", "task/analysis", "assessment.published", whisper("Unknown is a valid answer.")));
    expect(m.body.claim).toBe("Unknown is a valid answer.");
    expect(m.body.advisory).toBe(false); // defaults applied by the whisper schema
  });

  it("only SYMBIONT PRIME may publish a governance decision", async () => {
    await expect(bus.publish(cred["governance.symbiont_prime"], env("governance.symbiont_prime", "task/governance", "decision.published", { decision: "PASS" }))).resolves.toBeTruthy();
    await expect(bus.publish(cred["core.ethos"], env("core.ethos", "task/governance", "decision.published", { decision: "PASS" }))).rejects.toThrow(/governance\.decide/);
  });

  it("the Conclave moderator writes deliberation but can never cast a ballot", async () => {
    await expect(bus.publish(cred["procedure.conclave"], env("procedure.conclave", "task/deliberation", "status.updated", { round: 1 }))).resolves.toBeTruthy();
    await expect(bus.publish(cred["procedure.conclave"], env("procedure.conclave", "task/deliberation", "ballot.cast", { s: 1 }))).rejects.toThrow(/deliberation\.ballot/);
  });

  it("WITNESS reads the full transcript; LOGOS cannot, and cannot read the governance channel", async () => {
    await bus.publish(cred["core.logos"], env("core.logos", "task/analysis", "assessment.published", whisper("c")));
    expect(bus.fullTranscript(cred["core.witness"])).toHaveLength(1);
    expect(() => bus.fullTranscript(cred["core.logos"])).toThrow(PermissionError);
    expect(() => bus.read(cred["core.logos"], "task/governance")).toThrow(PermissionError);
    expect(bus.read(cred["core.logos"], "task/analysis")).toHaveLength(1);
  });
});

describe("authentication", () => {
  it("an unauthenticated sender THROWS: no credential, a forged token, or another entity's credential", async () => {
    await expect(bus.publish(null, env("core.logos", "task/analysis", "assessment.published", whisper("x")))).rejects.toBeInstanceOf(AuthenticationError);
    await expect(bus.publish({ entityId: "core.logos", token: "forged" }, env("core.logos", "task/analysis", "assessment.published", whisper("x")))).rejects.toBeInstanceOf(AuthenticationError);
    await expect(bus.publish(cred["core.ethos"], env("core.logos", "task/analysis", "assessment.published", whisper("x")))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("entities outside the roster cannot be registered", () => {
    expect(() => bus.register("plugin.unvetted")).toThrow(AuthenticationError);
  });
});

describe("bus mechanics", () => {
  it("rate limit: a second whisper from the same Voice in a cycle THROWS; the next cycle resets", async () => {
    await bus.publish(cred["core.logos"], env("core.logos", "task/analysis", "assessment.published", whisper("first")));
    await expect(bus.publish(cred["core.logos"], env("core.logos", "task/analysis", "assessment.published", whisper("second")))).rejects.toBeInstanceOf(RateLimitError);
    bus.startCycle(`cyc_test_${cycleN}_b`, cycleN + 1000);
    await expect(bus.publish(cred["core.logos"], env("core.logos", "task/analysis", "assessment.published", whisper("third")))).resolves.toBeTruthy();
  });

  it("non-whisper messages are not rate-limited", async () => {
    await bus.publish(cred["core.witness"], env("core.witness", "task/deliberation", "objection.raised"));
    await expect(bus.publish(cred["core.witness"], env("core.witness", "task/deliberation", "status.updated"))).resolves.toBeTruthy();
  });

  it("in_reply_to threads are preserved", async () => {
    const a = await bus.publish(cred["core.logos"], env("core.logos", "task/analysis", "assessment.published", whisper("A")));
    const b = await bus.publish(cred["core.ethos"], { ...env("core.ethos", "task/analysis", "critique.published"), in_reply_to: a.message_id });
    expect(b.in_reply_to).toBe(a.message_id);
  });

  it("the removed 'distress' urgency is rejected as an invalid envelope", async () => {
    await expect(bus.publish(cred["core.ethos"], { ...env("core.ethos", "task/analysis", "evidence.shared"), urgency: "distress" as "high" })).rejects.toThrow(/invalid envelope/);
  });

  it("an LLM-shaped whisper body with an out-of-range number is rejected", async () => {
    await expect(bus.publish(cred["core.logos"], env("core.logos", "task/analysis", "assessment.published", whisper("x", { confidence: 1.7 })))).rejects.toThrow(/invalid whisper body/);
  });

  it("allowed messages persist authorized=true; denials persist authorized=false and write bus.denied", async () => {
    const cycleId = bus.currentCycle!.id;
    const ok = await bus.publish(cred["core.logos"], env("core.logos", "task/analysis", "assessment.published", whisper("kept")));
    await bus.publish(cred["advisor.omega"], env("advisor.omega", "task/deliberation", "ballot.cast", { s: 1 })).catch(() => {});
    const rows = await db.busMessage.findMany({ where: { cycleId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.fromEntity, r.authorized])).toEqual([
      ["core.logos", true],
      ["advisor.omega", false],
    ]);
    expect(rows[0].id).toBe(ok.message_id);
    expect(rows[1].denyReason).toMatch(/PERMISSION DENIED/);
    const denied = await db.ledgerEvent.findMany({ where: { cycleId, kind: "bus.denied" } });
    expect(denied).toHaveLength(1);
    expect(denied[0].subjectId).toBe("advisor.omega");
  });
});

describe("action vocabulary", () => {
  it("maps a publish to its canonical actions", () => {
    expect(publishActions("task/deliberation", "ballot.cast")).toEqual(["deliberation.ballot", "task.deliberation.write", "task.deliberation.publish", "ballot.cast"]);
    expect(publishActions("task/governance", "decision.published")).toContain("governance.decide");
    expect(publishActions("memory/hive", "memory.candidate")).toContain("memory.hive.write");
  });
});
