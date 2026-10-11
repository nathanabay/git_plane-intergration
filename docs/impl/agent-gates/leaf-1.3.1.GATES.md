# Gates for leaf-1.3.1

OWNS: src/sync/**, src/queue/**, src/db/**, src/index.ts, src/config/**, tests/sync/**, tests/queue/**, tests/db/**, tests/deploy/**, deploy/**, docs/impl/agent-gates/leaf-1.3.1.GATES.md

- [x] G1: A4 write path and consumers pass the driver oracle
  CHECK: node scripts/verify-a4-writepath.mjs
  EXPECT: A4 write path verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=cfee44e11e35a2b80ecfea788f3aa94f9f42dade9dfc034180694b4f4a542321; exit=0; EXPECT=matched; output-sha256=6e0758264de5710d1fae409c8ac14eaac7d9650bbe00fb574669ff9bda17e5ad; output-bytes=1546; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: A2/A3 behaviour did not regress
  CHECK: node scripts/verify-a2-ingress.mjs
  EXPECT: A2 ingress verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3459d0b605b7a7ea2f743ab17c5f18533c69e69560908faa05bc5204ee6c12f8; exit=0; EXPECT=matched; output-sha256=16a9408ae54fd8e2f0ebb7f9f3cdd3cad4325de8e537563b2c3d2f52b2b9bc4e; output-bytes=1268; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: A3 ledgers did not regress
  CHECK: node scripts/verify-a3-schema.mjs
  EXPECT: A3 schema verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=bc165618ef39922b9fe506cd3ea130671b73fefda60702fe92db217223aa9aab; exit=0; EXPECT=matched; output-sha256=3f42e8f415f480999dcd655db0aa0e00dbef20cbd810c27165d0d721822a8f8c; output-bytes=1409; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: own tests run, at least 35 passing, none skipped
  CHECK: node scripts/run-tests.mjs 35 tests/sync tests/queue
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=53ec0c5225e47d7a7e9efcc9035e910483b08e0d6e570d05f6d19b7aa4cc6456; exit=0; EXPECT=matched; output-sha256=e1434934225cc0c93cf62a0c1d582833ccaffd3b5762bfd2b62f3672f51d36ab; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: typecheck clean
  CHECK: node scripts/typecheck.mjs "src/sync/**/*.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "src/index.ts" "src/config/**/*.ts" "tests/sync/**/*.ts" "tests/queue/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=585724efceab5324b4edcfb456682e25791fd7dd9f4543943ac6e16436791e31; exit=0; EXPECT=matched; output-sha256=2edb6663fd7d2b9d5ddab5970a263d53cd4a009218685e8f040dff1b89e986a2; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: no stubs or placeholders
  CHECK: node scripts/verify-no-stubs.mjs src/sync src/queue src/db src/index.ts tests/sync tests/queue
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=00173a41c6a9e0cbd2f86a4c094a00849b3078f5c7053f37f1af64a5b6c270b9; exit=0; EXPECT=matched; output-sha256=d700bbaaeb45afe92ee5c92925955e5dc24b5fc21f671e4a7247c311caa76ae9; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G7: A1 deploy behaviour and the earlier db/deploy tests did not regress
  CHECK: node scripts/verify-a1-deploy.mjs && node scripts/run-tests.mjs 10 tests/db tests/deploy tests/api
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=31ff84bd54a7e18462a462f47d07d86bb6adc826b80f2f1b96581226e0b2f1cf; exit=0; EXPECT=matched; output-sha256=e383362b5b1073963de249a94c719ffcb364b4881ed20860a1e1bb3bd3d7a11b; output-bytes=65; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries
