import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

/** Fresh test.db with all migrations applied, once per `pnpm test` run. */
export default function setup() {
  for (const f of ["test.db", "test.db-journal"]) rmSync(f, { force: true });
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
  });
}
