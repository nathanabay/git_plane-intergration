# Round-1 fixes — implementer SA

Tests for all five findings: `tests/queue/fixes-r1.test.ts`.

## F2 (runtime half)
- `src/app/mappings.ts` `mappingsForProject(db, projectId, workspaceSlug?)` narrows by workspace.
- `src/app/context.ts` `payloadBelongsToMapping` compares the payload's `workspace_slug` with the mapping's (falls back to
  `workspace_id` resolved through Plane; a payload naming neither is refused). `handlePlaneIssue` (`src/app/issues.ts`) drops
  every candidate mapping that fails it and audits `workspace_mismatch` / `unmapped_project`.
- Test: "F2: a Plane delivery from another workspace cannot drive a mapping" — no GitHub write, audit `workspace_mismatch`.
- Needs from CA: none; the filter lives in files SA owns. SB owns the config-API half.

## F5 (app half)
- `src/app/issues.ts` `assigneeSyncWriter`: the diff is computed only over logins present in the workspace user map
  (`mappedLogins`); `remove_assignees` requests are also filtered to mapped logins, so an empty Plane set (CB's mirror
  emits it) removes mapped assignees and nothing else.
- Tests: "F5: assignee sync leaves GitHub assignees that have no user-map row alone" and "F5: emptying the mapped set…".

## F6
- `src/app/credentials.ts` `createCredentialSource`: reads `github_app_config`, decrypts with `decryptSecret` + the
  `GITSYNC_TOKEN_KEY` key; the row wins, env is the fallback (no row, or database unreachable and nothing cached).
  Results are cached for 5 s, so a rotated key/secret applies within seconds without a restart.
- `src/app/github.ts` rebuilds the App client when the credentials change; `src/app/main.ts` passes
  `githubSecret: () => credentials.webhookSecret()` to the webhook routes (verification uses the stored secret).
- Test: "F6: credentials saved in the admin UI win over the environment and changes are picked up".

## F9
- `src/app/writers.ts` `queuedPlaneWriter` / `queuedGithubWriter` wrap the inline write paths; `main.ts` gives reducers these.
  Reducers enqueue on `outbound-plane` / `outbound-github` with deterministic job ids (delivery + sequence, so an inbound
  retry does not duplicate). Op recording stays in `apply`, which runs in the outbound workers.
- `src/queue/index.ts`: outbound queues get 30 attempts with a custom backoff (`outboundBackoff` in `src/queue/workers.ts`:
  5 s doubling to a 10 min ceiling, several hours in total); inbound jobs keep 5 attempts / 2 s.
- **Writes whose result a reducer needs** (Plane `create_issue`, `upsert_label`, `add_link`, `update_link`, GitHub
  `create_issue`) run inline through the same write path, so the created id is returned; the inbound job's own retry covers
  them. Writes made with a per-user token never go into Redis and also run inline. Plane triage/unknown-state rejection is
  checked by `preflight` before enqueueing.
- Tests: "F9: reducers enqueue writes…" and "F9: outbound backoff rides out hours".

## F12
- `src/app/identity.ts` `ensureLinkedByEmail`: for an unmapped GitHub sender, read the user's public email through the
  App (`GET /users/{login}`, id must match the event's), list workspace members (`/workspaces/{slug}/members/`) and call
  `matchPlaneUserByEmail`. Exactly one match inserts a `user_map` row and audits `linked`; none/multiple/no public
  email/id mismatch/conflict audit `failed` (kind `identity_email_match`) and nothing is linked. Retried at most every
  10 minutes per login. Called from `actorTokenFor` (`context.ts`) and the push handler.
- Tests: the three "F12:" tests.

## F7 hooks for CA
Requested by CA (relayed by the driver); CA's tests in `tests/a8/rule-events.test.ts` reproduce all three and pass (19/19).
- `src/app/push.ts` `handlePush`: after `smartCommits` and `branchPushed`, calls `await runPushRules(ctx, mapping, job)` once per
  mapping (from `./rules.ts`); `pushedToDefault` is removed.
- `src/app/push.ts` `branchPushed`: no longer calls `runRules`; it keeps the branch rollup link.
- `src/app/issues.ts` `handlePlaneIssue`: the Plane-side `runRules` call passes `source: "plane"`.
