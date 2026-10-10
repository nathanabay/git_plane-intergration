# Leaf brief: leaf-1.3.1 — A4 the single write path and queue consumers (implementer A, wave 3)

Read `.unlazy/impl/briefs/COMMON.md` first. Its rules are part of this brief.

Your ledger: `docs/impl/agent-gates/leaf-1.3.1.GATES.md`

## OWNS

    src/sync/**, src/queue/**, src/db/**, src/index.ts, src/config/**, tests/sync/**,
    tests/queue/**, tests/db/**, tests/deploy/**, deploy/**, docs/impl/agent-gates/leaf-1.3.1.GATES.md

(`src/sync/mirror.ts`, `src/sync/dev-info.ts` and `src/sync/reconcile.ts` will be written by later
tasks — do not create them.)

## Driver gates (copy all into your ledger, exactly)

    - [ ] G1: A4 write path and consumers pass the driver oracle
      CHECK: node scripts/verify-a4-writepath.mjs
      EXPECT: A4 write path verification passed
      EVIDENCE: pending

    - [ ] G2: A2/A3 behaviour did not regress
      CHECK: node scripts/verify-a2-ingress.mjs
      EXPECT: A2 ingress verification passed
      EVIDENCE: pending

    - [ ] G3: A3 ledgers did not regress
      CHECK: node scripts/verify-a3-schema.mjs
      EXPECT: A3 schema verification passed
      EVIDENCE: pending

    - [ ] G4: own tests run, at least 35 passing, none skipped
      CHECK: node scripts/run-tests.mjs 35 tests/sync tests/queue
      EXPECT: tests passed
      EVIDENCE: pending

    - [ ] G5: typecheck clean
      CHECK: node scripts/typecheck.mjs "src/sync/**/*.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "src/index.ts" "src/config/**/*.ts" "tests/sync/**/*.ts" "tests/queue/**/*.ts"
      EXPECT: typecheck passed
      EVIDENCE: pending

    - [ ] G6: no stubs or placeholders
      CHECK: node scripts/verify-no-stubs.mjs src/sync src/queue src/db src/index.ts tests/sync tests/queue
      EXPECT: stub scan passed
      EVIDENCE: pending

Read `scripts/verify-a4-writepath.mjs` in full first: it pins the contract below.

---

## Why this task matters

A4 is the **chokepoint**. Every later task that changes Plane or GitHub (B4 Smart Commits, B5 PR
automation, B6 mirroring, B7 dev-info, B8 replay/backfill) must write through the classes you
build here. That is what keeps the echo ledger authoritative and the `triage` ban enforceable in
one place (IMPLEMENTATION_PLAN.md, phase 3). Read spec §1.3, §3 ("Two Plane write semantics"),
§4, §5, §7.1 and §9 (rate limits) before writing code, and HANDOFF.md's four pitfalls.

## Contract (the oracle imports exactly these)

