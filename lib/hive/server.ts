import "server-only";
import { getDb } from "@/lib/council/db";
import { createHive, type Hive } from "./index";

/** One Hive per server process (credentials and bus live in memory; state lives in the database). */
let hive: Hive | null = null;
export function serverHive(): Hive {
  if (!hive) hive = createHive({ env: process.env, db: getDb() });
  return hive;
}
