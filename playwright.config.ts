import { defineConfig } from "@playwright/test";

// e2e always runs against mock providers and the test database (docs/TEST_PLAN.md).
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  // one shared database (e2e.db): files run one at a time, in name order (constitution before reveal)
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3100" },
  webServer: {
    command: "pnpm exec next dev --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { USE_MOCK_PROVIDERS: "true", HIVE_TEST_RUNNER: "1", DATABASE_URL: "file:./e2e.db", NEXT_DIST_DIR: ".next-e2e" },
  },
});
