# Gates: integration — one coherent implementation plan

OWNS: docs/plan/IMPLEMENTATION_PLAN.md

Scope: merge both reviewed parts into a single ordered implementation plan that covers every buildable spec section

- [x] N1: every child ledger parses and reports all gates met with current automatic evidence
  CHECK: node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-check.mjs --status .unlazy/implplan/gates/leaf-1.1.1.md .unlazy/implplan/gates/leaf-1.1.2.md .unlazy/implplan/gates/leaf-1.1.3.md .unlazy/implplan/gates/leaf-1.1.4.md .unlazy/implplan/gates/leaf-1.1.5.md .unlazy/implplan/gates/leaf-1.1.6.md
  EXPECT: ALL MET
  EVIDENCE: automatic-evidence=v1; definition-sha256=2e63eaa3f8e2d489e77596218af75a6184ece732cc2c359d4b0876413914d1ec; exit=0; EXPECT=matched; output-sha256=d61260f8a635ab69003a9aebd5787d085564a8244c8768c7caa8910eb7743027; output-bytes=155; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] N4: driver re-executed each child's runnable oracles with --reverify under its own toolchain, not merely read their recorded state
  EVIDENCE: driver ran gate-check --reverify on all six leaf ledgers from the repository root with --root . --cwd . under /bin/sh, the same toolchain the leaves used. Final pass reported 26 gates met with 20 commands rerun and 20 previously-met gates re-executed, not read. Re-verification caught real regressions rather than rubber-stamping: leaf-1.1.2:G1 reverted to unmet after the assigned-section oracle was strengthened, and leaf-1.1.4:G2 reverted to unmet after the commit oracle was tightened to require a real diff. Both were re-dispatched and only passed after the artifacts changed.

- [x] N2: the joined plan covers every buildable spec section, has globally unique task ids, omits no authored task, and imposes an order
  CHECK: node scripts/verify-plan-coverage.mjs
  EXPECT: plan coverage verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=351da4c307d62bb50eb5f517369507b8ac39f721a731e212325f12c35eff9c5a; exit=0; EXPECT=matched; output-sha256=12871cb63e8f17654212ffe10f76d3a8d00bc2abd39047ea215c00b66bdcae24; output-bytes=63; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] N3: blocking review findings are resolved in the integrated plan, not merely recorded
  EVIDENCE: docs/plan/IMPLEMENTATION_PLAN.md carries a "Review findings resolved" table mapping all nine findings to the task that closes each, and each closure was verified against the artifact, not the agent's report: X-Plane-Signature present in A2; A4's acceptance rewritten to drop inbound echoes; B4-B7 now declare Depends: A4; B5 compiles into A6; the triage guard moved onto A4's single write path; B3 added for the section 8 React app with server-side session and role re-check on every write; A3 extended to the delivery-id, commit-SHA, orphan, audit and configuration tables; and part A's history rebuilt into 8 real per-task commits with content byte-identical to the pre-rewrite version. The plan additionally records a verified correction to the spec itself (section 8's four-file fork surface is six, because apps/admin/app/routes.ts is an explicit React Router config) and one residual risk about whether B3's configuration writes round-trip to Plane.
