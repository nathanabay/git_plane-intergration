# Gates: review round 1 fix pass, Sonnet implementer SB

OWNS: src/ui/api.ts, src/ui/validate.ts, src/ui/mapping-check.ts, src/ui/plane-auth.ts, src/ui/http.ts, src/ui/static.ts, src/github/smart-commits.ts, src/github/html.ts, src/auth/**, src/rules/**, tests/ui/auth.test.ts, tests/ui/instance.test.ts, tests/ui/operations.test.ts, tests/ui/static.test.ts, tests/ui/workspace.test.ts, tests/ui/harness.ts, tests/github/smart-commits.test.ts, tests/github/fakes.ts, tests/auth/**, tests/rules/**, Dockerfile, .dockerignore, docs/impl/fixes-r1-SB.md, docs/impl/agent-gates/fix-r1-sb.GATES.md

Scope: fix the round-1 findings assigned to Sonnet implementer SB (F2,F8,F16,F18) at the root, each with a test, documented for the round-2 review

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/fix-r1-sb.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: every assigned finding has a section in the fixes document
  CHECK: sh -c 'f=docs/impl/fixes-r1-SB.md; [ -f $f ] || { echo "FAIL missing $f"; exit 1; }; for id in F2 F8 F16 F18; do grep -qE "^#+ +$id\b" $f || { echo "FAIL $id not answered"; exit 1; }; done; echo "all findings answered"'
  EXPECT: all findings answered
  EVIDENCE: pending

- [ ] G2: every driver oracle passes on the fixed tree
  CHECK: sh scripts/heavy.sh sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; node scripts/verify-fork-patch.mjs all >/dev/null 2>&1 || { echo "FAIL fork"; exit 1; }; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: pending

- [ ] G3: the whole repository's tests pass together
  CHECK: sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests
  EXPECT: tests passed
  EVIDENCE: pending

- [ ] G4: the whole tree typechecks
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] G5: no stubs or placeholders anywhere in src or tests
  CHECK: node scripts/verify-no-stubs.mjs src tests
  EXPECT: stub scan passed
  EVIDENCE: pending

- [ ] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r1-sb.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending
