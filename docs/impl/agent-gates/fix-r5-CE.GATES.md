# Round 5 CE gates

OWNS: src/ui/api.ts, src/app/identity.ts, src/app/credentials.ts, src/config/env.ts, src/db/ledgers.ts, src/db/migrations/008-*.sql, src/db/schema.ts, docker-compose.override.yaml, deploy/**, tests/ui/review-r5-ce.test.ts

The round brief overrides the normal unlazy runner: these are direct execution results, not gate-check automatic evidence. The driver performs formal gate verification. Scope includes the relayed F3 mapping API seam.

- [x] F7: concurrent unlink cannot resurrect an account and failed mutations roll back
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/ui/review-r5-ce.test.ts tests/db/migrate.test.ts
  EXPECT: fail 0
  EVIDENCE: Direct execution exited 0; 19 tests, 19 passed, 0 failures. Includes both controlled API races, all unlink mutation rollbacks, actor suppression and real PostgreSQL pool contention. Formal runner evidence intentionally not generated under the round restrictions.

- [x] F8: persistent retirement survives recreation and unavailable retirement authority rejects old signatures
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/ui/review-r5-ce.test.ts tests/db/migrate.test.ts
  EXPECT: fail 0
  EVIDENCE: Same direct execution exited 0; 19 tests, 19 passed, 0 failures. PostgreSQL server_version_num was 150007; fresh 001-008, upgrade from applied 001-007 and repeated migration all passed. Non-root read-only-secret, persistent marker, recreation, unavailable database, old signature and marker failure checks passed.

- [x] TYPES: CE sources and targeted tests typecheck
  CHECK: node scripts/typecheck.mjs src/ui/api.ts src/app/identity.ts src/app/credentials.ts src/config/env.ts src/db/ledgers.ts src/db/schema.ts tests/ui/review-r5-ce.test.ts tests/db/migrate.test.ts
  EXPECT: typecheck passed
  EVIDENCE: Direct execution exited 0 and printed typecheck passed (53 project files).
