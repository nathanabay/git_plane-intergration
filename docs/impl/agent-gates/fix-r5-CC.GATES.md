# Round 5 CC

OWNS: src/sync/mirror.ts, src/operations/tooling.ts, tests/mirror/review-r5-cc.test.ts

Scope: F1 reducer replay recovery and F2 stable identity after ambiguous create failure.

- [ ] G1: F1 actual mirror and PR reducers recover failed workflow tails without repeating successful effects.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/review-r5-cc.test.ts
  EXPECT: fail 0
  EVIDENCE: Direct permitted run passed: 9 tests, 0 failures; actual mirror and PR UI replay tests passed. Driver owns formal gate-check evidence.

- [ ] G2: F2 committed-but-unacknowledged creates retain their original identity through terminal failure and re-opt-in.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/review-r5-cc.test.ts
  EXPECT: fail 0
  EVIDENCE: Direct permitted run passed: 9 tests, 0 failures; mirror/PR lost-response recovery, saved-result, orphan, retention and barrier cases passed. Driver owns formal gate-check evidence.

- [ ] G3: Owned source and regression test typecheck.
  CHECK: node scripts/typecheck.mjs src/sync/mirror.ts src/operations/tooling.ts tests/mirror/review-r5-cc.test.ts
  EXPECT: typecheck passed
  EVIDENCE: Direct permitted typecheck passed (43 imported project files). Driver owns formal gate-check evidence.
