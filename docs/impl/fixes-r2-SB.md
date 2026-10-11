# Round-2 fixes, implementer SB

## F1 Mapping writes fail closed without a verifier (API half)
`src/ui/api.ts` `authoriseMapping` now throws 503 when `deps.verifyMapping` is absent, instead of returning (create and any update that
changes the project or repository). Settings-only PATCHes need no verification and still work. `tests/ui/harness.ts` supplies a permissive
verifier by default and `null` omits it. Test: `tests/ui/workspace.test.ts` "r2 F1: without a mapping verifier ...". SA wires the real
verifier in `src/app/main.ts`. Not done here (needs schema or `src/app`, outside SB's OWNS): the per-workspace allow-list of installation ids.

## F12 Manual user links are checked against GitHub (API half)
`PUT /user-links/:id` calls the optional `lookupGithubUser` dependency: unknown account 422, id mismatch 422, outage 502 (nothing stored); the
stored login is GitHub's canonical casing. `createGithubUserLookup(request)` in `src/ui/mapping-check.ts` builds it from an App/installation
request function (`GET /users/{username}`); SA wires it. Tests: "r2 F12" x2 in `tests/ui/workspace.test.ts`. Workspace-membership checks,
resolving actors by `sender.id` and the unlink tombstone live in `src/app` / the schema, outside SB's OWNS.

## F14 Large pushes (Smart Commit half)
`commitsOf` in `src/github/smart-commits.ts` treats `listCommitRange` as untrusted: malformed entries are dropped, duplicates collapse, the
range is capped at `MAX_RANGE_COMMITS` (10000, audited as `smart_commit_truncated`), and the payload's own commits are always kept, so an
empty or short range loses nothing. Without a lookup the loud audit stays. Tests: "r2 F14" x2 in `tests/github/smart-commits.test.ts`.
SA wires the lookup in `src/app/push.ts`.

## F15 Credential source in the instance API
`GET /instance/health` adds `githubAppCredentials: { source: "database" | "environment", decryptOk }`; `decryptOk` is false when the stored
row no longer decrypts with the token key. Test: "r2 F15" in `tests/ui/instance.test.ts`. The no-fallback-after-first-read and null-URL
behaviours are in `src/app/credentials.ts`, outside SB's OWNS.

## F16 Smart Commit lock timeout
The lock wait is bounded (`lockTimeoutMs`, default 30 s) in both layers: the in-process queue races its turn against a timer, and the
cross-replica lock uses `pg_try_advisory_lock` in a poll loop on its dedicated connection. Expiry throws `SmartCommitLockTimeout`
(a `SmartCommitRetry`), so the delivery retries; a timed-out waiter releases its place so it never blocks the queue. Test: "r2 F16" (the
in-process path; the advisory path needs a real Postgres pool and is not reachable with PGlite). Per-request Plane timeouts are in
`src/sync`, outside SB's OWNS.

## F5 support for CA
`src/rules/engine.ts` `validateTrigger` accepts the exact trigger `branch.created` (the §7.1 "branch pushed" point, emitted by CA on the first
push of a non-default branch). `branch.*`, `branch.deleted` etc. stay unknown. Test: "branch.created is an exact trigger ..." in
`tests/rules/engine.test.ts`.

## Test memory
Round-1's `afterEach` closing of PGlite databases in `tests/github/fakes.ts` remains; no new unbounded loops.

## F6 support for CB
`SecretString` has an optional readonly `planeUserId`; `TokenVault.load(userId, kind)` attaches it (`src/auth/identity.ts`), so a queued write can persist the owner id and reload the current PAT at execution time, never the plaintext. The tag is not part of the redacted JSON/inspect output. Test: "TokenVault.load tags the token with its owner" in `tests/auth/identity.test.ts`.
