# Leaf brief: leaf-1.1.5 — part B: resolve review findings, then commit per task

Repository root: `/Users/nathanamare/Downloads/git_plane intergration` — `cd` there first. You own ONLY:
- `docs/plan/part-b-github-ui.md`
- `docs/plan/agent-gates/commit-b.GATES.md`

Read `docs/plan/review-notes.md` in full. It is a blocking review. Then read the spec at
`docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` for any section you touch.

## Part 1 — fix these defects in part B

**Blockers:**
1. **B3, B4, B5 and B6 all declare `Depends: none` and all produce Plane writes.** Four
   independent write paths reintroduce the echo loop §5 exists to prevent. Every Plane write must
   go through part A's A4 write path, which records `op_hash` before writing. Add
   `Depends: A4` (plus A3 where storage is needed) and say explicitly in each body that Plane
   writes are issued through A4's client, never directly.
2. **B4 "evaluates lifecycle states" and "implements branch-regex rules"** in
   `src/github/pr-automation.ts` with `Depends: none`. §7.1 forbids a second parallel
   state-mapping evaluator — there is exactly one engine (A6). Rewrite B4 so it **compiles**
   lifecycle mappings and branch rules into A6 rules and declares `Depends: A6`. Remove any
   language implying it evaluates state itself.
3. **The `triage` prohibition is asserted only in B4.** B3's `#<transition>` and B5's state
   mirroring have no guard. State that the guard lives on A4's single write path, and remove the
   claim that B4 enforces it alone. Also fix B4's "mapping PR events to the six state groups" —
   §7.1 maps lifecycle points to **states** (In Progress, In Review, Done), not groups, and the
   six groups include `triage`, the one you must never write.
4. **No task owns the embedded React app.** §8 requires "All real UI is one React app in this
   repo with two entry routes" — B1 and B2 only add iframes pointing at it. Add a task that
   builds that app: both entry routes (instance-admin and workspace-settings), the config API
   behind it, and the §8 surfaces — repo↔project mappings, state mappings and rule sets, sync
   direction and per-field conflict policy, per-repo Smart Commits toggle, per-user account
   linking — plus the §7.6 dry-run, audit log with replay, and backfill UI.

**Correction to the spec you must apply (driver finding, verified):**
5. §8 says the fork surface is **four files**. That is wrong. `makeplane/plane`'s
   `apps/admin/app/routes.ts` is an **explicit** React Router route config (it imports
   `index`, `layout`, `route` from `@react-router/dev/routes`), so registering a route means
   editing `routes.ts` as well as adding the nav entry and the route component. The real surface
   is **three files per app, six total**. Update B1 and B2 to list all three files each, and
   correct the "four-file fork limit" wording. Their current `pages/` paths are also wrong — the
   real tree is `app/(all)/(dashboard)/...`; use paths consistent with that.

**Further defects:**
6. **B2** omits the §8 auth requirement, and it is the surface that accepts mapping writes:
   validate the viewer via Plane's API and check workspace role (admin/owner) before rendering
   **or accepting mapping writes**.
7. **B3** falls back to the service account only when `sender` is `ghost`; §7.2 requires the
   same fallback when `sender` is a bot or unmapped, and requires recording it in the audit log.
   Add the second mandatory guard: a config option requiring `verification.verified == true`
   before honouring commands. Scope `#<transition>` resolution by `(project, group)` with name
   as fallback, never name alone (§7.1). Add §7.2's loud-failure rule for a nonexistent target state.
8. **B5** omits §7.3's shipping defaults (`source_of_truth:github` for title/description,
   `last_write_wins` for state and assignees) and the cross-link confirmation comment.
9. **B6** surfaces mutable rollups as links, but §4 says a duplicate link URL is rejected with
   400 — a rollup must be **updated in place** via `/links/{pk}/`, which means retaining link
   ids. Reconcile this with A4 explicitly. Also fix detection: §7.4 detects previews by provider
   (Vercel, Netlify, Cloudflare Pages, AWS Amplify) and markdown links ending in "Preview"; the
   title prefix is only for categorised links.
10. **B7** declares `Depends: B2`, a nav stub. Its real dependencies are A6 (plus its no-write
    mode), A3 (audit table) and A2/A4 (ingress and outbound workers). Fix them.
11. **B8** claims rate-limit backoff inside `src/auth/identity.ts`; rate limiting belongs to
    A4's outbound workers (§4). Move or restate it. §9's concrete PAT obligations are unclaimed:
    encrypt at rest, never log, and a UI revocation path that invalidates the stored token.

Renumber tasks contiguously if you add any. Keep every citation to a real spec section, and keep
your assigned sections cited: 7.1, 7.2, 7.3, 7.4, 7.6, 8, 9.

## Part 2 — commit once per task (contract C12)

After the fixes, make **one distinct git commit per task** in part B. Each commit subject must
contain that task's id as a standalone token, e.g.:

```
git add docs/plan/part-b-github-ui.md
git commit -m "B4: compile lifecycle and branch rules into the A6 engine"
```

Every task id B1..Bn needs its own commit, and two tasks may not share one commit. If
`.git/index.lock` appears, another agent is committing — wait a few seconds and retry.
Verify with: `node scripts/verify-agent-commits.mjs docs/plan/part-b-github-ui.md B`

## Part 3 — unlazy (contract C10)

Ledger at `docs/plan/agent-gates/commit-b.GATES.md`, at least 2 gates, at least one runnable.
Include these two runnable gates verbatim:

```
- [ ] G1: part B still passes structural and assigned-section verification
  CHECK: node scripts/verify-plan-part.mjs docs/plan/part-b-github-ui.md B 7.1,7.2,7.3,7.4,7.6,8,9
  EXPECT: plan part verification passed
  EVIDENCE: pending

- [ ] G2: every task in part B has its own distinct commit
  CHECK: node scripts/verify-agent-commits.mjs docs/plan/part-b-github-ui.md B
  EXPECT: agent commit verification passed
  EVIDENCE: pending
```

Verify with the real checker (hand-written evidence is rejected):
`node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --approve docs/plan/agent-gates/commit-b.GATES.md`

Finish only when every gate is met. Do not write outside the two files you own.
