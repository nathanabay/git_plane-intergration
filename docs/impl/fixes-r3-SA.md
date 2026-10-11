# Round-3 fixes — implementer SA

Tests: `tests/app/fixes-r3.test.ts` (F5, F7, F8, F18); `tests/app/fixes-r2.test.ts` F14 updated to SB's corrected premise
(the push payload lists up to 2048 commits, so the compare lookup is exercised at `PUSH_PAYLOAD_COMMIT_LIMIT`).

## F5 (wiring half)
- `src/app/main.ts` `composeRoutes` passes `lookupGithubUser: createGithubUserLookup(...)` (an App-level `GET /users/{login}` through the new
  `GithubClient.appRequest`, `src/app/github.ts`) and `isWorkspaceMember: createPlaneMemberCheck(planeClient)` (service PAT, `/workspaces/{slug}/members/`)
  to `createConfigRoutes`; SB's API fails closed (503) without them.
- `src/app/push.ts`: Smart Commits get `usersByGithubId(ctx.db, slug, payload.sender)`, so a login re-registered by someone else is not attributed.
- Tests: "F5: the service's own routes verify a manual user link…" (through `composeRoutes`: id mismatch is 422, nothing stored) and
  "F5: Smart Commits attribute by the sender's GitHub id…".
- **Not done (outside my OWNS):** the unlink tombstone honoured by `ensureLinkedByEmail` needs a table (`src/db/**`, GA) and the
  `DELETE /user-links` write (`src/ui/api.ts`, SB). Once both exist `ensureLinkedByEmail` (`src/app/identity.ts`) should skip a
  `(workspace, gh_id)` that has a tombstone; tell me the table name and I will add it. Assignee mapping in `rules.ts`/`issues.ts` by login is CA's/mine
  and unchanged: `mappedLogins` is login-based because GitHub assignee payloads carry logins; the id check is made when the link is stored.

## F7
- `src/app/issues.ts` `handlePlaneIssue`: the `.catch(() => 0)` is gone. Only 404/403 from the installation lookup ("the App is not installed
  there") still yields installation 0, which a write that needs it rejects; every other failure (GitHub 5xx, network) fails the delivery so it retries.
- Test: "F7: a transient installation-lookup failure fails the delivery (it retries); 'not installed' does not".
- For GA/CB: `GithubWritePath` treating `installationId: 0` as a permanent *remote* error is still wrong in `src/sync/github.ts` — it is a caller bug and should throw
  a distinct programming error (not mine to edit).

## F8
- `src/app/pr.ts` `handleForMapping`: `fireReadyForMerge` now runs after the delivery's own lifecycle rules, so `pull_request.approved` runs first and the
  `ready_for_merge` state wins. Test: "F8: with both 'approved' and 'ready for merge' mapped, the ready rule runs last".

## F15
- `src/api/handler.ts`: the comment now says what is true — GitHub does not redeliver a failed webhook; `deploy/APPLY.md` §11 documents redelivering from the App's
  "Recent deliveries" page.
- **For SB (`src/ui/api.ts`, not mine):** `/instance/health` should report the credential source in use rather than re-derive it. Add to `ConfigApiDeps`
  `credentialHealth?: () => Promise<{ source: "database" | "environment"; decryptOk: boolean }>` and use it for `githubAppCredentials`. `composeRoutes` already has
  `credentials.describe`; pass it as `credentialHealth: () => credentials.describe()` once the field exists (an unknown property fails the typecheck today).
- **For GA (migration):** persisting "a stored row has existed" needs a column, e.g. `instance_settings.github_app_saved BOOLEAN NOT NULL DEFAULT FALSE`, set by the
  save in `src/ui/api.ts` (`PUT /instance/github-app`). `src/app/credentials.ts` `sawRow` should then be initialised from it so a restart cannot fall back to a rotated-out
  environment secret. In-process behaviour (no fallback once a row was read) is unchanged and tested in r2.

## F18 (the parts in my files)
- `src/app/pr.ts` `fireReadyForMerge`: links are looked up first (no linked item: no GitHub call), the already-fired audit is checked before readiness, and readiness
  is evaluated only on an approving review and a completed `check_suite` (`src/app/checks.ts`: a `check_run` no longer triggers it).
  Test: "F18: readiness costs no GitHub reads for a PR with no linked item, and a check_run does not evaluate it".
- **Not mine:** audit `ignored` when the executor skips every target (`src/app/rules.ts`, CA); hide the base-branch field for `branch_pushed` and hash the comment JSON
  with the body (UI/`src/sync`, GB/SB).

## Round-3 F1 hand-off from CB: `{ID}-NEW` creates as a durable plan
- `src/app/context.ts`: `PlaneWriter.plan?` and `GithubWriter.plan?` (`PlanWriter`, from `src/app/writers.ts`).
- `src/app/pr.ts` `createRequested`: when the writers have `plan`, the `-NEW` create registers one plan keyed
  `create:pr:<workspace>:<repoId>#<number>:<projectId>` (with `pendingLink`): `create_issue` (bind `created`), `sync_link`
  (`planeIssueId: resultRef("created.id")`), the `pr_create_request` `created` audit (same reference), and a final GitHub-side
  `resume_reducer` step carrying `{ kind: "pr_created", job, mappingId, projectId, identifier, issueId: resultRef("created.id") }`.
  No created id is read synchronously; the reducer returns once the plan is registered. Writers without `plan` (raw test writers) keep the
  previous inline path (`tests/a8/rule-engine.test.ts` still covers it).
- `src/app/pr.ts` `handleCreatedPr(ctx, request)`: the continuation. It finds the mapping from the stored job, and for the newly created
  target only runs the delivery's lifecycle rules, the PR rollup link and the linkback comment (`completeItems`, extracted from `handleForMapping`
  and shared by both). It does not re-run the original reducer.
