# Round 5 CE fixes

F7 and F8 are implemented. The driver-relayed F3 mapping API seam is also implemented. Only CE-owned implementation paths, the required CE gate ledger and this report were written. Nothing was staged, committed or pushed.

## F7 — unlink serialization and authority

- `src/db/ledgers.ts:286`: `withUserLinkTransaction` leases a dedicated production connection, starts a transaction and locks the workspace's durable `user_link_locks` row. The workspace lock covers every account decision, including replacement of an existing account and DELETE addressed by Plane user ID. Single-connection engines serialize transactions locally.
- `src/ui/api.ts:332`: manual linking updates the map and clears suppression in the same locked transaction. `src/ui/api.ts:346`: unlink deletes the map, writes the tombstone and revokes all user tokens on that same connection; any mutation or commit failure rolls back the group.
- `src/app/identity.ts:39`: both the existing-map decision and final auto-link check/insert use the same transaction helper. Tombstones precede existing mappings. Suppression heals stale resurrected mappings and their tokens. Unavailable database authority throws after audit, preventing `actorTokenFor` from performing its later unchecked mapping lookup; external profile lookup failures retain service fallback.
- `src/db/migrations/008-identity-locks-credential-retirement.sql:3`: creates the lock table. Its cleanup at line 8 removes old mappings contradicted by tombstones and revokes their tokens. `src/db/schema.ts:10` registers the table name.

Proof: `tests/ui/review-r5-ce.test.ts:47` and `:87` exercise both real API/auto-link interleavings, including the final-negative-check/insert boundary and the deleted-map/before-tombstone boundary. `:116` injects failures into map deletion, tombstone insertion, token revocation and commit; `:136` checks manual relink rollback. `:151` drives actual actor resolution with suppression and authority-read errors. `:176` verifies that no transaction query escapes to the pool. `:366` additionally observes a real PostgreSQL lock wait between independent pools and verifies no map remains after unlink.

## F8 — durable bootstrap retirement

- `src/config/env.ts:1` and `:50`: configure `GITHUB_CREDENTIAL_MARKER_PATH`, defaulting to `/var/lib/gitsync/credentials/bootstrap-retired`. `src/app/credentials.ts:30` uses that configured location rather than the PEM directory.
- `src/app/credentials.ts:53`: persist retirement in the database and synchronously write/fsync the marker and containing directory before accepting database credentials. Mandatory persistence errors remain visible and refuse verification.
- `src/app/credentials.ts:66`: cold database outages always refuse credential verification, including when no marker exists or a save preceded the first source read. Only previously loaded database credentials survive a warm outage. Environment credentials require a successful database retirement check on every load; retirement-read errors are never treated as absence.
- `docker-compose.override.yaml:16`, `deploy/git-sync.env.example:30` and `deploy/APPLY.md:66`: wire a separate persistent writable state bind mount and document provisioning it for uid/gid 1000, preserving it across recreation and backing it up.
- `src/db/migrations/008-identity-locks-credential-retirement.sql:17`: atomically retire bootstrap credentials through a config-save trigger, and backfill existing config rows. `src/ui/api.ts:482` relies on this trigger instead of a separately committed marker query. This closes the save-before-first-read window.

Proof: `tests/ui/review-r5-ce.test.ts:216` uses actual non-root child processes with a read-only secret directory and a separate persistent state directory. It verifies successful persistence, mandatory failure at the old secret-directory location, process recreation and rejection of the retired secret's signature with no enqueue. `:256` proves the missing-marker cold-outage case. `:265` supplies a healthy bootstrap positive control, refuses warm environment-cache/outage and retirement-read failures, and preserves verified database credentials during a warm outage. `:288` proves mandatory marker failure; `:304` proves save-before-first-read retirement; `:318` checks deployment wiring.

Migration proof: `tests/ui/review-r5-ce.test.ts:366` verifies PostgreSQL **15.7** (`server_version_num = 150007`), applies all 001–008 migrations to a fresh database, separately creates an already-migrated 001–007 database and upgrades it with 008 only, then reruns migration with no changes. It checks `workspace_installations` exists and its seeded row survives, existing credentials are backfilled, suppressed legacy maps/tokens are removed, retirement survives config deletion, new saves trigger retirement, and a forced retirement failure rolls back credential rotation. All four existing tests in `tests/db/migrate.test.ts` passed unchanged.

The non-root credential tests reproduce filesystem permissions and fresh-process state; the production service image was not deployed.

## Relayed F3 seam

`src/ui/api.ts:149` captures and validates `onInstallationVerified(id)`. POST at `:191` persists `installation_id`; PATCH at `:208` verifies the effective project and repository even for settings-only updates and persists the verified ID. A success result without a verified ID fails closed with 503. No disabled-mappings inventory route was added here; CD owns that route.

Proof: `tests/ui/review-r5-ce.test.ts:328` exercises POST, settings-only PATCH, project-only PATCH, ID persistence and revoked-authority rejection; `:358` rejects a verifier that returns success without certifying an installation.

## Validation

Executed sequentially, directly, with no oracle, heavy runner, gate-check or whole-suite run:

```text
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/ui/review-r5-ce.test.ts tests/db/migrate.test.ts
```

Exit 0: **19 tests passed, 0 failed, 0 skipped** (15 CE tests and 4 existing migration tests), duration 54,825.97 ms. The final run used two test files, heap 1024 and concurrency 1.

```text
node scripts/typecheck.mjs src/ui/api.ts src/app/identity.ts src/app/credentials.ts src/config/env.ts src/db/ledgers.ts src/db/schema.ts tests/ui/review-r5-ce.test.ts tests/db/migrate.test.ts
```

Exit 0: **typecheck passed (53 project files)**. The lightweight ledger records direct results; formal gate-check evidence is left to the driver under the round restrictions.

## Driver-owned fixture adjustments

These older tests were inspected, not executed or edited; their assumptions deliberately conflict with the fixes:

- `tests/ui/harness.ts:72`: successful default verifier must invoke `check.onInstallationVerified?.(1)` before returning null. Its previous null-only stub no longer certifies a mapping. This affects mapping setup in workspace, auth and operations tests.
- `tests/ui/workspace.test.ts:185`: its custom success stub also needs the callback; capture only serializable identity fields for the `seen` comparison because the input now includes the callback. Settings-only updates at `:213` now verify and reject the configured refusal with 422, rather than bypassing it. The unwired settings-only PATCH at `:316` must now expect 503.
- Credential fixtures in `tests/ui/review-r4-sb.test.ts:61`, `tests/app/fixes-r2.test.ts:79` and `tests/queue/fixes-r1.test.ts:66` need an explicit `GITHUB_CREDENTIAL_MARKER_PATH` inside their writable temporary directory. The round-4 sibling-marker assertion at `tests/ui/review-r4-sb.test.ts:78` should check the configured path. The cold database-outage bootstrap expectation at `tests/app/fixes-r2.test.ts:98` must expect rejection; a missing marker cannot establish safe retirement history. Healthy-database bootstrap remains supported and positively tested.

## Adjusted fixtures

The driver authorized these five files in the follow-up. The fixture handoff above is now completed; no implementation code changed in this follow-up.

- `tests/ui/harness.ts:72`: the successful default verifier invokes `onInstallationVerified(1)`.
- `tests/ui/workspace.test.ts:186`: the custom verifier captures serializable identity fields and invokes the callback only on success. Its settings-only PATCH assertions now require verification: 422 for a refusal at `:215`, and 503 for an unwired verifier at `:318`.
- `tests/ui/review-r4-sb.test.ts:67`: credentials use an explicit marker path in writable temporary storage; `:78` checks that configured path. The healthy-database environment bootstrap positive test remains intact.
- `tests/app/fixes-r2.test.ts:81`: credentials use explicit temporary marker storage. `:85` positively asserts healthy-database bootstrap; `:101` rejects cold-outage bootstrap with a fresh, absent marker.
- `tests/queue/fixes-r1.test.ts:67`: credentials use explicit temporary marker storage. Existing healthy-database environment secret/private-key assertions remain intact.

Both capped batches exited 0 with no failures or skips (**46 tests passed**):

```text
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/ui/workspace.test.ts tests/ui/review-r4-sb.test.ts
```

32 passed; duration 50,295.47 ms. This batch also exercises the adjusted shared UI harness.

```text
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/fixes-r2.test.ts tests/queue/fixes-r1.test.ts
```

14 passed; duration 34,207.14 ms. Batches ran sequentially, with two test files each, heap 1024 and concurrency 1.

```text
node scripts/typecheck.mjs tests/ui/harness.ts tests/ui/workspace.test.ts tests/ui/review-r4-sb.test.ts tests/app/fixes-r2.test.ts tests/queue/fixes-r1.test.ts
```

Exit 0: **typecheck passed (56 project files)**. No oracles, heavy runner, gate-check, whole suite, staging, commits or push.
