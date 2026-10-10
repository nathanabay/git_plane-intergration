# Gates: B3 embedded React configuration app and config API

OWNS: src/ui/**, tests/ui/**, Dockerfile, .dockerignore, docs/impl/agent-gates/leaf-1.3.2.GATES.md

Scope: B3 (spec §8, §7.3, §7.6, §9) the one React app with instance-admin and workspace-settings entry routes, and the config API that authenticates every request against Plane's session, re-checks role on every write, refuses cross-site writes, stores configuration locally with secrets encrypted

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.3.2.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=e7089489b9251b973aee8b103da9c0983ee8ede22ec535eded924049821043d1; exit=0; EXPECT=matched; output-sha256=396a54b8967c003b4f38fbd9c9a2e798f0527f46076ad9c853a5812cf1b1ab0c; output-bytes=465; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: the config API's auth, CSRF, validation, defaults, encryption, no-Plane-writes rule and UI serving satisfy the driver oracle
  CHECK: node scripts/verify-b3-config-api.mjs
  EXPECT: B3 config API verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=67d87923fe122ba6e1238c5e2fc0dd7b3db27aa9e271fe9e6264a1a84cb77ccb; exit=0; EXPECT=matched; output-sha256=2d0d5434a80f1673362045b853e724343a8fd2c5c0b332aad98efffbc2a7e854; output-bytes=1288; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: the multi-stage image still meets the deploy contract
  CHECK: node scripts/verify-a1-deploy.mjs
  EXPECT: A1 deploy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=286dbc85703b62af86c8eb3b6104b5c056ec04f3f5b2418be74488e99c427a21; exit=0; EXPECT=matched; output-sha256=45c80c61bb8cffc7d09e20087fa4340f5c4e1f20969be393475deed4777c0294; output-bytes=30; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: the leaf's own tests run with at least 25 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 25 tests/ui
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4848bc975ab5edacc618a2504a83e6e5ebf7f41236a0c98168bfaff2a6900e04; exit=0; EXPECT=matched; output-sha256=c059c2d729cd03835dc63cbfed178e496e1c4c0e4d9f1bc8503cbb8e22851978; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: the server code and the TSX app typecheck under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/ui/**/*.ts" "src/ui/**/*.tsx" "tests/ui/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=44f98d51f1d010785cc33ad6895738f3a0b955fee143cf5b9481c52c5de744a3; exit=0; EXPECT=matched; output-sha256=0011fd787472ba3511ba3e9aede872bfcf6cd58479700b8d57acc2bba7edfdd3; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/ui tests/ui Dockerfile
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=56758ff58896b275add9a2afc14832c0990319a685471468161c215377a0768d; exit=0; EXPECT=matched; output-sha256=bfdcbb839bc518adf9e914d46f1f713658ed846e2f4fb46bbf84e67cb9277024; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.3.2.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e761bec4f63ea06a654a3544df1855957bcd125616589f969d69e51d5f5e8b7c; exit=0; EXPECT=matched; output-sha256=cb8e4176c9d51feaf8fe935850126effc3e114074fe174c38e1560546414f3c1; output-bytes=64; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G7: driver review — every handler authenticates before touching the DB, the role check is never cached, no secret reaches a response or a log, the UI covers every §8 workspace and instance surface assigned to B3
  EVIDENCE: driver review: src/ui/plane-auth.ts authenticates every request against Plane (users/me + workspace-members/me, instances/admins/me for instance routes) with no cache, forwards only the validated session cookie (RFC 6265 octet check), manual redirects, 8s timeout, 401/403 split per §8; api.ts validates Origin and JSON content type on writes (oracle), encrypts GitHub App secrets with B9 and never returns them, revokes tokens on unlink, issues no Plane writes. UI covers mappings, rules, conflict policy, toggles, user links, audit (workspace) and app credentials, magic words, settings (instance). Not yet browser-tested: the React app was built and served but not exercised in a browser; to be covered in review/E2E.
