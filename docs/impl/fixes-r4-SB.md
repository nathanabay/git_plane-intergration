# Round-4 fixes, implementer SB

## F11 Unlinking is no longer undone by the next event
- `src/db/migrations/007-user-link-tombstones-credential-state.sql`: table `user_link_tombstones(workspace_slug, gh_id, created_at)`, PK `(workspace_slug, gh_id)`.
- `src/db/ledgers.ts`: `addUserLinkTombstone`, `isUserLinkTombstoned`, `clearUserLinkTombstone`.
- `src/ui/api.ts` `DELETE /user-links/:id` returns the removed row's `gh_id` and writes the tombstone; `PUT /user-links/:id` clears it (a manual link is an explicit admin decision).
- `src/app/identity.ts` `ensureLinkedByEmail` returns null for a tombstoned `(workspace, gh_id)` — checked before the lookup and again just before the insert — and audits `identity_email_match / skipped / unlinked_by_admin`, so the sender acts as the service identity.
- Tests (`tests/ui/review-r4-sb.test.ts`): "F11: unlinking writes a tombstone and a manual link lifts it"; "F11: after an unlink the next event does not re-link by email, and the service fallback is audited" (includes the no-tombstone control and lifting).

## prev F15 Credential fallback is durable; health reports the live source
- Migration 007 also adds `github_credential_state` (backfilled when a `github_app_config` row exists). `markCredentialRowSeen` / `credentialRowEverSeen` in `src/db/ledgers.ts`; `PUT /instance/github-app` marks it (`src/ui/api.ts`).
- `src/app/credentials.ts`: "a row was seen" is now remembered in the process, in the database, and in a marker file beside the key path (`.gitsync-db-credentials`; override with the new `markerPath` argument; a read-only mount just falls back to the database marker). With any of them set the environment secret is refused on a database outage at cold start, on a missing row and after a restart.
- `src/ui/api.ts`: new optional `ConfigApiDeps.credentialStatus`; `/instance/health` reports `githubAppCredentials` from it (falling back to the stored-row check when unset).
- Tests: three "prev F15" credential tests and "saving credentials ... health reports the live credential source".
- **Needs from others:** SA's `composeRoutes` must pass `credentialStatus: () => credentials.describe()` to `createConfigRoutes` (src/app/main.ts, not mine). The old assertion in `tests/app/fixes-r2.test.ts` ("F15 ... `outage` ... strictEqual(await outage.webhookSecret(), 'leaked-env-secret')") now contradicts the finding on purpose: a second source created after a row was read must refuse the environment secret. That one line must be changed to expect a refusal (I do not own the file).

## F3 support for CB: retry a failed outbound write
`src/ui/api.ts`: `OperationsDeps.retryFailed?(id, workspaceSlug)` and workspace-admin `POST /workspaces/:slug/outbound-writes/:id/retry` (same auth and CSRF as the other operations routes): 202 `{ id, status: "retry_scheduled" }`; the outbox answers `{ ok: true, retried }` and `retried:false` (unknown, foreign or not failed) is 404, 503 when unwired. Test: "F3 (CB): POST /outbound-writes/:id/retry ...". SA passes the production callback through `composeRoutes`.

## F4 support for CC (migration 007)
`uq_sync_links_label_sync` is recreated as unique over ACTIVE label_sync links only (`status = 'active'`), so a replacement link can be created after the old one is orphaned. Test: "F4 (CC): only ACTIVE label_sync links are unique".

## Regression note: `tests/app/fixes-r2.test.ts` "F15: the credential source says where credentials come from…"
Case: the test encoded the OLD in-memory behaviour. It created a second source after a row had been read, with the database down, and expected `leaked-env-secret` — exactly the restart fallback review-4 prev F15 closed. The code was right. Only that assertion changed: the post-read outage source (same key directory, so the durable marker is present) must refuse; and a cold start with no marker and no row ever read (fresh key directory) still verifies with the environment, so the database-outage proof is kept. Nothing else in the test or file was touched.
