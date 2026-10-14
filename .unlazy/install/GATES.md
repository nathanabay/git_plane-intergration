# Gates: one-command installation

OWNS: install.sh, src/install/**, src/config/env.ts, src/app/credentials.ts, tests/install/**, scripts/verify-install-e2e.mjs, INSTALL.md, README.md, deploy/APPLY.md, deploy/git-sync.env.example, Dockerfile, .dockerignore

Scope: replace the 12-step manual runbook with `./install.sh`, which detects the Plane install, generates every secret, creates the database, merges the compose override, routes /git-sync through Plane's proxy, starts the service and waits for health; GitHub App credentials become optional at boot (entered later in the admin UI); re-runs are idempotent and `--uninstall` reverses it.

- [x] G1: installer unit tests pass (Plane env parsing, compose override merge and removal, Caddyfile patching, env-file rendering that keeps existing secrets, PAT lookup)
  CHECK: node scripts/run-tests.mjs 20 tests/install
  EXPECT: /tests passed \(\d+ tests in \d+ files\)/
  EVIDENCE: automatic-evidence=v1; definition-sha256=600214eee5f60dc603692e105eb4630a66297988952d258224c4b5e2295f7de0; exit=0; EXPECT=matched; output-sha256=73f17d733cafe4e455ef8708af2dacc863c29e4542a539b78ce7834aa0ca4429; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/pomfret; path=ae06f499d48e/29 entries

- [x] G2: the service boots without GitHub env, rejects a partial GitHub env, and the credential source fails closed with a clear "not configured" error
  CHECK: node --test --test-reporter=tap tests/install/config-optional-github.test.ts
  EXPECT: /^# pass [1-9]\d*$[\s\S]*^# fail 0$/m
  EVIDENCE: automatic-evidence=v1; definition-sha256=2d9ca568548d23e24d1f8ce524a50d6521c651311efb24c102284aa90bd12de9; exit=0; EXPECT=matched; output-sha256=ef311d6464bea578bd32d28c12a033339e9dcc8f98e48a3546696856bb8c3509; output-bytes=1787; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/pomfret; path=ae06f499d48e/29 entries

- [x] G3: end-to-end — install.sh finds an installed-but-stopped Plane and a Plane whose containers were removed, refuses a folder without Plane, and against a scratch Plane-shaped compose project in rootless Docker yields a healthy git-sync reachable through Plane's proxy, keeps existing override services, writes a 0600 env file, creates the gitsync database, is idempotent on re-run, and --uninstall removes it
  CHECK: node scripts/verify-install-e2e.mjs
  EXPECT: INSTALL E2E PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=7f81f254a588a088541e49e34c2645232f6fa5b5bd4b3c369a07ddb36d24cee1; exit=0; EXPECT=matched; output-sha256=4ed046d0bb42721bd6f0a58b86d22f143ac5ce05b6470b45dbaf3f3576695a8a; output-bytes=2727; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/pomfret; path=ae06f499d48e/29 entries

- [x] G4: typecheck is clean
  CHECK: npm run typecheck
  EXPECT: /tsc --noEmit/
  EVIDENCE: automatic-evidence=v1; definition-sha256=8e300cacd752379e791d0869fd71368576ef18f4733c689aea550f4b3db51ef0; exit=0; EXPECT=matched; output-sha256=ff4137474b89cc8436a92c07376e14eee266c4e94c4b316da0272d50eea5e297; output-bytes=61; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/pomfret; path=ae06f499d48e/29 entries

- [x] G5: full regression suite still green
  CHECK: node scripts/run-tests.mjs 1162 tests
  EXPECT: /tests passed \(\d+ tests in \d+ files\)/
  EVIDENCE: automatic-evidence=v1; definition-sha256=5e5ee1c8e48183cb7329ccaffcbb431e7633c8a8f2e6e7fb9744ac8d4f6aa492; exit=0; EXPECT=matched; output-sha256=285b42bcf3e995d937d7a2deb398d164b361592149a5d3b8cbb0674428f2f77f; output-bytes=39; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/pomfret; path=ae06f499d48e/29 entries

- [x] G6: docs — INSTALL.md gives a short quick start built on ./install.sh, and APPLY.md points to it instead of the manual steps
  EVIDENCE: manual review 2026-10-14 — INSTALL.md: 3-command install, 2 prompts, GitHub App settings table, connect, everyday use, options, safety, troubleshooting; every path/label checked against code (god-mode/git-sync route, GitHub App form labels, users/me verified on Plane v1.4.2); deploy/APPLY.md opens with ./install.sh pointer incl. convpss command; README.md links INSTALL.md
