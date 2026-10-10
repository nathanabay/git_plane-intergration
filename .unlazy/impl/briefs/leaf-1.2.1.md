# Leaf brief: leaf-1.2.1 — A2 ingress and queues + A3 schemas (implementer A, wave 2)

Read `.unlazy/impl/briefs/COMMON.md` first. Its rules are part of this brief.

Your ledger: `docs/impl/agent-gates/leaf-1.2.1.GATES.md`

## OWNS

    src/index.ts, deploy/**, src/api/**, src/queue/**, src/db/**, src/config/**, tests/api/**,
    tests/queue/**, tests/db/**, tests/deploy/**, docs/impl/agent-gates/leaf-1.2.1.GATES.md

`src/index.ts`, `deploy/**` and `tests/deploy/**` are handed over from your wave 1 leaf; keep
every A1 behaviour (the A1 oracle is G3 below).

**Amendment (driver, after dispatch): router parameters.** B3's config API (wave 3) needs path
parameters and the UI needs a prefix route. Extend `src/index.ts` routing, keeping every existing
behaviour:
- `RouteHandler` becomes `(req, res, params: Record<string, string>) => void | Promise<void>`.
- A path segment `:name` matches exactly one non-empty segment; the value is URL-decoded into
  `params.name`. A trailing `/*` matches any remainder (possibly several segments) into
  `params["*"]`, without the query string.
- An exact (literal) path beats a pattern; among patterns, more literal segments win. 405 with
  `Allow` still applies when the path matches but the method does not.
- Reject any request path containing a `..` segment (after decoding) with 400 before routing.
The A2 oracle has a new check for this.

**Carried-over A1 fixes (do these first):**
1. `deploy/APPLY.md` generates the DB password with `openssl rand -base64 32`. Base64 contains `/`,
   `+` and `=`; pasted raw into `DATABASE_URL` a `/` breaks URL parsing and the service cannot
   connect. Generate a URL-safe password (`openssl rand -hex 32`) and say why.
2. APPLY.md `echo`es the generated password to the terminal. Do not print secrets; write it
   straight into `git-sync.env` (e.g. with `sed`) and tell the operator where it went.
3. If `loadConfig` reads a variable that `deploy/git-sync.env.example` does not document, add it
   there with a comment. The A1 oracle must keep passing.

## Driver gates (copy all into your ledger, exactly)

    - [ ] G1: A2 ingress, queues, GitHub App and wiring pass the driver oracle
      CHECK: node scripts/verify-a2-ingress.mjs
      EXPECT: A2 ingress verification passed
      EVIDENCE: pending

    - [ ] G2: A3 migrations and ledgers pass the driver oracle
      CHECK: node scripts/verify-a3-schema.mjs
      EXPECT: A3 schema verification passed
      EVIDENCE: pending

    - [ ] G3: A1 behaviour did not regress
      CHECK: node scripts/verify-a1-deploy.mjs
      EXPECT: A1 deploy verification passed
      EVIDENCE: pending

    - [ ] G4: own tests run, at least 30 passing, none skipped
      CHECK: node scripts/run-tests.mjs 30 tests/api tests/queue tests/db tests/deploy
      EXPECT: tests passed
      EVIDENCE: pending

    - [ ] G5: typecheck clean
      CHECK: node scripts/typecheck.mjs "src/index.ts" "src/api/**/*.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "src/config/**/*.ts" "tests/api/**/*.ts" "tests/queue/**/*.ts" "tests/db/**/*.ts" "tests/deploy/**/*.ts"
      EXPECT: typecheck passed
      EVIDENCE: pending

    - [ ] G6: no stubs or placeholders
      CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/api src/queue src/db src/config tests/api tests/queue tests/db
      EXPECT: stub scan passed
      EVIDENCE: pending

Read `scripts/verify-a2-ingress.mjs` and `scripts/verify-a3-schema.mjs` in full first: they pin
the contract.

## New dependencies (installed by the driver — do not touch package.json)

`bullmq@6.3.12` (bundles its own Redis client; `connection: { url }`), `@octokit/app@16.1.4`,
`@octokit/webhooks@14.2.0`, `pg@8.23.1`; dev: `@electric-sql/pglite@0.5.8` (a real Postgres
engine compiled to WASM — use it for every DB test), `@types/pg`.

