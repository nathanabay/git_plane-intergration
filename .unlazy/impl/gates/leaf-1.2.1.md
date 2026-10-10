# Gates: A2 webhook ingress and queues + A3 schemas and ledgers

OWNS: src/index.ts, deploy/**, src/api/**, src/queue/**, src/db/**, src/config/**, tests/api/**, tests/queue/**, tests/db/**, tests/deploy/**, docs/impl/agent-gates/leaf-1.2.1.GATES.md

Scope: A2 (spec §4, §3) signature-verified ingress that only enqueues, four BullMQ queues on Valkey, GitHub App token minting, env-driven wiring; A3 (spec §5, §1.3, §7.6, §8, §9) Postgres migrations for the identity map, field-granular op ledger, idempotency ledgers, audit log, configuration and token tables, plus the data-access functions later tasks consume

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.2.1.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: A2 satisfies the driver-held ingress, queue, GitHub App and process-wiring oracle
  CHECK: node scripts/verify-a2-ingress.mjs
  EXPECT: A2 ingress verification passed
  EVIDENCE: pending

- [ ] G2: A3 migrations apply to a real Postgres engine and the ledger contract holds
  CHECK: node scripts/verify-a3-schema.mjs
  EXPECT: A3 schema verification passed
  EVIDENCE: pending

- [ ] G3: phase 1 entry-point behaviour did not regress
  CHECK: node scripts/verify-a1-deploy.mjs
  EXPECT: A1 deploy verification passed
  EVIDENCE: pending

- [ ] G4: the leaf's own tests run with at least 30 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 30 tests/api tests/queue tests/db tests/deploy
  EXPECT: tests passed
  EVIDENCE: pending

- [ ] G5: the leaf's TypeScript typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/index.ts" "src/api/**/*.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "src/config/**/*.ts" "tests/api/**/*.ts" "tests/queue/**/*.ts" "tests/db/**/*.ts" "tests/deploy/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] G6: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/api src/queue src/db src/config tests/api tests/queue tests/db
  EXPECT: stub scan passed
  EVIDENCE: pending

- [ ] G7: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.2.1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending

- [ ] G8: driver review against spec §4 and §5 — handler does only verify/enqueue/respond, secrets never logged, migration is transactional, op ledger is field-granular with consume-once semantics
  EVIDENCE: pending
