import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docs/TEST_PLAN.md §3: items removed on purpose (owner decision) stay removed.
 * reference/sent2.md is excluded; it is the unmodified design reference.
 */

const ROOT = process.cwd();
const DIRS = ["prompts", "constitution", "config", "lib", "app"];
const FILES = ["seed/voice_roster.json"];
const BANNED: [RegExp, string][] = [
  [/SHELTER/, "SHELTER"],
  [/shelter_halted/, "shelter_halted"],
  [/h_max/, "h_max"],
  [/hMax/, "hMax"],
  [/harm filter/i, "harm filter"],
  [/CRISIS_GATE/, "CRISIS_GATE"],
  [/crisisGate/, "crisisGate"],
  [/PAUSE_NOTICE/, "PAUSE_NOTICE"],
  [/SCOPE_GATE/, "SCOPE_GATE"],
  [/['"]distress['"]/, "'distress' (as an urgency value)"],
  [/safety_self_harm/, "safety_self_harm"],
  [/safety_greater_good/, "safety_greater_good"],
];

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

describe("removed items stay removed", () => {
  const files = [...DIRS.flatMap(walk), ...FILES].filter((f) => !f.startsWith("reference/"));

  it("scans a non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(BANNED.map(([re, label]) => [label, re] as const))("no file contains %s", (_label, re) => {
    const hits = files.filter((f) => re.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("the guardian prompt file does not exist", () => {
    expect(existsSync(path.join(ROOT, "prompts/governance/shelter.md"))).toBe(false);
  });
});
