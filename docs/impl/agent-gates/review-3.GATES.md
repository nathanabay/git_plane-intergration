# Gates: implementation review round 3 (Claude reviewer)

OWNS: docs/impl/review-3.md, docs/impl/agent-gates/review-3.GATES.md

Scope: an adversarial, grounded review of tasks A1–A8 and B1–B9 after the round-2 fixes, adjudicating all
17 round-2 findings against the code and hunting regressions, written to docs/impl/review-3.md.

- [x] G1: the review is decidable, grounded, and adjudicates every round-2 finding
  CHECK: node scripts/verify-impl-review.mjs docs/impl/review-3.md docs/impl/review-2.md
  EXPECT: implementation review verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=6d4754e09a8fc6de3ade0a910dfcfea865333f5d20084a9d32d45e54db2c1a02; exit=0; EXPECT=matched; output-sha256=ff2040f11784b2782c73057e15f197b19dc861878165aafaa35ae60d75076bbf; output-bytes=104; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: every driver oracle passes on the tree I reviewed
  CHECK: sh scripts/heavy.sh sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring verify-fork-patch; do a=""; [ $o = verify-fork-patch ] && a=all; node scripts/$o.mjs $a >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f90c483452f9594cf825ed79dc2d3e150a32bd6ceb891e81106640dbf52aa0f4; exit=0; EXPECT=matched; output-sha256=6877732afcf7659776aee916e490d069bc6d53112e05dcaa101005e3ea3f8478; output-bytes=19; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries
