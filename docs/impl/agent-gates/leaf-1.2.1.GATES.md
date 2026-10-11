# Gates for leaf-1.2.1

OWNS: src/index.ts, deploy/**, src/api/**, src/queue/**, src/db/**, src/config/**, tests/api/**, tests/queue/**, tests/db/**, tests/deploy/**, docs/impl/agent-gates/leaf-1.2.1.GATES.md

- [x] G1: A2 ingress, queues, GitHub App and wiring pass the driver oracle
  CHECK: node scripts/verify-a2-ingress.mjs
  CWD: ../../..
  EXPECT: A2 ingress verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5c902a67d7426af0f925f49a846183612c63a6cd0cc864fa023c550f51f5d983; exit=0; EXPECT=matched; output-sha256=16a9408ae54fd8e2f0ebb7f9f3cdd3cad4325de8e537563b2c3d2f52b2b9bc4e; output-bytes=1268; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G2: A3 migrations and ledgers pass the driver oracle
  CHECK: node scripts/verify-a3-schema.mjs
  CWD: ../../..
  EXPECT: A3 schema verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e90b3f169677c51ced2bc6cc7965253dd8931037701ebc5d378b3a2e1eaa201f; exit=0; EXPECT=matched; output-sha256=8ec4a2377a59a1d20b553ea308f935d66745c89677fe0c62b7e1226cc3f3d9a5; output-bytes=969; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G3: A1 behaviour did not regress
  CHECK: node scripts/verify-a1-deploy.mjs
  CWD: ../../..
  EXPECT: A1 deploy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=2d29d735399a5b7768de5e8801a02affaa85a250bcfa9e009cbb958e1872a9ee; exit=0; EXPECT=matched; output-sha256=45c80c61bb8cffc7d09e20087fa4340f5c4e1f20969be393475deed4777c0294; output-bytes=30; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G4: own tests run, at least 30 passing, none skipped
  CHECK: node scripts/run-tests.mjs 30 tests/api tests/queue tests/db tests/deploy
  CWD: ../../..
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=31dcb922980b979e766c8c85307132fc65e032a20509f0698fdc22cd1fe560b9; exit=0; EXPECT=matched; output-sha256=f43568ccf054ac558fbdf4353434b20e9c6d2bf1d9235dc970a8e03d393f696a; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G5: typecheck clean
  CHECK: node scripts/typecheck.mjs "src/index.ts" "src/api/**/*.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "src/config/**/*.ts" "tests/api/**/*.ts" "tests/queue/**/*.ts" "tests/db/**/*.ts" "tests/deploy/**/*.ts"
  CWD: ../../..
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=cc524b40c0bc8798a909300de059bef0877b2825144346f1dcddee10478b1cfa; exit=0; EXPECT=matched; output-sha256=dc4f832132a65163dbe1e0b8b1bc554ae02e7645a3c063a5cedfd68aa812cfe7; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G6: no stubs or placeholders
  CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/api src/queue src/db src/config tests/api tests/queue tests/db
  CWD: ../../..
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b1c642a5959164fdd058df1458ab1df0c0830cd4be245a299088d16fe2febc06; exit=0; EXPECT=matched; output-sha256=c2b55827418d8d1d9faa2c394ac70522689717258aac134e0a02911b8aa85225; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G7: fix round 2 — migrations atomic and serialised on a real Postgres pool, echo consumption exact, schema corrections, oversize 413 (own tests)
  CHECK: node scripts/run-tests.mjs 8 tests/api tests/db
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5a402a33ad91e9b750ef9216db07b49933b296eeff692bced8b1958acdcef607; exit=0; EXPECT=matched; output-sha256=42e110c75a56aac013b814169980cd9e0132e8bb8056c75ee49cf1610bf24d1c; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G8: schema corrections hold on a real Postgres 15.7 (autolinks off, GHE url, uniques, cascade, atomic migrate, concurrent migrate, concurrent consume)
  CHECK: node scripts/verify-a3-schema.mjs
  EXPECT: A3 schema verification passed (16 checks)
  EVIDENCE: automatic-evidence=v1; definition-sha256=8beeb3aa000ecc0fc3dcde73f3606b7bfc4ecf5c1983310cf7d591a189221c77; exit=0; EXPECT=matched; output-sha256=3f42e8f415f480999dcd655db0aa0e00dbef20cbd810c27165d0d721822a8f8c; output-bytes=1409; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries
