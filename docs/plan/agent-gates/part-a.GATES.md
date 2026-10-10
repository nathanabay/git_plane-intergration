# Gates: part-a

OWNS: docs/plan/part-a-service-core.md, docs/plan/agent-gates/part-a.GATES.md

- [x] G1: part A passes the structural and spec-citation verifier
  CHECK: node scripts/verify-plan-part.mjs docs/plan/part-a-service-core.md A
  EXPECT: plan part verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a21753f78946e1e1dffab78e652a0ebeb21a451058debe350d318bf053ac2070; exit=0; EXPECT=matched; output-sha256=d50d700599a6122030ea6deef3f982114854ef862e38c6ba36b0d3ebf29b59d1; output-bytes=53; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=8ab7b88bda7f/63 entries

- [x] G2: ledger passes unlazy lint
  CHECK: node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-lint.mjs docs/plan/agent-gates/part-a.GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=c87d4934cb6c3595f74559a6e31bbbfb7fb8cf486b6a5e9210ab19359440e4b3; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=8ab7b88bda7f/63 entries
