# Round-1 fixes, implementer SB

## F2 Mapping writes authorised against workspace and installation (config-API half)
`src/ui/mapping-check.ts` adds `createMappingVerifier`: the Plane project is fetched with the service PAT
(`GET /workspaces/{slug}/projects/{pid}/`; 404/403 is refused) and the repository through the App
(`installationIdFor` then `GET /repos/{owner}/{repo}`; the id and the full name must match). `src/ui/api.ts`
calls it on mapping create and update (`authoriseMapping`): a refusal is 422 and nothing is stored, an outage
is 502. Tests: `tests/ui/workspace.test.ts` ("F2: mappings are verified..." both refusals and the outage;
"F2: createMappingVerifier ..."). The verifier is an injected dependency (`verifyMapping`); constructing it in
`src/app/main.ts` and the runtime `workspace_slug` filter are outside SB's OWNS.

## F8 Smart Commits retry without re-applying finished commands
`src/github/smart-commits.ts`: every command is its own step with an id `sc:<sha>:<command>:<key>:...`
recorded in the audit ledger on success or on a permanent failure (unknown item or state, other 4xx, triage
ban). A transient failure (network, 429, 5xx) is not recorded; the commit is not claimed and
`SmartCommitRetry` is thrown after the whole push is processed, so the delivery retries and skips the steps
already recorded. The commit is claimed only when nothing is pending. Work per SHA runs under an in-process FIFO lock keyed by (database, workspace, sha) plus, on pooled engines, an advisory lock
(a single-connection engine only serialises single queries, so the earlier "serialises on its own" shortcut let two concurrent
deliveries both act).
Tests: the "F8:" tests in `tests/github/smart-commits.test.ts` (retry applies only what is missing, crash
resume, concurrency, permanent versus transient).

## F16 Claim per (sha, workspace)
`processPush` calls `claimCommit(db, sha, repoId, workspaceSlug)` and checks the claim by `(sha, workspace)`;
a pre-F16 row with an empty workspace still counts as done. Tests: the "F16:" tests in
`tests/github/smart-commits.test.ts`.

## F18 Pushes with more than 20 commits
`SmartCommitDeps.listCommitRange(before, after)` supplies the `compare/{before}...{after}` commits. When the
payload lists 20 commits the full range is processed in order without duplicates; a lookup failure fails the
delivery (retried); a new-branch push or a missing lookup is audited as `smart_commit_truncated`. Tests: the
"F18:" tests. The App-side implementation of `listCommitRange` belongs in `src/app/push.ts`, which SB does not own.

## Test memory note
The runaway memory seen in `tests/github` was not a retry loop: `freshDb()` kept every per-test PGlite (WASM memory outside the V8
heap, so `--max-old-space-size` does not bound it) open until the file ended. `tests/github/fakes.ts` now closes each test's
databases in `afterEach`. All retries are bounded by design: a transient failure rethrows once per delivery; the redelivery is the retry.
