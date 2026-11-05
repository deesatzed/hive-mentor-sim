import "server-only";
import { getDb } from "@/lib/council/db";
import { runReveal } from "./reveal";
import { serverHive } from "./server";
import { serverProviders } from "./serverProviders";

/** One Reveal run at a time per server process; progress is read back from the database (resumable). */
let current: { startedAt: string; lastError: string | null; promise: Promise<unknown> } | null = null;
let lastFinished: { finishedAt: string; ran: number; errors: string[] } | null = null;

export function revealStatus() {
  return { running: current !== null, startedAt: current?.startedAt ?? null, lastFinished };
}

export function startReveal(limit?: number): { started: boolean } {
  if (current) return { started: false };
  const run = { startedAt: new Date().toISOString(), lastError: null as string | null, promise: Promise.resolve() as Promise<unknown> };
  run.promise = runReveal({ hive: serverHive(), db: getDb(), decider: serverProviders().providers.decider, limit })
    .then((r) => (lastFinished = { finishedAt: new Date().toISOString(), ran: r.ran, errors: r.errors }))
    .catch((e: Error) => (lastFinished = { finishedAt: new Date().toISOString(), ran: 0, errors: [e.message] }))
    .finally(() => (current = null));
  current = run;
  return { started: true };
}
