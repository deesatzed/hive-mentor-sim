import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
      // `server-only` throws outside a React Server bundle; tests run server code directly.
      "server-only": path.resolve(import.meta.dirname, "tests/helpers/server-only-noop.ts"),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/helpers/global-setup.ts"],
    // One SQLite file is shared; run test files one at a time.
    fileParallelism: false,
    env: { USE_MOCK_PROVIDERS: "true", HIVE_TEST_RUNNER: "1", DATABASE_URL: "file:./test.db" },
  },
});
