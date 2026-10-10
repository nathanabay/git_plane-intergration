# Gates: B4 Smart Commits, B5 PR automation, B6 mirroring, B7 dev info, B8 operations

OWNS: src/github/**, src/sync/mirror.ts, src/sync/dev-info.ts, src/operations/**, src/ui/**, tests/github/**, tests/mirror/**, tests/dev-info/**, tests/operations/**, tests/ui/**, docs/impl/agent-gates/leaf-1.4.2.GATES.md

Scope: B4 (§7.2) Smart Commits attributed from sender only and applied once per SHA, B5 (§7.1) lifecycle and branch rules compiled into the A6 engine, B6 (§7.3) label-gated two-way mirroring with conflict policies, B7 (§7.4) dev-info rollups updated in place with preview detection, B8 (§7.6) dry-run, audit replay and backfill with config API endpoints and UI

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.4.2.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=be55912afe3eb2f599d073b8bc4ca599832dbc8b1f9c605bfcb19d13fd31c02d; exit=0; EXPECT=matched; output-sha256=d8af81f19645dc975a9efd0a9910f4538185d357949cd49911beb553c93d73f3; output-bytes=423; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: B4-B8 satisfy the driver oracle
  CHECK: node scripts/verify-b4-b8.mjs
  EXPECT: B4-B8 verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=accd30ff72af4c02626b67ae3cf0255d9ba7599ad3529e2538d3669bf569a450; exit=0; EXPECT=matched; output-sha256=3a175bdd1ad82bac7f48612f479da20c6d9e71a4ad6354b9b883a14de8a3e748; output-bytes=1815; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: the B3 config API and UI did not regress
  CHECK: node scripts/verify-b3-config-api.mjs
  EXPECT: B3 config API verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=67d87923fe122ba6e1238c5e2fc0dd7b3db27aa9e271fe9e6264a1a84cb77ccb; exit=0; EXPECT=matched; output-sha256=2d0d5434a80f1673362045b853e724343a8fd2c5c0b332aad98efffbc2a7e854; output-bytes=1288; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: the leaf's own tests run with at least 60 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 60 tests/github tests/mirror tests/dev-info tests/operations tests/ui
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4924bc270170839cf3c2a9cf1c9e8d4f52726f90140f5341b518161ce4c1ffbe; exit=0; EXPECT=matched; output-sha256=e7c24b49b92b04319c479c9201537c28e1d75a4bbba979a07829fdd038307e23; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: the leaf's TypeScript typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/github/**/*.ts" "src/sync/mirror.ts" "src/sync/dev-info.ts" "src/operations/**/*.ts" "src/ui/**/*.ts" "src/ui/**/*.tsx" "tests/github/**/*.ts" "tests/operations/**/*.ts" "tests/ui/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a4c895c0e75caa8a97ef22d7c678fb95b865787d862a489c85e17bf6db5b779c; exit=0; EXPECT=matched; output-sha256=7e0aaae11a0b07104129111a7501f59b2498302821034ab02759ce1ba36a3a5b; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/github src/sync/mirror.ts src/sync/dev-info.ts src/operations src/ui tests/github tests/operations
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=cc758ed3c26c4cbaf863a6ff5d953839d66765da999101ef4bfbb30fff5dc6bd; exit=0; EXPECT=matched; output-sha256=07a4b14d9b1228a095da1a57deba437e6e6bf0547962b923f1352dae65e1574b; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.4.2.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=06f9453e1f3a8ebb8f75c83ceed09496aadbd7edbf80cf2431530377b62e849b; exit=0; EXPECT=matched; output-sha256=cb8e4176c9d51feaf8fe935850126effc3e114074fe174c38e1560546414f3c1; output-bytes=64; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G7: driver review — every write goes through A4, attribution never reads pusher or commit author, mirroring respects direction and policy, replay uses a fresh delivery id
  EVIDENCE: driver review: grep over src/github, src/sync/mirror.ts, src/sync/dev-info.ts, src/operations finds no fetch() or Octokit write outside A4's write paths and no read of pusher/commit author (smart-commits.ts:2 documents why). Oracle confirms sender-only attribution with a forged author, once-per-SHA, loud missing-state failures, rules compiled into A6, (group,name) state resolution, label-gated mirroring with §7.3 defaults, in-place rollups, dry-run without writes, replay under a fresh delivery id. Gaps reported by B and routed: (1) no remove-assignee GitHub write in A4 → wave 5 (A); (2) Plane label-delta activity format unconfirmed → verify against the local test Plane; (3) Smart Commits are at-most-once (SHA claimed before writes) → for the reviewer to adjudicate; (4) mirror duplicate-create race lacks a DB constraint → wave 5 (A); (5) replay/backfill 503 until wired → wave 5 (A).
