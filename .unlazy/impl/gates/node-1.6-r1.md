# Gates: review round 1 fix pass — integration of six leaves

Scope: integrate fix-r1-sa, -ca, -sb, -cb, -ga and -gb into one tree that answers all eighteen round-1 findings and passes every check, ready for the round-2 review

- [x] N0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/node-1.6-r1.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=6c6f26cc4fc4d53a4f18690da65047113196ffda9ec64745c545a58d70eb0236; exit=0; EXPECT=matched; output-sha256=c20b9cd6f427d45670a96f64a2af5ea172043d1e6f62086d3303b5bfc66d4d6d; output-bytes=493; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N1: every leaf answered each assigned finding and left a fully met, checker-evidenced ledger
  CHECK: sh -c 'f=docs/impl/fixes-r1-SA.md; for id in F2 F5 F6 F9 F12; do grep -qE "^#+ +$id\b" $f || { echo "FAIL sa $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r1-sa.GATES.md >/dev/null || { echo "FAIL sa unlazy"; exit 1; }; f=docs/impl/fixes-r1-CA.md; for id in F7 F10; do grep -qE "^#+ +$id\b" $f || { echo "FAIL ca $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r1-ca.GATES.md >/dev/null || { echo "FAIL ca unlazy"; exit 1; }; f=docs/impl/fixes-r1-SB.md; for id in F2 F8 F16 F18; do grep -qE "^#+ +$id\b" $f || { echo "FAIL sb $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r1-sb.GATES.md >/dev/null || { echo "FAIL sb unlazy"; exit 1; }; f=docs/impl/fixes-r1-CB.md; for id in F3 F4 F5; do grep -qE "^#+ +$id\b" $f || { echo "FAIL cb $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r1-cb.GATES.md >/dev/null || { echo "FAIL cb unlazy"; exit 1; }; f=docs/impl/fixes-r1-GA.md; for id in F1 F13 F16 F17; do grep -qE "^#+ +$id\b" $f || { echo "FAIL ga $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r1-ga.GATES.md >/dev/null || { echo "FAIL ga unlazy"; exit 1; }; f=docs/impl/fixes-r1-GB.md; for id in F11 F14 F15; do grep -qE "^#+ +$id\b" $f || { echo "FAIL gb $id"; exit 1; }; done; node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/fix-r1-gb.GATES.md >/dev/null || { echo "FAIL gb unlazy"; exit 1; }; echo "all six leaves answered and machine-verified"'
  EXPECT: all six leaves answered and machine-verified
  EVIDENCE: automatic-evidence=v1; definition-sha256=3040c08c4ba843efe508f698be4b7175eabf77f668cafccc2a924369faae4aba; exit=0; EXPECT=matched; output-sha256=6cee7ec41240ce8f9bb1fb460caeaac3903bc5866859455c560b6d28abfa0613; output-bytes=45; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N2: every driver oracle passes on the combined fixed tree
  CHECK: sh scripts/heavy.sh sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; node scripts/verify-fork-patch.mjs all >/dev/null 2>&1 || { echo "FAIL fork"; exit 1; }; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8b2f5cd3f6e296e9d9450b51c7b8304d23074669e5f78692e00f59f2f6f03be3; exit=0; EXPECT=matched; output-sha256=6877732afcf7659776aee916e490d069bc6d53112e05dcaa101005e3ea3f8478; output-bytes=19; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N3: the whole repository's tests pass together on the combined tree
  CHECK: sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=71413dfa3ee84c10f50036b5f0fe293809e719d60260cc1efd0a5096b1111979; exit=0; EXPECT=matched; output-sha256=ff103e2474c49aac939c53e90f100fece9afb0bb79a900390cc9b82b6d65c856; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N4: the whole tree typechecks
  CHECK: node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=259f4e7868e263eb4b58049b98375454da988c9ab16c04af50427f515ab04a0b; exit=0; EXPECT=matched; output-sha256=7cd426c3f074aec975d3f89843e289748f7b525a998d3201da0c3d12f60b34c2; output-bytes=37; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N5: no stubs or placeholders anywhere in src or tests
  CHECK: node scripts/verify-no-stubs.mjs src tests
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=31f959ff923770492b645fe5a233696b301eb497336d7aae6f8317167b2c947b; exit=0; EXPECT=matched; output-sha256=ee58f810a0a50a418cc21a3b22e778ca28ead09f23496607cc1fbcac8041bd98; output-bytes=29; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] N6: the driver spot-checked the fixes against the findings, including the F2, F5 and F16 splits and the CA/CB shared mapper
  EVIDENCE: driver spot-check on the combined tree: F1 src/parse/references.ts:128 treats 403 like 404 (matches the live-Plane probe); F2 config half src/ui/mapping-check.ts:29,43 verifies the project via Plane and the repo via the App; F2 runtime half: the one caller of mappingsForProject (src/app/issues.ts:91) is followed by payloadBelongsToMapping per candidate (src/app/context.ts), refusing payloads from another workspace — the driver's initial suspicion that the filter was missing was refuted by reading the code; F3 src/sync/mirror.ts:85,93 restrict mirror partners to created_by='label_sync'; F9 src/app/main.ts:44-45 route reducer writes through queuedPlaneWriter/queuedGithubWriter onto outbound-plane/outbound-github, keeping only result-needing writes inline (documented in writers.ts); CA's shared ruleEventsFor (src/app/rule-events.ts:68) is used by CB's dry-run adapter. Incidents during the pass: OOM (resolved, heavy checks serialized), three runaway SB test runs and orphaned workers killed, stray CB text in CA's session (no effect).

- [x] N7: every leaf's ownership lease was released after verification
  EVIDENCE: fix-r1-sa: released 1 lease(s) for impl/fix-r1-sa; fix-r1-ca: released 1 lease(s) for impl/fix-r1-ca; fix-r1-sb: released 1 lease(s) for impl/fix-r1-sb; fix-r1-cb: released 1 lease(s) for impl/fix-r1-cb; fix-r1-ga: released 1 lease(s) for impl/fix-r1-ga; fix-r1-gb: released 1 lease(s) for impl/fix-r1-gb;
