# G1 automated end-to-end suite

S28–S52 are implemented in the five assigned `scripts/e2e/scenarios/04-dev.mjs` through `08-ui.mjs` files. The shared G1 helpers are exported from `04-dev.mjs`; importing the other groups registers that module once. No source, unit-test, harness or runner file was edited, and no local git staging, commit or push was performed.

Run one scenario with `node scripts/e2e/run.mjs --only S28`. To run all G1 scenarios sequentially, use:

```bash
for number in $(seq 28 52); do
  node scripts/e2e/run.mjs --only "S${number}"
done
```

The existing harness supplies credentials, browser sessions, Docker access and the test-environment guard. Targets are only `http://100.85.50.109:8090`, workspace `gitsync-test`, project `GITSY`, mapping 1 and `nathanabay/gitsync-test`. Use `--keep` only when intentionally retaining fixtures for investigation. Each invocation writes its own Markdown/JSON evidence under `docs/impl/e2e-runs/`.

Fixture names contain the run ID. Cleanup closes PRs/issues, deletes branches and Plane items, restores configuration, and removes the file merged by S32. GitHub fixture commits use the requested REST APIs, without local git operations. Negative assertions wait for the exact event/action or Smart Commit rejection and relevant outbox completion. Redelivery observes the actual backend duplicate-enqueue event for the exact original GUID, then checks unchanged comment/command receipts. S33 scopes its temporary lifecycle rule to its own branch. S49 removes only its own already-settled association to model a historical missing link before invoking the real backfill API. Reconciliation calls the deployed reducer and real Plane client with candidate-link enumeration restricted to the fixture item.

## Documentation used

All documentation was resolved with `npx ctx7@latest library` before `npx ctx7@latest docs`. Library IDs are attached to each API fact below. Project behavior (rules, link tiers, report markers, reducers and UI routes) is established from this repository and the recorded live scenario evidence, rather than inferred from provider documentation.

