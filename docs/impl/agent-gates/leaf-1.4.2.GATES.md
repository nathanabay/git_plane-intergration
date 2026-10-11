# Gates for leaf-1.4.2

OWNS: src/github/**, src/sync/mirror.ts, src/sync/dev-info.ts, src/operations/**, src/ui/**, tests/github/**, tests/mirror/**, tests/dev-info/**, tests/operations/**, tests/ui/**, docs/impl/agent-gates/leaf-1.4.2.GATES.md

- [x] G1: B4-B8 pass the driver oracle
  CHECK: node scripts/verify-b4-b8.mjs
  EXPECT: B4-B8 verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=accd30ff72af4c02626b67ae3cf0255d9ba7599ad3529e2538d3669bf569a450; exit=0; EXPECT=matched; output-sha256=3a175bdd1ad82bac7f48612f479da20c6d9e71a4ad6354b9b883a14de8a3e748; output-bytes=1815; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: B3 config API and UI did not regress
  CHECK: node scripts/verify-b3-config-api.mjs
  EXPECT: B3 config API verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=67d87923fe122ba6e1238c5e2fc0dd7b3db27aa9e271fe9e6264a1a84cb77ccb; exit=0; EXPECT=matched; output-sha256=2d0d5434a80f1673362045b853e724343a8fd2c5c0b332aad98efffbc2a7e854; output-bytes=1288; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: own tests run, at least 60 passing, none skipped
  CHECK: node scripts/run-tests.mjs 60 tests/github tests/mirror tests/dev-info tests/operations tests/ui
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4924bc270170839cf3c2a9cf1c9e8d4f52726f90140f5341b518161ce4c1ffbe; exit=0; EXPECT=matched; output-sha256=e7c24b49b92b04319c479c9201537c28e1d75a4bbba979a07829fdd038307e23; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: typecheck clean
  CHECK: node scripts/typecheck.mjs "src/github/**/*.ts" "src/sync/mirror.ts" "src/sync/dev-info.ts" "src/operations/**/*.ts" "src/ui/**/*.ts" "src/ui/**/*.tsx" "tests/github/**/*.ts" "tests/operations/**/*.ts" "tests/ui/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a4c895c0e75caa8a97ef22d7c678fb95b865787d862a489c85e17bf6db5b779c; exit=0; EXPECT=matched; output-sha256=7e0aaae11a0b07104129111a7501f59b2498302821034ab02759ce1ba36a3a5b; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no stubs or placeholders
  CHECK: node scripts/verify-no-stubs.mjs src/github src/sync/mirror.ts src/sync/dev-info.ts src/operations src/ui tests/github tests/operations
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=cc758ed3c26c4cbaf863a6ff5d953839d66765da999101ef4bfbb30fff5dc6bd; exit=0; EXPECT=matched; output-sha256=07a4b14d9b1228a095da1a57deba437e6e6bf0547962b923f1352dae65e1574b; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries
