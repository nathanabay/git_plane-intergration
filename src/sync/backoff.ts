export const MAX_BACKOFF_MS = 60_000;
const MAX_HEADER_WAIT_MS = 5 * 60_000;

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff: 1s, 2s, 4s ... capped at 60s. `attempt` is zero-based. */
export function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
}

/**
 * How long to wait before retrying a throttled or failed request: Retry-After (seconds or an HTTP date),
 * else until X-RateLimit-Reset (epoch seconds), else exponential backoff. GitHub only resets on a
 * 403 when x-ratelimit-remaining is 0, so callers there pass `resetNeedsExhausted`.
 */
export function retryDelayMs(get: (name: string) => string | null | undefined, attempt: number, opts: { resetNeedsExhausted?: boolean; now?: number } = {}): number {
  const now = opts.now ?? Date.now();
  const retryAfter = get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_HEADER_WAIT_MS);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - now), MAX_HEADER_WAIT_MS);
  }
  const reset = Number(get("x-ratelimit-reset"));
  const exhausted = !opts.resetNeedsExhausted || get("x-ratelimit-remaining") === "0";
  if (exhausted && Number.isFinite(reset) && reset > 0) return Math.min(Math.max(0, reset * 1000 - now), MAX_HEADER_WAIT_MS);
  return backoffMs(attempt);
}
