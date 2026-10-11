# Round 4 fixes — SC (F6, F7, F8, prev F18)

Tests: `tests/github/review-r4-sc.test.ts` (6 tests; all passed before the CC dependency below was added to `pr.ts`).

- **F6** `src/github/pr-automation.ts` `checkPrReadiness`: a 403/404 from the combined-status read returns not ready and calls `hooks.onUnavailable`; any other error propagates (the delivery retries). `src/app/pr.ts` `fireReadyForMerge` audits `readiness_unavailable`. Tests: "F6: a 403/404 …", "F6: fireReadyForMerge writes nothing …".
  NOT DONE (files not mine): add "Commit statuses: Read-only" and the `status` event to `docs/research/findings-github.md` and `deploy/APPLY.md`.
- **F7** `src/app/pr.ts` `handleForMapping`: the PR's active `pr` sync links in the mapping's project are added to `items`, de-duplicated. Test: "F7: an item created by -NEW … still moves when the PR later merges". The `-NEW` plan now uses `nextCreateGeneration` / `createPlanRoot` with `pendingMarker` (per CB/CC contract); `null` is audited and ignored; `inserted === false` is audited and the delivery's own rules cover the item via its stored link.
- **F8** `src/app/issues.ts`: `planeInstallation` returns 0 only for 404 or a non-rate-limited 403 (`retry-after` / `x-ratelimit-remaining: 0` rethrow). With installation 0 the GitHub writer is replaced by `notInstalledWriter`, which audits `github_not_installed` and registers/plans nothing. Tests: both F8 tests.
- **prev F18** `src/app/rules.ts` `runRules`: counts writes through the executor's writer; a matched rule with zero writes is audited `ignored`. Test: "prev F18 …".

- **F6 docs** `docs/research/findings-github.md:14`: added the "Commit statuses: Read-only" App permission (the `status` webhook event was already listed at line 33). `deploy/APPLY.md` lists neither App permissions nor events, so it has nothing to amend.
- **F7 plan call** (`src/app/pr.ts`): uses `nextCreateGeneration(db, objectKey)` / `createPlanRoot` (CC's exports, signatures as assumed) and passes both `pendingLink` and `pendingMarker`, as mirror does; without `pendingLink` the outbox gives each step its own target.

## Verification (typecheck + targeted, one file group at a time, concurrency 1)
- `tests/github/review-r4-sc.test.ts`: 6/6 pass.
- `tests/app/ready-for-merge.test.ts`: passes.
- My four source files typecheck clean. The only typecheck error left in the set is `tests/a8/harness.ts(118)` (`PLANE_SERVICE_USER_ID` type), which is a harness/CA issue; the harness diff in the tree now defaults it, so it may already be fixed.

## Open items for the driver (not SC's files)
1. `tests/app/pr-new-plan.test.ts` F1 fails (`createdIssueIds` 0 !== 1). The Plane `create_issue` intent errors with "Plane intent lookup returned an invalid or mismatched object": the outbox now does a pre-lookup `GET …/projects/{pid}/issues/` before a non-idempotent POST (CA/CB R4 F9), and the harness fake in `tests/a8/harness.ts` answers that GET with `{}`. The registration side (my `pr.ts`) is correct: sequence 1 `create_issue`, 2 `resume_reducer`, marker row present. The harness fake needs a list response (`{ results: [], next_cursor: null, next_page_results: false }`) for `GET …/issues/`.
2. `src/sync/mirror.ts` `inserted` type errors came from the in-progress `PlanWriter` change (CB/CC); not re-checked after CC's exports landed.
