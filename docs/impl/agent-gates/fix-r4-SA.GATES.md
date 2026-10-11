OWNS: src/app/main.ts, src/app/mappings.ts, src/ui/mapping-check.ts, tests/app/review-r4-sa.test.ts

- [x] F1 composeRoutes passes installationWorkspaceFromDb(db). CHECK: node --test tests/app/review-r4-sa.test.ts (F1 test) — passed
- [x] F5 runtime mapping lookups join workspace_installations, audit installation_not_allowed. CHECK: same file (F5 test) — passed
- [x] typecheck: node scripts/typecheck.mjs src/app/main.ts src/app/mappings.ts tests/app/review-r4-sa.test.ts — passed
- [x] F3 wiring: RouteParts.retryFailed → OperationsDeps.retryFailed from ordered outbox (main.ts:43,70,126). CHECK: typecheck — passed
