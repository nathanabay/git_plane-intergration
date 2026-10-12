# Gates: fix round 6 CB

OWNS: src/operations/outbox.ts, src/operations/plans.ts, src/github/smart-commits.ts, tests/writers/review-r3.test.ts, tests/writers/review-r4-cb.test.ts, tests/writers/service.test.ts, tests/writers/review-r6-cb.test.ts

Scope: F2 immutable source authority at registration and Smart Commit admission; F3 workspace inference; repair the three assigned stale writer fixtures without weakening their claims.

- [ ] F2: Smart Commit execution between registrations needs no completion claim, transient later lookups retain partial progress, and re-registration/recovery retain frozen source authority.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/writers/review-r6-cb.test.ts
  EXPECT: fail 0
  EVIDENCE: pending

- [ ] F3: Two projects proving the same workspace permit the actual PR linkback reducer, while distinct or unknown workspaces remain unresolved.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/writers/review-r6-cb.test.ts
  EXPECT: fail 0
  EVIDENCE: pending

- [ ] FIXTURES: Registration receipts, original failed-create recovery, and production mapping admission preserve the writer fixtures' acknowledgement/FIFO/identity claims.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/writers/review-r3.test.ts tests/writers/review-r4-cb.test.ts tests/writers/service.test.ts
  EXPECT: fail 0
  EVIDENCE: pending

- [ ] TYPES: Owned implementation and tests typecheck.
  CHECK: node scripts/typecheck.mjs src/operations/outbox.ts src/operations/plans.ts src/github/smart-commits.ts tests/writers/review-r3.test.ts tests/writers/review-r4-cb.test.ts tests/writers/service.test.ts tests/writers/review-r6-cb.test.ts
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] F5_SUPPORT: Retained later continuations stay failed without implicit remote retry and resume once in order after explicit repair.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/writers/review-r6-cb.test.ts
  EXPECT: fail 0
  EVIDENCE: pending

Per round-6 limits, direct permitted check results are recorded in fixes-r6-CB.md; automatic gate evidence is left to the driver.
