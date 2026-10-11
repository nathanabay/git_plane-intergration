# Round 4 fixes — SA

## F1 — allow-list wired
`src/app/main.ts:58` passes `installationWorkspace: installationWorkspaceFromDb(db)` to `createMappingVerifier` (import added at the top).
Proof: `tests/app/review-r4-sa.test.ts` "F1" drives `composeRoutes` over HTTP: allow-listed installation → 201, unlisted → 422, another workspace's → 422.

## F5 — existing mappings obey the allow-list
`src/app/mappings.ts` (`allowedMappings`, used by `mappingsForRepo` and `mappingsForProject`): `LEFT JOIN workspace_installations` on installation id AND workspace slug. A non-matching row is skipped and audited as `installation_not_allowed` (outcome `skipped`).
A row whose `installation_id` is still NULL passes through: it cannot be judged here, and `installationFor` (src/app/context.ts, not mine) remembers the id on first use, after which the check applies.
Proof: test "F5" — a mapping on an installation listed for another workspace is skipped and audited; deleting the allow-list entry stops both lookups.

## For the driver (files I do not own)
1. **Existing tests now fail** (12 in `tests/app/*.test.ts`: fixes-r2/r3, pr-new-plan, ready-for-merge, mirror-rules) because `tests/a8/harness.ts:134` `mapping()` inserts `installation_id = 1` with no `workspace_installations` row. Fix: have `mapping()` also `INSERT INTO workspace_installations (installation_id, workspace_slug) VALUES (installationId, slug) ON CONFLICT DO NOTHING` when installationId is non-null. (Other suites using that harness or inserting repo_mappings directly may need the same.)
2. APPLY.md should list existing mappings without an allow-list entry (`SELECT rm.* FROM repo_mappings rm LEFT JOIN workspace_installations wi ON wi.installation_id = rm.installation_id AND wi.workspace_slug = rm.workspace_slug WHERE rm.installation_id IS NOT NULL AND wi.installation_id IS NULL`); `/instance/health` (SB's api.ts) could report the same.
3. Optional hardening: `installationFor` should refuse a freshly resolved installation that is not allow-listed for the mapping's workspace, closing the NULL-installation gap.

## Relay: retryFailed wiring
`src/app/main.ts:43` optional `RouteParts.retryFailed` (returns `{ok:true; retried:boolean}`), passed into `operations` at `:70`, supplied from `ordered.retryFailed` at `:126`. Proof: typecheck passes against CB (outbox.ts:314) and SB (ui/api.ts:35); no route test of mine (the route is SB's).

## Follow-up: tests/a8/harness.ts (SA DONE 2)
- `mapping()` now inserts the `workspace_installations` row (`ON CONFLICT (installation_id) DO NOTHING`) for a non-null installation, so a8 suites exercise the real allow-list (F5).
- The harness config seeds `PLANE_SERVICE_USER_ID: over.serviceUserId ?? "svc-user-default"` (CA, prev F17); `makeHarness({ serviceUserId })` overrides it. The inbound `serviceUserId` dep is still passed only when a test asks for one, so echo-suppression behaviour is unchanged.
- Typecheck of the harness passes.
- Results, batches of ≤3 files, `--test-concurrency=1`, heap cap 1024:
  - pr-new-plan, ready-for-merge, review-r4-sa: 4/5 pass. Before the harness fix, the allow-list failures (smart-commit attribution, ready-for-merge, F14 push, etc.) were failing; they now pass.
  - fixes-r2, fixes-r3, mirror-rules: 12/16 pass.
  - service-plan, queue/fixes-r1: 11/14 pass.
- **Remaining 8 failures are not the harness.** 7 stop at `OrderedWriteDeferredError` ("an earlier outbound intent must finish first", src/operations/outbox.ts, CB): mirror-rules ×3, pr-new-plan "-NEW create", service-plan ×2 ("edit received while partner pending", "GitHub opt-in create"), fixes-r1 "fast worker cannot run the rule twice". The tests' drive loop retries deferred jobs but makes no progress, so the item is never created. Likely a consequence of CB's F2/F3 ordering change, so CB (or the test owners) should check. The 8th is fixes-r2 "F15: credential source…" failing with "db down" (SB's `src/app/credentials.ts`).

## Follow-up 2: realistic fake Plane in tests/a8/harness.ts (CC relay, F9)
- Issue create stores `external_source`/`external_id` from the body and returns them; `GET …/issues/?external_source=…&external_id=…` returns the stored object (200) or 404.
- Comment create stores and returns the external ids; `GET …/issues/<id>/comments/` returns the stored comments (`results`, `next_cursor: null`, `next_page_results: false`).
- Typecheck of the harness passes. Capped runs (heap 1024, concurrency 1, ≤3 files):
  - service-plan + queue/fixes-r1 + pr-new-plan: 15/15 pass (the earlier `OrderedWriteDeferredError` stalls were this missing lookup, not CB's outbox — my earlier guess was wrong).
  - fixes-r2 + fixes-r3 + mirror-rules: 15/16; the one failure is fixes-r2 "F15: credential source…" ("db down"), SB's `src/app/credentials.ts`.
  - ready-for-merge + review-r4-sa: 4/4 pass.
