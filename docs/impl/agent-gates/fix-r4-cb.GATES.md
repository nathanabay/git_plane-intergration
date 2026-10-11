# Gates: round 4 CB

OWNS: src/operations/outbox.ts, src/operations/plans.ts, tests/writers/review-r4-cb.test.ts, docs/impl/fixes-r4-CB.md, docs/impl/agent-gates/fix-r4-cb.GATES.md

Scope: F2, F3, F10; lightweight verification as explicitly requested for round 4.

- [x] F2: terminal plan failure clears its barrier, cancels pending siblings and audits once
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/writers/review-r4-cb.test.ts
  EXPECT: fail 0
  EVIDENCE: Direct CHECK run after final test edits: exit 0, tests 10, pass 10, fail 0, cancelled 0 (25976.437671 ms). Verifies stable intentId for actor/service/restart creates and actual PlaneApiError rate-limit header forms. Targeted typecheck passed (32 project files). No gate checker used.

- [x] F3: explicit replay or retry recovers failed intents without repeating applied writes
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/writers/review-r4-cb.test.ts
  EXPECT: fail 0
  EVIDENCE: Direct CHECK run after final test edits: exit 0, tests 10, pass 10, fail 0, cancelled 0 (25976.437671 ms). Verifies stable intentId for actor/service/restart creates and actual PlaneApiError rate-limit header forms. Targeted typecheck passed (32 project files). No gate checker used.

- [x] F10: rejected actor credentials fall back to service identity and audit once
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/writers/review-r4-cb.test.ts
  EXPECT: fail 0
  EVIDENCE: Direct CHECK run after final test edits: exit 0, tests 10, pass 10, fail 0, cancelled 0 (25976.437671 ms). Verifies stable intentId for actor/service/restart creates and actual PlaneApiError rate-limit header forms. Targeted typecheck passed (32 project files). No gate checker used.

Targeted typecheck: node scripts/typecheck.mjs src/operations/outbox.ts src/operations/plans.ts tests/writers/review-r4-cb.test.ts — passed (32 project files).
