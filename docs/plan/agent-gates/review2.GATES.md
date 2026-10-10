# Gates: second adversarial review, after the fix-and-commit pass

OWNS: docs/plan/review-notes-2.md, docs/plan/agent-gates/review2.GATES.md

Scope: adjudicate each of the seven blockers from docs/plan/review-notes.md as closed or open
against the current part A and part B artifacts, confirm the six-file fork surface, and hunt
regressions the fix pass introduced.

- [x] G1: the second review is substantive and records a decidable verdict
  CHECK: node scripts/verify-review.mjs docs/plan/review-notes-2.md
  EXPECT: review verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=bce20bebb59aad7ed828176b9e35123c79a7cf628e95a90749b90b828de1fc55; exit=0; EXPECT=matched; output-sha256=7d72115f55af02a68107921e290316f24bc975c130e9a70a67c2c051507d9dff; output-bytes=62; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=17082c0eb005/62 entries

- [x] G2: all seven original blockers carry an explicit closed-or-open label
  CHECK: node -e "const t=require('fs').readFileSync('docs/plan/review-notes-2.md','utf8');const m=[...t.matchAll(/^- Blocker ([1-7])\b[^\n]*\b(CLOSED|STILL OPEN)\b/gm)];const ids=new Set(m.map(x=>x[1]));if(ids.size!==7)throw new Error('adjudicated '+ids.size+' of 7 blockers');console.log('seven blockers adjudicated')"
  EXPECT: seven blockers adjudicated
  EVIDENCE: automatic-evidence=v1; definition-sha256=582823d39c57b32580ccd64d04f562b4b25dbdfdc30fd08a7ff9ddfe3cd60266; exit=0; EXPECT=matched; output-sha256=3af8e5e514866462231500c1c154f6ff63895a0a7fed6c863501e855c3d76d84; output-bytes=27; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=17082c0eb005/62 entries

- [x] G3: this ledger states outcomes that can fail
  CHECK: node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-lint.mjs docs/plan/agent-gates/review2.GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=1e12d84805d8b6e36d53138513ae669d81ec06d4ff26ff428e68f6a4a8a753f3; exit=0; EXPECT=matched; output-sha256=c1c8a06d7e5a6fd2aa9270587fc82955f008cb114d5a1c7e71f27c3b7860da60; output-bytes=180; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=17082c0eb005/62 entries

- [x] G4: every adjudication quotes the current artifact line it rests on
  EVIDENCE: 48 quoted fragments machine-checked against their sources with whitespace-normalised substring matching (part-a-service-core.md, part-b-github-ui.md, the spec, part-b.GATES.md, commit-a.GATES.md, scripts/verify-agent-commits.mjs): "all quotes verbatim", 0 misquotes. Re-measured after the follow-up pass moved both artifacts: part A content byte-identical to HEAD across the history rebuild (git diff HEAD -> empty, 57 lines), per-task commits now 9a1eb85/096ca33/8b3e7e3/45f2f9d/e23314a/6e24cd6/6513055/ac63391 at +9/+7/+7/+7/+7/+7/+7/+6 lines of the plan part; part B's B2/B3 re-read after 7f5b30a and d0dcf7c and re-adjudicated. Each of the seven adjudications, the three status findings and all three BLOCKER lines carries at least one verbatim quote.

- [x] G5: part A's per-task commits are real under the tightened oracle
  CHECK: node scripts/verify-agent-commits.mjs docs/plan/part-a-service-core.md A
  EXPECT: agent commit verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=60430d56eb1009fec844dffe8aa34ac004e03bed6e1ebb25905117e063f650ab; exit=0; EXPECT=matched; output-sha256=266714fb50d129eb66155a5b2e83e929c6f5d718f27b9b6f18a009028603c915; output-bytes=63; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=17082c0eb005/62 entries
