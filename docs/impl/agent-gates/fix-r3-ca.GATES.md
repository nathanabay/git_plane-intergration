# Gates: review round 3 fix pass, Codex implementer CA

OWNS: src/app/rules.ts, src/app/rule-events.ts, src/app/reducers.ts, src/app/github.ts, tests/a8/**, docs/impl/fixes-r3-CA.md, docs/impl/agent-gates/fix-r3-ca.GATES.md

Scope: fix the round-3 findings assigned to Codex implementer CA (F10) at the root, each with a test, documented for the round-4 review

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/fix-r3-ca.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=3b9d03e94a788a8473ac3b7540f114777365d0369ee527e5d979375a9f386952; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=554931db1d54/34 entries

- [x] G1: every assigned finding has a section in the fixes document
  CHECK: sh -c 'f=docs/impl/fixes-r3-CA.md; [ -f $f ] || { echo "FAIL missing $f"; exit 1; }; for id in F10; do grep -qE "^#+ +$id\b" $f || { echo "FAIL $id not answered"; exit 1; }; done; echo "all findings answered"'
  EXPECT: all findings answered
  EVIDENCE: automatic-evidence=v1; definition-sha256=2f04262909c33a34662502690e99c3bcf1567c79d2d544e5a5eff07216f611c9; exit=0; EXPECT=matched; output-sha256=d397b6f4c528e72ac0ae9643e210ad01cb85deac5c5c021db2a4625bb7b5c090; output-bytes=22; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=554931db1d54/34 entries

- [x] G2: every driver oracle passes on the fixed tree
  CHECK: sh scripts/heavy.sh sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; node scripts/verify-fork-patch.mjs all >/dev/null 2>&1 || { echo "FAIL fork"; exit 1; }; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8b2f5cd3f6e296e9d9450b51c7b8304d23074669e5f78692e00f59f2f6f03be3; exit=0; EXPECT=matched; output-sha256=6877732afcf7659776aee916e490d069bc6d53112e05dcaa101005e3ea3f8478; output-bytes=19; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=554931db1d54/34 entries

- [x] G3: the whole repository's tests pass together
  CHECK: sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=71413dfa3ee84c10f50036b5f0fe293809e719d60260cc1efd0a5096b1111979; exit=0; EXPECT=matched; output-sha256=8c4488fc93721947c8f49daadc8d6e2d158478b67edc1a83c3c166933b9e84f5; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=554931db1d54/34 entries

- [x] G4: the whole tree typechecks
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=56f2bb1dfe4a25b87923ea71833d7cfc4f3c2dd357d0e880f4bece2106e2a3f9; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=554931db1d54/34 entries

- [x] G5: no stubs or placeholders anywhere in src or tests
  CHECK: node scripts/verify-no-stubs.mjs src tests
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=31f959ff923770492b645fe5a233696b301eb497336d7aae6f8317167b2c947b; exit=0; EXPECT=matched; output-sha256=12073c282f7476b13a905102b6bf827f867546a525061f56af441936c1a21886; output-bytes=29; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=554931db1d54/34 entries
