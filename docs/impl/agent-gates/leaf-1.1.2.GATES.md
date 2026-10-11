OWNS: apps/admin/**, apps/web/**, packages/constants/**, src/auth/**, tests/auth/**, docs/impl/agent-gates/leaf-1.1.2.GATES.md

- [x] G1: both fork patches pass the driver oracle
  CHECK: node scripts/verify-fork-patch.mjs all
  EXPECT: fork patch verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=dfccc5ecdc7d2ae06cd26a8455f07d671b653e98a8b4f583709df50c42426dac; exit=0; EXPECT=matched; output-sha256=f31cbc7b52f3beb1a7b6f3d14ce4747cb72f7a499b6e0babbad2735031c94d8a; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G2: B9 satisfies the driver-held identity contract
  CHECK: node scripts/verify-identity-contract.mjs
  EXPECT: identity contract verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4f4230df2a2379e9c49bfe7767f8b444ad69a05b84aeeafa225f746b62b9c64e; exit=0; EXPECT=matched; output-sha256=064a2e79a50be6e53fbfc8c38f21fb455ce8bb52e1929f3c8e762ebe90948ad3; output-bytes=969; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G3: own tests run, at least 12 passing, none skipped
  CHECK: node scripts/run-tests.mjs 12 tests/auth
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=cda8280641a7af66c51ee1b0ec9661b6131b962200dc13c9aa2da8d6b59be957; exit=0; EXPECT=matched; output-sha256=18ed440919746e6b20bcc34fe41d7fa471a2d4f3a727a019958e6b1bcd7baf7f; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G4: typecheck clean
  CHECK: node scripts/typecheck.mjs "src/auth/**/*.ts" "tests/auth/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=073e03af09051123f15768f2039c6398408b8cfa45e338a07da4429ad0f72873; exit=0; EXPECT=matched; output-sha256=8957d743754be89b6f55f19d1ed18506b4282cdbfbbf2b77be1b309d59f1f5bd; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G5: no stubs or placeholders
  CHECK: node scripts/verify-no-stubs.mjs src/auth tests/auth apps
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=307374c31f7bfd583c30a049c2f52075bcf3194130379c74d52978df7d544df7; exit=0; EXPECT=matched; output-sha256=5ba58833636c7e4236b20c97e897e269a323e5d64b6f03a47ff5b7a9ad17c0d9; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G6: tamper tests are stable over 50 runs
  CHECK: sh -c 'for i in $(seq 1 50); do node scripts/run-tests.mjs 12 tests/auth >/dev/null || exit 1; done; echo "50 runs stable"'
  EXPECT: 50 runs stable
  EVIDENCE: automatic-evidence=v1; definition-sha256=a669034f1090c3da7ac6dc4493def3280ab650b960e6260013c34fbff616c996; exit=0; EXPECT=matched; output-sha256=ee47eb204e00e20399fe36a893cf4de7397dbd4ce7a5f3e8bd43a118c3320cd4; output-bytes=15; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries
