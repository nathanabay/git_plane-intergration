import type { SecretString } from "../auth/identity.ts";
import type { Db } from "../db/migrate.ts";
import { appendAudit, clearCreatePending, forgetAppliedOps, markCreatePending, recordAppliedOps } from "../db/ledgers.ts";
import { backoffMs, realSleep, retryDelayMs } from "./backoff.ts";
import type { Sleep } from "./backoff.ts";
import { opHash } from "./ophash.ts";

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
}

export interface PlaneState { id: string; name: string; group: string; default?: boolean }

const API_PREFIX = "/api/v1";

export class TokenBucket {
  #capacity: number;
  #fillRatePerMs: number;
  #tokens: number;
  #lastRefill: number;
  #queue: Promise<void> = Promise.resolve();
  #sleep: Sleep;

  constructor(ratePerMinute: number, capacity?: number, sleep: Sleep = realSleep) {
    this.#capacity = capacity ?? (ratePerMinute > 0 ? ratePerMinute : 1);
    this.#fillRatePerMs = ratePerMinute > 0 && Number.isFinite(ratePerMinute) ? ratePerMinute / 60_000 : 0;
    this.#tokens = this.#capacity;
    this.#lastRefill = Date.now();
    this.#sleep = sleep;
  }

  get ratePerMinute(): number {
    return this.#fillRatePerMs * 60_000;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get availableTokens(): number {
    const elapsed = Math.max(0, Date.now() - this.#lastRefill);
    return Math.min(this.#capacity, this.#tokens + (this.#fillRatePerMs > 0 ? elapsed * this.#fillRatePerMs : 0));
  }

  async acquire(cost = 1): Promise<void> {
    if (this.#fillRatePerMs <= 0) return;
    const prev = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prev;
    try {
      const now = Date.now();
      if (now > this.#lastRefill) {
        const elapsed = now - this.#lastRefill;
        this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#fillRatePerMs);
        this.#lastRefill = now;
      }

      if (this.#tokens < cost) {
        const needed = cost - this.#tokens;
        const waitMs = Math.ceil(needed / this.#fillRatePerMs);
        await this.#sleep(waitMs);
        this.#tokens = Math.max(0, this.#tokens + (waitMs * this.#fillRatePerMs) - cost);
        this.#lastRefill = Math.max(Date.now(), this.#lastRefill + waitMs);
      } else {
        this.#tokens -= cost;
      }
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

  constructor(opts: PlaneClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
    this.#maxRetries = opts.maxRetries ?? 5;
    this.#sleep = opts.sleep ?? realSleep;
    const rate = opts.rateLimitPerMinute ?? opts.requestsPerMinute ?? 60;
    this.#rateLimiter = new TokenBucket(rate, opts.burstCapacity, this.#sleep);
  }

  get rateBudget(): TokenBucket {
    return this.#rateLimiter;
  }

  get rateLimitPerMinute(): number {
    return this.#rateLimiter.ratePerMinute;
  }

  /** Retries rejected 429s and idempotent requests. Ambiguous POST failures belong to the durable outbox. */
  async request<T = unknown>(method: string, path: string, body?: unknown, opts?: { token?: SecretString }): Promise<T> {
    const url = this.#baseUrl + (path.startsWith(`${API_PREFIX}/`) ? path : API_PREFIX + path);
    const key = (opts?.token ?? this.#token).reveal();
    const post = method.toUpperCase() === "POST";
    for (let attempt = 0; ; attempt++) {
      await this.#rateLimiter.acquire();
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
      const text = await res.text();
      let parsed: unknown = text;
      if (text) { try { parsed = JSON.parse(text); } catch { /* non-JSON body is kept as text */ } } else parsed = undefined;
      if (res.ok) return parsed as T;
      const retriable = res.status === 429 || (!post && res.status >= 500);
      if (retriable && attempt < this.#maxRetries) {
        await this.#sleep(retryDelayMs((n) => res.headers.get(n), attempt));
        continue;
      }
      const detail = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? `: ${(parsed as { error: string }).error}` : "";
      const headers: Record<string, string> = {};
      for (const name of ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
        const value = res.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      throw new PlaneApiError(res.status, parsed, `Plane ${method} ${path} returned ${res.status}${detail}`, headers);
    }
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

  listStates(slug: string, projectId: string): Promise<PlaneState[]> {
    return this.listAll<PlaneState>(`/workspaces/${slug}/projects/${projectId}/states/`);
  }

  getIssueByIdentifier(slug: string, identifier: string): Promise<unknown> {
    return this.request("GET", `/workspaces/${slug}/issues/${encodeURIComponent(identifier)}/`);
  }

  getIssue(slug: string, projectId: string, issueId: string): Promise<unknown> {
    return this.request("GET", `/workspaces/${slug}/projects/${projectId}/issues/${issueId}/`);
  }
}

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
  constructor(message: string) { super(message); this.name = "UnknownPlaneState"; }
}

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
    if (!found) throw new UnknownPlaneState(`unknown Plane state id ${state} in project ${projectId}`);
    if (found.group === "triage") throw new TriageWriteRejected();
  }

  /** The checks that must fail inline, before a write is queued: the triage ban and an unknown state (§7.1). */
  async preflight(write: PlaneWrite): Promise<void> {
    if (write.kind === "update_issue" || write.kind === "create_issue") await this.#guardState(write.slug, write.projectId, write.fields);
  }

  async apply(write: PlaneWrite, opts: PlaneWriteOptions = {}): Promise<PlaneWriteResult> {
    const req = <T>(method: string, path: string, body?: unknown) => this.#client.request<T>(method, path, body, opts.actorToken ? { token: opts.actorToken } : undefined);
    const base = (w: { slug: string; projectId: string }) => `/workspaces/${w.slug}/projects/${w.projectId}`;

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
            throw new UnknownPlaneState(`unknown Plane state id ${stateId} in project ${write.projectId}`);
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
          await req("PATCH", `${base(write)}/issues/${write.issueId}/`, write.fields);
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
          const created = await req<{ id?: string }>("POST", `${base(write)}/issues/${write.issueId}/links/`, { url: write.url, title: write.title });
          return created?.id ? { ok: true, id: created.id } : { ok: true };
        } catch (err) {
          const msg = err instanceof PlaneApiError && err.status === 400 && err.body && typeof err.body === "object" ? (err.body as { error?: unknown }).error : undefined;
          if (msg === DUPLICATE_LINK) return { ok: true, duplicate: true };
          throw err;
        }
      }
      case "update_link": {
        await req("PATCH", `${base(write)}/issues/${write.issueId}/links/${write.linkId}/`, { url: write.url, title: write.title });
        return { ok: true, id: write.linkId };
      }
      case "upsert_label": {
        try {
          const created = await req<{ id: string }>("POST", `${base(write)}/labels/`, write.color ? { name: write.name, color: write.color } : { name: write.name });
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
    const path = `/workspaces/${write.slug}/projects/${write.projectId}/issues/`
      + (write.kind === "add_comment" ? `${write.issueId}/comments/` : "");
    const requestOptions = opts.actorToken ? { token: opts.actorToken } : undefined;
    if (intentId) {
      let existing: { id?: unknown; external_id?: unknown; external_source?: unknown } | undefined;
      if (write.kind === "create_issue") {
        // v1.4.2 returns one object (not a page) for this external-id lookup; absence is 404.
        try {
          existing = await this.#client.request("GET", `${path}?${new URLSearchParams({ external_source: "gitsync", external_id: intentId })}`, undefined, requestOptions);
        } catch (err) { if (!(err instanceof PlaneApiError) || err.status !== 404) throw err; }
      } else {
        const comments = await this.#client.listAll<{ id?: unknown; external_id?: unknown; external_source?: unknown }>(path, requestOptions);
        existing = comments.find((c) => c.external_source === "gitsync" && c.external_id === intentId);
      }
      if (existing !== undefined) {
        if (!existing || typeof existing.id !== "string" || !existing.id || existing.external_id !== intentId || existing.external_source !== "gitsync") {
          throw new PlaneApiError(502, {}, "Plane intent lookup returned an invalid or mismatched object");
        }
        await this.#recordCreated(existing.id);
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
      await this.#recordCreated(created.id);
      return { ok: true, id: created.id };
    } finally {
      for (const marker of markers) {
        try { await clearCreatePending(this.#db, marker); }
        catch { console.error("Plane create pending-marker cleanup failed"); }
      }
    }
  }

  async #recordCreated(id: string | undefined): Promise<void> {
    if (!id) return;
    try { await recordAppliedOps(this.#db, [{ opHash: opHash("plane", id, "created", null), direction: "to_plane" }]); }
    catch { console.error("Plane create succeeded but its echo-ledger bookkeeping failed"); }
  }
}
