import type { SecretString } from "../auth/identity.ts";
import type { Db } from "../db/migrate.ts";
import { appendAudit, clearCreatePending, forgetAppliedOps, markCreatePending, recordAppliedOps } from "../db/ledgers.ts";
import { backoffMs, realSleep, retryDelayMs } from "./backoff.ts";
import type { Sleep } from "./backoff.ts";
import { opHash } from "./ophash.ts";
import { classifyGithubError } from "../github/errors.ts";

export class PlaneApiError extends Error {
  readonly status: number;
  body: unknown;
  readonly response: { readonly status: number; readonly headers: Readonly<Record<string, string>> };
  constructor(status: number, body: unknown, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "PlaneApiError";
    this.status = status;
    this.body = body;
    this.response = Object.freeze({ status, headers: Object.freeze({ ...headers }) });
  }
}

/**
 * Contract 2: Plane's 429 (or the local budget refusing a long wait) is scheduling data, not a reason to
 * sleep while holding a worker. `retryAt` is an epoch-ms deadline the queue job or outbox row must honor in
 * full. It is still a `PlaneApiError` with status 429, so every existing status check keeps working, and
 * `classifyGithubError` (G1) reads its status and preserved headers as `rate_limited`.
 */
export class PlaneRateLimitError extends PlaneApiError {
  readonly retryAt: number;
  /** False when the local budget refused before any request was sent. */
  readonly requestMade: boolean;
  constructor(retryAt: number, opts: { body?: unknown; message?: string; headers?: Record<string, string>; requestMade?: boolean } = {}) {
    super(429, opts.body ?? {}, opts.message ?? "Plane rate limit; retry at the server deadline", opts.headers ?? {});
    this.name = "PlaneRateLimitError";
    this.retryAt = retryAt;
    this.requestMade = opts.requestMade ?? true;
  }
}

/** The longest the client waits inline for its own budget; anything longer is deferred (contract 2). */
export const PLANE_MAX_INLINE_WAIT_MS = 2_000;

export class TriageWriteRejected extends Error {
  constructor(message = "writes into the triage state group are not allowed (§7.1)") {
    super(message);
    this.name = "TriageWriteRejected";
  }
}

export interface PlaneClientOptions {
  baseUrl: string;
  token: SecretString;
  fetch?: typeof fetch;
  maxRetries?: number;
  sleep?: Sleep;
  rateLimitPerMinute?: number;
  requestsPerMinute?: number;
  burstCapacity?: number;
  /** Budget waits longer than this throw `PlaneRateLimitError` instead of sleeping (default 2 s). */
  maxInlineWaitMs?: number;
}

export interface PlaneState { id: string; name: string; group: string; default?: boolean }

const API_PREFIX = "/api/v1";
/** A10: v1.4.2 lists `/issues/` under "Deprecated url patterns"; `work-items/` is served by the same views. */
export const PLANE_ITEMS_SEGMENT = "work-items";
/**
 * One Plane path segment: a UUID, a project identifier or a workspace slug (letters, digits, `_`, `-`).
 * Encoding alone is not enough: `..` encodes to itself and the WHATWG URL parser also folds `%2e%2e`
 * into a dot segment, so `projects/../../other-ws` would leave this workspace (security audit S1).
 */
const PLANE_SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;
export function planeSegment(value: unknown, what = "Plane path segment"): string {
  if (typeof value !== "string" || !PLANE_SEGMENT.test(value)) throw new PlaneApiError(400, {}, `${what} is not a valid Plane id`);
  return encodeURIComponent(value);
}

/** `/workspaces/{slug}/` plus each checked segment and a trailing slash, as every v1 route expects. */
export const planeWorkspacePath = (slug: string, ...segments: string[]): string =>
  `/workspaces/${planeSegment(slug, "workspace slug")}/${segments.map((s) => `${planeSegment(s)}/`).join("")}`;

/** `/workspaces/{slug}/projects/{projectId}/work-items/`, plus `{itemId}/` when an item is named. */
export const planeItemsPath = (slug: string, projectId: string, itemId?: string): string =>
  planeWorkspacePath(slug, "projects", projectId, PLANE_ITEMS_SEGMENT, ...(itemId === undefined ? [] : [itemId]));

