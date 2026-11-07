import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agreement, aiLevels, gradingCards, loadOwnerGrades, saveOwnerGrade } from "@/lib/hive/grading";

/** Decision 7: owner grading. TEST FIXTURE report (two scenarios, made-up AI scores), removed after the test. */

const REPORT = "scenarios-live-0000-unit-test-fixture.json";
const file = path.join(process.cwd(), "reports", "eval", REPORT);
const grades = path.join(process.cwd(), "local", "grades", REPORT.replace(/\.json$/, ".grades.json"));
writeFileSync(
  file,
  JSON.stringify({
    results: [
      { id: "empathy_career", category: "empathy", skipped: false, outputs: ["TEST FIXTURE reply"], rubric: { scores: { empathy_first: 1.6, non_sycophancy: 0.4 } } },
      { id: "conclave_conflict", category: "conflict", skipped: false, outputs: ["TEST FIXTURE reply 2"], rubric: { scores: { empathy_first: 0.9, coherence: 2 } } },
    ],
  }),
);
afterAll(() => {
  for (const f of [file, grades]) if (existsSync(f)) rmSync(f);
});

describe("owner grading", () => {
  it("builds one card per reply with the scenario's qualities", () => {
    const cards = gradingCards(REPORT);
    expect(cards.map((c) => c.id)).toEqual(["empathy_career", "conclave_conflict"]);
    expect(cards[0].qualities.map((q) => q.name)).toEqual(["empathy_first", "non_sycophancy"]);
    expect(cards[0].replies).toEqual(["TEST FIXTURE reply"]);
  });
  it("rounds the AI score to the nearest level", () => {
    expect(aiLevels(REPORT, "empathy_career")).toEqual({ empathy_first: { score: 1.6, level: 2 }, non_sycophancy: { score: 0.4, level: 0 } });
  });
  it("refuses incomplete or invalid grades, saves complete ones, and measures agreement", () => {
    expect(() => saveOwnerGrade(REPORT, "empathy_career", { empathy_first: 2 })).toThrow(/missing non_sycophancy/);
    expect(() => saveOwnerGrade(REPORT, "nope", {})).toThrow(/no card/);
    saveOwnerGrade(REPORT, "empathy_career", { empathy_first: 2, non_sycophancy: 1 });
    saveOwnerGrade(REPORT, "conclave_conflict", { empathy_first: 1, coherence: 0 });
    expect(Object.keys(loadOwnerGrades(REPORT).cards)).toHaveLength(2);
    const a = agreement(REPORT);
    // matches: empathy_first 2=2, empathy_first 1=1; off by one: non_sycophancy 0 vs 1; miss: coherence 2 vs 0
    expect(a).toMatchObject({ graded: 2, judgments: 4, match: 2, offByOne: 1, rate: 0.5 });
    expect(a.byQuality.empathy_first).toEqual({ n: 2, match: 2 });
  });
});
