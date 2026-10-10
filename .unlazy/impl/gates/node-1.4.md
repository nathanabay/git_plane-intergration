# Gates: phase 4 features integration

Scope: integrate children leaf-1.4.1 and leaf-1.4.2 with the verified phase 3 result

- [x] N1: both direct children are reverified from their exact ledgers
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --timeout 900 --reverify --jobs 1 .unlazy/impl/gates/leaf-1.4.1.md .unlazy/impl/gates/leaf-1.4.2.md
  EXPECT: ALL MET
  EVIDENCE: automatic-evidence=v1; definition-sha256=605dbc05dc397e2ad8a8de1cf8024cd371f7ae3b061a6ab053d5e037eed29e9b; exit=0; EXPECT=matched; output-sha256=99f11410c5dd5ba123fa795f3d74e6353d6196daf61d7c297bd8076b3fafc4e0; output-bytes=15580; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N2: the whole tree, including the TSX app, typechecks together
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=1ae43ebf1f679870a22e8532b4611efe3bab0a2de9644ef9c5bb27a7e1d498df; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N3: every test suite passes together in one run
  CHECK: node scripts/run-tests.mjs 300 tests
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a09898008c6a67ea970800feb87260d760ed8ded3395f3df8fa0eaf7795856e5; exit=0; EXPECT=matched; output-sha256=c564d0f9cd1bf9b19efa172b41df00beac4e427c05b5c0a98a3320b7b62c7505; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N4: every leaf oracle so far still passes against the integrated tree
  CHECK: sh -c 'for o in verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "phase 4 oracles passed"'
  EXPECT: phase 4 oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e7893b751d92d216b10c6d6075bdce548306e402cd75ec088deb803623fa2235; exit=0; EXPECT=matched; output-sha256=d4e62b66172c385c444f4b07feadda69799c5781dde3c4a94eb1d05b29deaa9e; output-bytes=23; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N5: every direct leaf child's ownership lease was released after parent verification
  EVIDENCE: leaf-1.4.1: `released 1 lease(s) for impl/leaf-1.4.1`; leaf-1.4.2: `released 1 lease(s) for impl/leaf-1.4.2` — after reverify ALL MET.

- [x] N6: consequential manual outcomes from the children were reviewed at branch level
  EVIDENCE: driver reviewed leaf-1.4.1:G7 (read-only sweep, payload-only delivery audit, parsing false-positive control) and leaf-1.4.2:G7 (all writes via A4, sender-only attribution); five gaps from B routed (remove-assignee write, mirror create race constraint, replay/backfill wiring → wave 5; label-delta format → test Plane; at-most-once Smart Commits → reviewer). Claim refusal at w4b dispatch recorded in status.log and resolved by disjoint test directories.