/** A5: Plane v1.4.2 limits each API key with DRF's sliding 60-second history, not a refilling bucket. */
export const PLANE_RATE_WINDOW_MS = 60_000;
/** A5: a full bucket of a whole minute's budget let about 2x the limit through one sliding minute. */
export const DEFAULT_PLANE_BURST = 10;
/**
 * Slack added to the one-minute window before a send that would otherwise be exactly the limit-th in a minute.
 * Plane throttles on its own receive time (DRF `SimpleRateThrottle`: history entries `<= now - duration` drop), so an
 * old request that took longer in flight than the new one would still be inside Plane's minute at a zero margin.
 */
export const PLANE_RATE_MARGIN_MS = 1_000;

/**
 * Paces requests with a token bucket (smooths bursts) and a sliding window of `ratePerMinute` sends per
 * 60 s, which is the exact rule Plane's throttle enforces, so a burst can never exceed the key's limit.
 * Time is virtual (the latest scheduled send), so an injected sleep paces correctly in tests.
 */
export class TokenBucket {
  #capacity: number;
  #fillRatePerMs: number;
  #windowLimit: number;
  #tokens: number;
  #lastRefill: number;
  #clock = 0;
  #pausedUntil = 0;
  #sent: number[] = [];
  #queue: Promise<void> = Promise.resolve();
  #sleep: Sleep;
  #now: () => number;

  /** `now` is the clock the window is measured on; tests pass the same virtual clock their `sleep` advances. */
  constructor(ratePerMinute: number, capacity?: number, sleep: Sleep = realSleep, now: () => number = Date.now) {
    const rate = ratePerMinute > 0 && Number.isFinite(ratePerMinute) ? ratePerMinute : 0;
    this.#capacity = capacity ?? (rate > 0 ? Math.max(1, Math.min(DEFAULT_PLANE_BURST, Math.floor(rate))) : 1);
    this.#fillRatePerMs = rate / PLANE_RATE_WINDOW_MS;
    this.#windowLimit = Math.max(1, Math.floor(rate));
    this.#tokens = this.#capacity;
    this.#now = now;
    this.#lastRefill = now();
    this.#sleep = sleep;
  }

