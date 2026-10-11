# Gates for leaf-1.5.1

OWNS: src/index.ts, src/app/**, src/sync/github.ts, src/db/**, src/config/**, deploy/git-sync.env.example, tests/a8/**, tests/smoke/**, tests/deploy/**, tests/db/**, docs/impl/agent-gates/leaf-1.5.1.GATES.md

- [x] G1: the whole service works end to end against fake Plane and GitHub
  CHECK: node scripts/verify-wiring.mjs
  EXPECT: end-to-end wiring verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=94549ca2a6be0f72eef5f2ff1189e84be2034d80b49b699629e0bd5fcfafdbe8; exit=0; EXPECT=matched; output-sha256=83d0dc16d5bd494f306a8b213aa1f82c25f0ea428998fd9621c78cb1a15d0bda; output-bytes=560; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: every leaf oracle still passes against the wired tree
  CHECK: sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7ab8e476d2f45329db25312ea8e90865b158e3cbfd885af5b7a24a054627ec08; exit=0; EXPECT=matched; output-sha256=6877732afcf7659776aee916e490d069bc6d53112e05dcaa101005e3ea3f8478; output-bytes=19; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: the A8 suites run, at least 30 passing, none skipped (the live smoke test is excluded here)
  CHECK: node scripts/run-tests.mjs 30 tests/a8
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=727442a2366c656c0fab96d6fb0512fb0d8663e5273e9d0d4beab1d6446dad39; exit=0; EXPECT=matched; output-sha256=d706d9969147eb3994a31828d1b4930c55e2dc66fe2d39c834ca20bb4225d84c; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: typecheck clean across the whole tree
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=ff3f4abbd6b531004f5688f48a2407918e98e311552d1bf1b526d3d034c64e2e; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no stubs or placeholders
  CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/app src/config tests/a8
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3cdabea30a08c732b328cb71e6d60529275b7efae8065e2b9c75574f378a337c; exit=0; EXPECT=matched; output-sha256=5ed851337513247faa9e39b4cdded5563c04f56f77ae3f1306cf552f0bb38c38; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: the earlier suites for A1, A2 and A4 still pass (tests/db is leaf-1.4.1's and is reported separately)
  CHECK: node scripts/run-tests.mjs 30 tests/deploy tests/sync tests/queue tests/api
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1bccfaca512089affa7cf3091408ac6310de6289e64e546b8b90d9e6f8dbf715; exit=0; EXPECT=matched; output-sha256=058bd6c811977e19657343db378f1465409118a2d24cbc51053bcede57f42fb6; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G7: the live smoke test is defined and skips cleanly when its environment is absent
  CHECK: node --test tests/smoke/live-smoke.test.ts
  EXPECT: skipped 1
  EVIDENCE: automatic-evidence=v1; definition-sha256=38b92e62634f7ce9523a28cdee74c3204d8d99540d6dfc96e7f59c0d4f1ba7ce; exit=0; EXPECT=matched; output-sha256=64bcb7caf95856c6a4e6f8f85bb41036e14bce7acd74499db475bf9f26ab51d8; output-bytes=298; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G8: the whole repository's tests pass together, so a change cannot break another leaf's suite
  CHECK: node scripts/run-tests.mjs 400 tests
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=6e58263bd22a649dcc26738efa70ff7515f764e4ae9bf7a0aa914562fbc3683b; exit=0; EXPECT=matched; output-sha256=b564240f3f93fe4593d215d03e91ccb1e6981059e571ae14ba4f67c9c8555add; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries
