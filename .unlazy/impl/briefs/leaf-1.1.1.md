# Leaf brief: leaf-1.1.1 — A1 deployment + A6 rule engine (implementer A, wave 1)

Read `.unlazy/impl/briefs/COMMON.md` first. Its rules are part of this brief.

Your ledger: `docs/impl/agent-gates/leaf-1.1.1.GATES.md`

## OWNS

    docker-compose.override.yaml, Dockerfile, .dockerignore, deploy/**, src/index.ts,
    src/rules/**, tests/deploy/**, tests/rules/**, docs/impl/agent-gates/leaf-1.1.1.GATES.md

## Driver gates (copy all into your ledger, exactly)

    - [ ] G1: A1 deploy artifacts and service entry pass the driver oracle
      CHECK: node scripts/verify-a1-deploy.mjs
      EXPECT: A1 deploy verification passed
      EVIDENCE: pending

    - [ ] G2: A6 satisfies the driver-held rule engine contract
      CHECK: node scripts/verify-rules-contract.mjs
      EXPECT: rules contract verification passed
      EVIDENCE: pending

    - [ ] G3: own tests run, at least 20 passing, none skipped
      CHECK: node scripts/run-tests.mjs 20 tests/rules tests/deploy
      EXPECT: tests passed
      EVIDENCE: pending

    - [ ] G4: typecheck clean
      CHECK: node scripts/typecheck.mjs "src/index.ts" "src/rules/**/*.ts" "tests/rules/**/*.ts" "tests/deploy/**/*.ts"
      EXPECT: typecheck passed
      EVIDENCE: pending

    - [ ] G5: no stubs or placeholders
      CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/rules deploy Dockerfile docker-compose.override.yaml tests/rules tests/deploy
      EXPECT: stub scan passed
      EVIDENCE: pending

Read `scripts/verify-a1-deploy.mjs` and `scripts/verify-rules-contract.mjs` in full before you
start: they are the acceptance tests and pin details this brief summarises.

---

## Task A1 — deployment (spec §3, §1.1)

There is **no SSH access to the live host** from here. Write the artifacts as files a human
applies; do not pretend anything was deployed.

Facts about the live host (`/root/plane`): Plane v1.4.2 Community compose — services `web`,
`space`, `admin`, `live`, `api`, `worker`, `beat-worker`, `migrator`, `plane-db` (Postgres 15.7),
`plane-redis` (Valkey 7.2.11), `plane-mq`, `plane-minio`, `proxy`. The upstream file is saved at
`scripts/fixtures/plane-compose.v1.4.2.yml`. Host Caddy at `/root/caddy` reaches `plane-proxy:80`
over an external docker network named `gateway`. `/root/plane/docker-compose.override.yaml`
**already exists** with unknown contents — never tell anyone to replace it.

Deliverables:

1. **`docker-compose.override.yaml`** — a fragment to merge into the existing override:
   - service `git-sync`: `image: ${GITSYNC_IMAGE:-git-sync:local}` (no build context — the host
     builds the image from a checkout of this repo), networks `default` and `gateway` (alias
     `git-sync` on `gateway`), **no published host ports**, `restart: unless-stopped`,
     `depends_on` `plane-db` and `plane-redis`, a healthcheck hitting
     `http://127.0.0.1:3100/git-sync/healthz` using `node -e` (the image has no curl/wget),
     environment from `env_file` with `required: false` pointing at `git-sync.env`.
   - `admin` image → `${GITSYNC_ADMIN_IMAGE:-plane-admin-gitsync:v1.4.2}` and `web` image →
     `${GITSYNC_WEB_IMAGE:-plane-frontend-gitsync:v1.4.2}` (the fork images Part B's build
     scripts produce; see B1/B2).
   - top-level `networks: gateway: external: true`.
2. **`deploy/caddy/Caddyfile`** — the `tasks.qelal.et` site block exactly as spec §3 shows, the
   `handle /git-sync/*` route before the `reverse_proxy plane-proxy:80` catch-all. Do not strip
   the prefix: the service serves everything under `/git-sync/`.