```ts
// src/sync/ophash.ts — the ONE hashing function both sides use
export type Side = "plane" | "github";
export function normalizeValue(value: unknown): string;
  // canonical JSON: object keys sorted recursively; an array whose items are all scalars is sorted;
  // undefined → null. Strings are NOT trimmed or case-folded (Plane compares exact values).
export function opHash(side: Side, targetId: string, field: string, value: unknown): string;
  // sha256 hex of JSON.stringify([side, targetId, field, normalizeValue(value)]) — field-granular (§5)

// src/sync/plane.ts
export class PlaneApiError extends Error { status: number; body: unknown }
export class TriageWriteRejected extends Error {}
export interface PlaneClientOptions { baseUrl: string; token: SecretString; fetch?: typeof fetch;
  maxRetries?: number /* default 5 */; sleep?: (ms: number) => Promise<void> }
export class PlaneClient {
  constructor(opts: PlaneClientOptions);
  request<T = unknown>(method: string, path: string, body?: unknown, opts?: { token?: SecretString }): Promise<T>;
  listStates(slug: string, projectId: string): Promise<{ id: string; name: string; group: string; default?: boolean }[]>;
  getIssueByIdentifier(slug: string, identifier: string): Promise<unknown>;     // GET .../issues/PROJ-123/ (§1.2)
  getIssue(slug: string, projectId: string, issueId: string): Promise<unknown>;
}
export type PlaneWrite =
  | { kind: "update_issue"; slug: string; projectId: string; issueId: string; fields: Record<string, unknown> }
  | { kind: "create_issue"; slug: string; projectId: string; fields: Record<string, unknown> }
  | { kind: "add_comment"; slug: string; projectId: string; issueId: string; commentHtml: string }
  | { kind: "add_link"; slug: string; projectId: string; issueId: string; url: string; title: string }
  | { kind: "update_link"; slug: string; projectId: string; issueId: string; linkId: string; url: string; title: string }
  | { kind: "upsert_label"; slug: string; projectId: string; name: string; color?: string };
export interface PlaneWriteResult { ok: true; id?: string; duplicate?: boolean }
export class PlaneWritePath {
  constructor(deps: { client: PlaneClient; db: Db; stateCacheMs?: number });
  apply(write: PlaneWrite, opts?: { actorToken?: SecretString }): Promise<PlaneWriteResult>;
}

// src/sync/github.ts
export type GithubWrite =
  | { kind: "update_issue"; installationId: number; owner: string; repo: string; repoId: number; number: number;
      fields: { title?: string; body?: string; state?: "open" | "closed" } }
  | { kind: "add_labels"; installationId: number; owner: string; repo: string; repoId: number; number: number; labels: string[] }
  | { kind: "remove_label"; installationId: number; owner: string; repo: string; repoId: number; number: number; label: string }
  | { kind: "add_assignees"; installationId: number; owner: string; repo: string; repoId: number; number: number; assignees: string[] }
  | { kind: "comment"; installationId: number; owner: string; repo: string; repoId: number; number: number; body: string }
  | { kind: "create_issue"; installationId: number; owner: string; repo: string; repoId: number; title: string; body: string; labels?: string[] };
export class GithubWritePath {
  constructor(deps: { app: { installationOctokit(id: number): Promise<any> }; db: Db; sleep?: (ms: number) => Promise<void> });
  apply(write: GithubWrite): Promise<{ ok: true; id?: number }>;
}
export function githubFieldChanges(event: string, payload: any): { targetId: string; field: string; value: unknown }[];

// src/queue/workers.ts
export type InboundOutcome = "duplicate" | "echo" | "handled";
export interface InboundDeps { db: Db; serviceUserId?: string; opTtlMinutes: number;
  onPlaneEvent(job: InboundJob): Promise<void>; onGithubEvent(job: InboundJob): Promise<void> }
export function processInbound(job: InboundJob, deps: InboundDeps): Promise<InboundOutcome>;
export function startWorkers(opts: { connectionUrl: string; prefix: string; inbound: InboundDeps;
  plane: PlaneWritePath; github: GithubWritePath; planeWritesPerMinute?: number }): { close(): Promise<void> };

// src/sync/router.ts — where later tasks register their reducers
export class EventRouter {
  on(source: "plane" | "github", event: string, reducer: (job: InboundJob) => Promise<void>): void; // event "issue", "pull_request", "*"
  dispatch(job: InboundJob): Promise<"routed" | "unhandled">;
}
```

## Paths and client conventions

- `PlaneClientOptions.baseUrl` is the origin (`PLANE_BASE_URL`, e.g. `http://api:8000`); the client
  prefixes `/api/v1`. Paths (§1.2): `/api/v1/workspaces/{slug}/projects/{pid}/issues/` and
  `/{pk}/`, `.../issues/{id}/comments/`, `.../issues/{id}/links/` and `/{pk}/`,
  `.../projects/{pid}/states/`, `.../projects/{pid}/labels/`,
  `/api/v1/workspaces/{slug}/issues/{PROJ-123}/`. Trailing slashes as shown — Django redirects
  otherwise.
- List responses may be a bare array or a cursor page `{ results, next_cursor, next_page_results }`;
  handle both and follow `cursor=` until `next_page_results` is false.
