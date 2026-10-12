# CA round 5

OWNS: src/app/pr.ts, src/app/issues.ts, src/app/rules.ts, tests/app/review-r5-ca.test.ts

The driver runs gate-check after this round. Only the brief's capped commands are run here.

- [ ] F4: A confirmed orphan can be replaced once through the PR reducer.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r5-ca.test.ts
  EXPECT: fail 0
  EVIDENCE: pending
- [ ] F5: Same-workspace cross-project created targets receive lifecycle, readiness and check rules.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r5-ca.test.ts
  EXPECT: fail 0
  EVIDENCE: pending
- [ ] F6: Pending PR creates retain each later lifecycle event in order.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r5-ca.test.ts
  EXPECT: fail 0
  EVIDENCE: pending
- [ ] T1: Owned PR lifecycle changes typecheck.
  CHECK: node scripts/typecheck.mjs src/app/pr.ts src/app/issues.ts src/app/rules.ts tests/app/review-r5-ca.test.ts
  EXPECT: typecheck passed
  EVIDENCE: pending
