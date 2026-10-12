# Fix round 7 — CB

Updated only `tests/github/review-r5-cb.test.ts` and this required report. The stale expectation came from round-6 F3: registration now counts distinct authorized workspaces, not project mapping rows.

- `tests/github/review-r5-cb.test.ts:234` now expects two projects in workspace `ws` to infer `ws` and dispatch successfully. The successful-effect count is two. Unknown-repository, later-mapping and unlisted-installation rejection controls remain intact.
- `tests/github/review-r5-cb.test.ts:251` adds a genuine two-workspace query result using database rows rather than mocked query output. The production installation primary key normally prevents conflicting grants, so this isolated PGlite fixture temporarily removes that constraint to model legacy/corrupt grants for the same repo/installation across two workspaces. Registration stores NULL ownership and the production authorizer refuses dispatch. After removing the conflict and restoring the primary key, the original intent still cannot execute or be retried as workspace-owned. A fresh uniquely owned intent dispatches successfully as the positive control.

Verification:

```text
node scripts/typecheck.mjs tests/github/review-r5-cb.test.ts
typecheck passed (55 project files)

NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/github/review-r5-cb.test.ts
9 tests passed, 0 failed
```

No product code, oracles, heavy.sh, gate-check or whole suite was changed or run. No staging, commits or pushes.
