# Gates: phase 1 foundations integration

Scope: integrate children leaf-1.1.1 and leaf-1.1.2 into one verified phase 1 result

- [ ] N1: every named direct child is reverified from its exact ledger
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --jobs 1 .unlazy/impl/gates/leaf-1.1.1.md .unlazy/impl/gates/leaf-1.1.2.md
  EXPECT: ALL MET
  EVIDENCE: pending

- [ ] N2: the whole tree typechecks together, so the two children's files coexist under one tsconfig
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] N3: every test suite in the repository passes together
  CHECK: node scripts/run-tests.mjs 32 tests
  EXPECT: tests passed
  EVIDENCE: pending

- [ ] N4: cross-child contract holds: the compose fragment's fork image tags equal the tags the fork build scripts produce
  CHECK: node scripts/verify-phase1-integration.mjs
  EXPECT: phase 1 integration verification passed
  EVIDENCE: pending

- [ ] N5: every direct leaf child's ownership lease was released after parent verification
  EVIDENCE: pending

- [ ] N6: consequential manual outcomes from the children were reviewed at branch level
  EVIDENCE: pending
