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
    env: { USE_MOCK_PROVIDERS: "true", DATABASE_URL: "file:./test.db" },
  },
});
