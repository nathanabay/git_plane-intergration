# Gates: A4 single write path and queue consumers

OWNS: src/sync/**, src/queue/**, src/db/**, src/index.ts, src/config/**, tests/sync/**, tests/queue/**, tests/db/**, tests/deploy/**, deploy/**, docs/impl/agent-gates/leaf-1.3.1.GATES.md

Scope: A4 (spec §5, §3, §4, §7.1, §9) the one Plane and GitHub write path every later task uses — field-granular op recording before writes, ingress echo consumption, Plane 400/409 semantics, triage ban, rate-limit backoff, queue workers and service wiring

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.3.1.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=c262a8ab6c5361ed96e88b114789cbcb68d32902ee7fb067fe3ddac71fddb14c; exit=0; EXPECT=matched; output-sha256=6882633bb76967151d0a3096476c8be8cecc444a534f8221fc9bf0818fc3101a; output-bytes=174; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: the write path, echo ledger, Plane semantics, triage ban, backoff and workers satisfy the driver oracle
  CHECK: node scripts/verify-a4-writepath.mjs
  EXPECT: A4 write path verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=cfee44e11e35a2b80ecfea788f3aa94f9f42dade9dfc034180694b4f4a542321; exit=0; EXPECT=matched; output-sha256=6e0758264de5710d1fae409c8ac14eaac7d9650bbe00fb574669ff9bda17e5ad; output-bytes=1546; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: A2 ingress behaviour did not regress
  CHECK: node scripts/verify-a2-ingress.mjs
  EXPECT: A2 ingress verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3459d0b605b7a7ea2f743ab17c5f18533c69e69560908faa05bc5204ee6c12f8; exit=0; EXPECT=matched; output-sha256=16a9408ae54fd8e2f0ebb7f9f3cdd3cad4325de8e537563b2c3d2f52b2b9bc4e; output-bytes=1268; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: A3 ledger behaviour did not regress
  CHECK: node scripts/verify-a3-schema.mjs
  EXPECT: A3 schema verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=bc165618ef39922b9fe506cd3ea130671b73fefda60702fe92db217223aa9aab; exit=0; EXPECT=matched; output-sha256=3f42e8f415f480999dcd655db0aa0e00dbef20cbd810c27165d0d721822a8f8c; output-bytes=1409; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: the leaf's own tests run with at least 35 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 35 tests/sync tests/queue
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=53ec0c5225e47d7a7e9efcc9035e910483b08e0d6e570d05f6d19b7aa4cc6456; exit=0; EXPECT=matched; output-sha256=e1434934225cc0c93cf62a0c1d582833ccaffd3b5762bfd2b62f3672f51d36ab; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: the leaf's TypeScript typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/sync/**/*.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "src/index.ts" "src/config/**/*.ts" "tests/sync/**/*.ts" "tests/queue/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=585724efceab5324b4edcfb456682e25791fd7dd9f4543943ac6e16436791e31; exit=0; EXPECT=matched; output-sha256=2edb6663fd7d2b9d5ddab5970a263d53cd4a009218685e8f040dff1b89e986a2; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/sync src/queue src/db src/index.ts tests/sync tests/queue
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=00173a41c6a9e0cbd2f86a4c094a00849b3078f5c7053f37f1af64a5b6c270b9; exit=0; EXPECT=matched; output-sha256=d700bbaaeb45afe92ee5c92925955e5dc24b5fc21f671e4a7247c311caa76ae9; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G7: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.3.1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e9e4ec868316c21b6e5ed9eea52b8cbbe5034d8fbcf90592c3c2cd3d3638e259; exit=0; EXPECT=matched; output-sha256=e59cf7132e52dd9b7bdc73ab355aa69ecf174b08ff77b8d3261bac1599caa238; output-bytes=64; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G8: driver review — no write path bypasses op recording, echoes are dropped only on ingress, triage check precedes every state write, no token or body is logged
  EVIDENCE: driver review: src/sync/plane.ts:157-212 — update_issue guards triage (#guardState, plane.ts:147-155, refreshes the state cache once before failing on an unknown id) before recording; ops recorded before the PATCH and forgotten on failure (plane.ts:167-172); create/comment record `created` after success; add_link 400-duplicate and label 409 handled per §3. github.ts records and forgets the same way (github.ts:118-123). src/queue/workers.ts processInbound drops duplicates, consumes ops on ingress only, consumes on the service-actor pre-filter, and releases the delivery id when a handler throws so BullMQ retries are not lost. No token or body is logged. Carried to wave 4 (A): audit_log needs a workspace_slug column (raised by B3); index.ts must mount B3's routes.
