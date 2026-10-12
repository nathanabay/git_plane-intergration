# CA — review 6 fixes

Implemented F5, the frozen-write-authority contract in CA-owned PR/mirror reducers, and the two
stale F8 fixtures. Edited only `src/app/pr.ts`, `src/app/issues.ts`,
`tests/github/review-r4-sc.test.ts`, and `tests/app/review-r6-ca.test.ts`, plus the requested
CA ledger/report. No staging, commits, pushes, schema changes, or edits to another agent's files.

## F5 — retain PR events after terminal creation failure

- `src/app/pr.ts:166` discovers both live pending creates and retained failed roots using their
  saved marker metadata. Later events receive deterministic, result-bound continuations under
  the original root, with predecessors preserving delivery order. Source/original-delivery
  identity still deduplicates saved continuations.
- `src/app/pr.ts:199` uses CB's `holdOnFailure: true` plan option. A failed group receives held
  failed continuations without restarting its remote writes or recreating a live barrier.
  Original delivery replay and failed-write Retry revive the retained group and its later events.
- `src/app/pr.ts:212` fences before creation lookup, and `src/app/pr.ts:245` excludes already
  retained identifiers from new creation requests. An edit received after terminal failure
  therefore cannot implicitly reset the original failed create through generation lookup.
- Proof: `tests/app/review-r6-ca.test.ts:65` runs the production inbound router and ordered
  outbox with `createOutboundAuthoriser`. It exhausts an unlinked create, handles subsequent
  edited/approved/merged events and a duplicate transport replay, verifies unchanged failed
  original intents/attempts and saved event order, and tests both original-delivery replay and
  failed-write Retry. Each repair creates one item, executes opened/approved/merged rules once,
  preserves In Progress → In Review → Done, and leaves the final rollup MERGED with one linkback.

## Frozen write authority

- `src/app/issues.ts:16` wraps the reducer's writers with the verified mapping snapshot from
  CD's `freezeMappingAuthority`. Plane/GitHub writes, plan steps, rollups, label mutations and
  assignee reconciliation receive `_authority = { workspaceSlug, mappingId, repoId, installationId }`.
  Plan/mutation options also carry that authority to dependent internal registrations.
- PR lifecycle and readiness use this writer context at `src/app/pr.ts:126` and
  `src/app/pr.ts:162`; repaired PR continuations preserve their dispatched authority at
  `src/app/pr.ts:312`. Mirror continuations preserve it at `src/app/issues.ts:102`,
  `src/app/issues.ts:119`, and `src/app/issues.ts:139`; ordinary mirror/rule reducers use the
  verified context at `src/app/issues.ts:156` and `src/app/issues.ts:231`.
- Proof: the F5 test checks frozen metadata on all original/held intents and all eventual
  rule, rollup and linkback intents. `tests/app/review-r6-ca.test.ts:120` verifies both real
  mirror-create directions carry the same admitted mapping. `tests/app/review-r6-ca.test.ts:133`
  removes the original mapping, creates another eligible mapping, and proves execution and Retry
  still reject the old PR intent without changing its frozen source authority.

## Two stale review-r4-sc fixtures

The deliberate round-5 F3 fix disabled NULL-installation database mappings before reducer
admission. The old fixtures therefore never reached their mocked lookup failures.

- `tests/github/review-r4-sc.test.ts:73` now seeds verified installation 1, asserts the mapping
  is admitted, and invokes the existing `planeInstallation` classifier with an uncached in-memory
  snapshot. Both retry-after and exhausted-quota 403s still propagate; no GitHub writes occur.
- `tests/github/review-r4-sc.test.ts:89` likewise seeds a verified mapping, checks plain 403/404
  lookup results are installation 0, then exercises the actual `notInstalledWriter`. It verifies
  no plan method, no GitHub calls, no durable outbound rows, and the `github_not_installed` audit.
- `src/app/issues.ts:189` and `src/app/issues.ts:204` export these existing helper boundaries.
  Their lookup classification and suppression behavior are unchanged. A verified reducer uses
  its cached installation ID, so merely replacing NULL with 1 while retaining the old full-reducer
  call would still fail to exercise the lookup; the helper boundary preserves the tests' original
  rate-limit/permanent-failure intent without bypassing database admission policy.

## Checks and shared seam

Final typecheck exited 0: `typecheck passed (43 project files)`.
Final capped three-file run exited 0: **15 tests passed, 0 failed**, with no cancellations/skips.

```sh
node scripts/typecheck.mjs src/app/pr.ts src/app/issues.ts tests/github/review-r4-sc.test.ts tests/app/review-r6-ca.test.ts
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r6-ca.test.ts tests/github/review-r4-sc.test.ts tests/app/review-r5-ca.test.ts
```

The initial capped run reproduced F5 before CB's shared option landed and exposed a missing
`label` field in the new mirror webhook fixture. The fixture was corrected; the final run above
passes with the landed CB/CD changes. CA requested the `holdOnFailure` seam through the driver
and did not modify CB's files. There are no remaining CA implementation handoffs.

No oracles, heavy.sh, gate-check, gate-lint, or whole suite ran. All four ledger outcomes passed
direct permitted checks; checker-generated evidence remains pending for the driver in
`docs/impl/agent-gates/fix-r6-CA.GATES.md`.
