import "server-only";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * One PrismaClient per process, per database URL. SQLite via better-sqlite3.
 * DATABASE_URL is "file:./dev.db" (relative to the repo root / cwd).
 */

const clients = new Map<string, PrismaClient>();

export function sqlitePathFromUrl(url: string): string {
  if (!url.startsWith("file:")) throw new Error(`DATABASE_URL must be a file: URL for SQLite, got '${url}'`);
  const p = url.slice("file:".length);
  return path.isAbsolute(p) ? p : path.resolve(/*turbopackIgnore: true*/ process.cwd(), p);
}

export function getDb(url = process.env.DATABASE_URL ?? "file:./dev.db"): PrismaClient {
  const file = sqlitePathFromUrl(url);
  let client = clients.get(file);
  if (!client) {
    client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: file }) });
    clients.set(file, client);
  }
  return client;
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => c.$disconnect()));
  clients.clear();
}
