# Gates: implementation review round 1 (Claude reviewer)

OWNS: docs/impl/review-1.md, docs/impl/agent-gates/review-1.GATES.md

Scope: an adversarial, grounded review of tasks A1–A8 and B1–B9 written to docs/impl/review-1.md.

- [x] G1: the review is decidable and grounded
  CHECK: node scripts/verify-impl-review.mjs docs/impl/review-1.md
  EXPECT: implementation review verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8de7bad06051ecaad682b091eae0c743b48ff691a22da4ef486789a88c277508; exit=0; EXPECT=matched; output-sha256=205e470b0797913b32014e697e395a761db839eca06d0d7b98fccb515ddb01b6; output-bytes=104; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: every driver oracle passes on the tree I reviewed
  CHECK: sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring verify-fork-patch; do a=""; [ $o = verify-fork-patch ] && a=all; node scripts/$o.mjs $a >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "all oracles passed"'
  EXPECT: all oracles passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=955fd219ba9a27bd4c3ef47735765f81f5c2a27442d3aa09ef848debe8cb2c40; exit=0; EXPECT=matched; output-sha256=6877732afcf7659776aee916e490d069bc6d53112e05dcaa101005e3ea3f8478; output-bytes=19; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries
