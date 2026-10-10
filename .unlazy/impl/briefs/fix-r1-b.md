# Fix pass r1 — implementer B

Read `.unlazy/impl/briefs/fix-r1-common.md` first.

Your findings (full text in `docs/impl/review-1.md`):
- **F2 [BLOCKING], config-API half** → on mapping create/update verify the Plane project belongs
  to the workspace (`GET /api/v1/workspaces/{slug}/projects/{pid}/` with the service PAT; 404/403
  → 422) and the GitHub repo is reachable through the App with matching id and full name (A's
  `installationIdFor` / an installation Octokit, injected as a dependency). Tests for both refusals.
- **F3 [BLOCKING]** backfill links become mirror partners → the mirror only ever acts on links
  with `created_by = 'label_sync'` (both directions); backfilled references never mirror. Test:
  backfill links #5 to WEB-12, then `issues.edited`/`closed` for #5 writes nothing to Plane.
- **F4 [MAJOR]** Plane→GitHub labels/assignees never fire on real payloads → handle UUID arrays
  under both `labels`/`assignees` and `label_ids`/`assignee_ids`; resolve label ids to names via
  `GET …/labels/` and member ids to GitHub logins via `user_map`.
- **F5 [MAJOR], your half** → the mirror must not ignore an empty Plane assignee set; emit the
  removal of mapped assignees. (A restricts the diff to mapped logins in `src/app/issues.ts`.)
- **F8 [MAJOR]** Smart Commits at-most-once → make a transient write failure retryable without
  re-applying commands that already succeeded (e.g. per-command idempotency keys recorded on
  success, release the SHA claim on failure, or a queued retry of the failed command only).
- **F11 [MAJOR]** the lifecycle→state table UI is missing → add the simple mapping table
  (lifecycle point → state, plus branch rules) that compiles to rules through B5's
  `compileLifecycleRules` and saves as a rule-set version; advanced users still edit YAML (§7.1).
- **F14 [MINOR]** `ready_for_merge` never fires → emit it when a PR is approved and its check
  suites all pass, or remove it from the configurable set and say why.
- **F15 [MINOR]** web iframe renders before the role is known → render a loader until
  `workspaceUserInfo` is loaded; regenerate the fork patch and mirrored files.
- **F16 [MINOR], your half** → pass the mapping's workspace to `claimCommit` (A changes its key).
- **F18 [MINOR]** pushes with more than 20 commits drop commands → fetch the remaining commits
  with the compare API (`GET /repos/{owner}/{repo}/compare/{before}...{after}`) when the payload
  is truncated.
