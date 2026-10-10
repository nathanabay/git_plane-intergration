# Leaf brief: leaf-1.5.1 — A8 test suites + wiring the whole service (implementer A, wave 5)

Read `.unlazy/impl/briefs/COMMON.md` first. Your ledger: `docs/impl/agent-gates/leaf-1.5.1.GATES.md`.

## OWNS

    (see the correction below — the authoritative list is in the ledger)

Everything else is verified and read-only to you. If a verified module is wrong, report it —
do not edit it.

## Driver gates (copy into your ledger exactly)

    - [ ] G1: the whole service works end to end against fake Plane and GitHub
      CHECK: node scripts/verify-wiring.mjs
      EXPECT: end-to-end wiring verification passed
      EVIDENCE: pending

    - [ ] G2: every leaf oracle still passes against the wired tree
      CHECK: sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "all oracles passed"'
      EXPECT: all oracles passed
      EVIDENCE: pending

    - [ ] G3: the A8 suites run, at least 30 passing, none skipped (the live smoke test is excluded here)
      CHECK: node scripts/run-tests.mjs 30 tests/a8
      EXPECT: tests passed
      EVIDENCE: pending

    - [ ] G4: typecheck clean across the whole tree
      CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
      EXPECT: typecheck passed
      EVIDENCE: pending

    - [ ] G5: no stubs or placeholders
      CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/app src/config tests/a8
      EXPECT: stub scan passed
      EVIDENCE: pending

**Correction to the file list above:** put the A8 suites in `tests/a8/` —
`tests/a8/echo-loop.test.ts`, `grammar.test.ts`, `rule-engine.test.ts`, `security.test.ts`,
`idempotency.test.ts` — and the live smoke test at `tests/smoke/live-smoke.test.ts`. Your OWNS is
therefore `src/index.ts, src/app/**, src/sync/github.ts, src/db/**, src/config/**, deploy/git-sync.env.example, tests/a8/**,
tests/smoke/**, tests/deploy/**, docs/impl/agent-gates/leaf-1.5.1.GATES.md`.

Read `scripts/verify-wiring.mjs` in full first.

## Wiring (`src/index.ts` main, composition in `src/app/**`)

Compose every verified module into the running service. Keep `src/index.ts` importable without
side effects; put the composition in `src/app/` so it can be tested.
- Config: add `GITHUB_API_BASE_URL` (optional; GHE or tests — passed to `createGithubApp` as
  `baseUrl`), `PLANE_SERVICE_USER_ID` (optional, the actor pre-filter), `PUBLIC_ORIGIN` (default
  `https://tasks.qelal.et`, the config API's CSRF origin) — document each in
  `deploy/git-sync.env.example`.
- HTTP: webhook routes (A2), config API routes and UI routes (B3/B8: `createConfigRoutes`,
  `createUiRoutes` with the built `dist/ui`), health.
- `EventRouter` reducers, each looking up the repo mapping (`repo_mappings` by GitHub repo id or
  Plane project) and skipping unmapped repos with an audit row:
  - `pull_request`, `pull_request_review`: A5 `parseReferences` (branch, title, body) with the
    instance magic words → `resolveReferences` → `upsertSyncLink` (tier, `created_by`
    `magic_word` or `branch`) → B5 rules for the mapping's latest `rule_sets` version, run with
    `createRuleExecutor` over the closing/non-closing issues (relation links get no state change)
    → B7 PR rollup link on every linked issue. `{ID}-NEW` creates an item (§6) through A4.
  - `push`: B4 `processPush`; B7 commit/branch info where applicable.
  - `issues`, `issue_comment`: B6 `onGithubIssue`. Plane `issue` / `issue_comment`: B6 `onPlaneIssue`.
  - `check_suite`, `check_run`, `deployment_status`: B7 rollups and preview detection.
  - Unmatched events: audited as `unhandled`.
- Workers (A4), maintenance (A7) with an `onOrphan` that comments on the GitHub side when the
  mapping's linkback toggle is on (§1.3), and the reconciliation interval from settings.
- Startup order: HTTP up first (ingress must work while the DB is down), DB migrate with retry,
  then workers and maintenance. SIGTERM: HTTP, workers, maintenance, queues, DB; exit 0.
- Per-user attribution (§9): where a reducer acts for a GitHub sender, use B9 `resolveActor` and
  the vault's PAT when mapped; otherwise the service PAT, audited.

## A8 suites (spec §10)

- **Echo loop** (the one that earns its keep): feed a Plane event, capture the GitHub write,
  synthesise the GitHub webhook that write produces, assert it is dropped; then the reverse.
- **Fixture-driven reducer tests**: recorded-shape payloads for every handled GitHub and Plane
  event through the composed reducers, asserting the exact outbound calls (fakes, no network).
- **Idempotency**: same delivery id twice → one effect; same commit SHA via two branches and
  again after a rebase (same SHA) → one effect.
- **Grammar**: Smart Commit parsing across multi-key, multi-command, hyphenated transitions,
  malformed input.
- **Security**: a commit with a forged `--author` (and `pusher`) must not act as that user.
- **Live smoke test** (`tests/smoke/live-smoke.test.ts`): a definition that runs only when
  `SMOKE_PLANE_URL`, `SMOKE_PLANE_PAT`, `SMOKE_WORKSPACE`, `SMOKE_PROJECT` are set (skips cleanly
  otherwise, and is excluded from G3). It must work against a throwaway project; the driver will
  run it against the local test Plane at `http://127.0.0.1:8090`.

## Gaps carried from wave 4 (do these too)

1. **A4 has no way to remove a GitHub assignee**, so Plane→GitHub assignee sync (§7.3) can only add.
   Add `{ kind: "remove_assignees", …, assignees: string[] }` to `GithubWrite` in
   `src/sync/github.ts` (`DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees`), recording
   `assignee:<login>` = `false` exactly as `githubFieldChanges` reports `unassigned`; keep the A4
   oracle passing. Then use it from the wiring so B6's mirror can remove assignees (B6's
   `onPlaneIssue` takes its GitHub writer as a dependency — pass the real one).
2. **Mirror duplicate-create race.** Two simultaneous `labeled` events for one GitHub issue can both
   create a Plane item. Add `src/db/migrations/003-*.sql` with a partial unique index on
   `sync_links (gh_repo_id, gh_number, gh_kind) WHERE created_by = 'label_sync'` and make
   `upsertSyncLink` callers tolerate the conflict (the loser must not create a second item — create
   only after winning the insert, or check the constraint error and stop).
3. **Replay and backfill answer 503 until wired.** `createConfigRoutes` takes an optional
   `operations: { enqueue, githubFor, resolveIssue }`; pass real ones (A2's `enqueueInbound`, an
   installation Octokit for the mapping's repo, A5's identifier resolution).
