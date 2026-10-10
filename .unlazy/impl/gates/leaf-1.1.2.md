# Gates: B1 admin fork + B2 web fork + B9 attribution and identity

OWNS: apps/admin/**, apps/web/**, packages/constants/**, src/auth/**, tests/auth/**, docs/impl/agent-gates/leaf-1.1.2.GATES.md

Scope: B1 and B2 (spec §8) the six-file Plane v1.4.2 fork surface as applicable patches with mirrored files and image build scripts; B9 (spec §9, §7.2) sender-only actor resolution, exactly-one email matching, encrypted per-user token vault with revocation, service credential loading

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.1.2.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: both fork patches apply to pristine makeplane/plane v1.4.2, touch at most six files in total, register a route in each routes.ts, render an iframe at the service UI path, and match their mirrored copies
  CHECK: node scripts/verify-fork-patch.mjs all
  EXPECT: fork patch verification passed
  EVIDENCE: pending

- [ ] G2: B9 satisfies the driver-held identity contract checks
  CHECK: node scripts/verify-identity-contract.mjs
  EXPECT: identity contract verification passed
  EVIDENCE: pending

- [ ] G3: the leaf's own auth test suite runs with at least 12 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 12 tests/auth
  EXPECT: tests passed
  EVIDENCE: pending

- [ ] G4: B9 typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/auth/**/*.ts" "tests/auth/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: pending

- [ ] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/auth tests/auth apps
  EXPECT: stub scan passed
  EVIDENCE: pending

- [ ] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.1.2.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending

- [ ] G7: driver review against spec §8 and §9 — the web iframe route checks workspace role (admin/owner) before rendering, fork files are the real v1.4.2 nav/route seams, build scripts produce the image tags the compose fragment expects, PATs are never logged
  EVIDENCE: pending
