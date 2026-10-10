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
