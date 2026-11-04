import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Node's built-in .env loader; the file is optional (tests set DATABASE_URL themselves).
if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx --conditions=react-server prisma/seed.ts" },
  datasource: { url: process.env.DATABASE_URL ?? "file:./dev.db" },
});
