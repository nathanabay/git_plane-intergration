# Fix pass G3: G6, G10, P3

Files changed: `src/sync/mirror.ts`, `src/app/issues.ts`, `src/app/pr.ts`. `src/app/rules.ts` needed no change.
Regression tests: `tests/mirror/audit-g3.test.ts` (not run, per the round's rules; typecheck only).
Context7 used: `/websites/developers_plane_so` (work-item retrieve), `/websites/github_en_rest` (list reviews is
chronological and paginated; get an issue).

## Shared approach (G10 and P3)

Neither GitHub nor Plane delivers webhooks in occurrence order, and a Plane retry resends the snapshot it took when the
change was queued. Snapshot-driven fields therefore mirror the partner's **current** value when the current read is at
least as new as the delivery:

- `freshest(delivered, current)` (`src/sync/mirror.ts:208`) compares the `updated_at` stamps both services put on the
  object. A newer (or equal) read wins. Fields the read omits keep the delivered value. With an older read, an unstamped
  read or no read, the delivery is used as before.
- A read that fails (5xx, rate limit) throws, so the delivery is retried and never applies a snapshot that may be stale.
  A gone object (404) returns null, and the delivery is used.
- `shouldApply`'s `last_write_wins` comment no longer claims that events arrive in order (`src/sync/mirror.ts:38`).

## G10 [MAJOR]: GitHub snapshots overwrite newer state

- `MirrorDeps.currentGithubIssue` / `currentPlaneIssue` (`src/sync/mirror.ts:80-82`) are wired in production at
  `src/app/issues.ts:100-115`: `GET /repos/{owner}/{repo}/issues/{n}` (a 404 classified by `classifyGithubError`, or a
  410 for a deleted issue, returns null) and `planeClient.getIssue` (a Plane 404 returns null).
- GitHub→Plane (`src/sync/mirror.ts:248`): title, body, state, labels and assignees come from `current`. A delayed
  `closed` after a reopen mirrors the issue's state now, not the action (`:284`). Comments are additive and keep the
  delivery.
- PRs (`src/app/pr.ts`): `currentPrOf` (`:86`) reads `GET …/pulls/{n}` **before the delivery changes anything**
  (`:302` and `:422` for fenced continuations), so a throttled or failed read retries the whole delivery safely.
  - `staleLifecycle` (`:104`) skips a lifecycle trigger that the PR's current state contradicts (a `closed` after the
    reopen, `opened` after the merge or after going back to draft, `drafted` after ready). A merge is final. A skip is
    audited `rule_match`/`ignored` (`:360`).
  - The rollup title and URL use the current PR (`:379`).
- Tests: `G10: a delayed GitHub title edit…`, `…delayed closed after reopened…`, `…delayed assignment…`,
  `…a failed GitHub read fails the delivery…`, `staleLifecycle rejects…`, `a closed delivered after the PR was
  reopened runs no rule and the rollup stays OPEN`, and the `freshest` unit test.

## P3 [MAJOR]: Plane deliveries are unordered

- Plane→GitHub (`src/sync/mirror.ts:521`): for the full-value fields (`FULL_VALUE_FIELDS`, `:467`: name, description,
  state, assignees), the item is re-read and `freshest` applies. Assignees use the current set when it is newer, and
  otherwise `activity.new_value` as before. Label deliveries stay diff-based and make no read.
- Tests: `P3: a stale Plane rename…`, `…stale assignee delivery…`, `…stale state delivery…`, `…a read older than the
  delivery, and a label diff, use the delivery`.

## G6 [MAJOR]: review rollups only read the first 100 reviews

- `listPrReviews` (`src/app/pr.ts:55`) reads every page in chronological order. It follows the `link` header's
  `rel="next"`, or a full page when there is no header. It returns `{ items, complete }`, with `complete: false` at
  its page bound or for a non-list response.
- `reviewsOf` (`:71`) uses it and fails closed: an incomplete or failed read gives the rollup no reviews, so it shows
  REVIEW, never a stale APPROVAL/REJECTED.
- Tests: `G6: reviews are read across every page…`, `…stops at its page bound…incomplete`, `the PR rollup reflects a
  change request on the second page of reviews`.

## Also fixed here, because the code is in my files

- **G15 (pr.ts part, finding owned by G2)**: readiness is now also re-evaluated after `ready_for_review` and `reopened`
  (`readinessEvent`, `src/app/pr.ts:116`). It is judged on the current PR, with the open/non-draft and once-per-head
  guards still in `readyForMapping`. Deferred `pr_created` continuations get the same behavior. Tests: `G15: marking
  an approved, green draft ready…fires`, `G15: a late ready_for_review for a PR that is a draft again does not fire`.
- **G2 (issues.ts:193 part, finding owned by G1)**: `planeInstallation` (`src/app/issues.ts:214`) drops its local
  header check for `classifyGithubError`. Only `not_found` and `permission` mean "not installed". A headerless
  secondary limit and anything else are rethrown and retried. Test: `G2: a headerless secondary rate limit is retried…`.
  This assumes G1 classifies a 403 that carries GitHub's secondary-limit message as `rate_limited`.

## Deferred / for the driver

