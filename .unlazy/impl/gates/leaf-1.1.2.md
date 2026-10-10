# Gates: B1 admin fork + B2 web fork + B9 attribution and identity

OWNS: apps/admin/**, apps/web/**, packages/constants/**, src/auth/**, tests/auth/**, docs/impl/agent-gates/leaf-1.1.2.GATES.md

Scope: B1 and B2 (spec §8) the six-file Plane v1.4.2 fork surface as applicable patches with mirrored files and image build scripts; B9 (spec §9, §7.2) sender-only actor resolution, exactly-one email matching, encrypted per-user token vault with revocation, service credential loading

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.1.2.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=fe37bc9ac8225625c6618492a95c23d30d1b5ffeaf86ed6c7f8191b87de099d5; exit=0; EXPECT=matched; output-sha256=32382107c83674e6baaafad9852435024dc2abeba7ce757ce0299a07c11804c4; output-bytes=509; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: both fork patches apply to pristine makeplane/plane v1.4.2, touch at most six files in total, register a route in each routes.ts, render an iframe at the service UI path, and match their mirrored copies
  CHECK: node scripts/verify-fork-patch.mjs all
  EXPECT: fork patch verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=dfccc5ecdc7d2ae06cd26a8455f07d671b653e98a8b4f583709df50c42426dac; exit=0; EXPECT=matched; output-sha256=f31cbc7b52f3beb1a7b6f3d14ce4747cb72f7a499b6e0babbad2735031c94d8a; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: B9 satisfies the driver-held identity contract checks
  CHECK: node scripts/verify-identity-contract.mjs
  EXPECT: identity contract verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4f4230df2a2379e9c49bfe7767f8b444ad69a05b84aeeafa225f746b62b9c64e; exit=0; EXPECT=matched; output-sha256=fca8367890c384d279c9e0058e1271b06016cf3bc28db9ec9f09216d678a1ea8; output-bytes=1164; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: the leaf's own auth test suite runs with at least 12 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 12 tests/auth
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=cda8280641a7af66c51ee1b0ec9661b6131b962200dc13c9aa2da8d6b59be957; exit=0; EXPECT=matched; output-sha256=a2d7a796758a0fd2debf5242ed7290b7c0a3916ddecf36a2ea5695ddc50da511; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: B9 typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/auth/**/*.ts" "tests/auth/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=073e03af09051123f15768f2039c6398408b8cfa45e338a07da4429ad0f72873; exit=0; EXPECT=matched; output-sha256=8957d743754be89b6f55f19d1ed18506b4282cdbfbbf2b77be1b309d59f1f5bd; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/auth tests/auth apps
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=307374c31f7bfd583c30a049c2f52075bcf3194130379c74d52978df7d544df7; exit=0; EXPECT=matched; output-sha256=c2b55827418d8d1d9faa2c394ac70522689717258aac134e0a02911b8aa85225; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.1.2.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=adfa0f57b9f144cf243aa7abdb60a3371673ae733d4629248161705a1c0189c7; exit=0; EXPECT=matched; output-sha256=bf3418561dc14ab5574225a979503f71d98f7fe61a794ae943b1a708d392415c; output-bytes=64; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G7: driver review against spec §8 and §9 — the web iframe route checks workspace role (admin/owner) before rendering, fork files are the real v1.4.2 nav/route seams, build scripts produce the image tags the compose fragment expects, PATs are never logged
  EVIDENCE: driver review after fix round w1b. §8: web route registered through Plane's own seam apps/web/app/routes/extended.ts (mergeRoutes deep-merges by layout file; verify-fork-patch evaluates the merged tree: no duplicate ids, route nested under settings/(workspace)/layout.tsx); nav entry in item-categories.tsx uses upstream SettingsSidebarItem props (apps/web/core/components/settings/sidebar/item.tsx:14-22) and lucide-react 0.469.0 Github icon, gated by allowPermissions([ADMIN], WORKSPACE); page gates on EUserPermissions.ADMIN and renders NotAuthorizedView; three files per app, six total; admin route sits under the dashboard layout that already restricts to instance admins. Build scripts tag plane-admin-gitsync:v1.4.2 / plane-frontend-gitsync:v1.4.2 with upstream Dockerfile.admin / Dockerfile.web (verified present at v1.4.2). §9: identity.ts resolves from sender only, enforces 12-byte IV / 16-byte tag, SecretString redacts; no token is logged. Minor carried to review: the web page renders the iframe while workspaceUserInfo is still loading; B3's server-side check is the real gate.
