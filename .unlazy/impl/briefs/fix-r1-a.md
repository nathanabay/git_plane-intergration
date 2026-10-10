# Fix pass r1 — implementer A

Read `.unlazy/impl/briefs/fix-r1-common.md` first.

Your findings (full text in `docs/impl/review-1.md`):
- **F1 [BLOCKING]** identifier endpoint 403 fails deliveries → treat 403 as unknown/inaccessible
  in `resolveReferences`, audit it; update `tests/smoke/live-smoke.test.ts` to expect 403 for an
  unknown project.
- **F2 [BLOCKING], runtime half** → `mappingsForProject` and every Plane-side lookup must also
  match the payload's `workspace_slug` against the mapping's workspace (src/app). (B adds the
  create/update verification in the config API.)
- **F5 [MAJOR], your half** → `src/app/issues.ts`: compute the GitHub assignee diff only over
  logins present in the workspace user map; leave unmapped GitHub assignees untouched. (B changes
  the mirror to stop ignoring an empty Plane assignee set.)
- **F6 [MAJOR]** GitHub App credentials saved in the admin UI are never used → load
  `github_app_config` (decrypt with B9's `decryptSecret` and `GITSYNC_TOKEN_KEY`) and prefer it
  over env, re-reading when it changes (or at least on each worker start), env as fallback.
- **F7 [MAJOR]** only PR events reach the rule engine → route `push`, `commit.pushed_to_default`,
  `check_suite.*`, `deployment_status.*`, `issue.*`, `comment.*` events into A6 for the mapping's
  rules too (§7.5), with the linked issues as targets.
- **F9 [MAJOR]** outbound queues are dead → reducers enqueue `PlaneWrite`/`GithubWrite` jobs on
  `outbound-plane`/`outbound-github` with long-horizon retries; inbound jobs stay short (§4).
  Where a reducer needs the write's result (e.g. a created id), document how it gets it.
- **F10 [MAJOR]** echo-loop suite uses payload shapes Plane never sends → rebuild the fixtures
  from the probe evidence (UUID arrays, `labels`, and the web app's `*_ids` names) and make label
  echoes terminate with **zero** extra writes.
- **F12 [MAJOR]** email matching never called → when a sender is unmapped, try §9 email matching
  (GitHub user's public/verified email via the App, then B9 `matchPlaneUserByEmail` against
  workspace members); zero or several matches is a loud audit failure, never a guess.
- **F13 [MINOR]** create-type ops recorded after the response → record a pending op before the
  request and bind it to the id afterwards, or document why the race is harmless with a test.
- **F16 [MINOR], your half** → the commit claim key: make `claimCommit` key on (sha, workspace)
  so one repo mapped into two workspaces processes each workspace once, while fork re-delivery
  of the same SHA into the same workspace still dedupes (new migration). B passes the workspace.
- **F17 [MINOR]** unbounded ledgers, TTL needs restart → prune `webhook_deliveries`,
  `processed_commits` and old audit payloads on a retention setting in the maintenance job; read
  the TTL from settings each run.
