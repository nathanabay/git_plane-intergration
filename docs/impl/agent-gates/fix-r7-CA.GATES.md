# CA round 7

OWNS: src/app/push.ts, src/app/pr.ts, src/app/issues.ts, tests/mirror/review-r5-cc.test.ts, tests/app/review-r7-ca.test.ts

Only permitted checks are run directly; checker-generated evidence is left for the driver.

- [ ] F1: Push and PR admission freeze refreshed, authorized installations and continuations preserve that snapshot.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r7-ca.test.ts
  EXPECT: fail 0
  EVIDENCE: pending
- [ ] F2: A saved confirmed orphan bypasses the failed-create fence and gets one replacement.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r7-ca.test.ts
  EXPECT: fail 0
  EVIDENCE: pending
- [ ] R5: Ambiguous PR creates keep their identity and require explicit repair after terminal failure.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/review-r5-cc.test.ts
  EXPECT: fail 0
  EVIDENCE: pending
- [ ] T1: CA-owned changes typecheck.
  CHECK: node scripts/typecheck.mjs src/app/push.ts src/app/pr.ts src/app/issues.ts tests/mirror/review-r5-cc.test.ts tests/app/review-r7-ca.test.ts
  EXPECT: typecheck passed
  EVIDENCE: pending
