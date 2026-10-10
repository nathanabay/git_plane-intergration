# Gates: A5 reference parsing + A7 reconciliation sweep + storage for Part B

OWNS: src/parse/**, src/sync/reconcile.ts, src/queue/**, src/db/**, tests/parse/**, tests/reconcile/**, tests/queue/**, tests/db/**, docs/impl/agent-gates/leaf-1.4.1.GATES.md

Scope: A5 (spec §6) three-tier reference parsing with opt-outs, multi-issue lists, create requests and the all-PRs-merge rule; A7 (spec §1.3) a reconciliation sweep that orphans 404s and never closes anything, op pruning on a schedule; audit workspace scoping, audited inbound deliveries and the dev-info link table that Part B consumes

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.4.1.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=d86b7e4156694f7ad15c079ae9cf6002d653fca3965eabec4df888d79334e06f; exit=0; EXPECT=matched; output-sha256=b19625e2084aca4dbf4e72b49b7b3ba34dd0be69ddcb1342c693f6387610f586; output-bytes=392; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: A5, A7 and the storage additions satisfy the driver oracle
  CHECK: node scripts/verify-a5-a7.mjs
  EXPECT: A5/A7 verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5ea1f92a7d1045cdf39db43c0bdfb6a43bf6435b2f22a7888e553dc6761faff1; exit=0; EXPECT=matched; output-sha256=042d08a181dd645542c09a30b1714a254b342eaa240ab42d80ae9fdbeb3780a3; output-bytes=1146; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: the earlier Part A oracles did not regress
  CHECK: sh -c 'for o in verify-a3-schema verify-a2-ingress verify-a4-writepath; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "part A regressions passed"'
  EXPECT: part A regressions passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=27d730f4f20048f4fc62268f7bce8d1f2d665f12e32346d7dabf230612dca71b; exit=0; EXPECT=matched; output-sha256=9dd15d08380ee3f6d688e201b28cd837599ce3f076fb3057a64b71e8364f1119; output-bytes=26; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: the leaf's own tests run with at least 40 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 40 tests/parse tests/reconcile tests/queue tests/db
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=654721ef9b9db273a2e2f5d349fdff397b49855547e3cbc043de8142fb8e1177; exit=0; EXPECT=matched; output-sha256=bf3af29065f5289d05fec711aedc7e4ad90bcb32fbcf74334d324df0c89c65e2; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: the leaf's TypeScript typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/parse/**/*.ts" "src/sync/reconcile.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "tests/parse/**/*.ts" "tests/queue/**/*.ts" "tests/db/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7cae8f654e5ad830c91ae94a3539a1d5890547d263337e63b783de42c7c60ad4; exit=0; EXPECT=matched; output-sha256=c6341f5d2a2aae2dd3894768c1a22dc092370d01c4126442a4ecae24af4f10eb; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/parse src/sync/reconcile.ts src/queue src/db tests/parse
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=959ee1fb3de6054ca2388784047a7e3995406a422deeef8de281499bebf0867e; exit=0; EXPECT=matched; output-sha256=7119c56650eb9eca0557c809a405311ae0bda7db98ca2a8dcded30ef45799925; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.4.1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e3d76978cfa7c5bb8e987c84a80145a4773b5921d7a185290b778fccb59b6819; exit=0; EXPECT=matched; output-sha256=bf3418561dc14ab5574225a979503f71d98f7fe61a794ae943b1a708d392415c; output-bytes=64; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G7: driver review — parsing matches §6 including false-positive avoidance, the sweep never writes to Plane, audit payloads hold no secrets
  EVIDENCE: driver review: src/sync/reconcile.ts only reads (getIssue) and writes the gitsync DB — 404 → markLinkOrphaned + audit + onOrphan, other errors counted, never a state change (oracle confirms GET-only); src/queue/workers.ts:45-60 audits each delivery with event + payload only, never headers or signatures. Parsing: uppercase-only keys outside branch names unless a magic word precedes them, plus a commented deny-list (UTF, SHA, CVE, ISO…) — sensible false-positive control; the residual that a real project named like a denied token needs a magic word is documented. Maintenance queue exported as MAINTENANCE_QUEUE because the A2 oracle pins QUEUE_NAMES to four (driver's oracle constraint).
