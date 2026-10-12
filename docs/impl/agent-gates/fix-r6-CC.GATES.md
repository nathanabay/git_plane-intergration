# Round 6 CC gates

OWNS: src/sync/mirror.ts, tests/mirror/review-r6-cc.test.ts, docs/impl/fixes-r6-CC.md, docs/impl/agent-gates/fix-r6-CC.GATES.md

Checks run directly under the round brief; no checker, oracle, or whole-suite execution.

- [x] G1: Mirror scope changes and regression tests typecheck
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node scripts/typecheck.mjs "src/sync/mirror.ts" "tests/mirror/review-r6-cc.test.ts"
  EXPECT: typecheck passed
  EVIDENCE: Direct execution exited 0; typecheck passed (33 project files).

- [x] G2: Both mirror directions register frozen authority, including create plans and resumed pending events
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/review-r6-cc.test.ts
  EXPECT: fail 0
  EVIDENCE: Direct execution exited 0; tests 4, pass 4, fail 0, cancelled 0, skipped 0. Existing mirror.test.ts separately had 26 passing tests in the initial two-file run; its four failures were confined to the new fixture before sync_direction was supplied.
