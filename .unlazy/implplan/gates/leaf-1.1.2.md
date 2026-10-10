# Gates: implementation plan — GitHub side and Plane UI forks

OWNS: docs/plan/part-b-github-ui.md, docs/plan/agent-gates/part-b.GATES.md

Scope: author the complete implementation plan for the GitHub App, Smart Commits, dev-info surfacing, the two Plane frontend forks and operational tooling (spec §7.1, §7.2, §7.3, §7.4, §7.6, §8, §9)

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/implplan/gates/leaf-1.1.2.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=546896e365d2cae7b8f5ef9fd11aab41bd9eb1a03ac3812b2c933ad624076c38; exit=0; EXPECT=matched; output-sha256=1496943aa89e42cce2f1254af7e3b2ab55884e1156bceada03337c9f93a42a07; output-bytes=178; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] G1: part B is a structurally complete plan whose every spec citation resolves
  CHECK: node scripts/verify-plan-part.mjs docs/plan/part-b-github-ui.md B 7.1,7.2,7.3,7.4,7.6,8,9
  EXPECT: plan part verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f91f3a2bdb206a87c0083c04214cb5f7b8e8f82f4c7c34afc821e9ad12788203; exit=0; EXPECT=matched; output-sha256=03b606dc05e0be72546e3acd536ec53078f6e6766f2c8a54aeb05c92508d0f55; output-bytes=53; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] G2: the four-file fork surface and GitHub App permission set are stated precisely enough to execute without re-deriving them
  EVIDENCE: driver review of docs/plan/part-b-github-ui.md after fix round ready-1c. Fork surface is exactly four files, counted from the Files lines of B1 and B2: apps/admin/components/nav.tsx, apps/admin/pages/git-sync-iframe.tsx, apps/web/components/nav.tsx, apps/web/pages/git-sync-iframe.tsx. The permission set is enumerated at lines 10-13: repository Pull requests Read+Write, Issues Read+Write, Contents Read+Write, Checks Read-only, Deployments Read-only, Administration Write (only if autolinks enabled); organization Members Read-only; plus the caveat that adding a permission later forces re-consent on every existing installation. B6 independently records that autolinks stay off by default because they require Administration: Write, consistent with spec 7.4.

- [x] G3: the agent ran unlazy on its own work and left a ledger whose every gate is met with checker-written evidence
  CHECK: node scripts/verify-agent-unlazy.mjs docs/plan/agent-gates/part-b.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=64cae72b60c096ef8e5fbdfa9d45671d254ee4959e4ef6bce7a08f928f0883e0; exit=0; EXPECT=matched; output-sha256=a095a1016fc86aea52bcc8a2c56ad715af99e0524617ef3fb398748942fac800; output-bytes=64; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries
