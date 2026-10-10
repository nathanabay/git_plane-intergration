# Gates: phase 3 write path and configuration integration

Scope: integrate children leaf-1.3.1 and leaf-1.3.2 with the verified phase 2 result

- [ ] N1: both direct children and the phase 2 branch are reverified from their exact ledgers
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --jobs 1 .unlazy/impl/gates/leaf-1.3.1.md .unlazy/impl/gates/leaf-1.3.2.md .unlazy/impl/gates/node-1.2.md
  EXPECT: ALL MET
  EVIDENCE: pending

- [x] N2: the whole tree, including the TSX app, typechecks together
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=1ae43ebf1f679870a22e8532b4611efe3bab0a2de9644ef9c5bb27a7e1d498df; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [ ] N3: every test suite passes together in one run
  CHECK: node scripts/run-tests.mjs 150 tests
  EXPECT: tests passed
  EVIDENCE: pending

- [x] N4: every leaf oracle so far still passes against the integrated tree
  CHECK: sh -c 'for o in verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "phase 3 oracles passed"'
  EXPECT: phase 3 oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=9c528524353e2baa9d1f1c54ed7a7e5f87b3869e42ec7a8a8a795bb3758632fb; exit=0; EXPECT=matched; output-sha256=2b091c734ed7e14e59dcd887e5b78fd33a4af3946b8e9905a50fb19b8edaf0f8; output-bytes=23; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N5: every direct leaf child's ownership lease was released after parent verification
  EVIDENCE: leaf-1.3.1: `released 1 lease(s) for impl/leaf-1.3.1`; leaf-1.3.2: `released 1 lease(s) for impl/leaf-1.3.2` — both after reverify ALL MET.

- [x] N6: consequential manual outcomes from the children were reviewed at branch level
  EVIDENCE: driver reviewed leaf-1.3.1:G8 (write path, triage guard, ingress consumption) and leaf-1.3.2:G7 (session auth without cache, cookie scoping, CSRF, encrypted secrets, no Plane writes); no out-of-OWNS writes in wave 3. N1 first failed only on gate-check's default 120s per-check timeout (nested reverify is longer); passes with --timeout 1800. Carried to wave 4: audit_log.workspace_slug, inbound deliveries audited with payload for B8 replay, dev-info link table for B7, mounting B3 routes in index.ts.
