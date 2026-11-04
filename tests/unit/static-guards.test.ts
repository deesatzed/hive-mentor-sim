import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** docs/TEST_PLAN.md #5 and #6 (the parts that exist as of M1). */

const ROOT = process.cwd();
function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((n) => {
    const rel = path.join(dir, n);
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : rel.endsWith(".ts") || rel.endsWith(".tsx") ? [rel] : [];
  });
}
const source = ["lib", "app", "scripts", "prisma"].flatMap(walk);
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

describe("static guards", () => {
  it("only lib/council/ledger.ts writes LedgerEvent", () => {
    const writers = source.filter((f) => /\.ledgerEvent\.(create|createMany|upsert)\b/.test(read(f)));
    expect(writers).toEqual(["lib/council/ledger.ts"]);
  });

  it("only lib/hive/bus.ts may write BusMessage", () => {
    const writers = source.filter((f) => /\.busMessage\.(create|createMany|upsert)\b/.test(read(f)));
    expect(writers.filter((f) => f !== "lib/hive/bus.ts")).toEqual([]);
  });

  it("no code updates or deletes append-only ledger and bus rows", () => {
    const hits = source.filter((f) => /\.(ledgerEvent|busMessage)\.(update|updateMany|delete|deleteMany)\b/.test(read(f)));
    expect(hits).toEqual([]);
  });

  it("MemoryRecord is updated only in lib/hive/state.ts, and only priority / resolvedCycle (TEST_PLAN #6)", () => {
    const writers = source.filter((f) => /\.memoryRecord\.(update|updateMany|upsert|delete|deleteMany)\b/.test(read(f)));
    expect(writers).toEqual(["lib/hive/state.ts"]);
    const calls = read("lib/hive/state.ts").match(/memoryRecord\.(update|updateMany)\([^;]*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const fields = [...c.matchAll(/data:\s*\{\s*(\w+)/g)].map((m) => m[1]);
      for (const f of fields) expect(["priority", "resolvedCycle"]).toContain(f);
    }
    expect(source.filter((f) => /\.memoryRecord\.(delete|deleteMany)\b/.test(read(f)))).toEqual([]);
  });

  it("decision models judge: control code never reads numeric judgments from LLM output (TEST_PLAN #4)", () => {
    for (const f of ["lib/hive/orchestrator.ts", "lib/hive/attention.ts", "lib/hive/conclave.ts", "lib/hive/arbiter.ts", "lib/hive/manager.ts"]) {
      const text = read(f);
      expect(text, f).not.toMatch(/\.data\.(confidence|salience|valence|score|decision|probability)\b/);
    }
  });

  it("no ad-hoc model fetch outside lib/council/providers", () => {
    const hits = source.filter(
      (f) => !f.startsWith("lib/council/providers/") && /openrouter\.ai|api\.openai\.com|\/chat\/completions/.test(read(f)) && f !== "scripts/verify-live.ts",
    );
    expect(hits).toEqual([]);
  });
});