  get ratePerMinute(): number {
    return this.#fillRatePerMs * 60_000;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get availableTokens(): number {
    const elapsed = Math.max(0, this.#now() - this.#lastRefill);
    return Math.min(this.#capacity, this.#tokens + (this.#fillRatePerMs > 0 ? elapsed * this.#fillRatePerMs : 0));
  }

  /** Plane reported the key exhausted (`X-RateLimit-Remaining: 0`): send nothing before `untilMs`. */
  pauseUntil(untilMs: number): void {
    if (Number.isFinite(untilMs)) this.#pausedUntil = Math.max(this.#pausedUntil, untilMs);
  }

  #refill(at: number): void {
    if (at > this.#lastRefill) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + (at - this.#lastRefill) * this.#fillRatePerMs);
      this.#lastRefill = at;
    }
  }

  /**
   * Waits for the budget. With `maxWaitMs`, a longer wait is not slept: it throws `PlaneRateLimitError`
   * (no request made) with the time the budget frees up, and nothing is consumed.
   */
  async acquire(cost = 1, opts: { maxWaitMs?: number } = {}): Promise<void> {
    if (this.#fillRatePerMs <= 0) return;
    const prev = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prev;
    try {
      const at = Math.max(this.#now(), this.#clock);
      this.#refill(at);
      let wait = Math.max(0, this.#pausedUntil - at);
      const tokensThen = Math.min(this.#capacity, this.#tokens + wait * this.#fillRatePerMs);
      if (tokensThen < cost) wait += Math.ceil((cost - tokensThen) / this.#fillRatePerMs);
      // The window is (send - span, send], as Plane's throttle drops history `<= now - duration`.
      const span = PLANE_RATE_WINDOW_MS + PLANE_RATE_MARGIN_MS;
      while (this.#sent.length && this.#sent[0]! <= at + wait - span) this.#sent.shift();
      if (this.#sent.length >= this.#windowLimit) {
        wait = Math.max(wait, this.#sent[this.#sent.length - this.#windowLimit]! + span - at);
      }
      if (opts.maxWaitMs !== undefined && wait > opts.maxWaitMs) {
        throw new PlaneRateLimitError(at + wait, { message: "Plane request budget exhausted; retry when it frees up", requestMade: false });
      }
      if (wait > 0) await this.#sleep(wait);
      // Record when the request really leaves: a sleep that overran must not be booked at its planned time, or
      // the request would stay in Plane's minute longer than in this history.
      const sendAt = Math.max(at + wait, this.#now());
      this.#refill(sendAt);
      this.#tokens = Math.max(0, this.#tokens - cost);
      this.#clock = sendAt;
      for (let i = 0; i < cost; i++) this.#sent.push(sendAt);
    } finally {
      release();
    }
  }
}

export class PlaneClient {
  #baseUrl: string;
  #token: SecretString;
  #fetch: typeof fetch;
  #maxRetries: number;
  #sleep: Sleep;
  #rateLimiter: TokenBucket;
  #maxInlineWaitMs: number;

  constructor(opts: PlaneClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
    this.#maxRetries = opts.maxRetries ?? 5;
    this.#sleep = opts.sleep ?? realSleep;
    const rate = opts.rateLimitPerMinute ?? opts.requestsPerMinute ?? 60;
    this.#rateLimiter = new TokenBucket(rate, opts.burstCapacity, this.#sleep);
    this.#maxInlineWaitMs = opts.maxInlineWaitMs ?? PLANE_MAX_INLINE_WAIT_MS;
  }

  get rateBudget(): TokenBucket {
    return this.#rateLimiter;
  }

  get rateLimitPerMinute(): number {
    return this.#rateLimiter.ratePerMinute;
  }

  /**
   * Retries idempotent requests on network errors and 5xx. Ambiguous POST failures belong to the durable
   * outbox. A 429 is never slept on: it throws `PlaneRateLimitError` with the server's deadline (contract 2).
   */
  async request<T = unknown>(method: string, path: string, body?: unknown, opts?: { token?: SecretString }): Promise<T> {
    const url = this.#baseUrl + (path.startsWith(`${API_PREFIX}/`) ? path : API_PREFIX + path);
    const key = (opts?.token ?? this.#token).reveal();
    // The limit is per API key: only the service key's own exhaustion pauses the shared service budget.
    const serviceKey = opts?.token === undefined || key === this.#token.reveal();
    const post = method.toUpperCase() === "POST";
    for (let attempt = 0; ; attempt++) {
      await this.#rateLimiter.acquire(1, { maxWaitMs: this.#maxInlineWaitMs });
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method,
          headers: { "X-API-Key": key, "Content-Type": "application/json", Accept: "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (post || attempt >= this.#maxRetries) throw new Error(`Plane ${method} ${path} failed: ${err instanceof Error ? err.message : "network error"}`);
        await this.#sleep(backoffMs(attempt));
        continue;
      }
      if (serviceKey) this.#noteRemaining(res.headers);
      const text = await res.text();
      let parsed: unknown = text;
      if (text) { try { parsed = JSON.parse(text); } catch { /* non-JSON body is kept as text */ } } else parsed = undefined;
      if (res.ok) return parsed as T;
      if (!post && res.status >= 500 && attempt < this.#maxRetries) {
        await this.#sleep(retryDelayMs((n) => res.headers.get(n), attempt));
        continue;
      }
      const detail = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? `: ${(parsed as { error: string }).error}` : "";
      const headers: Record<string, string> = {};
      for (const name of ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
        const value = res.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      const message = `Plane ${method} ${path} returned ${res.status}${detail}`;
      if (res.status === 429) {
        // One rule for every deadline: Retry-After, else X-RateLimit-Reset, else the 60 s minimum fallback.
        const error = new PlaneApiError(429, parsed, message, headers);
        const c = classifyGithubError(error);
        const retryAt = c.kind === "rate_limited" ? c.retryAt : Date.now() + 60_000;
        if (serviceKey) this.#rateLimiter.pauseUntil(retryAt); // other requests on this key defer too
        throw new PlaneRateLimitError(retryAt, { body: parsed, message, headers });
      }
      throw new PlaneApiError(res.status, parsed, message, headers);
    }
  }

  /** A5: `X-RateLimit-Remaining: 0` means every send before `X-RateLimit-Reset` (epoch seconds) is rejected. */
  #noteRemaining(headers: Headers): void {
    if (headers.get("x-ratelimit-remaining")?.trim() !== "0") return;
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (!Number.isFinite(reset) || reset <= 0) return;
    this.#rateLimiter.pauseUntil(Math.min(reset * 1000, Date.now() + PLANE_RATE_WINDOW_MS));
  }

  /** Follows `next_cursor` while `next_page_results` is true; a bare array is a single page. */
  async listAll<T>(path: string, opts?: { token?: SecretString }): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 0; page < 1000; page++) {
      const url: string = cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path;
      const res = await this.request<T[] | { results?: T[]; next_cursor?: string | null; next_page_results?: boolean }>("GET", url, undefined, opts);
      if (Array.isArray(res)) return res;
      out.push(...(res?.results ?? []));
      if (!res?.next_page_results || !res.next_cursor) return out;
      cursor = res.next_cursor;
    }
    throw new Error(`Plane pagination did not terminate for ${path}`);
  }

  async listStates(slug: string, projectId: string): Promise<PlaneState[]> {
    return this.listAll<PlaneState>(planeWorkspacePath(slug, "projects", projectId, "states"));
  }

  async getIssueByIdentifier(slug: string, identifier: string): Promise<unknown> {
    return this.request("GET", planeWorkspacePath(slug, PLANE_ITEMS_SEGMENT, identifier));
  }

  async getIssue(slug: string, projectId: string, issueId: string): Promise<unknown> {
    return this.request("GET", planeItemsPath(slug, projectId, issueId));
  }

  /** The project as the service user sees it; `archived_at` is null unless the project is archived. */
  async getProject(slug: string, projectId: string): Promise<PlaneProject> {
    return this.request<PlaneProject>("GET", planeWorkspacePath(slug, "projects", projectId));
  }

  /**
   * Ids of the project's visible (not archived) work items, `per_page` at a time. Stops after `maxPages`,
   * or after the first page when `total_pages` exceeds it, and then reports `complete: false`, so a
   * caller never takes a partial list for the whole project.
   */
  async listIssueIds(slug: string, projectId: string, opts: { perPage?: number; maxPages?: number } = {}): Promise<PlaneIdPage> {
    const perPage = opts.perPage ?? 100;
    const maxPages = opts.maxPages ?? 1000;
    const ids: string[] = [];
    let cursor: string | null = null;
    let totalPages: number | undefined;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ per_page: String(perPage), fields: "id", order_by: "created_at" });
      if (cursor) q.set("cursor", cursor);
      const res = await this.request<PlanePage<{ id?: unknown }> | { id?: unknown }[]>("GET", `${planeItemsPath(slug, projectId)}?${q}`);
      if (Array.isArray(res)) return { ids: res.map((r) => r?.id).filter((id): id is string => typeof id === "string"), complete: true, totalPages: 1 };
      if (typeof res?.total_pages === "number") totalPages = res.total_pages;
      for (const r of res?.results ?? []) if (typeof r?.id === "string") ids.push(r.id);
      if (!res?.next_page_results || !res.next_cursor) return { ids, complete: true, ...(totalPages !== undefined ? { totalPages } : {}) };
      // Reading on would cost more than the caller allowed: stop now rather than after `maxPages` pages.
      if (totalPages !== undefined && totalPages > maxPages) return { ids, complete: false, totalPages };
      cursor = res.next_cursor;
    }
    return { ids, complete: false, ...(totalPages !== undefined ? { totalPages } : {}) };
  }

  /** The newest `updated_at` among the project's visible work items, or null for an empty project. */
  async latestIssueUpdate(slug: string, projectId: string): Promise<string | null> {
    const q = new URLSearchParams({ per_page: "1", fields: "id,updated_at", order_by: "-updated_at" });
    const res = await this.request<PlanePage<{ updated_at?: unknown }>>("GET", `${planeItemsPath(slug, projectId)}?${q}`);
    const at = res?.results?.[0]?.updated_at;
    return typeof at === "string" ? at : null;
  }

  /**
   * The item's newest activity rows. v1.4.2 keeps activities when an item is deleted (DO_NOTHING) and
   * records `field: "archived_at"` on archive and restore, so they tell an archived item from a deleted one.
   */
  /**
   * E2E-2: the work item git-sync created under this external id, archived or not; null when Plane has none (or it
   * was deleted). v1.4.2's list view answers an `external_source` + `external_id` query with the single item from
   * `Issue.objects`, which hides soft-deleted rows but not archived ones (the detail view uses `issue_objects`, which
   * hides both), and a miss is 404 "The requested resource does not exist.".
   */
  async findIssueByExternalId(slug: string, projectId: string, externalSource: string, externalId: string): Promise<PlaneExternalItem | null> {
    const q = new URLSearchParams({ external_source: externalSource, external_id: externalId });
    let item: PlaneExternalItem;
    try {
      item = await this.request<PlaneExternalItem>("GET", `${planeItemsPath(slug, projectId)}?${q}`);
    } catch (err) {
      if (err instanceof PlaneApiError && err.status === 404) return null;
      throw err;
    }
    // Anything but the exact item (a page, another id) is not evidence about this one.
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id
      || item.external_id !== externalId || item.external_source !== externalSource) {
      throw new PlaneApiError(502, {}, "Plane external-id lookup returned an unexpected body");
    }
    return item;
  }

  async listIssueActivities(slug: string, projectId: string, issueId: string, perPage = 50): Promise<PlaneActivity[]> {
    const q = new URLSearchParams({ per_page: String(perPage), order_by: "-created_at" });
    const res = await this.request<PlanePage<PlaneActivity> | PlaneActivity[]>("GET", `${planeItemsPath(slug, projectId, issueId)}activities/?${q}`);
    return Array.isArray(res) ? res : res?.results ?? [];
  }
}

export interface PlaneProject { id?: string; archived_at?: string | null }
export interface PlaneExternalItem { id: string; archived_at?: string | null; external_id?: string | null; external_source?: string | null }

/** The `external_source` on every work item and comment git-sync creates; its `external_id` is the outbox intent id. */
export const PLANE_EXTERNAL_SOURCE = "gitsync";

/** E2E-2: remembers the external id of a work item git-sync created (migration 012). */
export async function recordPlaneCreatedItem(db: Db, item: { planeIssueId: string; planeProjectId: string; externalSource: string; externalId: string }): Promise<void> {
  await db.query(`INSERT INTO plane_created_items (plane_issue_id, plane_project_id, external_source, external_id) VALUES ($1, $2, $3, $4)
    ON CONFLICT (plane_issue_id) DO NOTHING`, [item.planeIssueId, item.planeProjectId, item.externalSource, item.externalId]);
}

export async function planeCreatedItem(db: Db, planeIssueId: string, planeProjectId: string): Promise<{ externalSource: string; externalId: string } | null> {
  const row = (await db.query<{ external_source: string; external_id: string }>(
    "SELECT external_source, external_id FROM plane_created_items WHERE plane_issue_id = $1 AND plane_project_id = $2", [planeIssueId, planeProjectId])).rows[0];
  return row ? { externalSource: row.external_source, externalId: row.external_id } : null;
}
export interface PlaneActivity { verb?: string | null; field?: string | null; new_value?: string | null; created_at?: string }
interface PlanePage<T> { results?: T[]; next_cursor?: string | null; next_page_results?: boolean; total_pages?: number }
/** Contract 3: a list read either returns everything (`complete: true`) or says it did not. */
export interface PlaneIdPage { ids: string[]; complete: boolean; totalPages?: number }

export type PlaneWrite =
  | { kind: "update_issue"; slug: string; projectId: string; issueId: string; fields: Record<string, unknown>; skipTerminalState?: boolean }
  | { kind: "create_issue"; slug: string; projectId: string; fields: Record<string, unknown> }
  | { kind: "add_comment"; slug: string; projectId: string; issueId: string; commentHtml: string }
  | { kind: "add_link"; slug: string; projectId: string; issueId: string; url: string; title: string }
  | { kind: "update_link"; slug: string; projectId: string; issueId: string; linkId: string; url: string; title: string }
  | { kind: "upsert_label"; slug: string; projectId: string; name: string; color?: string };

export interface PlaneWriteResult { ok: boolean; id?: string; duplicate?: boolean }
export interface PlaneWriteOptions {
  actorToken?: SecretString;
  /** Stable durable outbox id, supplied by the executor rather than webhook data. */
  intentId?: string;
}

export class UnknownPlaneState extends Error {
  /** A9: v1.4.2's states list filters out triage states, so an id missing after a refresh may be one. */
  readonly mayBeTriage: boolean;
  constructor(message: string, mayBeTriage = false) { super(message); this.name = "UnknownPlaneState"; this.mayBeTriage = mayBeTriage; }
}

/** The id is absent from a freshly read states list: either it does not exist or it is a triage state. */
const unknownOrTriage = (stateId: string, projectId: string) => new UnknownPlaneState(
  `unknown Plane state id ${stateId} in project ${projectId}: not in the project's states list, which omits triage states, `
  + "so it is either missing or a triage state (writes into triage are not allowed, §7.1)", true);

/** Markers for creates in flight (F13, F9): ingress retries a creation event while one of these is fresh. */
export const pendingCreateHash = (projectId: string, name = "") =>
  opHash("plane", name ? `pending:${projectId}:${name.trim()}` : `pending:${projectId}`, "create_issue", null);
export const pendingCommentHash = (issueId: string) => opHash("plane", `pending:${issueId}`, "add_comment", null);

const DUPLICATE_LINK = "URL already exists for this Issue";

export class PlaneWritePath {
  #client: PlaneClient;
  #db: Db;
  #stateCacheMs: number;
  #states = new Map<string, { at: number; states: PlaneState[] }>();

  constructor(deps: { client: PlaneClient; db: Db; stateCacheMs?: number }) {
    this.#client = deps.client;
    this.#db = deps.db;
    this.#stateCacheMs = deps.stateCacheMs ?? 5 * 60_000;
  }

  async #statesFor(slug: string, projectId: string, refresh = false): Promise<PlaneState[]> {
    const key = `${slug}/${projectId}`;
    const hit = this.#states.get(key);
    if (hit && !refresh && Date.now() - hit.at < this.#stateCacheMs) return hit.states;
    const states = await this.#client.listStates(slug, projectId);
    this.#states.set(key, { at: Date.now(), states });
    return states;
  }

  /** §7.1: nothing may move an issue into `triage`. Runs before any op is recorded or request sent. */
  async #guardState(slug: string, projectId: string, fields: Record<string, unknown>): Promise<void> {
    const state = fields.state;
    if (state === undefined || state === null) return;
    if (typeof state !== "string") throw new Error("Plane state must be a state id string");
    let found = (await this.#statesFor(slug, projectId)).find((s) => s.id === state);
    if (!found) found = (await this.#statesFor(slug, projectId, true)).find((s) => s.id === state);
    if (!found) throw unknownOrTriage(state, projectId);
    // Plane v1.4.2 never lists triage states (StateManager excludes them); this guards a version that does.
    if (found.group === "triage") throw new TriageWriteRejected();
  }

  /** The checks that must fail inline, before a write is queued: the triage ban and an unknown state (§7.1). */
  async preflight(write: PlaneWrite): Promise<void> {
    if (write.kind === "update_issue" || write.kind === "create_issue") await this.#guardState(write.slug, write.projectId, write.fields);
  }

  async apply(write: PlaneWrite, opts: PlaneWriteOptions = {}): Promise<PlaneWriteResult> {
    const req = <T>(method: string, path: string, body?: unknown) => this.#client.request<T>(method, path, body, opts.actorToken ? { token: opts.actorToken } : undefined);
    const base = (w: { slug: string; projectId: string }) => planeWorkspacePath(w.slug, "projects", w.projectId);
    const item = (w: { slug: string; projectId: string; issueId: string }) => planeItemsPath(w.slug, w.projectId, w.issueId);

    switch (write.kind) {
      case "update_issue": {
        await this.#guardState(write.slug, write.projectId, write.fields);
        if (write.skipTerminalState) {
          const current = (await this.#client.getIssue(write.slug, write.projectId, write.issueId)) as any;
          const stateId = typeof current?.state === "object" ? current?.state?.id : current?.state;
          if (!stateId || typeof stateId !== "string") {
            throw new UnknownPlaneState(`issue ${write.issueId} current state cannot be resolved`);
          }
          let st = (await this.#statesFor(write.slug, write.projectId)).find((s) => s.id === stateId);
          if (!st) {
            st = (await this.#statesFor(write.slug, write.projectId, true)).find((s) => s.id === stateId);
          }
          if (!st) {
            throw unknownOrTriage(stateId, write.projectId);
          }
          if (st.group === "completed" || st.group === "cancelled") {
            await appendAudit(this.#db, {
              kind: "skipped_terminal_state",
              outcome: "skipped_terminal_state",
              workspaceSlug: write.slug,
              detail: { issueId: write.issueId, state: stateId, group: st.group },
            });
            return { ok: true, id: write.issueId };
          }
        }
        const hashes = Object.entries(write.fields).map(([field, value]) => opHash("plane", write.issueId, field, value));
        if (hashes.length === 0) return { ok: true, id: write.issueId };
        // Recorded BEFORE the request: the echo webhook can arrive before the response does.
        await recordAppliedOps(this.#db, hashes.map((opHash) => ({ opHash, direction: "to_plane" as const })));
        try {
          await req("PATCH", item(write), write.fields);
        } catch (err) {
          await forgetAppliedOps(this.#db, hashes); // a stale row would swallow a genuine human edit
          throw err;
        }
        return { ok: true, id: write.issueId };
      }
      case "create_issue":
      case "add_comment":
        return this.#create(write, opts);
      case "add_link": {
        try {
          const created = await req<{ id?: string }>("POST", `${item(write)}links/`, { url: write.url, title: write.title });
          return created?.id ? { ok: true, id: created.id } : { ok: true };
        } catch (err) {
          const msg = err instanceof PlaneApiError && err.status === 400 && err.body && typeof err.body === "object" ? (err.body as { error?: unknown }).error : undefined;
          if (msg === DUPLICATE_LINK) return { ok: true, duplicate: true };
          throw err;
        }
      }
      case "update_link": {
        await req("PATCH", `${item(write)}links/${planeSegment(write.linkId, "Plane link id")}/`, { url: write.url, title: write.title });
        return { ok: true, id: write.linkId };
      }
      case "upsert_label": {
        try {
          const created = await req<{ id: string }>("POST", `${base(write)}labels/`, write.color ? { name: write.name, color: write.color } : { name: write.name });
          return { ok: true, id: created.id };
        } catch (err) {
          const existing = err instanceof PlaneApiError && err.status === 409 && err.body && typeof err.body === "object" ? (err.body as { id?: unknown }).id : undefined;
          if (typeof existing === "string") return { ok: true, id: existing };
          throw err;
        }
      }
    }
  }

  async #create(write: Extract<PlaneWrite, { kind: "create_issue" | "add_comment" }>, opts: PlaneWriteOptions): Promise<PlaneWriteResult> {
    if (write.kind === "create_issue") await this.#guardState(write.slug, write.projectId, write.fields);
    const intentId = opts.intentId;
    if (intentId !== undefined && (typeof intentId !== "string" || !intentId.trim() || intentId.length > 255)) {
      throw new Error("Plane create intent id must be a nonempty string of at most 255 characters");
    }
    const path = write.kind === "add_comment" ? `${planeItemsPath(write.slug, write.projectId, write.issueId)}comments/`
      : planeItemsPath(write.slug, write.projectId);
    const requestOptions = opts.actorToken ? { token: opts.actorToken } : undefined;
    if (intentId) {
      let existing: { id?: unknown; external_id?: unknown; external_source?: unknown } | undefined;
      if (write.kind === "create_issue") {
        // v1.4.2 returns one object (not a page) for this external-id lookup; absence is 404.
        try {
          existing = await this.#client.request("GET", `${path}?${new URLSearchParams({ external_source: PLANE_EXTERNAL_SOURCE, external_id: intentId })}`, undefined, requestOptions);
        } catch (err) { if (!(err instanceof PlaneApiError) || err.status !== 404) throw err; }
      } else {
        const comments = await this.#client.listAll<{ id?: unknown; external_id?: unknown; external_source?: unknown }>(path, requestOptions);
        existing = comments.find((c) => c.external_source === "gitsync" && c.external_id === intentId);
      }
      if (existing !== undefined) {
        if (!existing || typeof existing.id !== "string" || !existing.id || existing.external_id !== intentId || existing.external_source !== "gitsync") {
          throw new PlaneApiError(502, {}, "Plane intent lookup returned an invalid or mismatched object");
        }
        await this.#recordCreated(existing.id, write, intentId);
        return { ok: true, id: existing.id };
      }
    }
    const name = write.kind === "create_issue" && typeof write.fields.name === "string" ? write.fields.name : "";
    const markers = write.kind === "add_comment" ? [pendingCommentHash(write.issueId)]
      : [pendingCreateHash(write.projectId), ...(name ? [pendingCreateHash(write.projectId, name)] : [])];
    try {
      for (const marker of markers) await markCreatePending(this.#db, marker, "to_plane");
      const fields = write.kind === "create_issue" ? write.fields : { comment_html: write.commentHtml };
      let created: { id?: unknown };
      try {
        created = await this.#client.request("POST", path, { ...fields,
          ...(intentId ? { external_source: "gitsync", external_id: intentId } : {}),
        }, requestOptions);
      } catch (err) {
        // A read replica can miss a committed create. Plane's exact conflict identifies its id.
        const duplicate = write.kind === "create_issue" ? "Issue with the same external id and external source already exists"
          : "Work item comment with the same external id and external source already exists";
        const body = err instanceof PlaneApiError && err.status === 409 && err.body && typeof err.body === "object"
          ? err.body as { error?: unknown; id?: unknown } : undefined;
        if (!intentId || body?.error !== duplicate || typeof body.id !== "string" || !body.id) throw err;
        created = { id: body.id };
      }
      if (!created || typeof created.id !== "string" || !created.id) throw new PlaneApiError(502, {}, "Plane create response has no id");
      await this.#recordCreated(created.id, write, intentId);
      return { ok: true, id: created.id };
    } finally {
      for (const marker of markers) {
        try { await clearCreatePending(this.#db, marker); }
        catch { console.error("Plane create pending-marker cleanup failed"); }
      }
    }
  }

  async #recordCreated(id: string | undefined, write: Extract<PlaneWrite, { kind: "create_issue" | "add_comment" }>, intentId: string | undefined): Promise<void> {
    if (!id) return;
    try { await recordAppliedOps(this.#db, [{ opHash: opHash("plane", id, "created", null), direction: "to_plane" }]); }
    catch { console.error("Plane create succeeded but its echo-ledger bookkeeping failed"); }
    if (write.kind !== "create_issue" || !intentId) return;
    // E2E-2: reconcile tells an archived item from a deleted one through this pair (see findIssueByExternalId).
    try { await recordPlaneCreatedItem(this.#db, { planeIssueId: id, planeProjectId: write.projectId, externalSource: PLANE_EXTERNAL_SOURCE, externalId: intentId }); }
    catch { console.error("Plane create succeeded but its external-id bookkeeping failed"); }
  }
}
