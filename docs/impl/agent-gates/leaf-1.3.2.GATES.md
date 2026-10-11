# Gates for leaf-1.3.2

OWNS: src/ui/**, tests/ui/**, Dockerfile, .dockerignore, docs/impl/agent-gates/leaf-1.3.2.GATES.md

- [x] G1: B3 config API and UI pass the driver oracle
  CHECK: node scripts/verify-b3-config-api.mjs
  EXPECT: B3 config API verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=67d87923fe122ba6e1238c5e2fc0dd7b3db27aa9e271fe9e6264a1a84cb77ccb; exit=0; EXPECT=matched; output-sha256=2d0d5434a80f1673362045b853e724343a8fd2c5c0b332aad98efffbc2a7e854; output-bytes=1288; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: the image still meets the deploy contract
  CHECK: node scripts/verify-a1-deploy.mjs
  EXPECT: A1 deploy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=286dbc85703b62af86c8eb3b6104b5c056ec04f3f5b2418be74488e99c427a21; exit=0; EXPECT=matched; output-sha256=45c80c61bb8cffc7d09e20087fa4340f5c4e1f20969be393475deed4777c0294; output-bytes=30; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: own tests run, at least 25 passing, none skipped
  CHECK: node scripts/run-tests.mjs 25 tests/ui
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4848bc975ab5edacc618a2504a83e6e5ebf7f41236a0c98168bfaff2a6900e04; exit=0; EXPECT=matched; output-sha256=c059c2d729cd03835dc63cbfed178e496e1c4c0e4d9f1bc8503cbb8e22851978; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: typecheck clean, including the TSX app
  CHECK: node scripts/typecheck.mjs "src/ui/**/*.ts" "src/ui/**/*.tsx" "tests/ui/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=44f98d51f1d010785cc33ad6895738f3a0b955fee143cf5b9481c52c5de744a3; exit=0; EXPECT=matched; output-sha256=0011fd787472ba3511ba3e9aede872bfcf6cd58479700b8d57acc2bba7edfdd3; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no stubs or placeholders
  CHECK: node scripts/verify-no-stubs.mjs src/ui tests/ui Dockerfile
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=56758ff58896b275add9a2afc14832c0990319a685471468161c215377a0768d; exit=0; EXPECT=matched; output-sha256=bfdcbb839bc518adf9e914d46f1f713658ed846e2f4fb46bbf84e67cb9277024; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries
