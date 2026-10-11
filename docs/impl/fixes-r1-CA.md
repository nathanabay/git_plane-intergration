# Round 1 fixes — CA

Shared delivery translator: `ruleEventsFor(source: "github" | "plane", event: string, payload: unknown): RuleEvent[]`, exported from `src/app/rule-events.ts:68`. Live adapters and CB's dry-run adapter delegate to this function. A default-branch push emits `push` followed by `commit.pushed_to_default`.

## F7

`src/app/rule-events.ts:14` translates branch pushes, default-branch commits, completed check suites/runs, deployment states, issue actions and comment actions into A6 events. It preserves repository, sender, branch, labels and issue/comment/deployment template context where present. Plane create/update/delete spellings are normalised to created/updated/deleted too. Tags, deleted branches and incomplete checks emit no rule events.

`src/app/rules.ts:92` resolves active `sync_links` within the mapping's workspace and project. `runRules` deduplicates targets while retaining the strongest reference tier; label opt-in links count as closing for rule actions. `runPushRules` (`src/app/rules.ts:100`) combines branch/commit references with links of PRs associated with pushed commits, deduplicating both SHAs and PR numbers. Associated PRs are paginated; unknown/inaccessible references are audited and do not discard valid targets. Saved custom `push` rules receive later pushes too; the unsaved shipping branch lifecycle still starts work only on the first push (§7.1).

SA-owned hooks, relayed through Orca CLI and now present in the tree: import `runPushRules` from `./rules.ts` in `src/app/push.ts`; call `await runPushRules(ctx, mapping, job)` once per mapping after Smart Commits; remove `pushedToDefault`; remove the `runRules` call from `branchPushed` while retaining branch rollups. This prevents branch-create double execution and lets later pushes reach custom rules. Existing `checks.ts` and `issues.ts` hooks consume the shared adapters. Plane-side `runRules` calls must set `source: "plane"` in their options. CA does not edit these SA-owned files.

Regression tests: `tests/a8/rule-events.test.ts` checks the shared translator against the dry-run adapter, live issue/comment rules (including comments on PRs), check suite/run rules, deployment rules, active-link isolation, associated-PR push targets, strongest-tier deduplication, exactly-once branch-create handling, both default-push triggers in order, and Plane audit source. The first run reproduced both missing later-push targets (zero comments instead of one) and the wrong Plane audit source (`github` instead of `plane`). `tests/a8/reducers.test.ts` retains first-branch-push and later-push shipping-default coverage.

## F10

`tests/a8/harness.ts:26` supplies stable label UUIDs and a project label endpoint. Label upserts exercise the existing-label 409 response and return the existing UUID, while newly created labels get distinct UUIDs. `tests/a8/echo-loop.test.ts:9` models the probe's field-granular activity, including `old_value`, `new_value`, actor/email and expanded snapshot data. The opt-in creation fixture uses `label_ids` with a UUID array rather than a label-name string.

`tests/a8/echo-loop.test.ts:127` captures the exact GitHub→Plane label PATCH, feeds its UUID array back as `activity.field: labels` alongside expanded `data.labels`, requires ingress outcome `echo`, and asserts both write counts remain identical: exactly zero extra Plane or GitHub writes. The former string fixture cannot satisfy the required `echo` assertion, and the former one-write tolerance is removed.

Separate human-edit tests cover both `labels` and `label_ids`, asserting the exact GitHub label-add and label-remove requests. Removed IDs are resolved through the project's label endpoint because they are absent from the current expanded snapshot. The resulting GitHub echoes are also required to produce zero further writes. Web-app `assignee_ids` UUID-array add/clear and `state_id` edits cover the other measured request-key aliases. An API `assignees` UUID-array echo has the same strict zero-write requirement. Harness cleanup runs even when an assertion fails.

The two assignee fixtures in `tests/a8/reducers.test.ts:86` now carry UUID-array activities and expanded snapshot users. Their expected writes reflect F5: unmapped GitHub assignees remain, while a removed mapped assignee is explicitly represented in the user map.

Targeted verification: the F7 file passed 21/21 tests; the echo-loop file passed 16/16 before adding the separately passing API-assignee echo test; the four selected assignee/branch reducer regressions passed. Verification commands: targeted files run with `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000`; the final G0–G5 results are checker evidence in `docs/impl/agent-gates/fix-r1-ca.GATES.md`. G2 and G3 use `scripts/heavy.sh`; G6 remains driver-owned. No spec disagreement, staging or commit is part of this leaf.
