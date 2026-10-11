# Gates for leaf-1.4.1

OWNS: src/parse/**, src/sync/reconcile.ts, src/queue/**, src/db/**, tests/parse/**, tests/reconcile/**, tests/queue/**, tests/db/**, docs/impl/agent-gates/leaf-1.4.1.GATES.md

- [x] G1: A5, A7 and the storage additions pass the driver oracle
  CHECK: node scripts/verify-a5-a7.mjs
  EXPECT: A5/A7 verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5ea1f92a7d1045cdf39db43c0bdfb6a43bf6435b2f22a7888e553dc6761faff1; exit=0; EXPECT=matched; output-sha256=042d08a181dd645542c09a30b1714a254b342eaa240ab42d80ae9fdbeb3780a3; output-bytes=1146; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: earlier Part A oracles did not regress
  CHECK: sh -c 'for o in verify-a3-schema verify-a2-ingress verify-a4-writepath; do node scripts/$o.mjs >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "part A regressions passed"'
  EXPECT: part A regressions passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=27d730f4f20048f4fc62268f7bce8d1f2d665f12e32346d7dabf230612dca71b; exit=0; EXPECT=matched; output-sha256=9dd15d08380ee3f6d688e201b28cd837599ce3f076fb3057a64b71e8364f1119; output-bytes=26; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: own tests run, at least 40 passing, none skipped
  CHECK: node scripts/run-tests.mjs 40 tests/parse tests/reconcile tests/queue tests/db
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=654721ef9b9db273a2e2f5d349fdff397b49855547e3cbc043de8142fb8e1177; exit=0; EXPECT=matched; output-sha256=bf3af29065f5289d05fec711aedc7e4ad90bcb32fbcf74334d324df0c89c65e2; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: typecheck clean
  CHECK: node scripts/typecheck.mjs "src/parse/**/*.ts" "src/sync/reconcile.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "tests/parse/**/*.ts" "tests/queue/**/*.ts" "tests/db/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7cae8f654e5ad830c91ae94a3539a1d5890547d263337e63b783de42c7c60ad4; exit=0; EXPECT=matched; output-sha256=c6341f5d2a2aae2dd3894768c1a22dc092370d01c4126442a4ecae24af4f10eb; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: no stubs or placeholders
  CHECK: node scripts/verify-no-stubs.mjs src/parse src/sync/reconcile.ts src/queue src/db tests/parse
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=959ee1fb3de6054ca2388784047a7e3995406a422deeef8de281499bebf0867e; exit=0; EXPECT=matched; output-sha256=7119c56650eb9eca0557c809a405311ae0bda7db98ca2a8dcded30ef45799925; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: reconcile tests typecheck too
  CHECK: node scripts/typecheck.mjs "src/sync/reconcile.ts" "tests/reconcile/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=863bb8f3aec42a0cd8751fd65d2dc1aa4b454be065c826d59655eda04b5b4d5d; exit=0; EXPECT=matched; output-sha256=2fc6eaf48f51f42ef2c03d296449c9a385998c92e0b0884e22ce0dc59760c1af; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries
