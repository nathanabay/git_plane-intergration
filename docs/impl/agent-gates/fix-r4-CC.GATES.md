# Gates: round 4 CC

OWNS: src/sync/mirror.ts, tests/mirror/review-r4-cc.test.ts, tests/mirror/mirror.test.ts, docs/impl/agent-gates/fix-r4-CC.GATES.md, docs/impl/fixes-r4-CC.md

- [x] G1: F4 re-opt-in creates a new partner and resumes its rules once; duplicate registration does not claim creation
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/review-r4-cc.test.ts tests/mirror/mirror.test.ts
  EXPECT: fail 0
  EVIDENCE: Manually executed the capped sequential CHECK on 2026-10-11 after final CB/SB changes and the driver-granted assignee fixture fix; 37 tests passed, 0 failed, exit 0. Includes all 11 CC regressions covering both directions, failed creates, stale markers, duplicates, legacy adapters, live markers and partial retention.

- [x] G2: prev F5 GitHub assignees resolve by stable account ID within their workspace
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/review-r4-cc.test.ts tests/mirror/mirror.test.ts
  EXPECT: fail 0
  EVIDENCE: Manually executed the capped sequential CHECK on 2026-10-11; 37 tests passed, 0 failed, exit 0. Both numeric-ID regressions and the existing mirror assignee assertions pass; no assertion was changed in the granted fixture fix.

- [x] G3: CC source and targeted tests typecheck
  CHECK: node scripts/typecheck.mjs src/sync/mirror.ts tests/mirror/review-r4-cc.test.ts tests/mirror/mirror.test.ts tests/mirror/service-plan.test.ts
  EXPECT: typecheck passed
  EVIDENCE: Manually executed CHECK on 2026-10-11 against CB's final inserted contract; typecheck passed (45 project files), exit 0. No gate-check used.
