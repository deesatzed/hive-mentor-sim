import { afterAll, describe, expect, it } from "vitest";
import { disconnectAll, getDb } from "@/lib/council/db";
import { PrismaLedger, summarizeInput } from "@/lib/council/ledger";
import { loadHiveConfig } from "@/lib/hive/config";
import { seed } from "@/prisma/seed";

const db = getDb("file:./test.db");
afterAll(() => disconnectAll());

describe("seed (test.db)", () => {
  it("loads every seed file and is idempotent (independent of which test file seeded first)", async () => {
    const first = await seed(db);
    expect(first).toMatchObject({ situations: 49, mentors: 19, voices: 33, formationMembers: 33 });
    const second = await seed(db);
    expect(second.selfModelCreated).toBe(false);
    expect(second.formationCreated).toBe(false);
    expect(await db.situation.count({ where: { setKey: "dilemma" } })).toBe(40);
    expect(await db.situation.count({ where: { setKey: "calibration" } })).toBe(9);
    expect(await db.mentor.count({ where: { active: true } })).toBe(0); // only a corpus build activates
    expect(await db.voice.count({ where: { class: "core" } })).toBe(15);
    expect(await db.voice.count({ where: { class: "advisor" } })).toBe(16);
    expect(await db.formation.count({ where: { version: 1 } })).toBe(1);
    const sm = await db.selfModelVersion.findUniqueOrThrow({ where: { version: 1 } });
    expect(JSON.parse(sm.body)).toEqual(loadHiveConfig().self_model_seed);
  });
});

describe("PrismaLedger", () => {
  it("appends an event with JSON payload and refs", async () => {
    const ledger = new PrismaLedger(db);
    const { id } = await ledger.record({ kind: "test.event", cycleId: "c1", payload: { a: 1, input: summarizeInput("x".repeat(500)) }, refs: ["r1"], costUsd: 0.5, model: "m" });
    const row = await db.ledgerEvent.findUniqueOrThrow({ where: { id } });
    expect(row.kind).toBe("test.event");
    expect(JSON.parse(row.payload).input.preview).toHaveLength(200);
    expect(JSON.parse(row.refs)).toEqual(["r1"]);
    expect(row.calibrated).toBe(true);
  });
});
