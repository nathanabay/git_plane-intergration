# Gates: Claude review, round 1

OWNS: docs/impl/review-1.md, docs/impl/agent-gates/review-1.GATES.md

Scope: an adversarial review of all seventeen implemented tasks against the spec, with every finding located, cited and given a fix

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.6.1.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=2bcda0be5eeba7f3f13c74ae05bf30e7997eb3286edd180de1516949bf640b28; exit=0; EXPECT=matched; output-sha256=f449152243711d8b3435730b2041a8d12af51a0982108b37dbd544486febf491; output-bytes=174; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: the review is decidable and grounded: every task has a verdict, every finding has an existing file:line, a real spec section, evidence and a fix
  CHECK: node scripts/verify-impl-review.mjs docs/impl/review-1.md
  EXPECT: implementation review verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8de7bad06051ecaad682b091eae0c743b48ff691a22da4ef486789a88c277508; exit=0; EXPECT=matched; output-sha256=205e470b0797913b32014e697e395a761db839eca06d0d7b98fccb515ddb01b6; output-bytes=104; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: the reviewer ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/review-1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e9689cd62b9b9a90f563fd4c7e31ceca72af5d9f131a448582aec07f478130d4; exit=0; EXPECT=matched; output-sha256=c89c32aa56c046b3834c1838ec81dbd550a7c7d37a1d501636aef1c51267e672; output-bytes=64; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: the driver confirmed at least one finding by reading the code and attempted to refute at least one, recording the outcome of each
  EVIDENCE: driver confirmed F1 independently before the review (live smoke test: identifier endpoint returns 403 for an unknown project; src/parse/references.ts handles only 404 — .unlazy/impl/evidence/plane-webhook-probe.md). Refutation attempted on F2 and failed: src/app/mappings.ts:33 selects repo_mappings by plane_project_id alone and src/ui/validate.ts never verifies the project with Plane or the repo with GitHub. Refutation attempted on F9 and failed: grep finds outboundPlane/outboundGithub only in their worker declarations (src/queue/workers.ts:129-130); no producer exists. Review: 3 BLOCKING, 9 MAJOR, 6 MINOR; verdict BLOCKING.
