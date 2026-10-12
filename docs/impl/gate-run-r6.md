# Full gate run after round 6

Tested committed HEAD `0390a494cd6d51d9a0cf7cb8dcbb861e2fa6b925` on 2026-10-12.
All prescribed gates ran once, in the brief's order. Heavy commands ran sequentially through
`sh scripts/heavy.sh`; typecheck and stub scan used their prescribed direct commands.

**Primary run: 12 pass, 2 fail across 14 gates.** Wiring passed its single diagnostic retry,
so its initial failure is reported as flaky and remains counted as a failed primary gate.
The suite's three failures reproduced in one focused diagnostic run.

- verify-a1-deploy: PASS
- verify-rules-contract: PASS
- verify-identity-contract: PASS
- verify-a3-schema: PASS
- verify-a2-ingress: PASS
- verify-a4-writepath: PASS
- verify-b3-config-api: PASS
- verify-a5-a7: PASS
- verify-b4-b8: PASS
- verify-wiring: FAIL — flaky oracle readiness race: fixture inserts into migration-006's table after waiting only for migration-001's table; retry passed.
- verify-fork-patch all: PASS
- whole suite: FAIL — three stale expectations concerning verified installation snapshots, same-workspace multi-project ownership, and implicit PR workflow repair.
- typecheck: PASS
- stub scan: PASS

## Failures

### Wiring oracle — flaky migration-readiness fixture

Command: `sh scripts/heavy.sh node scripts/verify-wiring.mjs` (first run exit 1).
Original log: `$HOME/.cache/gitsync-gates/verify-wiring.log`.

Key errors:

```text
FAIL: a PR opened with 'Fixes QLL-1' links the item, moves it to In Progress through A4, and adds a PR rollup link: relation "workspace_installations" does not exist
FAIL: Plane's echo of that write is dropped on ingress and causes no further writes: echo was not recognised
FAIL: a Smart Commit pushed by an unmapped sender comments as the service, ignoring the forged author (§7.2): no Smart Commit comment; Plane saw []
```

Root cause: **oracle readiness race**, not demonstrated PR/echo/Smart Commit product failure.
`scripts/verify-wiring.mjs:86` waits only for `public.repo_mappings`, created by
`src/db/migrations/001-init.sql:50`. It then seeds `workspace_installations` at
`scripts/verify-wiring.mjs:95`, but that table is created by
`src/db/migrations/006-workspace-installations.sql:3`. The server begins listening before
background migrations (`src/app/main.ts:144`, `:154`), and each migration commits separately
(`src/db/migrate.ts:40`); seeing the first table does not establish full schema readiness.
The failed allow-list insert prevents mapping/rule setup and the PR write, so the later echo
and Smart Commit checks fail without their prerequisite effects.

Suggested fix: make this oracle wait for the complete migration inventory, including migration
008, before seeding fixtures; retain all actual webhook/write/echo assertions. Do not use the
HTTP liveness endpoint or one early table as proof of migration completion.

Owner: **driver** (`scripts/` oracles are driver-owned).

Single retry: the same command, still through `heavy.sh`, redirected to
`$HOME/.cache/gitsync-gates/verify-wiring-r6-retry.log`, exited **0**. The successful retry log
was not read, following the brief's failed-log-only rule. Outcomes are **FAIL then PASS**;
this gate is flaky, not a clean first-run pass.

### Whole suite — installation-lookup fixture removes verified authority

Command: `sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests` (exit 1).

Key error, reproduced in the focused retry:

```text
F7: a transient installation-lookup failure fails the delivery (it retries); 'not installed' does not
Error [PlaneApiError]: A verified installation is required for outbound authority
at freezeMappingAuthority (src/app/mappings.ts:30)
at mappingWriterContext (src/app/issues.ts:16)
at handlePlaneIssue (src/app/issues.ts:231)
at TestContext.<anonymous> (tests/app/fixes-r3.test.ts:81)
```

Root cause: **stale fixture after round-6 frozen authority**. The test verifies and saves an
allowed installation at `tests/app/fixes-r3.test.ts:64`, then its query wrapper deliberately
changes every admitted mapping's hydrated installation ID to NULL at `:71`.
`mappingWriterContext` now freezes the verified mapping before the lookup classifier, and
`freezeMappingAuthority` correctly refuses the altered snapshot. The first broad rejection
check at `:79` can therefore pass for the wrong reason; the second delivery at `:81` throws
the same authority error instead of reaching its mocked 404 lookup.

Suggested fix: retain a verified mapping for full-reducer admission. Exercise transient and
permanent uncached lookup classification at the exported `planeInstallation` helper boundary
(`src/app/issues.ts:189`), as the repaired fixtures in `tests/github/review-r4-sc.test.ts:73`
and `:89` do. Assert the actual lookup/error and retain suppression/no-write assertions;
do not weaken frozen-authority validation to accommodate the artificial NULL snapshot.

