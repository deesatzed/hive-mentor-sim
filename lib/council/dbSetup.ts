import "server-only";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { disconnectAll, getDb, sqlitePathFromUrl } from "./db";
import { seed } from "@/prisma/seed";

/**
 * Script-only helpers (REPL, eval, e2e setup): create a migrated + seeded SQLite file, or clone one.
 * They only ever touch the single named database file and its journal. Never used by the app at
 * request time.
 */

function removeDbFile(file: string): void {
  for (const f of [file, `${file}-journal`]) if (existsSync(f)) unlinkSync(f);
}

export async function ensureDb(url: string, opts: { fresh?: boolean } = {}): Promise<void> {
  const file = sqlitePathFromUrl(url);
  if (!file.endsWith(".db")) throw new Error(`refusing to manage a database file not ending in .db: ${file}`);
  if (opts.fresh) {
    await disconnectAll();
    removeDbFile(file);
  }
  const existed = existsSync(file);
  execSync("pnpm exec prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } });
  if (!existed) await seed(getDb(url));
}

/** Copies a template database file to a new path (fresh per-scenario state for eval). */
export async function cloneDb(templateUrl: string, url: string): Promise<void> {
  await disconnectAll();
  const dst = sqlitePathFromUrl(url);
  if (!dst.endsWith(".db")) throw new Error(`refusing to overwrite a file not ending in .db: ${dst}`);
  removeDbFile(dst);
  copyFileSync(sqlitePathFromUrl(templateUrl), dst);
}
