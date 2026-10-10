# Leaf brief: leaf-1.1.4 — part A: resolve review findings, then commit per task

Repository root: `/Users/nathanamare/Downloads/git_plane intergration` — `cd` there first. You own ONLY:
- `docs/plan/part-a-service-core.md`
- `docs/plan/agent-gates/commit-a.GATES.md`

Read `docs/plan/review-notes.md` in full. It is a blocking review. Then read the spec at
`docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` for any section you touch.

## Part 1 — fix these defects in part A

**Blockers:**
1. **A2** names only `@octokit/webhooks` (GitHub). Nothing verifies Plane's own
   `X-Plane-Signature` HMAC-SHA256 (§1.2), so the public `/git-sync/webhooks/plane` endpoint is
   unauthenticated. Add that verification explicitly to A2.
2. **A4's Acceptance inverts the dedupe.** It says outbound workers drop matching messages; §5
   drops **inbound** echoes. As written, a human who sets Done, reverts, then sets Done again
   inside the TTL has their second write silently discarded. Rewrite the Acceptance so the drop
   happens on ingress.
3. **A3 defines only two tables** but owns the only migration. Also define storage for: delivery
   ids and processed commit SHAs (§5, kept separate from `op_hash`), an orphaned status A7 can
   mark, the §7.6 audit log (inbound deliveries, rule matches, outbound calls and results, with
   replay), and the config/mapping tables §8 needs (repo↔project mappings, state mappings, rule
   sets, conflict policy, per-repo toggles, the §9 user map). Add `tier` and `created_by` to
   `sync_links` per §5. Fix `Depends:` — the `gitsync` database comes from A1.

**Further defects:**
4. **A4** never states the two §4 Plane write semantics it is named for: duplicate link URL
   returns 400 and is treated as success; duplicate label returns 409 carrying the existing id,
   which is a free upsert. State both.
5. **A5** scans three sources; §6 lists four — **PR title is missing**. Also unclaimed:
   `{IDENTIFIER}-NEW` create-issue-from-PR, and §6's rule that when several PRs link one item,
   **all** must merge before it advances. Fix `Depends:` — identifier resolution needs A4.
6. **A6** omits `log_time` and `add_link` from §7.5's action set (B3 and B6 need them), omits
   author and repo conditions, never states first-match-wins ordering, never mentions the §7.1
   rule that the mapping table **compiles into** these rules, and provides no no-write evaluation
   mode, which B7's dry-run requires. Its Acceptance ("returns correct target actions") is not
   decidable — name a fixture set.
7. **A7** cites §4 for the sweep; it is §1.3. Add "frequency is a config value". Nobody prunes
   `applied_ops` on its TTL though A7 owns the only cron file — claim it.
8. **A8** omits §10's security test (a commit with a forged `--author` must not act as that
   user) — the test that proves the §7.2 rule the whole design rests on. Its Acceptance demands
   all tests pass while its files include a live smoke test against tasks.qelal.et; separate the
   offline suite from the live smoke test so the acceptance is decidable.
9. **Single-write-path guard:** the §7.1 `triage` prohibition must live on A4's Plane write path,
   not in one consumer. State that A4 rejects any write targeting a `triage`-group state.
10. **`@octokit/app` installation-token minting is unowned** across both parts though §4 calls it
    one of the two largest pieces of boilerplate. Claim it in A2 or A4.

Renumber tasks contiguously if you add any. Keep every citation to a real spec section.

## Part 2 — commit once per task (contract C12)

After the fixes, make **one distinct git commit per task** in part A. Each commit subject must
contain that task's id as a standalone token, e.g.:

```
git add docs/plan/part-a-service-core.md
git commit -m "A3: define delivery-id, commit-SHA, orphan status and audit tables"
```

Every task id A1..An needs its own commit, and two tasks may not share one commit. If
`.git/index.lock` appears, another agent is committing — wait a few seconds and retry.
Verify with: `node scripts/verify-agent-commits.mjs docs/plan/part-a-service-core.md A`

## Part 3 — unlazy (contract C10)

Ledger at `docs/plan/agent-gates/commit-a.GATES.md`, at least 2 gates, at least one runnable.
Include these two runnable gates verbatim:

```
- [ ] G1: part A still passes structural and assigned-section verification
  CHECK: node scripts/verify-plan-part.mjs docs/plan/part-a-service-core.md A 3,4,5,6,7.5,10
  EXPECT: plan part verification passed
  EVIDENCE: pending

- [ ] G2: every task in part A has its own distinct commit
  CHECK: node scripts/verify-agent-commits.mjs docs/plan/part-a-service-core.md A
  EXPECT: agent commit verification passed
  EVIDENCE: pending
```

Verify with the real checker (hand-written evidence is rejected):
`node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --approve docs/plan/agent-gates/commit-a.GATES.md`

Finish only when every gate is met. Do not write outside the two files you own.