Owner: **SA** for the mapping-verification/authority seam in the round-4 table; the test's
header also credits SA. Coordinate with **SC**, the round-4 owner of `src/app/issues.ts`
and its lookup classifier. This older test file has no explicit round-4 ownership row, so
the driver must assign its fixture edit.

### Whole suite — same-workspace projects still expected to be ambiguous

Command: `sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests` (exit 1).

Key error, reproduced in the focused retry:

```text
F3 seam: GitHub registration freezes only a unique authorized repo/installation workspace
AssertionError: 'ws' !== undefined
at TestContext.<anonymous> (tests/github/review-r5-cb.test.ts:236)
```

Root cause: **stale assertion after round-6 F3**. At
`tests/github/review-r5-cb.test.ts:233` the fixture adds another project mapping for the same
repository, installation and workspace. It still expects missing workspace authority at
`:236` and denied execution at `:238`. `src/operations/outbox.ts:185` now uses
`SELECT DISTINCT rm.workspace_slug`, so both mappings correctly establish workspace `ws`.
CB had already identified this driver fixture follow-up in `docs/impl/fixes-r6-CB.md:38`.

Suggested fix: assert persisted workspace `ws` and successful execution for the second
same-workspace project. Preserve the unknown-repository and unlisted-installation rejection
controls at `:239` and `:245`, and update the successful-effect count accordingly.

Owner: **CB**, round-4 owner of the outbox/registration seam. The driver must assign this
older regression file, which is outside the exact round-4 file row.

### Whole suite — PR edit still expected to revive a terminal create implicitly

Command: `sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests` (exit 1).

Key error, reproduced in the focused retry:

```text
F2: pr re-opt-in recovers a committed-but-unacknowledged POST using its original external_id
The error is expected to be an instance of "OrderedWriteDeferredError". Received "AssertionError"
Error message: a pending intent exists
at execute (tests/mirror/review-r5-cc.test.ts:45)
at TestContext.<anonymous> (tests/mirror/review-r5-cc.test.ts:140)
```

Root cause: **stale assertion after round-6 F5**. The fixture exhausts the create to terminal
failure at `tests/mirror/review-r5-cc.test.ts:132`, sends an ordinary edited PR event at
`:135`, then expects executable pending work at `:140`. The PR reducer now retains that
later event with `holdOnFailure: true` (`src/app/pr.ts:199`) and excludes its identifier from
fresh creation (`:245`). The outbox records the continuation as failed awaiting explicit
repair (`src/operations/outbox.ts:398`), preserving the failed original workflow. With no
pending intent, the test's executor correctly fails its own precondition before making a
recovery lookup. The mirror variant did not fail in the primary run.

Suggested fix: for the PR variant, first assert that the edit preserves the original failed
create, attempts and external ID and retains a held continuation without another POST.
Invoke explicit delivery replay or failed-write Retry before expecting pending recovery.
Keep the unavailable-lookup assertions and the final one-partner/original-external-ID checks.

Owner: **CC** for the mirror/recovery regression family; coordinate with **SC**, round-4
owner of PR reducer behavior, and **CB**, owner of outbox repair/held-plan semantics. The
driver must assign this later-round test file before edits.

## Diagnostic reruns and passing checks

After all prescribed gates finished, the wiring oracle was retried once. Then only the three
failing suite cases were rerun once, serially through the heavy wrapper:

```sh
NODE_OPTIONS=--max-old-space-size=1024 sh scripts/heavy.sh node --test --test-concurrency=1 --test-timeout=60000 --test-name-pattern='^F7: a transient installation|^F3 seam: GitHub registration|^F2: pr re-opt-in' tests/app/fixes-r3.test.ts tests/github/review-r5-cb.test.ts tests/mirror/review-r5-cc.test.ts
```

Diagnostic result: **0 pass, 3 fail, 0 cancelled, 0 skipped**, exit 1. All three errors
reproduced; no flaky result was observed among these test failures. The whole-suite wrapper
reported **3 failures and 0 cancellations** but does not print its passing count on failure;
no whole-suite passing count is claimed.

Passing direct commands:

```text
node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
typecheck passed (140 project files)

node scripts/verify-no-stubs.mjs src tests
stub scan passed (148 files)
```

Final HEAD remained `0390a494cd6d51d9a0cf7cb8dcbb861e2fa6b925`; no diff from HEAD existed
under `src/`, `tests/` or `scripts/` during the final inspection. Only this report and its
lightweight ledger were edited. No product/test/oracle fixes, staging, commits or pushes.
