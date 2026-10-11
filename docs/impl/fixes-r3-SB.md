# Round-3 fixes, implementer SB

## F4 Installation allow-list per workspace (API shape — read by GA and GB)

**Storage (GA adds a migration + ledger functions).** Table `workspace_installations`:

    installation_id  BIGINT      PRIMARY KEY            -- a GitHub App installation belongs to at most ONE workspace
    workspace_slug   TEXT        NOT NULL               -- /^[a-z0-9][a-z0-9_-]*$/ (SLUG_PATTERN)
    account_login    TEXT                               -- optional label shown in the UI (org/user the installation is on)
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    INDEX (workspace_slug)

SB reads it with plain SQL from `src/ui/mapping-check.ts` (`installationWorkspaceFromDb(db)`), so GA's ledger functions are optional sugar.

**Instance-admin API** (Plane instance-admin session, same auth/CSRF rules as the other `/instance/*` routes), base `/git-sync/api`:

| Method + path | Body | Success | Errors |
|---|---|---|---|
| `GET /instance/installations` | – | `200 [{ installationId: number, workspaceSlug: string, accountLogin: string \| null, createdAt: string }]` ordered by workspace then id | 401/403 |
| `PUT /instance/installations/:installationId` | `{ workspaceSlug: string, accountLogin?: string \| null }` | `200` the entry (idempotent for the same workspace; updates `accountLogin`) | 404 bad id; 422 invalid body/slug; 409 the installation is already allow-listed for a different workspace (delete it first) |
| `DELETE /instance/installations/:installationId` | – | `204` | 404 not listed |

**Verifier rule.** `createMappingVerifier` resolves the repository's installation (`installationIdFor`) and accepts the mapping only if
`workspace_installations` lists that installation for the request's workspace; otherwise 422 "That GitHub installation is not allowed for this
workspace". Without an allow-list source the verifier refuses every repository (fail closed). Removing an entry does not delete existing
mappings; it blocks new/changed ones.

### F4 what changed
- `src/ui/mapping-check.ts`: `createMappingVerifier` takes `installationWorkspace` (`installationWorkspaceFromDb(db)` reads `workspace_installations`) and refuses a repository whose installation is not allow-listed for the request's workspace; with no source it refuses everything. 
- `src/ui/api.ts` + `src/ui/validate.ts` (`parseInstallationEntry`): `GET/PUT/DELETE /instance/installations[/:id]` as published above (409 when the installation belongs to another workspace; the insert is conflict-guarded against races).
- Tests: `tests/ui/workspace.test.ts` (verifier refusals: another workspace's installation, unlisted installation, no source; DB reader), `tests/ui/instance.test.ts` ("r3 F4": auth, create, idempotent relabel, 409, 404/422, list, delete). `tests/ui/harness.ts` creates the table `IF NOT EXISTS` so it works before and after GA's migration.
- **Cross-owner, required to switch it on:** SA's `src/app/main.ts` must pass `installationWorkspace: installationWorkspaceFromDb(db)` to `createMappingVerifier` (until then every new mapping is refused, which is the fail-closed behaviour); GA's migration must create `workspace_installations` exactly as above (an existing deployment's mappings keep working, new/changed ones need an allow-list entry); GB builds the UI on the API.

## F5 User links fail closed and check membership (API half)
`PUT /user-links/:id` now needs both `lookupGithubUser` and `isWorkspaceMember` (503 without either), verifies the GitHub id against the login (422), the Plane user against the workspace members (422) and answers 502 on an outage. `createPlaneMemberCheck(plane)` in `src/ui/mapping-check.ts` is the service-PAT member check. Tests: "r3 F5" x2 in `tests/ui/workspace.test.ts`.
**Cross-owner:** SA's `composeRoutes` passes `lookupGithubUser: createGithubUserLookup(...)` and `isWorkspaceMember: createPlaneMemberCheck(planeClient)`; `src/app/push.ts` and `issues.ts` should build `users` with `usersByGithubId(ctx.db, slug, payload.sender)` (already exists in `src/app/context.ts`) so Smart Commit attribution is by `sender.id`, not login; the unlink tombstone honoured by `ensureLinkedByEmail` is schema/`src/app` work.

## F12 Compare premise and failure handling
`PUSH_PAYLOAD_COMMIT_LIMIT` is 2048 (the webhook's real cap); `MAX_RANGE_COMMITS` is 10000. A compare refused with 404/422 keeps the payload's commits and audits `smart_commit_truncated`; 5xx, 429 and network errors still throw so the delivery retries. Test: "r3 F12".

## F16 In-process lock never admits a second holder
The key's tail is dropped only after the whole chain has settled (`chained.then(...)`), not when a timed-out waiter leaves, so a retried delivery still queues behind the running holder. Test "r3 F16" (verified to fail with the old `delete` in the `finally`).

## F1 support for CB (Smart Commit step identity)
`src/github/smart-commits.ts` `step()` runs each command step's write under `deliveryScope.run({ ...store, deliveryId: store?.deliveryId ?? "smartcommit-<sha>", operationId: "sc:<sha>:<step>" }, run)` — the existing step key, per the contract in `docs/impl/fixes-r3-CB.md` F1. The step keys remain the commit ledger keys; a step is recorded when its write is durably registered. A partial retry skips recorded steps and re-issues only the unfinished one under the same operation id, and identical writes from different commands (different step ids) never collide. An enclosing delivery scope is preserved (only `operationId` is replaced; `occurrences` and `workspaceSlug` carry over). Test: "r3 F1: every Smart Commit write runs under its step id ..." in `tests/github/smart-commits.test.ts`. Note: `src/github/smart-commits.ts` now imports `deliveryScope` from `src/app/writers.ts`, as the contract specifies.
