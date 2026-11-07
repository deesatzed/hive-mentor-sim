import "server-only";

export class LiveModeNotConfiguredError extends Error {
  constructor(public readonly missing: string[]) {
    super(`live mode not configured; missing: ${missing.join(", ")}`);
    this.name = "LiveModeNotConfiguredError";
  }
}

/** Mock providers are for the automated tests only (owner decision 2026-11-06). */
export class MockModeNotAllowedError extends Error {
  constructor() {
    super("USE_MOCK_PROVIDERS=true is allowed only inside the test runners (HIVE_TEST_RUNNER=1). The app runs on live providers only.");
    this.name = "MockModeNotAllowedError";
  }
}
