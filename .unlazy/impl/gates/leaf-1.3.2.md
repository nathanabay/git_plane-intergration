# Gates: B3 embedded React configuration app and config API

OWNS: src/ui/**, tests/ui/**, Dockerfile, .dockerignore, docs/impl/agent-gates/leaf-1.3.2.GATES.md

Scope: B3 (spec §8, §7.3, §7.6, §9) the one React app with instance-admin and workspace-settings entry routes, and the config API that authenticates every request against Plane's session, re-checks role on every write, refuses cross-site writes, stores configuration locally with secrets encrypted

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.3.2.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: the config API's auth, CSRF, validation, defaults, encryption, no-Plane-writes rule and UI serving satisfy the driver oracle
  CHECK: node scripts/verify-b3-config-api.mjs
  EXPECT: B3 config API verification passed
  EVIDENCE: pending

- [ ] G2: the multi-stage image still meets the deploy contract
  CHECK: node scripts/verify-a1-deploy.mjs
  EXPECT: A1 deploy verification passed
  EVIDENCE: pending

- [ ] G3: the leaf's own tests run with at least 25 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 25 tests/ui
  EXPECT: tests passed
  EVIDENCE: pending

- [ ] G4: the server code and the TSX app typecheck under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/ui/**/*.ts" "src/ui/**/*.tsx" "tests/ui/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/ui tests/ui Dockerfile
  EXPECT: stub scan passed
  EVIDENCE: pending

- [ ] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.3.2.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending

- [ ] G7: driver review — every handler authenticates before touching the DB, the role check is never cached, no secret reaches a response or a log, the UI covers every §8 workspace and instance surface assigned to B3
  EVIDENCE: pending