1. **Deployment-status ordering (part of G10)** is in `src/app/checks.ts` (G2's row). It needs the policy the audit
   describes: order by deployment/status id or `created_at`, and do not let an older status replace a newer rollup.
   I did not change it.
2. **Smart Commit immutable identities (part of G10)** are in `src/github/smart-commits.ts` (G2's row).
3. **Shared review reader (G6/G16)**: done in round 3 (below).
4. **Spec wording**: spec §7.3's "last write wins … events arrive in order" should say that each side mirrors the
   partner's current value when it is newer than the delivered snapshot (`updated_at`), so delivery order does not
   decide the outcome.
5. **Cost note**: a linked issue's snapshot-field event now makes one extra GET to the partner, and every PR delivery
   makes one `GET …/pulls/{n}`. On Plane this counts against `PLANE_API_RATE_PER_MINUTE`.
6. **Test-harness note**: the fakes (`tests/a8/harness.ts`, `tests/github/fakes.ts`) return objects without
   `updated_at`, so existing tests keep their delivered-snapshot behavior. No harness change was needed.

## Follow-up (G4 request)

- `findLinkId` now builds its path with `planeItemsPath(slug, projectId, issueId)` + `links/` from `src/sync/plane.ts`
  instead of a hardcoded `/issues/` path. The `MirrorDeps.currentPlaneIssue` doc comment no longer names the
  `/issues/` path. Typecheck passes. The G3 tests match rollup links on `/links/$`, so they hold for either path segment.

## Round 2: existing fixtures

I audited the existing tests that reach the round-1 reads (`mirrorDeps.currentGithubIssue` / `currentPlaneIssue`,
`currentPrOf`'s `GET …/pulls/{n}`, and readiness on `ready_for_review`/`reopened`). **No fixture needed a change**,
so no test file was edited. Why each one is safe without running it:

- **The reads tolerate fakes without them.** `freshest` uses a read only when it carries `updated_at`. A read without
  it, a null read, or a 404 (GitHub `not_found`/410, Plane `PlaneApiError` 404) keeps the delivered snapshot, which was
  the behavior before round 1.
- **`tests/a8/harness.ts`**: the default octokit reply `{ id, number }` has no `updated_at`. The Plane fake answers
  `GET /work-items/{id}/` with the seeded item (no `updated_at`) or a 404. Existing responders for
  `issues/{issue_number}` (`echo-loop`, `reducers`, `queue/fixes-r1`) and `pulls/{pull_number}` (`rule-engine`) return
  stamp-less objects, so they still feed only `assigneeSyncWriter` and `otherPrStates` as intended.
- **Custom fixtures**: `tests/mirror/review-r4-cc` (real `PlaneClient` whose GETs return a stamp-less page; GitHub GETs
  return `{ id, email }`), `review-r5-cc`, `service-plan` (harness) and `review-r6-cc` (hand-built `MirrorDeps` with no
  readers) all keep delivered values. `tests/app/fixes-r2`, `fixes-r3`, `review-r4-sa` and `review-r5-cd` build stub
  clients but do not run issue or PR reducers through the reads. Their `planeInstallation` cases (502 → rethrown,
  404 → 0) match the classifier.
- **No throwing responders** on the new routes, and **no call-count assertions** that include them. The only counted
  GitHub calls are filtered to `commits/{sha}/pulls`, `compare`, `reviews` or `check-suites` (fixes-r3 F18: no linked
  item, so readiness never reads). `rule-engine`'s `plane.calls.length === 0` is the unmapped-repository case, which
  returns before any read.
- **Seeded counters**: no test asserts on the harness's `100 + seq` / `9000 + seq` ids, so the extra GETs that advance
  `seq` change no expectation.
- **Readiness on stage changes**: among my test files, no existing test sends `ready_for_review`/`reopened` through
  `handlePullRequest`. `tests/mirror/mirror.test.ts` uses issue `reopened` with reader-less deps. G2's
  `tests/github/audit-g2.test.ts` already expects the new behavior (stamped `currentPr` fixtures) and is consistent
  with `currentPrOf`/`freshest`.

If the driver's run shows a failure that traces to these reads, send me the test name and assertion and I will update
that fixture without weakening its assertions.

## Round 3: one review reader (G6/G16 consolidation)

- `listPrReviews` (`src/app/pr.ts`) is now a thin wrapper over G2's `readPrReviews` (`src/github/pr-automation.ts`),
  which readiness also uses. Rollups and readiness therefore share one paginated, chronological reader: it follows the
  `link` header, has a 100-page bound reported as `complete: false`, and throws on a non-list page. The wrapper only
  narrows `ReviewSummary` to the rollup's `{ state, user }` shape.
- The rollup's fail-closed handling is unchanged: `reviewsOf` returns no reviews when `complete` is false or the read
  throws, so the title reads REVIEW and never shows a decision taken from a partial list.
- The local `readinessEvent` now delegates to G2's `shouldReevaluatePrReadiness` (same events: an approving review,
  `ready_for_review`, `reopened`), so the lifecycle path and fenced continuations share that rule too.
- Tests (`tests/mirror/audit-g3.test.ts`): the bound/malformed test now covers the shared contract (100 reads, then
  incomplete; a non-list page rejects; items mapped). The new test `an incomplete review read leaves the rollup at
  REVIEW` checks this end to end through `handlePullRequest`. The link-header and second-page rollup tests are
  unchanged. Typecheck passes.
