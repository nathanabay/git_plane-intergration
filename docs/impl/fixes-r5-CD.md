# Round 5 fixes — CD

## F3 — installation authority

- `src/app/mappings.ts:35`: runtime repo/project lookups reject and audit unresolved NULL installations and installations not allow-listed for the mapping's workspace. Legacy mappings require verified saving before admission.
- `src/app/mappings.ts:65`: remembering a newly resolved/event installation conditionally updates the mapping only while the installation belongs to that mapping's workspace; failed checks cannot change its saved installation.
- `src/ui/mapping-check.ts:13` and `:59`: the verifier validates a positive installation ID, repository identity and workspace ownership, rechecks ownership after the GitHub lookup, and reports the verified ID through `onInstallationVerified`. CE's API captures this callback and persists the ID on POST/PATCH, including settings-only saves. CD did not edit CE's API.
- `src/app/mappings.ts:81`: `createOutboundAuthoriser` implements the agreed outbox dependency. Missing workspace, unresolved installation, revoked/moved installation or absent mapping refuses execution. GitHub writes check their stored installation and repo/workspace mapping. Plane create workflows recover their source authority from durable sibling GitHub writes, markers or continuation mappings; Smart Commit writes use their durable source-repository claim. Older standalone Plane writes conservatively require every candidate target mapping to remain authorized.
- `src/app/main.ts:118`: production ordered outbox receives `authoriseWrite: createOutboundAuthoriser(db)`. CB's outbox invokes it on stored templates before execution/resume and failed-intent reset/replay, records refusals terminally, and infers a missing GitHub workspace only during registration from a unique verified mapping. CD did not edit CB's outbox.
- `src/app/mappings.ts:149`, `src/app/main.ts:83`, `src/ui/client/Admin.tsx:28`: disabled/unresolved mapping inventory, instance-admin-authenticated GET route, and admin panel with workspace, repo, project, installation, reason and recovery guidance.

Proof in `tests/app/review-r5-cd.test.ts`: first-use denial and authorized ID capture (`:50`), admin inventory and workspace movement (`:77`), actual composed POST/PATCH persistence and settings-only revalidation (`:104`), queued Plane/GitHub revocation, terminal failure, blocked manual retry, cross-project workflow/Smart Commit authority and restored authorized dispatch (`:122`).

### Driver-authorized fixture updates

- `tests/app/fixes-r3.test.ts:54`: only the F7 NULL-install lookup retry fixture changed. It first verifies and saves its installation. To retain coverage of the installation-resolution fallback, it then simulates an admitted legacy snapshot lacking its cached ID; the underlying SQL still checks the real verified mapping and allow-list. The original 502 failure and handled 404 assertions remain, with added assertions that both lookups actually ran and neither produced a GitHub write.
- `tests/a8/reducers.test.ts:151`: only the webhook-remembers-installation fixture changed. It verifies/saves installation 1 first, allow-lists event installation 4242 for the same workspace, processes the real delivery, and asserts the saved ID changes from 1 to 4242. Neither fixture skips its reducer or weakens its original behavior assertion.

## F10 — live credential health source

`src/app/main.ts:61` passes `credentialStatus: () => credentials.describe()` into the production config routes. Health now reports the same authoritative source used by webhook verification after the database credential row disappears.

Proof: `tests/app/review-r5-cd.test.ts:93` uses the real credential source and composed HTTP routes, loads stored credentials, deletes their row, proves environment fallback is refused, and requires health to report `{ source: "database", decryptOk: false }`.

## Verification

Passed:

```text
node scripts/typecheck.mjs src/app/mappings.ts src/app/main.ts src/ui/mapping-check.ts src/ui/client/Admin.tsx tests/app/review-r5-cd.test.ts tests/app/fixes-r3.test.ts tests/a8/reducers.test.ts
typecheck passed (60 project files)

NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 --test-name-pattern='round 5 CD|F7: a transient installation-lookup|the installation id from a webhook' tests/app/review-r5-cd.test.ts tests/app/fixes-r3.test.ts tests/a8/reducers.test.ts
tests 8; pass 8; fail 0
```

Earlier unfiltered capped run of `tests/app/review-r5-cd.test.ts` and `tests/app/review-r4-sa.test.ts` also passed: 8 tests, 0 failures. The final three-file run selects CD's regression group and the two newly assigned fixtures; it does not execute the unrelated Postgres-container test in reducers.test.ts.

Two finding gates have direct permitted check evidence in `docs/impl/agent-gates/fix-r5-CD.GATES.md`. No oracle, heavy.sh, gate-check, whole suite, staging, commit or push was run. Legacy standalone writes without enough stored authority intentionally fail closed; their target-mapping fallback can block a write when another candidate mapping is disabled.
