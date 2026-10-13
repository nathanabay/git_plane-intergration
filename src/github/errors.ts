import type { Db } from "../db/migrate.ts";
import { retryDelayMs } from "../sync/backoff.ts";

export type GithubErrorClassification =
  | { kind: "rate_limited"; retryAt: number }
  | { kind: "permission" | "not_found" | "transient" | "permanent" };

/** A deadline is scheduling data: callers must release their worker/lock rather than sleep. */
export class GithubRateLimitError extends Error {
  readonly retryAt: number;
  readonly requestMade: boolean;
  readonly key?: string;
  constructor(retryAt: number, cause?: unknown, requestMade = true, key?: string) {
    super("GitHub rate limit; retry at the server deadline", { cause });
    this.name = "GithubRateLimitError";
    this.retryAt = retryAt;
    this.requestMade = requestMade;
    this.key = key;
  }
}

export function githubErrorStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; response?: { status?: unknown } } | null;
  const status = Number(e?.status ?? e?.response?.status);
  return Number.isInteger(status) && status >= 100 ? status : undefined;
}

export function githubErrorHeaders(err: unknown): (name: string) => string | undefined {
  const e = err as { headers?: unknown; response?: { headers?: unknown } } | null;
  const headers = e?.response?.headers ?? e?.headers;
  return (name) => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    if (!headers || typeof headers !== "object") return undefined;
    const pair = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return pair?.[1] === undefined || pair[1] === null ? undefined : String(pair[1]);
  };
}

/** GitHub documents message-only secondary 403s and a one-minute exponential fallback. */
export function classifyGithubError(err: unknown, opts: { now?: number; attempt?: number } = {}): GithubErrorClassification {
  if (err instanceof GithubRateLimitError) {
    // Queue/outbox attempt counts survive a restart; an in-memory client's counter may not.
    const underlying = err.requestMade && err.cause && opts.attempt !== undefined ? classifyGithubError(err.cause, opts) : undefined;
    return { kind: "rate_limited", retryAt: Math.max(err.retryAt, underlying?.kind === "rate_limited" ? underlying.retryAt : 0) };
  }
  // src/sync/plane.ts already resolved this deadline (also for waits refused before any request was sent).
  if (err instanceof Error && err.name === "PlaneRateLimitError" && Number.isFinite((err as { retryAt?: unknown }).retryAt)) {
    const own = (err as Error & { retryAt: number }).retryAt;
    const fromResponse = (err as { requestMade?: unknown }).requestMade === false ? undefined
      : classifyGithubError({ status: 429, response: (err as { response?: unknown }).response, message: err.message }, opts);
    return { kind: "rate_limited", retryAt: Math.max(own, fromResponse?.kind === "rate_limited" ? fromResponse.retryAt : 0) };
  }
  const status = githubErrorStatus(err);
  const get = githubErrorHeaders(err);
  const e = err as { message?: unknown; response?: { data?: { message?: unknown } } } | null;
  const message = `${typeof e?.message === "string" ? e.message : ""} ${typeof e?.response?.data?.message === "string" ? e.response.data.message : ""}`;
  const limited = status === 429 || (status === 403 && (get("retry-after") !== undefined
    || get("x-ratelimit-remaining") === "0" || /secondary rate limit|abuse detection|abuse rate limit|API rate limit exceeded/i.test(message)));
  if (limited) {
    const now = opts.now ?? Date.now();
    const attempt = Number.isFinite(opts.attempt) ? Math.max(0, Math.floor(opts.attempt!)) : 0;
    const fallback = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(attempt, 6));
    // Both headers are lower bounds when present. Never resume before either deadline.
    const retryAfter = retryDelayMs((n) => n === "retry-after" ? get(n) : undefined, attempt, { now, fallbackMs: fallback });
    const reset = get("x-ratelimit-remaining") === "0" ? Number(get("x-ratelimit-reset")) * 1000 : NaN;
    const wait = get("retry-after") !== undefined ? retryAfter
      : Number.isFinite(reset) && reset > now ? reset - now : fallback;
    return { kind: "rate_limited", retryAt: Math.max(now + Math.max(1, wait), Number.isFinite(reset) ? reset : 0) };
  }
  if (status === 403) return { kind: "permission" };
  if (status === 404) return { kind: "not_found" };
  if (status === undefined || status === 401 || status === 408 || status >= 500) return { kind: "transient" };
  return { kind: "permanent" };
}

const cooldowns = new Map<string, { retryAt: number; attempt: number }>();
const ledgerId = (key: string) => `github-rate-limit:${key}`;

/** Reserved delivery-ledger IDs persist installation/App cooldowns across service replicas. */
export async function githubRetryDeadline(db: Db | undefined, key: string, now = Date.now()): Promise<number> {
  const local = cooldowns.get(key)?.retryAt ?? 0;
  if (!db) return local > now ? local : 0;
  const rows = await db.query<{ received_at: string | Date }>(
    "SELECT received_at FROM webhook_deliveries WHERE source = 'github' AND delivery_id = $1 AND received_at > $2", [ledgerId(key), new Date(now)]);
  return Math.max(local > now ? local : 0, rows.rows[0] ? new Date(rows.rows[0].received_at).getTime() : 0);
}

export async function rememberGithubRateLimit(db: Db | undefined, key: string, retryAt: number, advanceAttempt = true): Promise<void> {
  const previous = cooldowns.get(key);
  cooldowns.set(key, { retryAt: Math.max(previous?.retryAt ?? 0, retryAt), attempt: (previous?.attempt ?? 0) + (advanceAttempt ? 1 : 0) });
  if (db) await db.query(`INSERT INTO webhook_deliveries (source, delivery_id, received_at) VALUES ('github', $1, $2)
    ON CONFLICT (source, delivery_id) DO UPDATE SET received_at = GREATEST(webhook_deliveries.received_at, EXCLUDED.received_at)`,
  [ledgerId(key), new Date(retryAt)]);
}

/** Preserve Octokit's request properties/auth hooks while gating every REST read and write. */
export function withGithubRateLimits<T extends { request: (...args: any[]) => Promise<any> }>(
  client: T, opts: { key: string; db?: Db; now?: () => number },
): T {
  const now = opts.now ?? Date.now;
  const request = new Proxy(client.request, {
    async apply(target, _this, args) {
      const deadline = await githubRetryDeadline(opts.db, opts.key, now());
      if (deadline > now()) throw new GithubRateLimitError(deadline, undefined, false, opts.key);
      try {
        const response = await Reflect.apply(target, client, args);
        // An in-flight request succeeding must not clear another request's active cooldown.
        if ((cooldowns.get(opts.key)?.retryAt ?? 0) <= now()) cooldowns.delete(opts.key);
        return response;
      } catch (err) {
        if (err instanceof GithubRateLimitError) throw err; // A composed client may already be wrapped.
        const classified = classifyGithubError(err, { now: now(), attempt: cooldowns.get(opts.key)?.attempt ?? 0 });
        if (classified.kind !== "rate_limited") throw err;
        await rememberGithubRateLimit(opts.db, opts.key, classified.retryAt);
        throw new GithubRateLimitError(classified.retryAt, err, true, opts.key);
      }
    },
  });
  return new Proxy(client, { get(target, property, receiver) {
    if (property === "request") return request;
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
