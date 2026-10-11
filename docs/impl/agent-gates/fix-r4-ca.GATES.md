# Gates: round 4 CA lightweight fixes

OWNS: src/sync/plane.ts, src/config/env.ts, tests/sync/review-r4-ca.test.ts, tests/api/plane-rate-config.test.ts, docs/impl/fixes-r4-CA.md, docs/impl/agent-gates/fix-r4-ca.GATES.md

Scope: F9 non-idempotent Plane POST recovery and prev F17 required service identity. Round-4 user rule: direct targeted checks only; no checker or slow gates.

- [x] F9: ambiguous POSTs are not automatically repeated, stable issue intents recover an existing create, and bookkeeping failures preserve successful results
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/sync/review-r4-ca.test.ts tests/api/plane-rate-config.test.ts
  EXPECT: pass 33
  EVIDENCE: Direct CHECK execution per round-4 user exception: exit 0, 33 tests passed, fail/cancelled/skipped/todo all 0. F9 cases cover actual PlaneClient and PlaneWritePath with HTTP responses and injected ledger failures. Initial 28-case baseline had 27 failures and one positive control pass.

- [x] F17: config refuses startup without a service user id and accepts an explicit identity
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/sync/review-r4-ca.test.ts tests/api/plane-rate-config.test.ts
  EXPECT: pass 33
  EVIDENCE: Same direct CHECK passes all 33 tests, including both F17 tests and the permitted existing rate-config fixture: actual startup subprocesses exit 1 for absent/empty/whitespace identity; valid explicit identity is normalized and loaded with rate default 60.

- [x] TYPES: CA production changes and regression tests typecheck
  CHECK: node scripts/typecheck.mjs src/sync/plane.ts src/config/env.ts tests/sync/review-r4-ca.test.ts tests/api/plane-rate-config.test.ts
  EXPECT: typecheck passed
  EVIDENCE: Direct CHECK exit 0: typecheck passed (10 project files). No gate checker used, as required this round.