3. **`Dockerfile`** + **`.dockerignore`** — `FROM node:24-alpine` (or `node:24-slim`),
   `npm ci --omit=dev`, copy `src/`, run as the non-root `node` user, `EXPOSE 3100`,
   `CMD ["node", "src/index.ts"]`. `.dockerignore` excludes at least `node_modules`, `.git`,
   `.unlazy`, `docs`, `tests`, `apps`, `packages`.
4. **`deploy/git-sync.env.example`** — every variable the service will read, each with a comment.
   Required names (later tasks depend on them): `PORT=3100`, `DATABASE_URL` (targets database
   `gitsync` on `plane-db`), `REDIS_URL` (`plane-redis`), `QUEUE_PREFIX=gitsync`,
   `PLANE_BASE_URL` (internal `http://api:8000` — say why internal), `PLANE_SERVICE_PAT`,
   `PLANE_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`,
   `GITSYNC_TOKEN_KEY` (32 random bytes base64; show the generating command).
5. **`deploy/sql/000-create-database.sql`** — idempotent-as-possible creation of role
   `gitsync` and database `gitsync` owned by it (Postgres has no `CREATE DATABASE IF NOT EXISTS`;
   use the `\gexec` pattern for psql). Plane's existing database is already initialised, so
   docker-entrypoint init scripts will not run — this is applied by hand.
6. **`deploy/APPLY.md`** — an ordered runbook for a human on `convpss`: back up the existing
   override and Caddyfile; build `git-sync:local` with `docker build`; create the DB with the SQL
   file via `docker compose exec plane-db psql`; create `/root/plane/git-sync.env` from the
   example; merge the fragment (by hand, showing the result shape); add the Caddy route and
   reload Caddy; register the two webhook URLs from spec §3; the `API_KEY_RATE_LIMIT` decision
   (currently `60/minute` in `plane.env`, an open decision — present the trade-off, do not
   decide); verification commands; rollback. State plainly that the fork image tags must exist
   before the `admin`/`web` image overrides are applied, or those services fail to start.
7. **`src/index.ts`** — the HTTP entry point, `node:http` only. Exports, exactly:

   ```ts
   export const DEFAULT_PORT = 3100;
   export const BASE_PATH = "/git-sync";
   export const WEBHOOK_PATHS = { plane: "/git-sync/webhooks/plane", github: "/git-sync/webhooks/github" } as const;
   export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
   export interface Route { method: string; path: string; handler: RouteHandler }
   export interface StartOptions { port?: number; host?: string; routes?: Route[] }
   export interface RunningServer { port: number; close(): Promise<void> }
   export function startServer(opts?: StartOptions): Promise<RunningServer>;
   ```

   Built-in `GET /git-sync/healthz` → `200 {"status":"ok"}`. Registered routes match exact
   path + method; a known path with the wrong method → `405` with an `Allow` header; anything
   else → `404`. A handler that throws → `500` with a generic body, error logged (never log
   request bodies — they carry secrets in later tasks). When run as the main module
   (`import.meta.main`), start on `PORT` env or `DEFAULT_PORT`, bind `HOST` env or `0.0.0.0`,
   log one startup line, and on `SIGTERM`/`SIGINT` close the server and exit 0. Importing the
   module must not start a server. Task A2 will later register the webhook handlers through
   `routes`; do not implement webhook handling here.
8. **`tests/deploy/*.test.ts`** — tests for `src/index.ts` (routing, 404/405/500, health,
   close releases the port).

## Task A6 — rule engine (spec §7.5, §7.1)

One engine. The lifecycle→state mapping table (B5, later) compiles *into* these rules; do not
build any second evaluator. The engine never performs I/O: it returns actions, and an injected
executor performs them.

