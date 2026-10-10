# Gates: phase 5 verification and wiring integration

Scope: integrate children leaf-1.5.1 with the verified phase 4 result into the running service

- [x] N1: the direct child is reverified from their exact ledgers
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --timeout 1800 --reverify --jobs 1 .unlazy/impl/gates/leaf-1.5.1.md
  EXPECT: ALL MET
  EVIDENCE: automatic-evidence=v1; definition-sha256=dac8f9e2d8533a683df62214371bdbb804ae7f062215f1976fa35aecc8ac8a93; exit=0; EXPECT=matched; output-sha256=b9bcfb63fea990c00d41ebcd2cf6a5ca0e5964c99f755077f58ed588d03eff28; output-bytes=7832; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N2: the whole tree, including the TSX app, typechecks together
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=ff3f4abbd6b531004f5688f48a2407918e98e311552d1bf1b526d3d034c64e2e; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N3: every test suite passes together in one run
  CHECK: node scripts/run-tests.mjs 400 tests
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=6e58263bd22a649dcc26738efa70ff7515f764e4ae9bf7a0aa914562fbc3683b; exit=0; EXPECT=matched; output-sha256=b564240f3f93fe4593d215d03e91ccb1e6981059e571ae14ba4f67c9c8555add; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N4: every leaf oracle so far still passes against the integrated tree
  CHECK: sh -c 'for o in verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "phase 5 oracles passed"'
  EXPECT: phase 5 oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5627e45a6f34ffbe91a0ef35946481ffd15526f9d2c129b0fba42b900ee62157; exit=0; EXPECT=matched; output-sha256=89d22b4bd710afda4f36dec67f572f59222446a9ecc5c15f4d144f375b1ca177; output-bytes=23; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N5: every direct leaf child's ownership lease was released after parent verification
  EVIDENCE: leaf-1.5.1: `released 1 lease(s) for impl/leaf-1.5.1` after reverify ALL MET (9 met).

- [x] N6: consequential manual outcomes from the children were reviewed at branch level
  EVIDENCE: driver reviewed leaf-1.5.1:G7; N3 caught a cross-suite regression (tests/db hard-coded migration list) that the leaf's own gates missed — fixed in w5b and a whole-repository test gate (G8) added to the leaf. Live smoke test against the local Plane v1.4.2 confirmed the write semantics and exposed the identifier-endpoint 403 defect; both recorded in .unlazy/impl/evidence/plane-webhook-probe.md and handed to the reviewer.
