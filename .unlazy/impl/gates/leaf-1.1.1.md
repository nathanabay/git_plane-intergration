# Gates: A1 deployment artifacts and service entry + A6 rule engine

OWNS: docker-compose.override.yaml, Dockerfile, .dockerignore, deploy/**, src/index.ts, src/rules/**, tests/deploy/**, tests/rules/**, docs/impl/agent-gates/leaf-1.1.1.GATES.md

Scope: A1 (spec §3) deployable container, compose fragment, Caddy route, env and database artifacts and the HTTP entry point; A6 (spec §7.5, §7.1) the rule engine with first-match-wins and a no-write dry-run mode

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.1.1.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=a32b465714c6046956f6b69b2d65939020655841ddaf3a785e942d7585fc7acf; exit=0; EXPECT=matched; output-sha256=24465188d5f3d34c0c075b959da1fbc0fe1e423b8a3870d8ce5254dddf0426fb; output-bytes=490; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: A1 compose fragment merges onto Plane v1.4.2 compose, Caddy route precedes the catch-all, image/env/SQL/APPLY artifacts exist, and the service boots, serves health, 404s unknown paths and exits cleanly on SIGTERM
  CHECK: node scripts/verify-a1-deploy.mjs
  EXPECT: A1 deploy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=286dbc85703b62af86c8eb3b6104b5c056ec04f3f5b2418be74488e99c427a21; exit=0; EXPECT=matched; output-sha256=45c80c61bb8cffc7d09e20087fa4340f5c4e1f20969be393475deed4777c0294; output-bytes=30; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: A6 satisfies the driver-held rule engine contract fixtures
  CHECK: node scripts/verify-rules-contract.mjs
  EXPECT: rules contract verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=0b94274d62ae6f4827f8c7e944cd8f4950822e30928b5997505c7d5599fec56f; exit=0; EXPECT=matched; output-sha256=dc04f530ca367caf1dca482a6c8d7ae459804db0594275951b9968ef06e1483c; output-bytes=945; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: the leaf's own test suites run with at least 20 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 20 tests/rules tests/deploy
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=2e12cd68758f489e6eec0b9bf41be1f3e6321e259d9270d322ca8ce78d807466; exit=0; EXPECT=matched; output-sha256=78f96acf110bce72c1b92cafdd99561b525ca4bb37a58bad58fbcc649b14e15e; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: the leaf's TypeScript typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/index.ts" "src/rules/**/*.ts" "tests/rules/**/*.ts" "tests/deploy/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=0f5ed0fc8296c50041d17c08ed1990f2c5d7e5cf81aee5984c6f264a5dfe3ed9; exit=0; EXPECT=matched; output-sha256=0d16eba72c0684781daab23935b0c8c2af0878f0c38504c27e044274dfcba85c; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/rules deploy Dockerfile docker-compose.override.yaml tests/rules tests/deploy
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=eb55013d420595aff2fe7e0b3e5040afa4a59098f0f129c4a4448462d08c4028; exit=0; EXPECT=matched; output-sha256=5ba58833636c7e4236b20c97e897e269a323e5d64b6f03a47ff5b7a9ad17c0d9; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.1.1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1bceb70653889c139bde3302c28588fd7cbe092b4b5abbf14175a77003747107; exit=0; EXPECT=matched; output-sha256=cb8e4176c9d51feaf8fe935850126effc3e114074fe174c38e1560546414f3c1; output-bytes=64; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G7: driver review against spec §3 and §7.5 — fragment is mergeable into an existing override without clobbering it, APPLY.md is an ordered runbook a human can follow, rule engine semantics match §7.5 and do not grow a second evaluator
  EVIDENCE: driver review after fix round w1b. §3: docker-compose.override.yaml adds only the git-sync service, the admin/web image keys and the external gateway network, so it merges into an existing override (verify-a1-deploy merges it onto upstream v1.4.2 compose); key mounted read-only at docker-compose.override.yaml:16-17. APPLY.md is ordered: backup, build git-sync, build both fork images before compose up (APPLY.md:19-26 vs :118), secrets, DB via psql -U $POSTGRES_USER -v gitsync_password (APPLY.md:68-70, 000-create-database.sql:1 uses format %L), caddy validate before reload (:138-148), webhooks, verification, rollback. §7.5: src/rules/engine.ts rejects unknown rule keys (engine.ts:41-46), validates family members, first match wins, run() executes nothing in dry-run; no second evaluator exists. Carried to leaf-1.2.1 (owns deploy/** next): base64 DB password breaks DATABASE_URL (APPLY.md:41, env example :5) and APPLY.md echoes the password.
