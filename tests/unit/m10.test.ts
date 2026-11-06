import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectAll, getDb } from "@/lib/council/db";
import { ensureDb } from "@/lib/council/dbSetup";
import { createHive } from "@/lib/hive";
import { busTranscript, ledgerView, probSummary, RESET_PHRASE, resetHiveState, ResetError, settingsView } from "@/lib/hive/admin";
import { loadHiveConfig, type HiveConfig } from "@/lib/hive/config";
import { seed } from "@/prisma/seed";
import { MOCK_RULES } from "../helpers/mockRules";

/** M10: settings view, ledger view, bus transcript, database reset (mock providers, labeled). */

const URL = "file:./test-m10.db";
const BACKUPS = path.join(process.cwd(), "test-m10-backups");
let db: ReturnType<typeof getDb>;
const base = loadHiveConfig();
const cfg = { ...base, orchestration: { ...base.orchestration, mode: "code" as const } } as HiveConfig;
const hive = () => createHive({ env: { USE_MOCK_PROVIDERS: "true" }, db, cfg, providerDeps: { mockRules: MOCK_RULES } });
let cycleId = "";

beforeAll(async () => {
  rmSync(BACKUPS, { recursive: true, force: true });
  await ensureDb(URL, { fresh: true });
  db = getDb(URL);
  await seed(db);
  const h = hive();
  const r = await h.runCycle({ sessionId: await h.createSession(), input: "I keep putting off a hard conversation with my manager. How do I start it?" });
  expect(r.status).toBe("done");
  cycleId = r.cycleId;
});
afterAll(async () => {
  await disconnectAll();
  rmSync(BACKUPS, { recursive: true, force: true });
});

describe("settings view", () => {
  it("shows mock mode and never contains the API key", () => {
    expect(settingsView({ USE_MOCK_PROVIDERS: "true" }, cfg)).toMatchObject({ mock: true, providers: { mode: "mock" } });
    const secret = "sk-or-test-not-a-real-key-123456";
    const v = settingsView({ USE_MOCK_PROVIDERS: "false", OPENROUTER_API_KEY: secret, OPENROUTER_DEC_MODEL_1: "dec/model-a", OPENROUTER_REVIEWER_MODEL: "rev/model-b" }, cfg);
    expect(v.providers.mode).toBe("cloud");
    expect(JSON.stringify(v)).not.toContain(secret);
    expect(JSON.stringify(v)).toContain("rev/model-b");
  });

  it("reports a missing live configuration as a problem instead of throwing", () => {
    const v = settingsView({ USE_MOCK_PROVIDERS: "false" }, cfg);
    expect(v.providers.error).toMatch(/OPENROUTER_API_KEY/);
  });
});

describe("ledger view", () => {
  it("probabilities summary reads decision answers", () => {
    expect(probSummary({ answers: { a: 0.25, b: 0.5 } })).toBe("a 0.25 · b 0.50");
    expect(probSummary({ preview: "x" })).toBeNull();
  });

  it("filters by kind prefix and cycle; totals equal the sum of costs", async () => {
    const all = await ledgerView(db, { limit: 500 });
    const sum = (await db.ledgerEvent.findMany({ select: { costUsd: true } })).reduce((a, r) => a + r.costUsd, 0);
    expect(all.total.costUsd).toBeCloseTo(sum, 10);
    expect(all.total.events).toBe(await db.ledgerEvent.count());
    const dec = await ledgerView(db, { kind: "decision.*" });
    expect(dec.events.length).toBeGreaterThan(0);
    expect(dec.events.every((e) => e.kind.startsWith("decision."))).toBe(true);
    const one = await ledgerView(db, { cycleId });
    expect(one.events.every((e) => e.cycleId === cycleId)).toBe(true);
    expect(one.filtered.events).toBe(await db.ledgerEvent.count({ where: { cycleId } }));
  });

  it("bus transcript lists every envelope of the cycle with its authorization", async () => {
    const t = await busTranscript(db, cycleId);
    expect(t.length).toBe(await db.busMessage.count({ where: { cycleId } }));
    expect(t.length).toBeGreaterThan(0);
    expect(t.some((m) => m.type === "whisper" || m.kind === "whisper")).toBe(true);
    expect(t.every((m) => typeof m.authorized === "boolean")).toBe(true);
  });
});

describe("database reset", () => {
  it("refuses without the exact phrase and changes nothing", async () => {
    const before = await db.cycle.count();
    await expect(resetHiveState(db, { confirm: "reset", dbUrl: URL, cfg, backupDir: BACKUPS })).rejects.toBeInstanceOf(ResetError);
    await expect(resetHiveState(db, { confirm: ` ${RESET_PHRASE}`, dbUrl: URL, cfg, backupDir: BACKUPS })).rejects.toBeInstanceOf(ResetError);
    expect(await db.cycle.count()).toBe(before);
    expect(existsSync(BACKUPS)).toBe(false);
  });

  it("backs up first, clears the Hive's experience, keeps corpus, seed, approvals, and the ledger", async () => {
    const kept = {
      voices: await db.voice.count(),
      situations: await db.situation.count(),
      mentors: await db.mentor.count(),
      formations: await db.formation.count(),
      principles: await db.hivePrinciple.count(),
      ledger: await db.ledgerEvent.count(),
    };
    const cycles = await db.cycle.count();
    expect(cycles).toBeGreaterThan(0);
    const r = await resetHiveState(db, { confirm: RESET_PHRASE, dbUrl: URL, cfg, backupDir: BACKUPS });

    expect(existsSync(r.backup)).toBe(true);
    const copy = getDb(`file:${r.backup}`);
    expect(await copy.cycle.count()).toBe(cycles);

    for (const n of [db.hiveSession, db.cycle, db.busMessage, db.memoryRecord, db.hivePrediction, db.signal, db.evalRun, db.conclaveRun] as unknown as { count: () => Promise<number> }[]) expect(await n.count()).toBe(0);
    const sm = await db.selfModelVersion.findMany();
    expect(sm).toHaveLength(1);
    expect(sm[0]).toMatchObject({ version: 1, promoted: true });
    expect(JSON.parse(sm[0].body)).toEqual(cfg.self_model_seed);

    expect(await db.voice.count()).toBe(kept.voices);
    expect(await db.situation.count()).toBe(kept.situations);
    expect(await db.mentor.count()).toBe(kept.mentors);
    expect(await db.formation.count()).toBe(kept.formations);
    expect(await db.hivePrinciple.count()).toBe(kept.principles);
    expect(await db.ledgerEvent.count()).toBe(kept.ledger + 1); // append-only: nothing removed, the reset recorded
    const ev = await db.ledgerEvent.findFirstOrThrow({ where: { kind: "db.reset" } });
    expect(JSON.parse(ev.payload).deleted.hiveSession).toBe(1);

    // the Hive runs again after a reset
    const h = hive();
    const again = await h.runCycle({ sessionId: await h.createSession(), input: "What would make today a good day?" });
    expect(again.status).toBe("done");
  });
});
