# Gates: A1 deployment artifacts and service entry + A6 rule engine

OWNS: docker-compose.override.yaml, Dockerfile, .dockerignore, deploy/**, src/index.ts, src/rules/**, tests/deploy/**, tests/rules/**, docs/impl/agent-gates/leaf-1.1.1.GATES.md

Scope: A1 (spec §3) deployable container, compose fragment, Caddy route, env and database artifacts and the HTTP entry point; A6 (spec §7.5, §7.1) the rule engine with first-match-wins and a no-write dry-run mode

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.1.1.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: A1 compose fragment merges onto Plane v1.4.2 compose, Caddy route precedes the catch-all, image/env/SQL/APPLY artifacts exist, and the service boots, serves health, 404s unknown paths and exits cleanly on SIGTERM
  CHECK: node scripts/verify-a1-deploy.mjs
  EXPECT: A1 deploy verification passed
  EVIDENCE: pending

- [ ] G2: A6 satisfies the driver-held rule engine contract fixtures
  CHECK: node scripts/verify-rules-contract.mjs
  EXPECT: rules contract verification passed
  EVIDENCE: pending

- [ ] G3: the leaf's own test suites run with at least 20 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 20 tests/rules tests/deploy
  EXPECT: tests passed
  EVIDENCE: pending

- [ ] G4: the leaf's TypeScript typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/index.ts" "src/rules/**/*.ts" "tests/rules/**/*.ts" "tests/deploy/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/rules deploy Dockerfile docker-compose.override.yaml tests/rules tests/deploy
  EXPECT: stub scan passed
  EVIDENCE: pending

- [ ] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.1.1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending

- [ ] G7: driver review against spec §3 and §7.5 — fragment is mergeable into an existing override without clobbering it, APPLY.md is an ordered runbook a human can follow, rule engine semantics match §7.5 and do not grow a second evaluator
  EVIDENCE: pending
