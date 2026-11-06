/** Eval report (port of reference/sent2.md §4.2): a console table and a deterministic JSON file. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GradeResult } from "./types";

/** Removes run-specific ids so two mock runs produce byte-identical reports. */
export function normalizeIds(text: string): string {
  return text
    .replace(/opt_[A-Za-z0-9]+_(\d+)/g, "opt_<task>_$1")
    .replace(/msg_[a-f0-9]{12}/g, "msg_<id>")
    .replace(/\bc[a-z0-9]{24}\b/g, "<cuid>");
}

export function printTable(results: GradeResult[], live: boolean): boolean {
  const row = (s: string, w: number) => s.padEnd(w).slice(0, w);
  console.log(`\n${live ? "LIVE" : "MOCK (scripted providers: tests the pipeline, not model behavior)"}`);
  console.log(row("SCENARIO", 34) + row("CATEGORY", 12) + row("INVARIANTS", 12) + row("RUBRIC", 8) + row("GOLDEN", 8) + "RESULT");
  console.log("-".repeat(82));
  for (const r of results) {
    if (r.skipped) {
      console.log(row(r.id, 34) + row(r.category, 12) + row("-", 12) + row("-", 8) + row("-", 8) + `SKIPPED (${r.skipReason})`);
      continue;
    }
    const okN = r.invariants.filter((i) => i.ok).length;
    const inv = `${okN === r.invariants.length ? "ok" : "FAIL"} ${okN}/${r.invariants.length}`;
    const golden = r.goldenMatch === null ? "-" : r.goldenMatch ? "ok" : "FAIL";
    console.log(row(r.id, 34) + row(r.category, 12) + row(inv, 12) + row(`${Math.round((r.rubricScore ?? 0) * 100)}%`, 8) + row(golden, 8) + (r.passed ? "PASS" : "FAIL"));
    for (const i of r.invariants.filter((x) => !x.ok)) console.log(`    x ${i.name}: ${normalizeIds(i.detail)}`);
  }
  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.passed).length;
  const skipped = results.length - ran.length;
  console.log("-".repeat(82));
  console.log(`${passed}/${ran.length} run scenarios pass; ${skipped} skipped`);
  return passed === ran.length;
}

export function writeReport(results: GradeResult[], live: boolean, milestone: string, graderAgreement?: unknown, subset = false): string {
  const dir = path.join(process.cwd(), "reports", "eval");
  mkdirSync(dir, { recursive: true });
  // a subset run (--only) gets its own timestamped file, so it never overwrites a full run's report
  const now = new Date().toISOString();
  const liveName = subset ? `scenarios-live-${now.slice(0, 19).replace(/:/g, "")}-subset.json` : `scenarios-live-${now.slice(0, 10)}.json`;
  const file = path.join(dir, live ? liveName : subset ? "scenarios-mock-subset.json" : "scenarios-mock.json");
  const body = {
    mode: live ? "live" : "mock",
    note: live ? "live providers; measured" : "mock providers: scripted outputs; shows the pipeline and invariants work, not model behavior",
    milestone,
    summary: { run: results.filter((r) => !r.skipped).length, passed: results.filter((r) => r.passed).length, skipped: results.filter((r) => r.skipped).length },
    ...(graderAgreement ? { graderAgreement } : {}),
    results,
  };
  writeFileSync(file, normalizeIds(JSON.stringify(body, null, 2)) + "\n");
  return file;
}
