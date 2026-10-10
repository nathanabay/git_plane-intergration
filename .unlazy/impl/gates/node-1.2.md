# Gates: phase 2 skeleton and storage integration

Scope: integrate child leaf-1.2.1 with the verified phase 1 result into one working service skeleton

- [x] N1: the direct child and the phase 1 branch are reverified from their exact ledgers
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --jobs 1 .unlazy/impl/gates/leaf-1.2.1.md .unlazy/impl/gates/node-1.1.md
  EXPECT: ALL MET
  EVIDENCE: automatic-evidence=v1; definition-sha256=b86569bef020a64baa29e79a1b6c62063d8be2931bc302acedec55768149debd; exit=0; EXPECT=matched; output-sha256=539371d6a3c915e5a16baf1db1b75b1596fee2b135bd3466c1149e0e6b52c29f; output-bytes=13517; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N2: the whole tree typechecks together
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5873654f4b4075ecd44285772b2a40fd5f712e8357408b3e0abcb07470720a06; exit=0; EXPECT=matched; output-sha256=d409dc8e4edeb956e017e38a318c2a276c6fd04a2ab333ac37b62dc02851d869; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N3: every phase 1 and phase 2 test suite passes together in one run
  CHECK: node scripts/run-tests.mjs 75 tests/rules tests/deploy tests/auth tests/api tests/queue tests/db
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4f11814c98e67480ba44e2a74eebb75242e401453d6171659851b5b6c4de7f62; exit=0; EXPECT=matched; output-sha256=3db3ab5038027df41aff6087fc6169ab42bd413f8a1d6fd6ea4f5f52520637ad; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N4: cross-leaf contract — B9's real TokenVault works on A3's PgTokenStore, and the identity contract still holds
  CHECK: node scripts/verify-identity-contract.mjs
  EXPECT: identity contract verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4f4230df2a2379e9c49bfe7767f8b444ad69a05b84aeeafa225f746b62b9c64e; exit=0; EXPECT=matched; output-sha256=fca8367890c384d279c9e0058e1271b06016cf3bc28db9ec9f09216d678a1ea8; output-bytes=1164; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N5: every direct leaf child's ownership lease was released after parent verification
  EVIDENCE: leaf-1.2.1: `released 1 lease(s) for impl/leaf-1.2.1` after its reverify returned ALL MET (9 met).

- [x] N6: consequential manual outcomes from the child were reviewed at branch level
  EVIDENCE: driver reviewed leaf-1.2.1:G8 (handler scope, atomic migrations on real PG, consume-once with SKIP LOCKED, schema corrections) and confirmed the cross-leaf repair: B9's identity.ts restored and re-verified (leaf-1.1.2 ALL MET), PgTokenStore implements B9's TokenStore (N4). Roster change rev 3 recorded in PLAN.md and status.log.
