# Round 2 fixes — CA

Shared translator remains `ruleEventsFor(source: "github" | "plane", event: string, payload: unknown): RuleEvent[]` in `src/app/rule-events.ts:67`. The dry-run adapter continues to delegate to it.

## F4

`runPushRules` in `src/app/rules.ts:95` uses only IDs from the introduced `payload.commits` for PR association. It does not look up `after` or `head_commit`, and performs no association lookup on a first push. A `branch.created` lifecycle targets only references from the branch name and introduced commit messages. Subsequent non-default pushes may additionally target active PR links only when the PR's head branch and head repository match the pushed branch and mapped repository. Matching names on a fork are excluded; missing repository identity is refused. Existing target deduplication and reference tiers remain in force.

Driver decision recorded in `.unlazy/impl/status.log` at 2026-10-11T09:57:25Z: default-branch pushes use commit-message references only, with no PR association. Their general `push` and `commit.pushed_to_default` automation still evaluates independently.

Tests in `tests/a8/fixes-r2.test.ts` reproduce the reviewer's empty-commit branch creation, a first push with ordinary commits, wrong-head/fork PR associations, and a head-tip SHA outside the introduced range. Positive controls retain same-branch associations and first-push commit references. A default-branch regression proves even a PR headed by `main` is excluded while the introduced `QLL-2` reference receives both custom push actions. The first three F4 tests failed before the routing changes: the first pushes reset the merged item's state, and the later push targeted four items instead of just its own branch's item.

## F5

`src/app/rule-events.ts:75` emits the exact lifecycle trigger `branch.created` only for a valid, first push of a non-default branch. First push is identified by `created: true` or the 40-zero `before` SHA. The repository's default-branch metadata must be present. General `push` remains available for custom automation on subsequent pushes; tags and deleted branches produce neither trigger.

`src/app/rules.ts:19` removes the saved/unsaved `ruleSet.defaults` special evaluator entirely. Saved YAML and compiled shipping defaults now use the same rules engine and event stream. GB owns the coordinated compiler/editor change: `branch_pushed` compiles to `branch.created`. SB owns the exact-trigger vocabulary entry in `src/rules/engine.ts`; arbitrary `branch.*` families remain unsupported. These dependencies were relayed through Orca CLI, approved by the driver and are now present.

`tests/a8/fixes-r2.test.ts` runs the same first-topic, later-topic, main and first-main payloads against saved and unsaved defaults, and compares the no-write dry-run evaluation too. Only the first non-default push starts its referenced item. The shared-translator test covers ordinary pushes, deleted branches, tags and default-branch creation. Before the fix, saved defaults reset items on subsequent topic pushes and main pushes; first-main creation also started work under both saved and unsaved defaults.

Driver decision recorded at 2026-10-11T10:06:09Z: pre-release, no persisted r1 tables; no upgrade path by design. The service is pre-release and has never been deployed, so the old compiler has no persisted configurations to migrate. Customized YAML remains unchanged; no metadata-only rewriting is introduced.

## F10

`src/app/rule-events.ts:23` emits `check_suite.<conclusion>` only for `check_suite` deliveries with `action: completed`. Individual `check_run` deliveries emit no suite automation. No run-level trigger vocabulary is introduced. Existing check-run CI rollups continue through SA's `handleChecks`.

`tests/a8/fixes-r2.test.ts` covers success and failure run payloads in both the shared translator and dry-run adapter. Its live test feeds successful and failed runs from one suite, verifies two CI rollup refreshes and zero suite-rule comments, then feeds the completed suite and requires exactly one suite-rule comment. Those checks failed before this change: each run translated to a suite event and produced a comment.

`tests/a8/rule-events.test.ts` now rejects run-level suite automation and uses complete PR-head fixtures for allowed branch associations. `tests/a8/harness.ts` includes `repository.default_branch`, as real GitHub push payloads do.

Targeted results: all 19 tests in `fixes-r2.test.ts` and all 20 updated `rule-events.test.ts` tests pass. The expanded missing-repository negative control also passes. The original new-file run reproduced 13 failures out of 15 tests before the routing changes.

## Coordinated F7 wiring

`src/app/reducers.ts:5` imports SA's real `handleCommitStatus` export, and `src/app/reducers.ts:22` routes GitHub `status` deliveries to it. The webhook ingress in `src/api/handler.ts` accepts event header values without an event allow-list, so no ingress change is required. SA documents the readiness evaluator and handler under `F7 wiring` in `docs/impl/fixes-r2-SA.md`.

The added live-routing test in `tests/a8/fixes-r2.test.ts:33` feeds status deliveries through `processInbound` and the composed router. A failure status performs no writes or association lookup; a success status with an approved PR and passing suites fires exactly one `pull_request.ready_for_merge` comment and readiness audit; another success delivery for the same head does not fire again. Neither delivery is audited as unhandled. This test failed without registration and passes with the route (1/1 targeted).

## Coordinated F6 delivery metadata

`src/app/reducers.ts:31` adds a nonempty, declared Plane `workspace_slug` to the delivery scope, as requested in CB's ordered-outbox integration contract. GitHub writes originating from Plane deliveries can then correlate outbound failure audits to their workspace. A workspace UUID is not treated as a slug; GitHub payload fields cannot supply this Plane metadata.

The boundary test in `tests/a8/fixes-r2.test.ts:16` checks declared slugs, UUID-only Plane deliveries, ignored GitHub fields and scope cleanup between jobs. The scope and live status routing tests pass together (2/2 targeted). With the earlier 19 regressions, the file now contains 21 tests.

The new ledger copies driver gates G0–G5 only. G2/G3 run through `scripts/heavy.sh`; ad-hoc tests use `NODE_OPTIONS=--max-old-space-size=1024` and `--test-timeout=60000`. Final machine evidence is in `docs/impl/agent-gates/fix-r2-ca.GATES.md`. No staging or commits are part of CA's work.
