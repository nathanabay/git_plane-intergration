# Review round 1 fix pass — rules for both implementers

The Claude reviewer's round-1 review is `docs/impl/review-1.md`: VERDICT BLOCKING, 3 BLOCKING,
9 MAJOR, 6 MINOR. The driver independently confirmed F1, F2 and F9. Every finding assigned to you
below must be fixed as the review's `Fix:` line says, or — only if you can show the reviewer is
wrong — answered with evidence. Read each assigned finding's full text in `review-1.md`.

Rules (COMMON.md applies):
- Fix the root cause; add a test per finding that fails before your change and passes after.
- Read `.unlazy/impl/evidence/plane-webhook-probe.md`: facts measured on a real Plane v1.4.2
  (label activity carries UUIDs; unknown project key → 403; API field names `labels`/`assignees`/
  `state`, while Plane's web app sends `label_ids`/`assignee_ids`/`state_id`).
- Write `docs/impl/fixes-r1-<A|B>.md`: one section per finding id — what changed (file:line), the
  test that proves it, or the evidence that the finding is wrong. The reviewer reads this in round 2.
- Stay inside your OWNS (in your ledger `.unlazy/impl/gates/fix-r1-<a|b>.md`). The two of you work
  at the same time; the F2/F5/F16 splits below tell each of you exactly which side is yours.
- Your agent ledger: `docs/impl/agent-gates/fix-r1-<a|b>.GATES.md`, copying the driver gates from
  `.unlazy/impl/gates/fix-r1-<a|b>.md`. ALL MET via gate-check --approve --timeout 1800 after your
  final edit. Do not stage or commit.

## Resource rule (mandatory — the host is also the live Plane server)

Six implementers running full oracle suites at once exhausted the machine's memory and the kernel
OOM killer took down the editor, the agents and the test containers. Therefore:
- While iterating, run **only the targeted tests** for the files you change
  (`node --test tests/<area>/<file>.test.ts`). Do not start throwaway Postgres/Valkey yourself
  outside a test.
- Run any oracle (`scripts/verify-*.mjs`) or the whole-repo suite **only through**
  `sh scripts/heavy.sh <command>` — a machine-wide lock, so heavy checks run one at a time. Your
  ledger's G2 and G3 already use it (update your copy of those two gates to match
  `.unlazy/impl/gates/fix-r1-<you>.md`). Waiting on the lock is expected; never bypass it.
- Never run more than one heavy command at a time yourself.
- Run every ad-hoc test with a memory and time bound:
  `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>` (the heap flag
  must go in NODE_OPTIONS: `node --test` runs each file in a child process that does not inherit
  command-line flags). Two unbounded runs grew to
  4.7 GB and 2.7 GB within five minutes (an unbounded loop/retry under test) and were killed by
  the driver; an unbounded run throttles every agent's memory scope.
- **Exactly one gate-check run at a time per agent.** Before starting a new run, stop the previous
  one by killing its whole process group (`kill -- -<PGID>`): gate-check starts detached
  supervisors, and killing only the parent leaves them queued on the heavy lock. On 2026-10-11
  one agent had five concurrent runs plus orphans queued, blocking everyone.