Files: `src/rules/types.ts`, `src/rules/engine.ts` (more modules under `src/rules/` are fine).
Public contract — `scripts/verify-rules-contract.mjs` imports `src/rules/engine.ts` and checks it:

```ts
export type Action =
  | { type: "set_state"; state: string }
  | { type: "add_label"; label: string }
  | { type: "remove_label"; label: string }
  | { type: "assign"; assignee: string }
  | { type: "comment"; body: string }
  | { type: "add_link"; url: string; title: string }
  | { type: "log_time"; duration: string }          // raw Jira duration, e.g. "1w 2d 4h 30m"
  | { type: "create_issue"; project: string; title: string };

export interface RuleConditions {
  base_branch?: string; head_branch?: string;      // regex source, tested with RegExp.test
  labels_any?: string[]; labels_all?: string[];    // exact, case-sensitive
  author?: string | string[]; repo?: string | string[];   // case-insensitive equality
  project?: string | string[];                     // Plane project identifier, exact
}
export interface Rule { name?: string; when: string[]; if: RuleConditions; then: Action[] }
export interface RuleEvent {
  trigger: string; repo?: string; base_branch?: string; head_branch?: string;
  labels?: string[]; author?: string; project?: string;
  context?: Record<string, unknown>;               // template variables
}
export interface Evaluation { matched: { index: number; rule: Rule } | null; actions: Action[] }
export interface ActionExecutor { execute(action: Action, event: RuleEvent): Promise<unknown> }
export interface RunResult { evaluation: Evaluation; executed: Action[]; dryRun: boolean }

export function parseRules(source: string): Rule[];                // YAML text → validated rules
export function evaluate(rules: Rule[], event: RuleEvent): Evaluation;   // pure
export function run(rules: Rule[], event: RuleEvent, executor: ActionExecutor,
                    opts: { dryRun: boolean }): Promise<RunResult>;
```

Semantics:
- YAML shape is the spec §7.5 example: a list of `{ when, if?, then }`. `when` is a string or a
  list. Each `then` entry is a single-key map (`set_state: X`, `add_link: {url, title}`,
  `create_issue: {project, title}`, `log_time: "2h"`, ...).
- Trigger vocabulary: `pull_request.<lifecycle>` for each §7.1 lifecycle point (`drafted`,
  `opened`, `review_requested`, `changes_requested`, `approved`, `ready_for_merge`, `merged`,
  `closed_unmerged`, `reopened`), plus `push`, `commit.pushed_to_default`, and the families
  `check_suite.*`, `deployment_status.*`, `issue.*`, `comment.*`, `pull_request.*`. A family
  glob in a rule matches any event trigger `family.<word>`; a concrete family member such as
  `deployment_status.success` is accepted for the four open families. Anything else is rejected.
- A condition the event cannot satisfy (e.g. `base_branch` set, event has none) does not match.
  All present conditions must hold.
- **First match wins**: the first rule whose `when` and `if` match supplies all actions; later
  rules contribute nothing. `matched.index` is its position.
- Templates: `{{a.b.c}}` in any string action field resolves from `event.context`. An unresolved
  variable is a loud error (throw), never an empty string — §7.2 requires loud failure so the
  audit log can record it.
- `parseRules` fails loudly (throw an Error whose message names the rule index and the problem)
  on: input that is not a list, missing `when`, unknown trigger, unknown condition key, invalid
  regex, unknown action, an action map with more than one key, empty `then`, wrong value types.
- `evaluate` never mutates its inputs. Compile regexes once at parse time if you like, but the
  returned `Rule` objects must still `JSON.stringify` to the same value before and after.
- `run` with `dryRun: true` calls the executor **zero** times and returns `executed: []`; with
  `dryRun: false` it executes the matched actions sequentially in order and propagates an
  executor error (no swallowing). This is the no-write mode B8's dry-run needs.

Tests in `tests/rules/` should cover far more than the driver oracle: every action kind, every
condition, glob edge cases, every parse error class, template edge cases, ordering.
