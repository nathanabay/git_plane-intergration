# Round 6 fixes — CD

## F1 — authorize continuations before API destinations

`src/app/mappings.ts:116` and `:125`: both frozen and legacy `resume_reducer` writes are authorized by their stored continuation mapping and workspace before any destination-specific API branch. A GitHub-queued continuation needs no GitHub API write fields. Actual GitHub writes still require the installation/repository checks. Revocation remains enforced during execution and failed-intent reset through the existing production authorizer wiring at `src/app/main.ts:118` (unchanged).

Proof: `tests/app/review-r6-cd.test.ts:66` registers a real QLL-NEW PR with `createOutboundAuthoriser` installed, succeeds at creation, fails its GitHub-side resume, repairs through `replayDelivery`, and verifies one partner, original opened rule, OPEN rollup and linkback. Another replay adds no continuation effects. `:91` exercises a real Plane-to-GitHub mirror event deferred behind creation, continuation failure, revoked retry refusal, repaired dispatch of the renamed title and once-only replay. `:187` proves legacy continuations work on both queues, reject mismatched workspace/revocation, and do not exempt actual GitHub API writes.

## F2 validation — frozen source authority without completion claims

`src/app/mappings.ts:20` exports `FrozenWriteAuthority`; `:28` exports `freezeMappingAuthority`, which captures and freezes workspace, mapping ID, repository ID and verified installation ID. Its input accepts the four required fields, so both app mappings and mirror mappings use the same helper.

`src/app/mappings.ts:107`: when `_authority` is present, the authorizer fails closed on malformed authority, missing/mismatched workspace, missing mapping or changed repo/installation, and rechecks the exact installation allow-list entry. It checks only the frozen source mapping; SHA claims and unrelated target mappings cannot grant access. The dispatched target must match the frozen workspace/repository/installation as appropriate. Older rows without `_authority` retain the existing legacy checks, except for the corrected continuation branch order.

Proof: `tests/app/review-r6-cd.test.ts:119` executes a command on another project before any processed-commit claim exists, then proves malformed snapshots, missing/wrong workspace, repo edits, installation edits, installation movement and source deletion refuse it even when another target mapping exists. The final capped run also passed CB's actual first-command execution between two registrations, transient later-key lookup, once-only repair and immutable source-authority tests in `tests/writers/review-r6-cb.test.ts:14` and `:59`.

## F4 — workspace-isolated rollups with source ownership

`src/app/checks.ts:21`: linked PR targets are deduplicated and restricted to `mapping.workspaceSlug`; each target explicitly carries the frozen mapping snapshot. `:15`, `:48` and `:71` enter the verified mapping's authority scope for checks, deployments and commit-status readiness, so their rule writes also retain source authority at registration.

`src/sync/dev-info.ts:100`: `RollupTarget` carries `_authority` through the existing durable upsert path and inline add/update fallback. CB's registration captures it once and removes it before remote dispatch. The authorizer above prevents a surviving sync link or another authorized target mapping from replacing the original source mapping's permission.

Proof: `tests/app/review-r6-cd.test.ts:149` retains the old active PR control link, moves the installation, deletes the old source mapping, leaves an unrelated authorized mapping for the old target project, and processes actual check/deployment deliveries. Build, deployment and preview intents all contain the new source snapshot and write only to the new workspace. A queued rollup is then rejected after its source mapping is deleted, despite another mapping authorizing its target project.

## Cross-owner integration

The agreed helper/scope interface was relayed through the driver. CA stamps PR/issue writes and resumed work; CC scopes mirror reducers; CB freezes `DeliveryContext.authority`/plan authority on registration and validates dispatch/reset through this authorizer. The missing scope in `src/app/push.ts` was reported to the driver with the exact per-mapping scope change; that driver-owned edit is now present and supplies authority to production Smart Commits, branch rollups and push rules. CD edited none of those owners' files.

CD changed only `src/app/mappings.ts`, `src/app/checks.ts`, `src/sync/dev-info.ts`, its new test file, and the requested ledger/report. `src/app/main.ts` already supplies the authorizer and needed no edit. No stale fixtures were assigned to or changed by CD this round.

## Validation

```text
node scripts/typecheck.mjs src/app/mappings.ts src/app/checks.ts src/sync/dev-info.ts src/app/main.ts tests/app/review-r6-cd.test.ts
typecheck passed (53 project files)

NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r6-cd.test.ts tests/writers/review-r6-cb.test.ts tests/dev-info/outbox.test.ts
tests 12; pass 12; fail 0; cancelled 0; duration 47851.721534 ms
```

CD's own regression file also passed separately: 5 tests, 0 failures. Three finding gates have direct-check evidence in `docs/impl/agent-gates/fix-r6-CD.GATES.md`. No oracle, heavy.sh, gate-check, whole suite, staging, commit or push was run.
