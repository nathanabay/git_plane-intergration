# Gates: phase 3 write path and configuration integration

Scope: integrate children leaf-1.3.1 and leaf-1.3.2 with the verified phase 2 result

- [x] N1: both direct children and the phase 2 branch are reverified from their exact ledgers
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --jobs 1 .unlazy/impl/gates/leaf-1.3.1.md .unlazy/impl/gates/leaf-1.3.2.md .unlazy/impl/gates/node-1.2.md
  EXPECT: ALL MET
  EVIDENCE: automatic-evidence=v1; definition-sha256=c6daada22c93c83a61a68b029d296e56804e1d33e32a4e9db3bd33fde0b3c4ed; exit=0; EXPECT=matched; output-sha256=8a6f240561614e4f4e31cca366f0aa8bc12adf3abdb9f3d36f43a5b6076d951b; output-bytes=21327; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N2: the whole tree, including the TSX app, typechecks together
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=1b37867dd31513c2eb6aca51e42a6363b9d3a26539c07d20d0d0a97aea0add92; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N3: every test suite passes together in one run
  CHECK: node scripts/run-tests.mjs 150 tests
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3d6438fa103b0b42ccbe38d4697fb7145ebe10b6106a21e10990e7f0ba840f75; exit=0; EXPECT=matched; output-sha256=79cc42dfd560da640f9a100c85df98e3211036de918ceef05c638529b7ab85c1; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N4: every leaf oracle so far still passes against the integrated tree
  CHECK: sh -c 'for o in verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "phase 3 oracles passed"'
  EXPECT: phase 3 oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=9c528524353e2baa9d1f1c54ed7a7e5f87b3869e42ec7a8a8a795bb3758632fb; exit=0; EXPECT=matched; output-sha256=2b091c734ed7e14e59dcd887e5b78fd33a4af3946b8e9905a50fb19b8edaf0f8; output-bytes=23; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N5: every direct leaf child's ownership lease was released after parent verification
  EVIDENCE: leaf-1.3.1: `released 1 lease(s) for impl/leaf-1.3.1`; leaf-1.3.2: `released 1 lease(s) for impl/leaf-1.3.2` — both after reverify ALL MET.

- [x] N6: consequential manual outcomes from the children were reviewed at branch level
  EVIDENCE: driver reviewed leaf-1.3.1:G8 (write path, triage guard, ingress consumption) and leaf-1.3.2:G7 (session auth without cache, cookie scoping, CSRF, encrypted secrets, no Plane writes); no out-of-OWNS writes in wave 3. N1 first failed only on gate-check's default 120s per-check timeout (nested reverify is longer); passes with --timeout 1800. Carried to wave 4: audit_log.workspace_slug, inbound deliveries audited with payload for B8 replay, dev-info link table for B7, mounting B3 routes in index.ts.
