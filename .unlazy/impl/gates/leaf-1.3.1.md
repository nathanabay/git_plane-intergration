# Gates: A4 single write path and queue consumers

OWNS: src/sync/**, src/queue/**, src/db/**, src/index.ts, src/config/**, tests/sync/**, tests/queue/**, tests/db/**, tests/deploy/**, deploy/**, docs/impl/agent-gates/leaf-1.3.1.GATES.md

Scope: A4 (spec §5, §3, §4, §7.1, §9) the one Plane and GitHub write path every later task uses — field-granular op recording before writes, ingress echo consumption, Plane 400/409 semantics, triage ban, rate-limit backoff, queue workers and service wiring

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.3.1.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: the write path, echo ledger, Plane semantics, triage ban, backoff and workers satisfy the driver oracle
  CHECK: node scripts/verify-a4-writepath.mjs
  EXPECT: A4 write path verification passed
  EVIDENCE: pending

- [ ] G2: A2 ingress behaviour did not regress
  CHECK: node scripts/verify-a2-ingress.mjs
  EXPECT: A2 ingress verification passed
  EVIDENCE: pending

- [ ] G3: A3 ledger behaviour did not regress
  CHECK: node scripts/verify-a3-schema.mjs
  EXPECT: A3 schema verification passed
  EVIDENCE: pending

- [ ] G4: the leaf's own tests run with at least 35 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 35 tests/sync tests/queue
  EXPECT: tests passed
  EVIDENCE: pending

- [ ] G5: the leaf's TypeScript typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/sync/**/*.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "src/index.ts" "src/config/**/*.ts" "tests/sync/**/*.ts" "tests/queue/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] G6: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/sync src/queue src/db src/index.ts tests/sync tests/queue
  EXPECT: stub scan passed
  EVIDENCE: pending

- [ ] G7: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.3.1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending

- [ ] G8: driver review — no write path bypasses op recording, echoes are dropped only on ingress, triage check precedes every state write, no token or body is logged
  EVIDENCE: pending
