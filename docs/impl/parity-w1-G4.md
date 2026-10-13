# Parity wave 1, G4: C0 schema (migration 010 and db helpers)

Status: code written, typecheck passes (`node scripts/typecheck.mjs "src/db/**/*.ts" "tests/db/parity-g4.test.ts"`:
8 files, no errors). Tests were written but **not run**, as the brief says. Nothing staged or committed.

## Files

| File | Change |
|---|---|
| `src/db/migrations/010-parity-connect-oauth-mapping-states.sql` | new: every column and table in the brief's list |
| `src/db/parity.ts` | new: data-access helpers for those columns and tables |
| `src/db/schema.ts` | `TABLES.oauthStates` |
| `tests/db/parity-g4.test.ts` | new: regression tests (PGlite) |

## Migration 010

- **`github_app_config`**: `client_id TEXT`, `client_secret_v1 TEXT`, `app_slug TEXT`,
  `edition TEXT NOT NULL DEFAULT 'github'` with CHECK `github | ghe_cloud | ghes`, `ghe_subdomain TEXT`
  (CHECK: lowercase DNS label; required when edition is `ghe_cloud`).
  Existing rows are backfilled: `ghe_base_url` = `https://api.<sub>.ghe.com` becomes `ghe_cloud` + `<sub>`,
  any other non-empty base URL becomes `ghes`, none stays `github`.
- **`oauth_states`** (new): `nonce_hash` (SHA-256 hex, PK; the raw nonce is never stored), `purpose`
  (`install | oauth`), `workspace_slug`, `plane_user_id`, `pkce_verifier_v1` (encrypted; required for
  `oauth`), `installation_id` (for an OAuth step chained from the install callback, which must then
  confirm it in `GET /user/installations`), `created_at`, `expires_at`, `consumed_at`.
- **`user_tokens`**: `refresh_ciphertext`, `access_expires_at`, `refresh_expires_at` (all nullable),
  `needs_reauth BOOLEAN NOT NULL DEFAULT false`, `updated_at`. The existing `ciphertext` keeps the
  access token, so `PgTokenStore`/`TokenVault.load(…, "github_oauth")` keep working unchanged.
- **`repo_mappings`**: `open_state_id TEXT`, `closed_state_id TEXT` (CHECK: differ when both set),
  `report_problems BOOLEAN NOT NULL DEFAULT false`, `branch_template TEXT` (CHECK: contains `{key}`).
- **`instance_settings`**: `require_verified_commits BOOLEAN`, nullable: NULL means the admin never
  set it and `REQUIRE_VERIFIED_COMMITS` applies.

### Changes from the brief (decisions)

1. **`client_secret_v1` is TEXT, not BYTEA.** The brief says "encrypted like the private key", and
   `private_key_v1` is TEXT holding an `encryptSecret` blob (`v1:iv:tag:ct`, base64url; see
   `src/auth/identity.ts:52`). Matching the existing format lets callers reuse
   `encryptSecret`/`decryptSecret` as-is.
2. **No CHECK that `ghes` has a base URL.** Today's admin save (`src/ui/api.ts:531`) can clear
   `ghe_base_url` without knowing about `edition`, and that save would start failing. Wave 2's admin
   form should set edition and base URL together; `hosts.ts` (G1) should treat `ghes` without a base
   URL as a configuration error.
3. **`oauth_states.purpose` has two values.** The owner handoff (C1) reuses an `install` state with a
   longer `ttlSeconds` chosen by the caller; no third purpose is needed.

## Helpers (`src/db/parity.ts`)

Ciphertexts go in and out unchanged; the module never decrypts.

- App: `readGithubAppClient`, `saveGithubAppClient` (undefined keeps the stored value, so a form
  that does not resend the secret keeps it; returns false when there is no App row yet).
- State: `hashStateNonce`, `createOAuthState({nonce, purpose, workspaceSlug, planeUserId, ttlSeconds,
  pkceVerifierCiphertext?, installationId?})`, `consumeOAuthState(nonce, purpose)` (one atomic
  `UPDATE … WHERE consumed_at IS NULL AND expires_at > NOW() RETURNING`; replay, expiry, wrong purpose
  and unknown nonce all return null), `pruneOAuthStates(graceSeconds)`. The HMAC signature of the
  state is application-level (the C1/C2 owner); the db row is the single-use part.
