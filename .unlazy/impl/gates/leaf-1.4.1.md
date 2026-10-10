# Gates: A5 reference parsing + A7 reconciliation sweep + storage for Part B

OWNS: src/parse/**, src/sync/reconcile.ts, src/queue/**, src/db/**, tests/parse/**, tests/sync/reconcile*.test.ts, tests/queue/**, tests/db/**, docs/impl/agent-gates/leaf-1.4.1.GATES.md

Scope: A5 (spec §6) three-tier reference parsing with opt-outs, multi-issue lists, create requests and the all-PRs-merge rule; A7 (spec §1.3) a reconciliation sweep that orphans 404s and never closes anything, op pruning on a schedule; audit workspace scoping, audited inbound deliveries and the dev-info link table that Part B consumes

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.4.1.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: A5, A7 and the storage additions satisfy the driver oracle
  CHECK: node scripts/verify-a5-a7.mjs
  EXPECT: A5/A7 verification passed
  EVIDENCE: pending

- [ ] G2: the earlier Part A oracles did not regress
  CHECK: sh -c 'for o in verify-a3-schema verify-a2-ingress verify-a4-writepath; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "part A regressions passed"'
  EXPECT: part A regressions passed
  EVIDENCE: pending

- [ ] G3: the leaf's own tests run with at least 40 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 40 tests/parse tests/queue tests/db
  EXPECT: tests passed
  EVIDENCE: pending

- [ ] G4: the leaf's TypeScript typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/parse/**/*.ts" "src/sync/reconcile.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "tests/parse/**/*.ts" "tests/queue/**/*.ts" "tests/db/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/parse src/sync/reconcile.ts src/queue src/db tests/parse
  EXPECT: stub scan passed
  EVIDENCE: pending

- [ ] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.4.1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending

- [ ] G7: driver review — parsing matches §6 including false-positive avoidance, the sweep never writes to Plane, audit payloads hold no secrets
  EVIDENCE: pending
