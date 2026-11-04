import "server-only";

/** Shared HTTP plumbing for live providers. `fetch` and `sleep` are injectable for tests. */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_TIMEOUT_MS = 60_000;
export const BACKOFF_MS = 200;

/** Auth or credit problem: never retried, never falls back to another model. */
export class ProviderAuthError extends Error {
  constructor(public readonly status: number, detail: string) {
    super(`provider rejected the request (HTTP ${status}): ${detail}`);
    this.name = "ProviderAuthError";
  }
}

export class ProviderHttpError extends Error {
  constructor(public readonly status: number, public readonly detail: string) {
    super(`HTTP ${status}: ${detail}`);
    this.name = "ProviderHttpError";
  }
}

export const isAuthStatus = (s: number) => s === 401 || s === 402 || s === 403;
export const isRetryableStatus = (s: number) => s === 429 || s >= 500;

/** First 300 chars of an error body, with anything that looks like a bearer token removed. */
export async function errorDetail(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***").slice(0, 300);
}

/**
 * POST JSON with 1 retry on network errors, timeouts, 429, and 5xx (backoff 200 ms × attempt).
 * Returns the final Response for non-retryable statuses so callers can apply their own policy.
 */
export async function postJsonWithRetry(
  fetchImpl: FetchLike,
  sleep: Sleep,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const maxAttempts = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (isRetryableStatus(res.status) && attempt < maxAttempts) {
        await res.body?.cancel().catch(() => {});
        await sleep(BACKOFF_MS * attempt);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(BACKOFF_MS * attempt);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
