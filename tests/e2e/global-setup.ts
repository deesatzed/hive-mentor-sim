import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

/** e2e runs on mock providers against a fresh e2e.db (migrated + seeded). */
export default function setup() {
  for (const f of ["e2e.db", "e2e.db-journal"]) if (existsSync(f)) unlinkSync(f);
  execSync("pnpm exec prisma migrate deploy && pnpm -s db:seed", { stdio: "pipe", env: { ...process.env, DATABASE_URL: "file:./e2e.db" } });
}
