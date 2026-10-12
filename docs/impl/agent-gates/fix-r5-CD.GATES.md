# Round 5 CD gates

OWNS: src/app/mappings.ts, src/app/main.ts, src/ui/mapping-check.ts, src/ui/client/Admin.tsx, tests/app/review-r5-cd.test.ts, tests/app/fixes-r3.test.ts, tests/a8/reducers.test.ts

The fix-round brief overrides the general checker workflow: run checks directly; no gate-check or oracles.

- [x] F3: Mapping admission and durable writes fail closed after installation revocation; admin can inventory disabled mappings
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 --test-name-pattern='round 5 CD|F7: a transient installation-lookup|the installation id from a webhook' tests/app/review-r5-cd.test.ts tests/app/fixes-r3.test.ts tests/a8/reducers.test.ts
  EXPECT: fail 0
  EVIDENCE: Direct permitted check exited 0: tests 8, pass 8, fail 0. Includes both driver-authorized fixture updates. No gate-check was run, as required by the round brief.

- [x] F10: Composed health uses the live credential source after credential deletion
  CHECK: NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 --test-name-pattern='round 5 CD|F7: a transient installation-lookup|the installation id from a webhook' tests/app/review-r5-cd.test.ts tests/app/fixes-r3.test.ts tests/a8/reducers.test.ts
  EXPECT: fail 0
  EVIDENCE: CD regression file passed in the same capped run (exit 0); its F10 subtest drives composeRoutes after deleting the authoritative credential row and requires database/decryptOk false. No gate-check was run.
