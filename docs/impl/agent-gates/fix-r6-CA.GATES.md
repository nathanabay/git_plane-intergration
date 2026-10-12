# CA round 6

OWNS: src/app/pr.ts, src/app/issues.ts, tests/github/review-r4-sc.test.ts, tests/app/review-r6-ca.test.ts

Only the brief's permitted checks are executed directly. Driver checker evidence remains pending.

- [ ] F5: Later PR events survive terminal unlinked creation failure until explicit repair.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r6-ca.test.ts
  EXPECT: fail 0
  EVIDENCE: pending
- [ ] A1: PR and mirror intents freeze their admitted source mapping authority.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r6-ca.test.ts
  EXPECT: fail 0
  EVIDENCE: pending
- [ ] R4: Installation lookup classification fixtures reach the lookup with a verified stored mapping.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/github/review-r4-sc.test.ts
  EXPECT: fail 0
  EVIDENCE: pending
- [ ] T1: CA-owned changes typecheck.
  CHECK: node scripts/typecheck.mjs src/app/pr.ts src/app/issues.ts tests/github/review-r4-sc.test.ts tests/app/review-r6-ca.test.ts
  EXPECT: typecheck passed
  EVIDENCE: pending