- Tokens: `getGithubOAuthToken`, `putGithubOAuthToken` (clears `needs_reauth`),
  `markGithubOAuthNeedsReauth`, `deleteGithubOAuthToken` (removes only `github_oauth`; the existing
  `PgTokenStore.delete` removes every kind, which is wrong for a GitHub Disconnect),
  `withGithubOAuthRefreshLock(db, planeUserId, fn(conn, current))`: `SELECT … FOR UPDATE` on a
  dedicated connection (in-process queue on PGlite, the same pattern as `withUserLinkTransaction`).
  The callback receives the row as it is after the lock, so a waiter can skip its refresh when the
  winner already rotated the token; writes inside `fn` must use `conn`; a throw rolls back.
- Mapping: `readMappingParity`, `updateMappingParity` (undefined keeps, null clears),
  `isValidBranchTemplate`.
- Instance: `readRequireVerifiedCommits(db, envDefault)`, `writeRequireVerifiedCommits(db, value | null)`.

None of these is wired into a caller yet; the C1–C3, C4, N2, N3 and N6 owners use them.

## Tests (`tests/db/parity-g4.test.ts`, not run)

Upgrade from 001–009 with existing rows (four `ghe_base_url` cases, an old `github_oauth` token,
a mapping, a settings row); App fields, secret kept when omitted, edition/subdomain CHECKs, and the
008 credential trigger still fires; state single use, wrong purpose, replay, expiry, hash-only
storage, PKCE required, prune, four concurrent consumers with one winner; token store, rotation,
re-auth flag, disconnect keeps the Plane PAT; refresh lock single-flight (three callers, one refresh)
and rollback on failure; mapping fields and CHECKs; signed-commit setting vs env default.

## Context7 sources

Library ids resolved with `npx ctx7@latest library` (find-docs skill) before use.

- `/websites/github_en`, "Refreshing user access tokens" and "Generating a user access token for a
  GitHub App": refresh returns a new `access_token` (`expires_in`, default 28800 s) and a new
  `refresh_token` (`refresh_token_expires_in`, default 15897600 s); the refresh token is **omitted
  when expiration is disabled**. Hence every refresh/expiry column is nullable, and the rotation is
  why the refresh lock exists.
- `/websites/github_en`, web application flow: `state` is "an unguessable random string … against
  cross-site request forgery"; PKCE `code_challenge` with `code_challenge_method=S256`; the
  `code_verifier` is sent with the code exchange, so it is stored (encrypted) with the state; the
  code "is valid for 10 minutes", a sensible OAuth state TTL.
- `/websites/github_en`, "About versions of GitHub Docs" (GHE.com): enterprises on a GHE.com
  subdomain such as `octocorp.ghe.com` call `https://api.SUBDOMAIN.ghe.com`. Basis of the backfill
  and the `ghe_subdomain` column.
- `/websites/developers_plane_so`, states: state groups `backlog, unstarted, started, completed,
  cancelled`, each state has an `id`. Confirmed in the v1.4.2 source
  (`apps/api/plane/db/models/state.py`): the same groups plus `triage`, and the default manager
  excludes triage states. `open_state_id`/`closed_state_id` store that id as TEXT, like
  `plane_project_id`.
- `/websites/postgresql_18`, `substring(string from pattern)`: returns the first parenthesized
  subexpression, or NULL when there is no match. The backfill relies on this.

## For the driver

- **`tests/ui/review-r5-ce.test.ts:416`** expects an upgrade from 001–007 to apply only `008-…`.
  Migration 009 (from the audit fixes) already breaks that assertion, and 010 adds to it. The
  expected list should be every migration from `008-` on. That test is outside my row.
- For G1 (`hosts.ts`): the edition values are `github | ghe_cloud | ghes`; `ghe_subdomain` is
  lowercase; GHES uses the existing `ghe_base_url`. `src/app/credentials.ts:69` still reads only
  `ghe_base_url`; wiring `edition` in there is outside my row.
- For G3 (C4): read `open_state_id`/`closed_state_id` with `readMappingParity`; NULL means fall back.
- For G2 (N2): `report_problems` is in `readMappingParity`; it defaults to false.
- For N6 (wave 2): `readRequireVerifiedCommits(db, config.REQUIRE_VERIFIED_COMMITS)` should replace
  the env read at `src/app/push.ts:51` (G2's file).

## Follow-up 1 (driver-assigned)

- `tests/ui/review-r5-ce.test.ts:416`: the upgrade from 001–007 now expects every migration from
  `008-` onward (`all.filter((f) => f >= "008-")`; `all` is sorted), so 009, 010 and any later one
  are included. Typecheck passes (`node scripts/typecheck.mjs tests/ui/review-r5-ce.test.ts`); not run.
- Follow-up 2 (`src/app/credentials.ts:69` edition and `ghe_subdomain` through G1's `hosts.ts`) waits
  for the driver's go once `hosts.ts` lands.
