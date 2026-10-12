# Round 6 CD gates

OWNS: src/app/mappings.ts, src/app/checks.ts, src/sync/dev-info.ts, src/app/main.ts, tests/app/review-r6-cd.test.ts

Checks run directly under the round brief; no checker, oracle, or whole-suite execution.

- [x] F1: GitHub-side PR and mirror continuations dispatch under their stored workspace/mapping, including repair and revocation
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r6-cd.test.ts
  EXPECT: fail 0
  EVIDENCE: Direct permitted check exited 0: CD regression file 5 tests, 5 passed. Real PR opened workflow and Plane-origin pending mirror continuation dispatch with the production authorizer; failure/replay preserves once-only effects, revoked mirror reset refuses. Also passed in final three-file run, 12 tests, 12 passed. No gate-check was run.

- [x] F2: Frozen source authority permits command execution before a SHA claim and rejects changed or revoked ownership
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r6-cd.test.ts
  EXPECT: fail 0
  EVIDENCE: CD regression file passed directly (5/5). Final capped run also includes CB's first-command execution during a later transient identifier lookup before the SHA claim, immutable re-registration, and inherited/nested plan authority: 12 tests, 12 passed, exit 0. No gate-check was run.

- [x] F4: Rollups retain their source authority and cannot reach a former workspace through surviving links or unrelated mappings
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r6-cd.test.ts
  EXPECT: fail 0
  EVIDENCE: Direct CD regression passed with old active control link retained, moved installation, removed old source mapping and unrelated authorized old-project mapping. Build/deployment/preview intents carry the new mapping snapshot and write only its workspace; source deletion rejects a queued rollup despite another target grant. Final capped three-file run passed 12/12, exit 0. No gate-check was run.
