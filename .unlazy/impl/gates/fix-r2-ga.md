# Gates: review round 2 fix pass, Gemini implementer GA

OWNS: src/parse/**, src/sync/plane.ts, src/sync/github.ts, src/sync/ophash.ts, src/sync/router.ts, src/sync/reconcile.ts, src/db/**, src/queue/**, tests/parse/**, tests/sync/**, tests/db/**, tests/queue/**, tests/reconcile/**, tests/smoke/**, docs/impl/fixes-r2-GA.md, docs/impl/agent-gates/fix-r2-ga.GATES.md

Scope: fix the round-2 findings assigned to Gemini implementer GA (F8,F9,F13,F17) at the root, each with a test, documented for the round-3 review

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/fix-r2-ga.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: every assigned finding has a section in the fixes document
  CHECK: sh -c 'f=docs/impl/fixes-r2-GA.md; [ -f $f ] || { echo "FAIL missing $f"; exit 1; }; for id in F8 F9 F13 F17; do grep -qE "^#+ +$id\b" $f || { echo "FAIL $id not answered"; exit 1; }; done; echo "all findings answered"'
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
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r2-ga.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending
