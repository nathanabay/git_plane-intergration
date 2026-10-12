# Round 8 fixes — CD

## Review-8 F1 — resolve the orphan's source mapping

`src/app/main.ts:210` now calls `mappingForOrphanLink` before inspecting the mapping's linkback toggle or resolving/freezing its installation. New notifications retain the resolved source mapping's `_authority`.

`src/app/mappings.ts:75` resolves project-scoped label mirrors by repository, workspace and the link's `plane_project_id`, requiring one authorized matching mapping. An earlier mapping for another project cannot suppress or enable that notification, and a deleted owning project mapping cannot be replaced by the surviving unrelated mapping.

For PR links, the resolver recovers the source from a retained Plane create whose saved result identifies the orphan and whose resolved sync-link action matches the complete workspace/project/item/repository/PR identity. It uses that workflow's frozen `_authority.mappingId`; older workflows can recover the explicitly recorded original `pr_created` continuation mapping. It then requires that exact mapping to remain authorized for the link's repository/workspace. The target project's current mapping is never used to guess PR ownership. Missing, conflicting or malformed provenance, and a missing source mapping, skip the notification. PR links without retained create provenance likewise skip rather than adopt a target mapping; no schema or unowned writer changes were made.

## Proof

`tests/app/review-r8-cd.test.ts` uses real mirror/PR reducers, the production ordered outbox authorizer and `reconcileOnce` with its full `SyncLinkRow` callback:

- QLL is created first with linkback off, WEB has linkback on: an actual WEB mirror is orphaned and produces a WEB-stamped notification.
- Opposite toggles: the WEB orphan is silent despite QLL enabling linkback.
- Deleting WEB's owning mirror mapping while QLL survives produces no notification.
- Actual `WEB-NEW` creation through QLL uses retained QLL provenance for both toggle combinations, despite a separate WEB target-project mapping.
- Deleting the PR source mapping, or removing its retained create evidence, cannot substitute the surviving WEB mapping.
- An older create workflow without `_authority` recovers its explicitly stored source continuation.

## Validation

```text
node scripts/typecheck.mjs src/app/main.ts src/app/mappings.ts tests/app/review-r8-cd.test.ts tests/app/review-r7-cd.test.ts tests/a8/reducers.test.ts
typecheck passed (55 project files)

NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 --test-name-pattern='^F1:|^F3:|^an orphaned link is reported|^with linkback off an orphan' tests/app/review-r8-cd.test.ts tests/app/review-r7-cd.test.ts tests/a8/reducers.test.ts
tests 11; pass 11; fail 0; cancelled 0
```

The round-8 regression file also passed separately: 7 tests, 0 failures. The final three-file run selects all round-7/round-8 CD regressions and the two assigned orphan fixtures in reducers.test.ts.

Only assigned code/test files, including the two subsequently assigned fixture files, and this requested report were written. No staging, commit, push, oracle, heavy.sh, gate-check or whole-suite execution occurred.

## Driver-authorized fixture repairs — completed

Round-8 source resolution made the older partial orphan objects stale. The driver assigned their narrow updates after the initial report:

- `tests/a8/reducers.test.ts:135` and `:147`: added `plane_project_id: "p-qll"`, `gh_kind: "issue"`, and `created_by: "label_sync"`. All enabled/disabled, comment-route and no-close assertions are unchanged.
- `tests/app/review-r7-cd.test.ts:22`: added the same complete mirror metadata for its original `p-qll` source. The fresh callback at `:39` now uses `plane_project_id: "p-web"` and a distinct `plane_issue_id: "new-orphan"`, owned by the remaining mapping. All execution/Retry refusal, unchanged-authority, legacy-row and fresh-source positive-control assertions are unchanged.

Both repairs passed in the final capped run above. No fixture handoff remains.
