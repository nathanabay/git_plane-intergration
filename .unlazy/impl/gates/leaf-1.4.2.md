# Gates: B4 Smart Commits, B5 PR automation, B6 mirroring, B7 dev info, B8 operations

OWNS: src/github/**, src/sync/mirror.ts, src/sync/dev-info.ts, src/operations/**, src/ui/**, tests/github/**, tests/sync/mirror*.test.ts, tests/sync/dev-info*.test.ts, tests/operations/**, tests/ui/**, docs/impl/agent-gates/leaf-1.4.2.GATES.md

Scope: B4 (§7.2) Smart Commits attributed from sender only and applied once per SHA, B5 (§7.1) lifecycle and branch rules compiled into the A6 engine, B6 (§7.3) label-gated two-way mirroring with conflict policies, B7 (§7.4) dev-info rollups updated in place with preview detection, B8 (§7.6) dry-run, audit replay and backfill with config API endpoints and UI

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.4.2.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: B4-B8 satisfy the driver oracle
  CHECK: node scripts/verify-b4-b8.mjs
  EXPECT: B4-B8 verification passed
  EVIDENCE: pending

- [ ] G2: the B3 config API and UI did not regress
  CHECK: node scripts/verify-b3-config-api.mjs
  EXPECT: B3 config API verification passed
  EVIDENCE: pending

- [ ] G3: the leaf's own tests run with at least 60 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 60 tests/github tests/operations tests/ui
  EXPECT: tests passed
  EVIDENCE: pending

- [ ] G4: the leaf's TypeScript typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/github/**/*.ts" "src/sync/mirror.ts" "src/sync/dev-info.ts" "src/operations/**/*.ts" "src/ui/**/*.ts" "src/ui/**/*.tsx" "tests/github/**/*.ts" "tests/operations/**/*.ts" "tests/ui/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/github src/sync/mirror.ts src/sync/dev-info.ts src/operations src/ui tests/github tests/operations
  EXPECT: stub scan passed
  EVIDENCE: pending

- [ ] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.4.2.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending

- [ ] G7: driver review — every write goes through A4, attribution never reads pusher or commit author, mirroring respects direction and policy, replay uses a fresh delivery id
  EVIDENCE: pending
