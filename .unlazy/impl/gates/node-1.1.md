# Gates: phase 1 foundations integration

Scope: integrate children leaf-1.1.1 and leaf-1.1.2 into one verified phase 1 result

- [x] N1: every named direct child is reverified from its exact ledger
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --jobs 1 .unlazy/impl/gates/leaf-1.1.1.md .unlazy/impl/gates/leaf-1.1.2.md
  EXPECT: ALL MET
  EVIDENCE: automatic-evidence=v1; definition-sha256=946d3628c2e2d7557dc82ea33c957e75ac26b68647ca466f69289d1ec0194673; exit=0; EXPECT=matched; output-sha256=c5507b68a62188928b60ea1be1acce998eef9c5dbc408ba29d7a4935d0f204fe; output-bytes=15929; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N2: the whole tree typechecks together, so the two children's files coexist under one tsconfig
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5873654f4b4075ecd44285772b2a40fd5f712e8357408b3e0abcb07470720a06; exit=0; EXPECT=matched; output-sha256=d409dc8e4edeb956e017e38a318c2a276c6fd04a2ab333ac37b62dc02851d869; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N3: every phase 1 test suite passes together in one run
  CHECK: node scripts/run-tests.mjs 32 tests/rules tests/deploy tests/auth
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a80047655aa13108a84b73814cbe5950d874b085ab2fde2fd6909e2b65042ee6; exit=0; EXPECT=matched; output-sha256=a7e92c4afbf5dec6a45df2a816a446a43371a14f54a362d52340c3372ebf5dc8; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N4: cross-child contract holds: the compose fragment's fork image tags equal the tags the fork build scripts produce
  CHECK: node scripts/verify-phase1-integration.mjs
  EXPECT: phase 1 integration verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=18e1cd5c758b5f9bdd66b33eadf2f9d39ebc5491872967dde815b56934ca9d64; exit=0; EXPECT=matched; output-sha256=e563612e275e3fe0282c3a5d2f57c6e2d06e480da4b55c9b44f987743686189c; output-bytes=40; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N5: every direct leaf child's ownership lease was released after parent verification
  EVIDENCE: leaf-1.1.1 released before wave 2 claim (`released 1 lease(s) for impl/leaf-1.1.1`); leaf-1.1.2: `released 1 lease(s) for impl/leaf-1.1.2`, after its reverify returned ALL MET (8 met).

- [x] N6: consequential manual outcomes from the children were reviewed at branch level
  EVIDENCE: driver reviewed both children's manual gates (leaf-1.1.1:G7, leaf-1.1.2:G7) after two fix rounds and one flake fix: driver review found 14 defects across rounds (duplicate React Router ids, as-any type suppression, hard-coded DB password, unmounted GitHub key, wrong psql user, missing fork build step, permissive rule keys, unvalidated trigger family members, truncated-GCM-tag acceptance, malformed-sender crash, lenient key decoding, role check, a 1/30 flaky tamper test, a stale typecheck claim); each was turned into a failing oracle check before the fix and passes now. Carried forward: base64 DB password in DATABASE_URL (assigned to leaf-1.2.1), iframe rendering before permissions load (to review).
