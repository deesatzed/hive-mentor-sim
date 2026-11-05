import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright's dev server is reached on 127.0.0.1 (tests/e2e).
  allowedDevOrigins: ["127.0.0.1"],
  // e2e builds into its own folder so it can run while the owner's `pnpm dev` is up (playwright.config.ts)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
