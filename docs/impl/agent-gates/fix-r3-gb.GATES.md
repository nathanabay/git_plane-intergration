# Gates: review round 3 fix pass, Gemini implementer GB

OWNS: src/github/pr-automation.ts, src/ui/app.tsx, src/ui/client/**, src/ui/styles.css, src/ui/build.mjs, src/ui/build.d.mts, src/ui/css.d.ts, apps/**, packages/**, tests/github/pr-automation.test.ts, tests/ui/client.test.ts, tests/ui-client/**, docs/impl/fixes-r3-GB.md, docs/impl/agent-gates/fix-r3-gb.GATES.md

Scope: fix the round-3 findings assigned to Gemini implementer GB (F4,F9) at the root, each with a test, documented for the round-4 review

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs docs/impl/agent-gates/fix-r3-gb.GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=f1907d5bc3e487dddcaf91c505a82aee69f6556c6b73653cbb1a8443ecba2195; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G1: every assigned finding has a section in the fixes document
  CHECK: sh -c 'f=docs/impl/fixes-r3-GB.md; [ -f $f ] || { echo "FAIL missing $f"; exit 1; }; for id in F4 F9; do grep -qE "^#+ +$id\b" $f || { echo "FAIL $id not answered"; exit 1; }; done; echo "all findings answered"'
  EXPECT: all findings answered
  EVIDENCE: automatic-evidence=v1; definition-sha256=ecae8a43b43c1566e906cfce9ae62a4fed45f5413d2941a60f9326a3f3c9f6cb; exit=0; EXPECT=matched; output-sha256=d397b6f4c528e72ac0ae9643e210ad01cb85deac5c5c021db2a4625bb7b5c090; output-bytes=22; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [ ] G2: every driver oracle passes on the fixed tree
  CHECK: sh scripts/heavy.sh sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; node scripts/verify-fork-patch.mjs all >/dev/null 2>&1 || { echo "FAIL fork"; exit 1; }; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: pending

- [ ] G3: the whole repository's tests pass together
  CHECK: sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests
  EXPECT: tests passed
  EVIDENCE: pending

- [x] G4: the whole tree typechecks
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=eb8008ca98df4174178ad8e00e27a674cdb57c37fac873894f6846b06c6a4424; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G5: no stubs or placeholders anywhere in src or tests
  CHECK: node scripts/verify-no-stubs.mjs src tests
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=31f959ff923770492b645fe5a233696b301eb497336d7aae6f8317167b2c947b; exit=0; EXPECT=matched; output-sha256=d97fee3ac6d7cdf66ac0b719c38465584ecea1d3e852e2a4dcb187ede3b46909; output-bytes=29; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries
