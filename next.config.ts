import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright's dev server is reached on 127.0.0.1 (tests/e2e).
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
