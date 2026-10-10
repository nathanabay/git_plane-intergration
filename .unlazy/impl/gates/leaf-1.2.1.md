# Gates: A2 webhook ingress and queues + A3 schemas and ledgers

OWNS: src/index.ts, deploy/**, src/api/**, src/queue/**, src/db/**, src/config/**, tests/api/**, tests/queue/**, tests/db/**, tests/deploy/**, docs/impl/agent-gates/leaf-1.2.1.GATES.md

Scope: A2 (spec §4, §3) signature-verified ingress that only enqueues, four BullMQ queues on Valkey, GitHub App token minting, env-driven wiring; A3 (spec §5, §1.3, §7.6, §8, §9) Postgres migrations for the identity map, field-granular op ledger, idempotency ledgers, audit log, configuration and token tables, plus the data-access functions later tasks consume

- [x] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.2.1.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=a1e01da12ac2d490e50e354455336216f7fc689117a4ba685b56bfd61b3bb905; exit=0; EXPECT=matched; output-sha256=f598f121b57c0eac7ffab3cb54bf6e2b32b32d04adc9657f6294b57eb7b307c9; output-bytes=445; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G1: A2 satisfies the driver-held ingress, queue, GitHub App and process-wiring oracle
  CHECK: node scripts/verify-a2-ingress.mjs
  EXPECT: A2 ingress verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3459d0b605b7a7ea2f743ab17c5f18533c69e69560908faa05bc5204ee6c12f8; exit=0; EXPECT=matched; output-sha256=16a9408ae54fd8e2f0ebb7f9f3cdd3cad4325de8e537563b2c3d2f52b2b9bc4e; output-bytes=1268; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G2: A3 migrations apply to a real Postgres engine and the ledger contract holds
  CHECK: node scripts/verify-a3-schema.mjs
  EXPECT: A3 schema verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=bc165618ef39922b9fe506cd3ea130671b73fefda60702fe92db217223aa9aab; exit=0; EXPECT=matched; output-sha256=3f42e8f415f480999dcd655db0aa0e00dbef20cbd810c27165d0d721822a8f8c; output-bytes=1409; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G3: phase 1 entry-point behaviour did not regress
  CHECK: node scripts/verify-a1-deploy.mjs
  EXPECT: A1 deploy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=286dbc85703b62af86c8eb3b6104b5c056ec04f3f5b2418be74488e99c427a21; exit=0; EXPECT=matched; output-sha256=45c80c61bb8cffc7d09e20087fa4340f5c4e1f20969be393475deed4777c0294; output-bytes=30; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G4: the leaf's own tests run with at least 30 passing tests and none skipped
  CHECK: node scripts/run-tests.mjs 30 tests/api tests/queue tests/db tests/deploy
  EXPECT: tests passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5c7ab58685a3c360a00d645d03680d0429f02b91a97eb637550f3eeb434c27fc; exit=0; EXPECT=matched; output-sha256=a1a96c456c649e16c325a0c0b0c987463cc7c4148443fe41de4dc409219ffd83; output-bytes=35; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G5: the leaf's TypeScript typechecks under the shared strict tsconfig
  CHECK: node scripts/typecheck.mjs "src/index.ts" "src/api/**/*.ts" "src/queue/**/*.ts" "src/db/**/*.ts" "src/config/**/*.ts" "tests/api/**/*.ts" "tests/queue/**/*.ts" "tests/db/**/*.ts" "tests/deploy/**/*.ts"
  EXPECT: typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b741b10ce41fc5a53c9b713a71135634f1f2d6b2da1c3eda5978de7c713ef07b; exit=0; EXPECT=matched; output-sha256=012b9bba49cc16abcd1f052560de8b1179d718af918e5bb9f9c35f95b6f33a57; output-bytes=36; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G6: no placeholder or stub markers in the leaf's files
  CHECK: node scripts/verify-no-stubs.mjs src/index.ts src/api src/queue src/db src/config tests/api tests/queue tests/db
  EXPECT: stub scan passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=fb9810c56f7a524cd318b93ce3639a0649ca39fb12d50de0fec7cb313bdb331a; exit=0; EXPECT=matched; output-sha256=bfdcbb839bc518adf9e914d46f1f713658ed846e2f4fb46bbf84e67cb9277024; output-bytes=28; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G7: the agent ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/leaf-1.2.1.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7e3cae8e68c19ed252858802514a207b15da963027724158214c3186eeb29d6f; exit=0; EXPECT=matched; output-sha256=2bc1b188eb911a7945465d5cd1ec9e3a7e0d8c8b7783cb91eae7fce58a6af9de; output-bytes=64; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=ae06f499d48e/29 entries

- [x] G8: driver review against spec §4 and §5 — handler does only verify/enqueue/respond, secrets never logged, migration is transactional, op ledger is field-granular with consume-once semantics
  EVIDENCE: driver review after w2d (Sonnet A took over from Gemini A). §4: src/api/handler.ts only verifies (raw-byte HMAC, timingSafeEqual; octokit verify for GitHub), enqueues, responds; 413 stops consuming the stream. §5: applied_ops holds hash/direction/time only; ledgers.ts:30-40 consumes one row with FOR UPDATE SKIP LOCKED (real-PG oracle: 3 consumers x 2 ops -> exactly 2, 25 rounds). migrate.ts runs each file + its schema_migrations row in one transaction on one connection under pg_advisory_xact_lock (real-PG oracle: injected failing migration fully rolled back; two concurrent replicas apply once). Schema: autolinks default false (§7.4), ghe_base_url (§8), unique policy/tier/version, cascading mapping FKs. Secrets never logged: index.ts logs only host:port and generic errors. Ownership: Gemini A overwrote src/auth/identity.ts at 18:23Z; repaired in w2c by B and re-verified; no out-of-OWNS writes since.
