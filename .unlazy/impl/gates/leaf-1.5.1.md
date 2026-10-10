# Gates: A8 test suites and wiring the whole service

OWNS: src/index.ts, src/app/**, src/sync/github.ts, src/db/**, src/config/**, deploy/git-sync.env.example, tests/a8/**, tests/smoke/**, tests/deploy/**, docs/impl/agent-gates/leaf-1.5.1.GATES.md

Scope: compose every verified module into the running service (reducers registered, config API and UI mounted, workers and maintenance started) and A8 (spec §10) the echo-loop, reducer, idempotency, grammar and forged-author security suites plus a live smoke test definition

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.5.1.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: the whole service works end to end against fake Plane and GitHub
  CHECK: node scripts/verify-wiring.mjs
  EXPECT: end-to-end wiring verification passed
  EVIDENCE: pending

- [ ] G2: every leaf oracle still passes against the wired tree
  CHECK: sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: pending

- [ ] G3: the A8 suites run with at least 30 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 30 tests/a8
  EXPECT: tests passed
  EVIDENCE: pending

- [ ] G4: the whole tree typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/app src/config tests/a8
  EXPECT: stub scan passed
  EVIDENCE: pending

- [ ] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.5.1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending

- [ ] G7: driver review — the echo-loop suite exercises both directions through real write paths, the security test forges author and pusher, every reducer writes only through A4
  EVIDENCE: pending
