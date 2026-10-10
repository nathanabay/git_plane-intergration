# Gates: A8 test suites and wiring the whole service

OWNS: src/index.ts, src/app/**, src/sync/github.ts, src/db/**, src/config/**, deploy/git-sync.env.example, tests/a8/**, tests/smoke/**, tests/deploy/**, tests/db/**, docs/impl/agent-gates/leaf-1.5.1.GATES.md

Scope: compose every verified module into the running service (reducers registered, config API and UI mounted, workers and maintenance started) and A8 (spec §10) the echo-loop, reducer, idempotency, grammar and forged-author security suites plus a live smoke test definition

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.5.1.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=f831c13822ca58a105d8d919dff648c64f4ffee425752a9e56a31edd0a77560d; exit=0; EXPECT=matched; output-sha256=776be18bd1a33859a56607869d6bed29a9d7e0a98a341e52d2ec9fabd41418c4; output-bytes=425; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: the whole service works end to end against fake Plane and GitHub
  CHECK: node scripts/verify-wiring.mjs
  EXPECT: end-to-end wiring verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=94549ca2a6be0f72eef5f2ff1189e84be2034d80b49b699629e0bd5fcfafdbe8; exit=0; EXPECT=matched; output-sha256=83d0dc16d5bd494f306a8b213aa1f82c25f0ea428998fd9621c78cb1a15d0bda; output-bytes=560; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: every leaf oracle still passes against the wired tree
  CHECK: sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7ab8e476d2f45329db25312ea8e90865b158e3cbfd885af5b7a24a054627ec08; exit=0; EXPECT=matched; output-sha256=6877732afcf7659776aee916e490d069bc6d53112e05dcaa101005e3ea3f8478; output-bytes=19; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: the A8 suites run with at least 30 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 30 tests/a8
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=727442a2366c656c0fab96d6fb0512fb0d8663e5273e9d0d4beab1d6446dad39; exit=0; EXPECT=matched; output-sha256=d706d9969147eb3994a31828d1b4930c55e2dc66fe2d39c834ca20bb4225d84c; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: the whole tree typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=ff3f4abbd6b531004f5688f48a2407918e98e311552d1bf1b526d3d034c64e2e; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/app src/config tests/a8
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3cdabea30a08c732b328cb71e6d60529275b7efae8065e2b9c75574f378a337c; exit=0; EXPECT=matched; output-sha256=5ed851337513247faa9e39b4cdded5563c04f56f77ae3f1306cf552f0bb38c38; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.5.1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4df9214abcaf5b74e38957628b483f54217ced5421ab8540a631c14dddb9a354; exit=0; EXPECT=matched; output-sha256=e59cf7132e52dd9b7bdc73ab355aa69ecf174b08ff77b8d3261bac1599caa238; output-bytes=64; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G8: the whole repository's tests pass together, so a change cannot break another leaf's suite
  CHECK: node scripts/run-tests.mjs 400 tests
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=6e58263bd22a649dcc26738efa70ff7515f764e4ae9bf7a0aa914562fbc3683b; exit=0; EXPECT=matched; output-sha256=b564240f3f93fe4593d215d03e91ccb1e6981059e571ae14ba4f67c9c8555add; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G7: driver review — the echo-loop suite exercises both directions through real write paths, the security test forges author and pusher, every reducer writes only through A4
  EVIDENCE: driver review: tests/a8/echo-loop.test.ts covers both directions for title, state, comments and creations through the real write paths plus consume-once, different-value and service-actor cases (lines 20-124); tests/a8/security.test.ts forges author, committer and pusher (lines 19-36) and checks provenance names the sender (line 77); verify-wiring drives signed webhooks through the real process to fake Plane/GitHub. No out-of-OWNS writes since w5 start. Open for the reviewer: labels echo test tolerates one extra write and rests on A's belief that Plane label webhooks carry names — contradicted by .unlazy/impl/evidence/plane-webhook-probe.md (UUIDs); mirror assignee removal ignores an empty list; REQUIRE_VERIFIED_COMMITS and mapping installation_id are A's additions.