A real **Valkey 7.2.11** (same as the live host) is built at `~/.cache/gitsync/bin/valkey-server`.
Tests that need Valkey start a throwaway one with `import { startValkey } from "../../scripts/lib/valkey.mjs"`
(read-only use of a driver script is fine) and stop it afterwards.

---

## Task A2 — ingress, queues, GitHub App (spec §4, §3, §1.2)

**The request path does three things only: verify, enqueue, return 200** (§4). No parsing beyond
JSON, no DB access, no business logic in the handler.

Plane signs exactly like this (read from Plane v1.4.2 `apps/api/plane/bgtasks/webhook_task.py`):

```python
signature = hmac.new(secret.encode("utf-8"), json.dumps(payload).encode("utf-8"), hashlib.sha256).hexdigest()
headers["X-Plane-Signature"] = signature          # bare hex, no "sha256=" prefix
requests.post(url, json=payload, headers=headers) # body bytes == json.dumps(payload)
```

So verify the HMAC over the **raw request bytes** — never re-serialise parsed JSON — and compare
with `crypto.timingSafeEqual` (guard unequal lengths first). Headers: `X-Plane-Delivery` (uuid),
`X-Plane-Event` ∈ {`project`, `issue`, `module`, `module_issue`, `cycle`, `cycle_issue`,
`issue_comment`} (§1.3). GitHub signs `X-Hub-Signature-256: sha256=<hex>`; verify with
`@octokit/webhooks` (`verify` from `@octokit/webhooks-methods`, or a `Webhooks` instance) and read
`X-GitHub-Delivery`, `X-GitHub-Event`.

Files and exact contract:

```ts
// src/queue/index.ts
export const QUEUE_NAMES = { inboundGithub: "inbound-github", inboundPlane: "inbound-plane",
  outboundPlane: "outbound-plane", outboundGithub: "outbound-github" } as const;
// Spec §4 writes these as inbound:github etc. BullMQ 6 throws "Queue name cannot contain :",
// so ":" becomes "-"; the "gitsync" prefix (§3) supplies the namespace. Keep this comment.
export interface InboundJob { source: "github" | "plane"; deliveryId: string; event: string;
  receivedAt: string /* ISO */; payload: unknown }
export interface Queues { inboundGithub: Queue<InboundJob>; inboundPlane: Queue<InboundJob>;
  outboundPlane: Queue; outboundGithub: Queue;
  enqueueInbound(job: InboundJob): Promise<void>;   // routes by job.source; jobId `${source}-${deliveryId}`
  close(): Promise<void> }
export function createQueues(opts: { connectionUrl: string; prefix: string }): Queues;

// src/api/handler.ts
export interface WebhookDeps { planeSecret: string; githubSecret: string;
  enqueue(job: InboundJob): Promise<void>; maxBodyBytes?: number /* default 25 MiB, GitHub's cap */ }
export function createWebhookRoutes(deps: WebhookDeps): Route[];   // Route from src/index.ts

// src/api/github-app.ts
export function createGithubApp(opts: { appId: number | string; privateKey: string; baseUrl?: string }):
  { installationOctokit(installationId: number): Promise<Octokit> };   // @octokit/app; GHE via baseUrl (§8)

// src/config/env.ts
export function loadConfig(env: NodeJS.ProcessEnv): Config;   // every var from deploy/git-sync.env.example
```

Status codes: 200 enqueued (body `{"queued":true}`); 200 without enqueue for GitHub `ping` and for
Plane events outside the catalog (`{"ignored":true}`); 400 missing delivery/event header or invalid
JSON after a valid signature; 401 missing/invalid signature (check the signature **before** parsing);
413 over `maxBodyBytes` (stop reading — do not buffer an unbounded body); 503 when enqueue throws,
so the sender retries. Job ids make a redelivered webhook a BullMQ no-op while the job is retained;
the durable delivery-id ledger (A3) is consumed by A4, not here.

`src/index.ts` main: `loadConfig(process.env)` → refuse to start (exit non-zero, message names
every missing variable, never prints values) when `PLANE_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET`
or `REDIS_URL` is missing; create queues, register the webhook routes, start; on SIGTERM close the
server **then** the queues, exit 0. Read the GitHub App key from `GITHUB_PRIVATE_KEY_PATH`. Do not
connect to Postgres at startup yet — A4 does that. Never log request bodies, headers carrying
signatures, or any secret.

