# Round 4 gate run

Heavy checks were run sequentially through `sh scripts/heavy.sh`. The whole-suite runner used its built-in bounded worker and heap settings. No product code was changed.

- verify-a1-deploy: FAIL — oracle service fixture omits required `PLANE_SERVICE_USER_ID`.
- verify-rules-contract: PASS
- verify-identity-contract: PASS
- verify-a3-schema: PASS
- verify-a2-ingress: FAIL — service fixture omits required `PLANE_SERVICE_USER_ID`; cleanup then waits on the exited child.
- verify-a4-writepath: PASS
- verify-b3-config-api: PASS
- verify-a5-a7: PASS
- verify-b4-b8: PASS
- verify-wiring: FAIL — its mapping fixture lacks the workspace installation allow-list row, so the later push is rejected.
- verify-fork-patch (all): PASS
- whole suite: FAIL — two stale fixtures/expectations in `tests/a8/echo-loop.test.ts` and `tests/a8/fixes-r2.test.ts`.
- typecheck: PASS — 131 project files.
- stub scan: PASS — 138 files.

## Failures

### verify-a1-deploy

Command: `sh scripts/heavy.sh node scripts/verify-a1-deploy.mjs`

Key error: `service never answered ... Missing required environment variables: PLANE_SERVICE_USER_ID`.

Root cause: the driver-owned service fixture does not set the newly required service user id. The config requirement is at `src/config/env.ts:41` and `:59-64`; the fixture is at `scripts/verify-a1-deploy.mjs:150-152`.

Suggested fix: set `PLANE_SERVICE_USER_ID` in `svcEnv`. Owner: **driver** (oracle).

### verify-a2-ingress

Command: `sh scripts/heavy.sh node scripts/verify-a2-ingress.mjs`

Key errors: `wired service starts from env ... timed out after 60000ms`; the test log shows the other ingress checks passing.

Root cause: `scripts/verify-a2-ingress.mjs:212` omits `PLANE_SERVICE_USER_ID`, so the child exits during config validation. Its `finally` at `:228` then waits for an `exit` event that has already fired, turning the immediate startup error into a timeout.

Suggested fix: provide `PLANE_SERVICE_USER_ID` in the fixture and make cleanup handle a child that already exited. Owner: **driver** (oracle).

### verify-wiring

Command: `sh scripts/heavy.sh node scripts/verify-wiring.mjs`

Key error: `no Smart Commit comment; Plane saw []`.

Root cause: diagnostic rerun showed audit outcomes `installation_not_allowed` and then `push / unmapped_repo` for repo 555 and installation 1. The fixture inserts the mapping at `scripts/verify-wiring.mjs:94` but does not insert the matching `(installation_id=1, workspace_slug='qelal')` row in `workspace_installations`. After the PR delivery remembers installation 1, the allow-list check in `src/app/mappings.ts:34-46` excludes the mapping on the push.

Suggested fix: seed the matching workspace installation before delivering the events. Owner: **driver** (oracle).

### Whole suite — F10 API assignee echo

Commands: `sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests`; diagnostic rerun: `sh scripts/heavy.sh env NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/a8/echo-loop.test.ts tests/a8/fixes-r2.test.ts`.

Key error: at `tests/a8/echo-loop.test.ts:189`, expected `{ assignees: [user] }`, actual `{ assignees: [] }`.

Root cause: the fixture inserts GitHub id `10` at `tests/a8/echo-loop.test.ts:186`, while the `ghIssue` helper supplies sender id `1`. The F5 mapping now resolves by GitHub id, so the fixture's login-only match is intentionally ignored.

Suggested fix: make the fixture's `gh_id` match the event's sender id (or make the event use the seeded id), keeping the assertion intact. Owner: **CC** (previous F5 owner; this test file is outside CC's declared round-4 ownership and needs driver assignment).

### Whole suite — F6 delivery scope

Commands: same whole-suite command and diagnostic rerun above.

Key error: at `tests/a8/fixes-r2.test.ts:25`, expected scopes omit `transportDeliveryId`; actual scopes include `transportDeliveryId: 'scope-plane'`, `'scope-uuid'`, and `'scope-github'`.

Root cause: the expected objects predate the driver-added transport identity in `src/app/reducers.ts:31-35`, which lets replay distinguish transport identity from write identity.

Suggested fix: update the expected scope objects to include the transport ids, or assert only the fields this test is intended to cover. Owner: **driver** (scope change and fixture are outside the round-4 agent ownership table).

## Counts

10 pass, 4 fail across 14 gates. The whole-suite runner reported two failing tests and exited 1; it does not print the total passing-test count on failure. The targeted rerun confirmed 36 pass and 2 fail across the two affected files.
