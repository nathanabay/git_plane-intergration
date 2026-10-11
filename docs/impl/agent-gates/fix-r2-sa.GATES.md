# Gates: review round 2 fix pass, Sonnet implementer SA

OWNS: src/app/main.ts, src/app/context.ts, src/app/credentials.ts, src/app/mappings.ts, src/app/identity.ts, src/app/issues.ts, src/app/pr.ts, src/app/push.ts, src/app/checks.ts, src/index.ts, src/config/**, src/api/**, deploy/**, docker-compose.override.yaml, tests/deploy/**, tests/api/**, tests/app/**, docs/impl/fixes-r2-SA.md, docs/impl/agent-gates/fix-r2-sa.GATES.md

Scope: fix the round-2 findings assigned to Sonnet implementer SA (F1,F12,F14,F15) at the root, each with a test, documented for the round-3 review

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/fix-r2-sa.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=f47085eeb642c285fcf21a70807db39a4cf64ede34566f59e7f46ab6b8648471; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: every assigned finding has a section in the fixes document
  CHECK: sh -c 'f=docs/impl/fixes-r2-SA.md; [ -f $f ] || { echo "FAIL missing $f"; exit 1; }; for id in F1 F12 F14 F15; do grep -qE "^#+ +$id\b" $f || { echo "FAIL $id not answered"; exit 1; }; done; echo "all findings answered"'
  EXPECT: all findings answered
  EVIDENCE: automatic-evidence=v1; definition-sha256=1bfff2e999f73c6eb0bae6f50c6be8da7080724ca8dcb16a2542eeaa5f295473; exit=0; EXPECT=matched; output-sha256=d397b6f4c528e72ac0ae9643e210ad01cb85deac5c5c021db2a4625bb7b5c090; output-bytes=22; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: every driver oracle passes on the fixed tree
  CHECK: sh scripts/heavy.sh sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; node scripts/verify-fork-patch.mjs all >/dev/null 2>&1 || { echo "FAIL fork"; exit 1; }; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8b2f5cd3f6e296e9d9450b51c7b8304d23074669e5f78692e00f59f2f6f03be3; exit=0; EXPECT=matched; output-sha256=6877732afcf7659776aee916e490d069bc6d53112e05dcaa101005e3ea3f8478; output-bytes=19; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: the whole repository's tests pass together
  CHECK: sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=71413dfa3ee84c10f50036b5f0fe293809e719d60260cc1efd0a5096b1111979; exit=0; EXPECT=matched; output-sha256=22d5f236efa049b5078f0ba3db0987fb5db6659c7bff118a6c007451e41482be; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: the whole tree typechecks
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=d285c97a96607d17eff93ec37536b5a565fd07ce59cd6bfebb822a40a5c0e78e; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no stubs or placeholders anywhere in src or tests
  CHECK: node scripts/verify-no-stubs.mjs src tests
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=31f959ff923770492b645fe5a233696b301eb497336d7aae6f8317167b2c947b; exit=0; EXPECT=matched; output-sha256=0a316618f2dd6abb3da91cb1c6e48405e7c70f54c68323d558b8fbc97cf6d5ed; output-bytes=29; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries
