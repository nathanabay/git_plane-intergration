# Round 4 fixes — CC

F4 is fixed in `src/sync/mirror.ts:103`: `nextCreateGeneration` selects a new key after a finished, unlinked create, retains the original object's pending-marker key, and refuses a second create while its group is live. It also recognises retained marker steps if retention prunes the root first. The exported `createPlanRoot` (`:100`) and `nextCreateGeneration` are shared with SC's PR create path. Both mirror directions supply the selected generation and stable marker to CB's outbox (`:316`, `:509`).

Mirror creates and pending-event continuations check the registration result (`src/sync/mirror.ts:96`, `:358`, `:527`). An explicit `inserted:false` returns `ignored`, allowing the ordinary inbound rules to run. As requested by the driver, a missing flag from a legacy adapter counts as true. `deferPendingMirror` excludes markers whose group has a failed write (`:84`), so edits do not join a permanently failed group.

F4 proof in `tests/mirror/review-r4-cc.test.ts`: orphan/re-label across three generations with one rule execution per generation and replay checks (`:118`); Plane re-opt-in (`:137`); partially pruned history (`:149`); a failed generation's persisted terminal state (`:160`); duplicate registration still allowing the inbound rule (`:171`); stale failed markers (`:190`); duplicate continuation registration (`:204`); legacy adapters (`:217`); and a stable marker key across generations (`:236`). These use a self-contained fixture with real PGlite migrations, reducers, ordered outbox and write paths, with fake HTTP edges.

prev F5 is fixed in `src/sync/mirror.ts:260`: GitHub assignees resolve from `user_map` by `(workspace_slug, gh_id)`, with no login fallback. Missing, invalid or unmapped numeric IDs produce no assignment; duplicate IDs produce one assignment. This shared function handles creates and later assignment/unassignment events. Proof: `tests/mirror/review-r4-cc.test.ts:251` covers rename, recycled login, duplicate accounts, workspace isolation and missing IDs on create; `:266` covers updates, clearing and invalid IDs.

The orphan regression exposed a separate schema prerequisite: migration 003's `uq_sync_links_label_sync` included orphaned rows. CC relayed the exact SQL to the driver, and SB added the active-only index replacement in migration 007. CC edited no migration. The final tests pass against that migration while retaining orphaned links.

Validation, run directly as required:

- `node scripts/typecheck.mjs src/sync/mirror.ts tests/mirror/review-r4-cc.test.ts tests/mirror/mirror.test.ts tests/mirror/service-plan.test.ts` — passed, 45 project files, against CB's final production `{ok:true, inserted:boolean}` and optional legacy-adapter declaration.
- `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/review-r4-cc.test.ts tests/mirror/mirror.test.ts` — 37 passed, 0 failed (11 CC regressions and 26 existing mirror tests).
- `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/service-plan.test.ts` — 5 passed, 0 failed.
- Total after fixture updates: 42 targeted tests passed across two sequential capped runs. Every follow-up test command used a 1024 MB heap, concurrency 1, a 60000 ms timeout, and at most three files.
- Ledger: 3 met, 0 unmet, 0 abandoned; evidence recorded manually from these executions.

Driver-granted fixture edit: `tests/mirror/mirror.test.ts:44` now seeds `(qelal, u-octo, octo, 1)` in `user_map`; `:57` supplies numeric IDs 1 and 2 on the existing GitHub assignees. This is exactly the authorised fixture fix for prev F5. All assertions remain unchanged, and the two formerly failing assignee tests now pass.

The initial capped three-file rerun found those two fixture failures plus three service-plan failures: the shared a8 harness returned HTTP 200 `{}` for CA's new external-ID lookup. CC relayed the harness mismatch to the driver without editing that unowned file. The shared fixture was updated by its owner; the final separate service-plan run passes all five tests. No failure remains in the affected files.

Files written: `src/sync/mirror.ts`, `tests/mirror/review-r4-cc.test.ts`, the expressly granted fixture changes in `tests/mirror/mirror.test.ts`, this report, and `docs/impl/agent-gates/fix-r4-CC.GATES.md`. No spec disagreement or remaining CC implementation blocker. No oracles, heavy.sh, gate-check, whole suite, staging, commits or pushes.
