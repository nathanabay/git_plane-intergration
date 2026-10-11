# Round-2 fixes — implementer SA

Tests for all four findings: `tests/app/fixes-r2.test.ts` (plus the existing `tests/queue/fixes-r1.test.ts`).

## F1 (wiring half)
- `src/app/main.ts` `composeRoutes` (split out of `runService`, so a test drives the real route list) passes
  `verifyMapping: createMappingVerifier({ plane: planeClient, github: ghClient })` (service PAT client + installation Octokit)
  to `createConfigRoutes`. SB makes the API fail closed when it is absent.
- Test: "F1: the service's own routes refuse a project that is not in the workspace (422)" goes through `composeRoutes`, not
  a hand-built harness, and finds nothing stored.
- **Not done, outside my OWNS / needs a decision:** the per-workspace allow-list of installation ids or orgs. It needs a table
  (`src/db/migrations/**`) and an admin endpoint (`src/ui/**`). Until then a workspace admin can map any repository the App
  reaches *within that project's workspace*; the verifier proves project-in-workspace and repo id/name match only.

## F12 (runtime half)
- `src/app/context.ts` `usersByGithubId`: `actorTokenFor` and `ensureLinkedByEmail` (`src/app/identity.ts`) look the sender up
  by `sender.id` (`user_map.gh_id`) and refresh `gh_login` on a match; no id falls back to the login lookup. A re-registered
  login with another id is no longer attributed.
- Test: "F12: an event is attributed by the sender's GitHub id…".
- **Not done:** the "unlinked by admin" tombstone that stops email re-linking after `DELETE /user-links`. It needs a schema
  change (`src/db/**`) and the API delete (`src/ui/**`), both outside my OWNS; for the driver to assign.

## F14 (wiring half)
- `src/app/push.ts` `listCommitRange`: `GET /repos/{owner}/{repo}/compare/{before}...{after}` through the installation Octokit,
  paginated (100 per page), mapped to `PushCommit`; supplied to `processPush`.
- Test: "F14: a push of 20+ commits is completed from the compare API…" (through `handlePush`'s inbound path; no
  `smart_commit_truncated` audit).

## F15 (runtime half)
- `src/app/credentials.ts`: `describe()` returns `{ source, decryptOk }` for the source actually in use. Once a database row has
  been read the environment is never used again: a database outage keeps the last stored credentials, and a vanished row or an
  undecryptable row throws instead of falling back. A null `ghe_base_url` with a row means github.com (the environment URL is
  no longer a fallback).
- `src/api/handler.ts`: when the secret cannot be produced the GitHub webhook answers 503 (GitHub redelivers).
- **For SB:** `/instance/health` should report `credentials.describe()`. `composeRoutes` has the source (`RouteParts.credentials`)
  but `ConfigApiDeps` has no field for it yet; add one and I will pass it.
- Tests: the two "F15:" tests.

## F7 wiring
`pull_request.ready_for_merge` (GB's `checkPrReadiness`, `src/github/pr-automation.ts`) is now wired into the live paths.
- `src/app/pr.ts` `fireReadyForMerge(ctx, mapping, job, octokit, pr)`: for an open, non-draft PR it calls `checkPrReadiness`
  (approving review, no changes requested, every check suite green) and, when ready, runs the rules with
  `pull_request.ready_for_merge` over the PR's stored links through `runRules`. Exactly-once guard: an `audit_log` row
  `kind='ready_for_merge'` (repo, PR number, head sha) written after the rules ran, checked under `withObjectLock`. So redelivered
  approvals, several check suites and a status event for the same head commit fire it once; a new push (new head sha) can fire again.
- `src/app/pr.ts` `handleForMapping`: after an approving `pull_request_review`, calls it. It runs before the "no item named in
  this delivery" early return, since the targets come from the PR's stored links.
- `src/app/checks.ts` `handleChecks`: after a completed `check_suite` / `check_run`, lists the PRs for the head sha
  (`GET /repos/{o}/{r}/commits/{sha}/pulls`) and calls it for each PR whose head is that sha.
- **`handleCommitStatus(ctx, job)`** exported from `src/app/checks.ts`: same lookup for a GitHub `status` event with
  `state: "success"`. CA has registered it for GitHub `status` in `src/app/reducers.ts` (the webhook ingress has no event
  allow-list) and added a live-routing regression in `tests/a8/fixes-r2.test.ts`.
- Tests: `tests/app/ready-for-merge.test.ts` — approval + passing checks fire once across approval, suite, redelivery and status;
  approval after green checks fires; a status alone fires; a failing status does not.

## F6 integration (ordered outbound writes, from `docs/impl/fixes-r2-CB.md`)
- `src/app/main.ts`: `createOrderedOutbox` is constructed once (`db`, inline Plane/GitHub paths, the two outbound queues,
  `loadActorToken` = `vault.load(id, "plane_pat")`). `ctx.plane`/`ctx.github` are `ordered.plane`/`ordered.github`, and
  `startWorkers` receives `ordered`. The execution-time readers are supplied: `readPlaneIssueFields` (GET the Plane issue,
  UUID arrays from `labels`/`assignees`, objects reduced to ids) and `listGithubAssignees` (GET the issue through its installation).
- `src/app/context.ts`: `PlaneWriter.mutateIssue?` and `GithubWriter.setAssignees?` (optional, for raw test writers).
- `src/app/issues.ts` `assigneeSyncWriter`: every `add_assignees` set, `[]` included, goes to `github.setAssignees(write, workspaceSlug)`
  before any read or diff; writers without it keep the immediate diff.
- Evidence: CB's `tests/writers/service.test.ts` passes (with the F2/F6 service test), as do my F5 tests.
- A fake `mutateIssue` in GB's `tests/github/pr-automation.test.ts` returned `{ ok: boolean }` against `PlaneWriteResult` and briefly failed the typecheck; the whole-tree typecheck (G4) passes on the final tree.