- `GithubWritePath` calls GitHub **only** through `octokit.request(route, params)` with route
  strings such as `"PATCH /repos/{owner}/{repo}/issues/{issue_number}"`, so any Octokit (and the
  oracle's fake) works. Reads `status`/`headers` from the response or from a thrown
  `RequestError` (`error.status`, `error.response.headers`).

## Semantics — each line is a spec requirement

**Echo ledger (§5, pitfalls 1 and 2).**
- `PlaneWritePath.apply(update_issue)`: for **each** field compute
  `opHash("plane", issueId, field, value)` and `recordAppliedOps(... "to_plane")` **before** the
  HTTP write (an echo can race the response). If the write then fails, **remove exactly those
  rows** (add `forgetAppliedOps(db, hashes)` to `src/db/ledgers.ts`) — otherwise a stale row would
  later swallow a genuine human edit. Plane's webhook reports `field` = the key we sent and
  `new_value` = the value we sent (spec §1.3, `model_activity`), so hashing the request body's
  keys and values matches the echo exactly.
- Creations: after a successful `create_issue`/`add_comment`, record
  `opHash("plane", <new id>, "created", null)`; Plane's create webhook has `verb created` with
  `field` null and `data.id` the new id.
- `processInbound`: (1) `recordDelivery` — a repeat is `"duplicate"` (§5). (2) Plane only:
  cheap pre-filter — if `activity.actor.id === serviceUserId`, consume the matching op if one
  exists and return `"echo"`. (3) compute the incoming change's hash identically
  (Plane: `opHash("plane", data.id, activity.field ?? "created", activity.field ? activity.new_value : null)`;
  GitHub: every entry of `githubFieldChanges`) and `consumeRecentOp` — **all** entries matching
  means `"echo"`. Drop echoes **here, on ingress** — never skip an outbound write because a
  similar op exists (pitfall 2). (4) otherwise call the source's handler → `"handled"`.
- `githubFieldChanges` and `GithubWritePath` use the **same** field vocabulary, targetId
  `${repoId}#${number}`:
  `issues|pull_request.edited` → one entry per key of `payload.changes` (`title`, `body`) with the
  current value; `closed`/`reopened` → `state` = `open|closed`; `labeled`/`unlabeled` →
  `label:<name>` = `true|false`; `assigned`/`unassigned` → `assignee:<login>` = `true|false`;
  `issue_comment.created` → `comment` = body; `issues.opened` → `created` = null. Anything else →
  `[]` (never an echo).

**Plane write semantics (§3).**
- `add_link`: `POST .../issues/{id}/links/`. A `400` whose error is
  `"URL already exists for this Issue"` is success → `{ ok: true, duplicate: true }`. Any other
  400 throws. `update_link`: `PATCH .../links/{linkId}/` (B7 updates rollups in place).
- `upsert_label`: `POST .../labels/`; a `409` carries the existing label's `id` → return it
  (free upsert, no list-then-create race).
- Error envelope `{"error": "..."}` → `PlaneApiError` with `status` and parsed `body`. List
  endpoints paginate with `next_cursor` / `next_page_results` — `listStates` follows cursors.

**Triage ban (§7.1).** A write that sets `state` (update or create) to a state whose group is
`triage` throws `TriageWriteRejected` **before** any op is recorded or any HTTP write is sent.
States come from `listStates`, cached per project for `stateCacheMs` (default 5 min). An unknown
state id is a loud error, not a pass-through.

**Auth (§9).** `X-API-Key: <token>`; the service PAT by default, `opts.actorToken` (a per-user
PAT from B9's vault) when given. Never log a token or a request body.

**Rate limits (§9).** `PlaneClient.request` retries `429` and `5xx` up to `maxRetries`, waiting
`Retry-After` seconds when present, else until `X-RateLimit-Reset` (epoch seconds) when present,
else exponential backoff (1s, 2s, 4s… capped at 60s), via the injectable `sleep`. 4xx other than
429 are not retried. `GithubWritePath` does the same for GitHub's `403`/`429` with
`retry-after` or `x-ratelimit-remaining: 0` + `x-ratelimit-reset`. The outbound-plane BullMQ worker
also uses a limiter of `planeWritesPerMinute` (default 50, under Plane's 60/minute) for ordering.

**Wiring (`src/index.ts`).** After A2's queue/route setup: `createDb(DATABASE_URL)`, `migrate`,
`PlaneClient` with `PLANE_SERVICE_PAT`, the GitHub App, both write paths, an `EventRouter` (no
reducers are registered yet — later tasks add them; an event with no reducer is written to the
audit log as `unhandled`, which is honest behaviour, not a placeholder), and `startWorkers`.
`PLANE_SERVICE_USER_ID` (new, optional) feeds the actor pre-filter — add it to
`deploy/git-sync.env.example`. Shutdown order on SIGTERM: HTTP server, workers, queues, db.