## Task A3 — schemas and ledgers (spec §5, §1.3, §7.6, §8, §9)

```ts
// src/db/migrate.ts
export interface Db { query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
                      exec(sql: string): Promise<unknown> }       // PGlite satisfies this directly
export function migrate(db: Db): Promise<{ applied: string[] }>;  // reads src/db/migrations/*.sql in order,
  // records each in schema_migrations, each file applied in one transaction, re-run applies nothing
// src/db/client.ts — createDb(databaseUrl): Db & { close(): Promise<void> } over a pg Pool
// src/db/schema.ts — row types and table-name constants
// src/db/ledgers.ts — the data access later tasks call (exact names; the oracle calls them):
recordDelivery(db, source: "plane" | "github", deliveryId: string): Promise<boolean>     // true = first time
claimCommit(db, sha: string, repoId: number): Promise<boolean>                           // keyed on SHA ALONE (§5)
recordAppliedOps(db, ops: { opHash: string; direction: "to_plane" | "to_github" }[]): Promise<void>
consumeRecentOp(db, opHash: string, ttlMinutes: number): Promise<boolean>   // deletes ONE matching row within TTL
pruneAppliedOps(db, olderThanMinutes: number): Promise<number>
upsertSyncLink(db, link: { planeWorkspaceSlug, planeProjectId, planeIssueId, ghRepoId, ghNumber,
  ghKind: "issue" | "pr", tier: "closing" | "non_closing" | "relation",
  createdBy: "magic_word" | "branch" | "label_sync" | "manual" }): Promise<string | number>   // id; idempotent
listActiveSyncLinks(db, opts: { limit: number; afterId?: string | number }): Promise<SyncLinkRow[]>
markLinkOrphaned(db, id): Promise<void>                    // status 'orphaned' + orphaned_at; never deletes (§1.3)
appendAudit(db, entry: { kind, source?, deliveryId?, detail?, outcome, error?, replayOf? }): Promise<string | number>
// src/db/token-store.ts — export class PgTokenStore implements TokenStore (import the type from src/auth/identity.ts)
```

Why consume-once: a write of N fields produces N Plane echoes, each matching exactly one recorded
op (§5). Consuming the matched row means a later, genuine human edit to the same value is **not**
dropped as an echo — dropping on ingress must never swallow legitimate repeat edits (HANDOFF.md
pitfall 2). Never hash whole objects (pitfall 1): `applied_ops` stores only the hash, a direction
and a timestamp.

Tables (all in `src/db/migrations/001-init.sql`; the oracle checks these names):
- `sync_links` (§5 columns, `tier`/`created_by`/`gh_kind` CHECKs, `status` `active|orphaned`,
  `orphaned_at`, `last_checked_at`, unique on the Plane-issue + GitHub-object identity)
- `applied_ops` (`op_hash`, `direction` CHECK `to_plane|to_github`, `created_at`, index for the
  TTL lookup), `webhook_deliveries` (PK source + delivery id), `processed_commits` (PK sha)
- `audit_log` (§7.6: inbound deliveries, rule matches, outbound calls and results, identity
  fallbacks; `replay_of` FK to `audit_log(id)`; `detail jsonb`; indexes for listing by time)
- configuration (§8): `github_app_config` (singleton; secrets stored encrypted via B9's
  `encryptSecret`, so text columns hold `v1:` blobs), `instance_settings` (singleton: smart-commits
  default for new repos, reconciliation interval, op TTL minutes), `magic_words` (tier + words, §6),
  `repo_mappings` (workspace slug, GitHub repo id/full name, Plane project id,
  `sync_direction` CHECK `bidirectional|github_to_plane`, per-repo smart-commits toggle,
  linkback toggle, autolinks toggle), `rule_sets` (mapping id, YAML source, version, updated_by,
  updated_at — the compiled §7.5 rules; state mappings compile into these, so no separate state
  evaluator table), `conflict_policies` (mapping id, field, `policy` CHECK
  `last_write_wins|source_of_truth:github|source_of_truth:plane`)
- identity (§9): `user_map` (plane user id ↔ github login + id, unique both ways per workspace),
  `user_tokens` (plane user id, kind CHECK `plane_pat|github_oauth`, ciphertext blob, PK user+kind)
