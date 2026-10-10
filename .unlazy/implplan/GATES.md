# Gates: implementation plan for Plane ↔ GitHub sync

OWNS: docs/plan/IMPLEMENTATION_PLAN.md

Scope: deliver a reviewed, spec-complete implementation plan the user can execute

- [x] R1: the integrated plan passes the joined-coverage oracle from a clean read
  CHECK: node scripts/verify-plan-coverage.mjs
  EXPECT: plan coverage verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=351da4c307d62bb50eb5f517369507b8ac39f721a731e212325f12c35eff9c5a; exit=0; EXPECT=matched; output-sha256=12871cb63e8f17654212ffe10f76d3a8d00bc2abd39047ea215c00b66bdcae24; output-bytes=63; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] R2: no plan artifact contains placeholder tokens
  CHECK: node scripts/verify-no-placeholders.mjs
  EXPECT: placeholder scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=c3d704264b52def02e41fb0308924190c411107ddaacf074355767d80b30fa3d; exit=0; EXPECT=matched; output-sha256=dba78c03025468425b5b0a8d916caeb4f36005d7b57cbfa6e61f2d67c9d42498; output-bytes=34; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] R3: driver reread the original request and reconciled every contract inventory row to a current owner and observation
  EVIDENCE: reread the request and all three amendments. All 14 inventory rows are ACTIVE with a current owner and a met observation: C1 leaf-1.1.1 (5/5), C2 leaf-1.1.2 (5/5), C3 leaf-1.1.3 (4/4), C4 two Gemini agents authored, recorded as Orca handles in dispatch.json across waves ready-1/1b/1c/3/5/6/7, C5+C6 node-1.1:N2 (13 spec sections, 17 tasks), C7 root R2 (5 files scanned), C8 node-1.1:N3, C9 node-1.1:N4, C10 agent-unlazy gates met on all six agent ledgers with checker-written evidence, C11 all agents hosted in Orca IDE workspaces, C12 leaf-1.1.4:G2 and leaf-1.1.5:G2 (8 and 9 distinct non-empty per-task commits), C13 leaf-1.1.4:G4 and leaf-1.1.5:G4, C14 leaf-1.1.6 (5/5). Request constraints each map to an observation: two Gemini authors (C4), Claude reviewing (C3), Claude re-reviewing after the Gemini agents finished (C14), Orca IDE as host (C11), every agent running unlazy (C10), and a commit per task after the review (C12). No row is DEFERRED, ABANDONED or awaiting an owner decision, and no gate in the scope is abandoned.
