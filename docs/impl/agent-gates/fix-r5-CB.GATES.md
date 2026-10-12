# Gates: fix round 5 CB

OWNS: src/operations/outbox.ts, src/operations/plans.ts, src/github/smart-commits.ts, src/github/pr-automation.ts, src/ui/client/Workspace.tsx, src/ui/client/http.ts, tests/github/review-r5-cb.test.ts

Scope: F9 recover failed Smart Commit commands and expose workspace Retry; F11 retry throttled readiness reads; agreed F3 outbox authority checks and registration-only workspace inference.

- [ ] F9: Actual push replay revives failed commands without repeating a successful sibling, and the workspace Retry action calls the scoped endpoint.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/github/review-r5-cb.test.ts
  EXPECT: fail 0
  EVIDENCE: pending

- [ ] F11: Final readiness signals propagate throttled 403s, then apply on recovery; ordinary permission failures remain unavailable.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/github/review-r5-cb.test.ts
  EXPECT: fail 0
  EVIDENCE: pending

- [ ] TYPES: Owned implementation and regression tests typecheck.
  CHECK: node scripts/typecheck.mjs src/operations/outbox.ts src/operations/plans.ts src/github/smart-commits.ts src/github/pr-automation.ts src/ui/client/Workspace.tsx src/ui/client/http.ts tests/github/review-r5-cb.test.ts
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] AUTH: Stored writes are authorized before resolution, refusals remain terminal on execution/retry/replay, and only unique authorized GitHub mappings establish workspace ownership during registration.
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/github/review-r5-cb.test.ts
  EXPECT: fail 0
  EVIDENCE: pending

Round 5 forbids gate-check and oracles. The driver will bind automatic evidence; this leaf records direct check results in fixes-r5-CB.md.
