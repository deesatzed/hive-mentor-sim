import "server-only";

export class LiveModeNotConfiguredError extends Error {
  constructor(public readonly missing: string[]) {
    super(`live mode not configured; missing: ${missing.join(", ")}`);
    this.name = "LiveModeNotConfiguredError";
  }
}
