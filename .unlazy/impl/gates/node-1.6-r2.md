# Gates: review round 2 fix pass — integration of six leaves

Scope: integrate fix-r2-sa, -ca, -sb, -cb, -ga and -gb into one tree that answers all seventeen round-2 findings and passes every check, ready for the round-3 review

- [x] N0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/node-1.6-r2.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=31401684b6b6ac6676e80680666dac4f93a444205d2a4f48c6b98cf2fa62bd53; exit=0; EXPECT=matched; output-sha256=d29ccb0ae983ad522e58cf9168f6caba4da0a3810bc4b0c3093a33c885fd1738; output-bytes=526; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N1: every leaf answered each assigned finding and left a fully met, checker-evidenced ledger
  CHECK: sh -c 'f=docs/impl/fixes-r2-SA.md; for id in F1 F12 F14 F15; do grep -qE "^#+ +$id\b" $f || { echo "FAIL sa $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r2-sa.GATES.md >/dev/null || { echo "FAIL sa unlazy"; exit 1; }; f=docs/impl/fixes-r2-CA.md; for id in F4 F5 F10; do grep -qE "^#+ +$id\b" $f || { echo "FAIL ca $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r2-ca.GATES.md >/dev/null || { echo "FAIL ca unlazy"; exit 1; }; f=docs/impl/fixes-r2-SB.md; for id in F1 F12 F14 F15 F16; do grep -qE "^#+ +$id\b" $f || { echo "FAIL sb $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r2-sb.GATES.md >/dev/null || { echo "FAIL sb unlazy"; exit 1; }; f=docs/impl/fixes-r2-CB.md; for id in F2 F6; do grep -qE "^#+ +$id\b" $f || { echo "FAIL cb $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r2-cb.GATES.md >/dev/null || { echo "FAIL cb unlazy"; exit 1; }; f=docs/impl/fixes-r2-GA.md; for id in F8 F9 F13 F17; do grep -qE "^#+ +$id\b" $f || { echo "FAIL ga $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r2-ga.GATES.md >/dev/null || { echo "FAIL ga unlazy"; exit 1; }; f=docs/impl/fixes-r2-GB.md; for id in F3 F7 F11; do grep -qE "^#+ +$id\b" $f || { echo "FAIL gb $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r2-gb.GATES.md >/dev/null || { echo "FAIL gb unlazy"; exit 1; }; echo "all six leaves answered and machine-verified"'
  EXPECT: all six leaves answered and machine-verified
  EVIDENCE: automatic-evidence=v1; definition-sha256=56994b1258b4e216399cc601e089f68d2a899be150bd5e83ee94d35403db35bb; exit=0; EXPECT=matched; output-sha256=6cee7ec41240ce8f9bb1fb460caeaac3903bc5866859455c560b6d28abfa0613; output-bytes=45; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N2: every driver oracle passes on the combined fixed tree
  CHECK: sh scripts/heavy.sh sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; node scripts/verify-fork-patch.mjs all >/dev/null 2>&1 || { echo "FAIL fork"; exit 1; }; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8b2f5cd3f6e296e9d9450b51c7b8304d23074669e5f78692e00f59f2f6f03be3; exit=0; EXPECT=matched; output-sha256=6877732afcf7659776aee916e490d069bc6d53112e05dcaa101005e3ea3f8478; output-bytes=19; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N3: the whole repository's tests pass together on the combined tree
  CHECK: sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=71413dfa3ee84c10f50036b5f0fe293809e719d60260cc1efd0a5096b1111979; exit=0; EXPECT=matched; output-sha256=22d5f236efa049b5078f0ba3db0987fb5db6659c7bff118a6c007451e41482be; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N4: the whole tree typechecks
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=d285c97a96607d17eff93ec37536b5a565fd07ce59cd6bfebb822a40a5c0e78e; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N5: no stubs or placeholders anywhere in src or tests
  CHECK: node scripts/verify-no-stubs.mjs src tests
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=31f959ff923770492b645fe5a233696b301eb497336d7aae6f8317167b2c947b; exit=0; EXPECT=matched; output-sha256=d8e2892ec580b333c208e0509cd53ea4429b75cb8ed7cf3267404e78bab960db; output-bytes=29; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N6: the driver spot-checked the fixes against the findings, including the cross-owner F6 ordered-outbox integration, F7 wiring and the F1/F12/F14/F15 splits
  EVIDENCE: driver spot-check on the combined tree — every round-2 'written but not wired' item is now wired in production: F1 src/app/main.ts:56 passes createMappingVerifier to createConfigRoutes (API fails closed without it, verify-b3 checks 503/422); F14 src/app/push.ts:47 supplies listCommitRange; F7 src/app/reducers.ts:22 routes 'status' to handleCommitStatus and src/app/pr.ts uses checkPrReadiness; F6 src/app/main.ts:87-89 builds one createOrderedOutbox used by the context and src/queue/workers.ts:207 (ordered hook), with CB's real-service acceptance test tests/writers/service.test.ts in the passing suite; F4 src/app/rules.ts:133 requires the associated PR's head.ref to equal the pushed branch. Decisions recorded: branch.created trigger (F5), default-branch pushes target commit-message references only, no legacy saved-table upgrade (pre-release). Driver oracle verify-b3 updated for fail-closed F1.

- [x] N7: every leaf's ownership lease was released after verification
  EVIDENCE: fix-r2-sa: released 1 lease(s) for impl/fix-r2-sa; fix-r2-ca: released 1 lease(s) for impl/fix-r2-ca; fix-r2-sb: released 1 lease(s) for impl/fix-r2-sb; fix-r2-cb: released 1 lease(s) for impl/fix-r2-cb; fix-r2-ga: released 1 lease(s) for impl/fix-r2-ga; fix-r2-gb: released 1 lease(s) for impl/fix-r2-gb;