- `src/app/main.ts`: `createOrderedOutbox({ ..., resumeReducer: (request) => handleCreatedPr(ctx, request) })`.
- Test `tests/app/pr-new-plan.test.ts` (real ordered outbox on PGlite, in-memory queues): registration creates nothing; after the queued jobs execute there is one
  created item, one `pr` sync link on it, a `created` audit naming it, the rollup link on it, one linkback comment; an `edited` redelivery creates nothing more.

## Round-3 F1 hand-off from CB: rollup link id recovery
- `src/app/context.ts`: `PlaneWriter.upsertRollup?` (the ordered writer provides it; `upsertRollupLink` in `src/sync/dev-info.ts` uses it, so a reducer never reads a queued link result).
- `src/app/main.ts`: the outbox gets `findPlaneLinkId: (target, url) => findLinkId(ctx, target, url)` — the current Plane link-list reader (`pr.ts`), used when a rollup's create is
  still queued or its stored id is gone.
- Test: `tests/app/pr-new-plan.test.ts` also asserts the rollup's link id is stored (`dev_info_links`) once the outbox has run, with the reader wired.

## Production gap: `assigneeSyncWriter` hid `plan`
- `src/app/issues.ts` `assigneeSyncWriter` (now exported for the test) forwards `ctx.github.plan` unchanged (bound to the writer); `setAssignees` is consumed by the wrapper
  itself, so `plan` is the only other optional method on `GithubWriter`. Plane→GitHub mirror creates therefore reach the ordered plan path instead of the inline fallback.
- Test: "F1 wiring: the assignee-sync wrapper forwards the writer's optional plan method unchanged". CB's acceptance test through `handlePlaneIssue` covers the full path.

## Mirror-created items: their `issue.*` rules run from a durable resume
- `src/app/issues.ts` `mirrorDeps(ctx, mapping, installationId, createContinuation?)`: GitHub issue events pass `createContinuation: { job }`, so CB's mirror plan ends with a
  `mirror_created` resume step.
- `src/app/issues.ts` `handleMirroredIssue(ctx, request)`: re-runs the original delivery's `githubRuleEvent` through `runRules` for only `request.projectId`/`request.issueId`
  (tier closing, as a label-created link counts), with `actorTokenFor` from the original sender and mapping. The reducer's own `linkedIssuesFor` run finds no target while the
  create is pending, so nothing runs twice.
- `src/app/main.ts`: `resumeReducer` dispatches `mirror_created` to `handleMirroredIssue` and `pr_created` to `handleCreatedPr`.
- Test: `tests/app/mirror-rules.test.ts` — through `handleGithubIssue` with the real ordered outbox, a custom `issue.labeled` rule does not run at registration, and runs
  exactly once, for the created item, after the item and its sync link exist.

## Fast worker: the mirror's rules never run twice
- `src/app/issues.ts` `handleGithubIssue`: the result of `onGithubIssue` is captured; when it is `created` and the writer has `plan`, the inbound `runRules` is skipped for
  that mapping — the `mirror_created` resume owns the rules for the new item. Writers without `plan` (raw inline path) keep the inbound run unchanged.
- Test: "F1: when a fast worker creates and links the item before the reducer returns, the rule still runs exactly once" (`tests/app/mirror-rules.test.ts`; queues whose `add`
  runs the worker at once). Confirmed to fail without the change (the rule ran twice) and pass with it.

## F11 wiring: configurable Plane request rate
- `src/config/env.ts`: `PLANE_API_RATE_PER_MINUTE` (default 60; a positive whole number or startup exits). The comment says it must equal Plane's `API_KEY_RATE_LIMIT` in `plane.env`.
- `src/app/main.ts`: passed to the `PlaneClient` as `rateLimitPerMinute`.
- `deploy/git-sync.env.example` documents it (60); `deploy/APPLY.md` mentions it next to the `API_KEY_RATE_LIMIT` decision.
- Test: `tests/api/plane-rate-config.test.ts`. The A1 oracle (`verify-a1-deploy`) runs in gate G2.

## An issue event received while its partner is still being created (`mirror_pending`)
- `src/app/issues.ts` `handlePendingMirroredIssue(ctx, request)`: the replay of an event CB's mirror registered as a deferred action in the create's ordering group. It selects the mapping by
  `request.mappingId` and the payload's repository, builds `mirrorDeps` **without** `createContinuation` (the partner now exists), runs `onGithubIssue` for the fields, then the original
  `githubRuleEvent` through `runRules` for `request.projectId`/`request.issueId` with `actorTokenFor` from the original sender.
- `src/app/issues.ts` `handleGithubIssue`: when `onGithubIssue` returns `action: "deferred"` the inbound `runRules` is skipped, as for planned creates; the replay owns the rules.
- `src/app/main.ts`: `resumeReducer` dispatches `mirror_pending` to this handler (`mirror_created` and `pr_created` as before).
- Test: "F1: an issues.edited received while the partner is still being created is replayed, rules included, once the link exists" (`tests/app/mirror-rules.test.ts`) — an edit arriving
  before the queued create ran ends with one created item, the edited title on it, and the `issue.edited` rule fired exactly once.

## Plane-origin `mirror_pending` (an edit or comment received while the GitHub partner is still being created)
- `src/app/issues.ts` `handlePlaneIssue`: Plane-side `mirrorDeps` now carry `createContinuation: { job }` so the mirror can register the event behind the in-flight create. The
  installation lookup moved to `planeInstallation` (unchanged behaviour: only 404/403 means "not installed", anything else fails the delivery).
- `src/app/issues.ts` `handlePendingMirroredIssue` branches on `request.job.source`; the Plane branch (`handlePendingPlaneEvent`) selects the mapping with
  `mappingsForProject(request.projectId)` filtered to `request.mappingId`, requires `payloadBelongsToMapping` (the F2 workspace authorization), builds `mirrorDeps` **without**
  `createContinuation`, and calls `onPlaneIssue` under the `plane:<issueId>` object lock. It does **not** re-run Plane rules: the original delivery already ran them inline.
  `issue` and `issue_comment` events both go through it.
- Tests (`tests/app/mirror-rules.test.ts`): a Plane title edit and a Plane comment received before the queued GitHub create ran are replayed afterwards — the issue is created,
  the edit reaches GitHub (`PATCH`, new title, the created issue number) and the comment is posted once on it. (The edit test sets `title: last_write_wins`; the default
  policy keeps Plane title edits out of GitHub, which the first run of this test showed through the handler's `ignored` result.)