| API fact relied on | Context7 library ID | Indexed primary source |
|---|---|---|
| Git reference creation uses `ref: refs/heads/<branch>` and `sha`; reference deletion targets `heads/<branch>`; a ref read confirms presence/absence. | `/websites/github_en_rest` | [Git references](https://docs.github.com/en/rest/git/refs) |
| Creating fixture content uses `PUT /repos/{owner}/{repo}/contents/{path}` with `message`, Base64 `content`, and `branch`; replacement/deletion identifies the existing blob by `sha`. | `/websites/github_en_rest` | [Repository contents](https://docs.github.com/en/rest/repos/contents) |
| PR creation accepts `title`, `body`, `head`, `base`, `draft`; PATCH can edit title/body or close a PR. Merge uses PUT and can pin `sha`, `merge_method` and `commit_title`; the response confirms `merged`. | `/websites/github_en_rest` | [Pull requests](https://docs.github.com/en/rest/pulls/pulls) |
| Ready-for-review uses `markPullRequestReadyForReview` with `input.pullRequestId`; it is a GraphQL mutation rather than a REST `draft:false` edit. | `/websites/github_en` | [GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations) |
| A user commit status is POSTed at `/statuses/{sha}` with `state`, `context`, `description` and `target_url`; `success` is a valid state. | `/websites/github_en_rest` | [Commit statuses](https://docs.github.com/en/rest/commits/statuses) |
| PR discussion comments and commit comments have distinct list resources; list pagination is consumed before asserting exact counts. | `/websites/github_en_rest` | [Issue comments](https://docs.github.com/en/rest/issues/comments), [Commit comments](https://docs.github.com/en/rest/commits/comments) |
| App webhook delivery APIs require App JWT authentication; list supports `per_page`/`cursor`, exposes GUID/repository ID and an int64 delivery ID; POST `/{delivery_id}/attempts` accepts real redelivery with 202. | `/websites/github_en_rest` | [App webhooks](https://docs.github.com/en/rest/apps/webhooks) |
| Octokit custom requests use the configured client defaults and return a response containing `data`, `headers` and `status`. | `/octokit/rest.js` | [Custom requests](https://github.com/octokit/rest.js/blob/main/docs/src/pages/api/04_custom_requests.md), [Pagination response distinction](https://github.com/octokit/rest.js/blob/main/docs/src/pages/api/05_pagination.md) |
| Plane v1 work-item creation accepts `name` and `state`; comments use `/work-items/{id}/comments/` and cursor pagination with `results`, `next_cursor` and `next_page_results`. | `/makeplane/developer-docs` | [Create work item](https://github.com/makeplane/developer-docs/blob/master/docs/api-reference/issue/add-issue.md), [List comments](https://github.com/makeplane/developer-docs/blob/master/docs/api-reference/issue-comment/list-issue-comments.md) |
| Plane v1 project states are read from `/projects/{id}/states/` and expose `id`, `name` and `group`; scenarios resolve actual fixture states by these fields. | `/makeplane/developer-docs` | [List states](https://github.com/makeplane/developer-docs/blob/master/docs/api-reference/state/list-states.md) |
| Plane v1 work-item deletion uses DELETE and returns 204. | `/websites/developers_plane_so` | [Delete work item](https://developers.plane.so/api-reference/issue/delete-issue) |
| Django `QuerySet.update()` returns matched-row count and bypasses model save/signals. S48 asserts exactly one matched fixture row, deliberately reproducing the archive-without-activity failure mode. The test container reports Django 5.2.15. | `/django/django` | [QuerySet update](https://github.com/django/django/blob/main/docs/ref/models/querysets.txt) |
| Retained custom job IDs prevent BullMQ from adding a duplicate job. `QueueEvents` emits `duplicated({jobId}, streamId)` when that happens; its connection is closed after observation. | `/taskforcesh/bullmq`, `/websites/api_bullmq_io` | [Job IDs](https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/jobs/job-ids.md), [QueueEventsListener](https://api.docs.bullmq.io/interfaces/v5.QueueEventsListener.html) |
| Node's `Buffer.from(text).toString('base64')` supplies encoded fixture content; `path.join` builds screenshot paths and `existsSync` checks artifact presence. `createRequire('/app/package.json')` resolves BullMQ from the service's dependencies while the harness snippet lives in `/tmp`. | `/websites/nodejs_latest-v24_x_api` | [Buffer](https://nodejs.org/docs/latest-v24.x/api/buffer.json), [Path](https://nodejs.org/docs/latest-v24.x/api/path.json), [Filesystem](https://nodejs.org/docs/latest-v24.x/api/fs.json), [Modules](https://nodejs.org/docs/latest-v24.x/api/module.json) |

The unlazy skill tracks scenario coverage in `.unlazy/e2e-g1/GATES.md`. Cloudflare's security-audit guidance was applied to scope restrictions, secret handling, owned fixtures and bounded observations. This is the explicitly authorized test-environment E2E suite, not a new full security audit.

## Last results

**25 scenarios: 23 PASS / 2 FAIL / 0 SKIP.** Each was run individually; 35 invocations include authoring fixes and reruns. None was skipped.

| ID | Scenario | Last result | Evidence |
|---|---|---|---|
| S28 | Development panel data and rendered branch template | PASS | [2610131525-815e](e2e-runs/2610131525-815e.md), [JSON](e2e-runs/2610131525-815e.json) |
| S29 | Create branch from panel is real and idempotent | PASS | [2610131526-a83b](e2e-runs/2610131526-a83b.md), [JSON](e2e-runs/2610131526-a83b.json) |
| S30 | Pushed key branch links item and starts work | PASS | [2610131526-049a](e2e-runs/2610131526-049a.md), [JSON](e2e-runs/2610131526-049a.json) |
| S31 | Draft closing PR starts work with one linkback | PASS | [2610131527-cd5d](e2e-runs/2610131527-cd5d.md), [JSON](e2e-runs/2610131527-cd5d.json) |
| S32 | Ready draft then merge completes item and rollup | PASS | [2610131527-6467](e2e-runs/2610131527-6467.md), [JSON](e2e-runs/2610131527-6467.json) |
| S33 | Closed unmerged PR follows configured lifecycle rule | PASS | [2610131601-aef9](e2e-runs/2610131601-aef9.md), [JSON](e2e-runs/2610131601-aef9.json) |
| S34 | Ref KEY links without a state change | **FAIL** | [2610131602-b171](e2e-runs/2610131602-b171.md), [JSON](e2e-runs/2610131602-b171.json) |
| S35 | Skip and ignore override a closing reference | PASS | [2610131531-de1f](e2e-runs/2610131531-de1f.md), [JSON](e2e-runs/2610131531-de1f.json) |
| S36 | Project NEW directive creates exactly one linked item | PASS | [2610131532-6db7](e2e-runs/2610131532-6db7.md), [JSON](e2e-runs/2610131532-6db7.json) |
| S37 | User commit status produces CI rollup on linked item | **FAIL** | [2610131532-4ce7](e2e-runs/2610131532-4ce7.md), [JSON](e2e-runs/2610131532-4ce7.json) |
| S38 | Smart Commit comment is attributed and linked to commit | PASS | [2610131533-eeb8](e2e-runs/2610131533-eeb8.md), [JSON](e2e-runs/2610131533-eeb8.json) |
| S39 | Smart Commit done transition completes linked item | PASS | [2610131534-8747](e2e-runs/2610131534-8747.md), [JSON](e2e-runs/2610131534-8747.json) |
| S40 | Smart Commit executes once on real push redelivery | PASS | [2610131547-4944](e2e-runs/2610131547-4944.md), [JSON](e2e-runs/2610131547-4944.json) |
| S41 | Unknown Smart Commit transition is rejected and audited | PASS | [2610131540-94d7](e2e-runs/2610131540-94d7.md), [JSON](e2e-runs/2610131540-94d7.json) |
| S42 | Unknown PR key posts one bot problem report | PASS | [2610131602-d14f](e2e-runs/2610131602-d14f.md), [JSON](e2e-runs/2610131602-d14f.json) |
| S43 | Bad Smart Commit posts one commit problem report | PASS | [2610131546-711b](e2e-runs/2610131546-711b.md), [JSON](e2e-runs/2610131546-711b.json) |
| S44 | Changed PR problem report is edited in place | PASS | [2610131602-a074](e2e-runs/2610131602-a074.md), [JSON](e2e-runs/2610131602-a074.json) |
| S45 | Reports disabled suppress both PR and commit notices | PASS | [2610131543-b81e](e2e-runs/2610131543-b81e.md), [JSON](e2e-runs/2610131543-b81e.json) |
| S46 | Real issue-comment redelivery has no second mirror effect | PASS | [2610131548-69d2](e2e-runs/2610131548-69d2.md), [JSON](e2e-runs/2610131548-69d2.json) |
| S47 | Deleted item is orphaned on first sweep and GitHub remains untouched | PASS | [2610131549-1eb8](e2e-runs/2610131549-1eb8.md), [JSON](e2e-runs/2610131549-1eb8.json) |
| S48 | Archived mirror stays active across two sweeps | PASS | [2610131550-2544](e2e-runs/2610131550-2544.md), [JSON](e2e-runs/2610131550-2544.json) |
| S49 | Backfill restores an existing PR reference | PASS | [2610131550-2edd](e2e-runs/2610131550-2edd.md), [JSON](e2e-runs/2610131550-2edd.json) |
| S50 | God-mode GitHub Sync page and sidebar render | PASS | [2610131551-3d58](e2e-runs/2610131551-3d58.md), [JSON](e2e-runs/2610131551-3d58.json) |
| S51 | Workspace GitHub Sync settings render at full height | PASS | [2610131552-86c3](e2e-runs/2610131552-86c3.md), [JSON](e2e-runs/2610131552-86c3.json) |
| S52 | Development panel renders inside work-item sidebar | PASS | [2610131552-aaf7](e2e-runs/2610131552-aaf7.md), [JSON](e2e-runs/2610131552-aaf7.json) |

## Product failures recorded in the accepted run

- **S34 — `Ref KEY` is incorrectly stored as `closing`.** The accepted run linked the PR with tier `closing` and moved the item from Todo to In Progress. The tier is the E2E-4 defect: the reference scan treated the same key as both a magic-word reference and a bare closing reference, then selected the stronger tier. Advancement to In Progress on opening is correct under [spec §6](../superpowers/specs/2026-10-10-plane-github-sync-design.md); the brief's original unchanged-state expectation was mistaken and has now been corrected below. GitHub PR title/body API facts were verified through Context7 `/websites/github_en_rest`, [Pull requests](https://docs.github.com/en/rest/pulls/pulls); the project's tier semantics come from the spec.

- **S37 — a handled success status produces no CI rollup.** The user-token POST returned 201 (status ID `56239231087`), and audit row `357` records the exact status delivery for the PR head. The panel still had `builds: []` after the delivery, outbox completion and another 30 seconds of polling. At that run, [checks.ts](../../src/app/checks.ts) invoked readiness for a `status` event without writing a CI link; CI rollup creation belonged to the check-run/check-suite path. The expected rollup assertion remains. The status endpoint and its fields are verified by Context7 `/websites/github_en_rest`, [Commit statuses](https://docs.github.com/en/rest/commits/statuses).

Both are FAIL results, not dependency skips. E2E-1 now passes via the public toggle API (S42–S45); E2E-2 passes with `active` links, one recognized archive and zero orphans/errors in each sweep (S48).

## Authoring corrections and cleanup

S33 initially sent an unquoted run-marked YAML name; quoting it fixed the scenario, and its rerun passed. Redelivery initially assumed numeric delivery IDs and a second worker audit row. Live App IDs were observed as BigInt, so they now cross the harness as exact decimal strings. The test then observed the actual BullMQ duplicate event, matching retained-job behavior, while preserving the unchanged effects/receipts assertions. The observer resolves BullMQ from `/app/package.json` because harness snippets live in `/tmp`. S43 was strengthened to use an existing item and an actually unknown transition, requiring the report to name both. Fixture branch prefixes were changed from `e2e-<timestamp>` to `e2e_<timestamp>` so the branch itself does not introduce an unrelated `E2E` project reference. S33/S34/S42/S44 were rerun, and reports now explicitly reject that unrelated diagnostic. Earlier attempts remain in the run directory; the table uses the last result.

Cleanup verification covered all 35 G1 invocations: no cleanup errors, all three created GitHub mirror issues closed, and zero undeleted run-owned Plane items (including archived items). PR closure and branch deletion are checked by their cleanup handlers, and the merged S32 fixture file was removed. YAML and the report toggle were restored. No scenario requires manual execution or is unautomatable under the supplied harness.

## Browser artifacts

- S50: [screenshot](e2e-runs/2610131551-3d58/s50.png).
- S51: [screenshot](e2e-runs/2610131552-86c3/s51.png).
- S52: [screenshot](e2e-runs/2610131552-aaf7/s52.png).

Browser DOM checks included the git-sync iframes. S50 measured the admin frame at 1110 × 836 in a 900-pixel viewport. S51 measured its workspace frame at 900 × 772 in the same viewport and asserted its full height. S52 checked its own item URL, Development frame, Start work, mapped repository and Create branch. The screenshots were also inspected visually.

Coverage verification: all seven acceptance gates met, zero unmet/abandoned; the final registry check and syntax checks passed. Product outcomes remain 23 PASS / 2 FAIL / 0 SKIP.


## E2E-5 code fix — driver redeployment/rerun pending

The recorded payload in audit row 357 was read without making any GitHub or Plane request: root `sha`, `state: success`, `context: e2e/2610131532-4ce7/S37`, `target_url` equal to PR #19's existing link, and one branch object with `name` and `commit.sha`. It has no check-suite/check-run object or PR list. Context7 `/websites/github_en`, [status webhook reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads#status), documents the root status fields and the bounded branches list; branch membership cannot establish a current PR head.

[checks.ts](../../src/app/checks.ts) now resolves the SHA against the authenticated repository's current PRs and active links in the mapped workspace, reads the current combined commit status, and writes one `[CI] Commit statuses · pass/fail/pending` link per PR. [dev-info.ts](../../src/sync/dev-info.ts) converts the aggregate conservatively: zero statuses is pending, and malformed metadata fails rather than becoming green. The combined server state covers all current contexts even when the returned `statuses` array is paginated. Context7 `/websites/github_en_rest`, [commit statuses](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference).

The stable `commit-status:<repo>:<PR>` identity updates that link in place as contexts and states change. It uses the repository's commit permalink, preserving the existing PR rollup and avoiding a collision with the real payload's `target_url`; an arbitrary or null CI target URL is never promoted to a work-item href. Check-run aggregates retain their separate identity. Registration failures propagate for queue retry, and readiness is evaluated afterward through the existing path. Cloudflare security-audit guidance informed the current-head, repository/workspace and retry controls.

[Regression tests](../../tests/app/commit-status-rollup.test.ts) reproduce the recorded root payload through ingress/router/reducer and Plane's link writer, including an already-existing PR link. They cover in-place state/context updates, nullable/unsafe target URLs, stale-success versus a current failing aggregate beyond a partial response page, branch-independent association, stale/foreign PR heads, workspace isolation, malformed snapshots and registration errors. One initial fixture hit the harness's `label_sync` uniqueness rule; it was corrected to model ordinary multi-item PR references, preserving the workspace assertion.

| Affected unit file | Final result |
|---|---|
| `tests/app/commit-status-rollup.test.ts` | 8/8 PASS |
| `tests/app/ready-for-merge.test.ts` | 2/2 PASS |
| `tests/dev-info/dev-info.test.ts` | 13/13 PASS |
| `tests/github/audit-g2.test.ts` | 29/29 PASS |

Typecheck passed. All 52 affected unit tests passed, each file run sequentially with `sh scripts/heavy.sh timeout 300 env NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 <file>`. Source diff whitespace checks passed. No existing test expectations were weakened or changed. Only the two assigned source files, the new regression, this report and the skill ledger were edited; no staging, commit or push occurred. The E2E suite was not run for this fix, and the accepted historical table remains unchanged pending the driver's redeployment and S37 rerun.

## S34 specification correction — pending driver run

S34 now requires exactly one item/PR association with tier `non_closing`, without a duplicate closing association. Opening must move the item to `started:In Progress`. After a confirmed merged delivery, a `MERGED` rollup and settled outbound writes, the item must still be In Progress and must not be completed. The tier and uniqueness checks are repeated after merge.

S35 retains its skip/ignore assertions and adds a distinct `Relates to KEY` PR. It requires exactly one `relation` association and the original item state on both opening and merge, observing the processed lifecycle event, rollup and settled writes before each negative state assertion. Extending S35 preserves the harness's numeric scenario-ID contract and the existing 25 scenario IDs. Both new merge cases register cleanup of their merged fixture file before later assertions.

The merge helper polls GET `/repos/{owner}/{repo}/pulls/{pull_number}` for `mergeable: true`, then uses PUT `/repos/{owner}/{repo}/pulls/{pull_number}/merge` with pinned `sha`, `merge_method: merge` and `commit_title`. These provider facts were rechecked with `npx ctx7@latest library` then `docs`, library ID `/websites/github_en_rest`: [merge parameters](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request), [mergeability polling](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database#checking-mergeability-of-pull-requests). Workflow effects follow spec §6, rather than a GitHub API assumption.

Validation for this correction: `node --check scripts/e2e/scenarios/04-dev.mjs` passed; static inspection confirms S28–S37 remain registered once in this module. No scenario or unit test was run. The historical results table above remains unchanged; the driver will redeploy and execute the corrected scenarios. Only `04-dev.mjs` and this report were edited for the correction. No source/test file, staging, commit or push was touched.
