import "server-only";
import { writeFileSync, mkdirSync } from "node:fs";
import { getDb } from "@/lib/council/db";
import { calibrationReport, calibrationResults, runCalibration } from "./calibration";
import { serverHive } from "./server";
import { serverProviders } from "./serverProviders";

/** One calibration run at a time per server process; results are read back from EvalRun rows. */
let current: { startedAt: string; ids: string[] | null } | null = null;
let lastFinished: { finishedAt: string; ran: string[]; errors: string[] } | null = null;

export function calibrationStatus() {
  return { running: current !== null, startedAt: current?.startedAt ?? null, ids: current?.ids ?? null, lastFinished };
}

export function startCalibration(ids?: string[]): { started: boolean } {
  if (current) return { started: false };
  current = { startedAt: new Date().toISOString(), ids: ids?.length ? ids : null };
  const db = getDb();
  runCalibration({ hive: serverHive(), db, decider: serverProviders().providers.decider, ids })
    .then(async (r) => {
      lastFinished = { finishedAt: new Date().toISOString(), ran: r.ran, errors: r.errors };
      mkdirSync("reports", { recursive: true });
      writeFileSync("reports/calibration.md", calibrationReport(await calibrationResults(db)));
    })
    .catch((e: Error) => (lastFinished = { finishedAt: new Date().toISOString(), ran: [], errors: [e.message] }))
    .finally(() => (current = null));
  return { started: true };
}
