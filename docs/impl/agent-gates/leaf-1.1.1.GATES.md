# Gates for leaf-1.1.1

OWNS: docker-compose.override.yaml, Dockerfile, .dockerignore, deploy/**, src/index.ts, src/rules/**, tests/deploy/**, tests/rules/**, docs/impl/agent-gates/leaf-1.1.1.GATES.md

- [x] G1: A1 deploy artifacts and service entry pass the driver oracle
  CHECK: node scripts/verify-a1-deploy.mjs
  EXPECT: A1 deploy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=286dbc85703b62af86c8eb3b6104b5c056ec04f3f5b2418be74488e99c427a21; exit=0; EXPECT=matched; output-sha256=45c80c61bb8cffc7d09e20087fa4340f5c4e1f20969be393475deed4777c0294; output-bytes=30; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G2: A6 satisfies the driver-held rule engine contract
  CHECK: node scripts/verify-rules-contract.mjs
  EXPECT: rules contract verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=0b94274d62ae6f4827f8c7e944cd8f4950822e30928b5997505c7d5599fec56f; exit=0; EXPECT=matched; output-sha256=dc04f530ca367caf1dca482a6c8d7ae459804db0594275951b9968ef06e1483c; output-bytes=945; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G3: own tests run, at least 20 passing, none skipped
  CHECK: node scripts/run-tests.mjs 20 tests/rules tests/deploy
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=2e12cd68758f489e6eec0b9bf41be1f3e6321e259d9270d322ca8ce78d807466; exit=0; EXPECT=matched; output-sha256=df742726ad15441fa4c04b5ae881dab96413da733d67b23e95571a1edc9a2b27; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G4: typecheck clean
  CHECK: node scripts/typecheck.mjs "src/index.ts" "src/rules/**/*.ts" "tests/rules/**/*.ts" "tests/deploy/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=0f5ed0fc8296c50041d17c08ed1990f2c5d7e5cf81aee5984c6f264a5dfe3ed9; exit=0; EXPECT=matched; output-sha256=0d16eba72c0684781daab23935b0c8c2af0878f0c38504c27e044274dfcba85c; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries

- [x] G5: no stubs or placeholders
  CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/rules deploy Dockerfile docker-compose.override.yaml tests/rules tests/deploy
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=eb55013d420595aff2fe7e0b3e5040afa4a59098f0f129c4a4448462d08c4028; exit=0; EXPECT=matched; output-sha256=5ba58833636c7e4236b20c97e897e269a323e5d64b6f03a47ff5b7a9ad17c0d9; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=7703dcba3837/30 entries
