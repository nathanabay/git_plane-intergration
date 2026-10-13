# Deep end-to-end test: results

Build `d81e928` deployed to the test Plane v1.4.2 (Tailscale 100.85.50.109:8090); migrations 001–011
applied. GitHub App `gitsync-test-nathanabay` (installation 170512646) on `nathanabay/gitsync-test`.
Mapping #1: `nathanabay/gitsync-test` ↔ GITSY, two-way, Smart Commits and link-back on.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 0 | Deploy verified build | PASS | containers healthy; migrations 001–011; health 200; both GitHub Sync pages 200 |
| 1 | Setup checklist (N7) | PASS | credentials, events, GitHub delivery, Plane delivery pass; permissions correctly FAIL (missing Organization Members: Read); rate limit correctly "unknown" |
| 2a | Connect / org card (C1) | PASS | card shows nathanabay, "User · installation 170512646", Manage access, Disconnect, Connect, owner hand-off |
| 2b | Personal account (C2) | PASS | user_map nathanabay (22275693); github_oauth token stored encrypted, needs_reauth false |
| 2c | Repository picker (C3) | PASS | picker lists only `nathanabay/gitsync-test (private)`; duplicate mapping refused |
| 3 | Mapping with states (C4) | PASS | mapping #1 created through the UI with Open/Closed state pickers |
| 4.1 | GitHub → Plane mirror (C5–C7) | PASS | issue #1 → GITSY-8; `@nathanabay` → `<mention-component … user_mention>`; `#1` and `owner/repo#1` → links; table kept; code block literal; one Plane link, one "Mirrored from" comment, one GitHub cross-link comment; echoes dropped |
| 4.2 | Plane → GitHub mirror | PASS | GITSY-9 (label `github`) → issue #2 by the App, label `plane`, "Mirrored from Plane" footer, one cross-link |
| 4.3 | Title edits | PASS | GitHub→Plane applied; Plane→GitHub not applied, as the default `source_of_truth: github` policy requires |
| 4.4 | States (C4) | PASS | close #1 → GITSY-8 Done; GITSY-9 → Cancelled closes #2 as NOT_PLANNED |
| 4.5 | Comments + attribution (C2) | PASS | GitHub→Plane comment attributed; Plane→GitHub comment posted **as nathanabay** through the user token |
| 5.1 | Development panel (N3) | PASS | GET development returns key, repo, template branch name; Create branch → 201, branch exists. **Contents: write suffices; Workflows: write not needed** |
| 5.2 | Rules (N6) | PASS | default lifecycle rules saved as version 1 with author |
| 5.3 | Smart Commit + draft PR | PASS | `GITSY-10 #comment …` → Plane comment with commit link; draft PR "Fixes GITSY-10" → In Progress; PR rollup and branch links; PR linkback comment |
| 5.4 | Ready + merge | PASS | merged into main → GITSY-10 Done; rollup MERGED; Smart Commit step executed once |
| 6 | Failure reports (N2) | PASS* | with reporting on: PR "Fixes GITSY-9999" → one bot comment naming the unknown key; Smart Commit `#nosuchstate` → one commit comment; editing the PR keeps one report (edited in place). *The per-mapping toggle could only be set in the database — see E2E-1 |
| 7.1 | Forged webhooks | PASS | bad GitHub signature 401; missing signature 401; forged Plane signature 401 |
| 7.2 | S1 traversal at rule save | PASS | `../../victim-ws/...` and `%2E%2E%2F...` both 422; nothing stored |
| 7.3 | GitHub redelivery | PASS | real `issue_comment` redelivered via the App API; still one mirrored comment |
| 7.4 | Deleted Plane item | PASS | GITSY-9 deleted → link orphaned on the first sweep (confirmed by Plane's activity); GitHub issue not touched |
| 7.5 | Archived Plane item | **FAIL** | GITSY-8 archived (in Done) → sweep 1 left it active, sweep 2 **orphaned** it (`archived: 0`) — see E2E-2 |

## Defects found

- **E2E-1 (N2): the "Report problems on GitHub/Plane" toggle is unreachable.** `report_problems` exists in
  migration 010 and `src/db/parity.ts`, but `src/ui/validate.ts` does not accept `reportProblems` and the
  mapping form has no checkbox, so reports stay off unless the database is edited.
- **E2E-2 (Plane A2): an archived item is orphaned after two sweeps.** On real Plane v1.4.2 the reconcile
  sweep did not recognise the archived item (`archived: 0`) and fell back to "a second sweep agrees". The
  unit tests used a fake Plane that answered the archive lookup; the real API path the code uses does not.

## Not defects

- Setup checklist "App permissions" FAIL is real: the App lacks **Organization → Members: Read**, which the
  org owner/admin claim rule needs for organisations. Add it in the App's permissions.
- Plane → GitHub title edits are not applied by default: the documented default conflict policy is
  `source_of_truth: github` for title and description.
- Review-requested automation was not exercised: it needs a second GitHub user.

## Automated suite (2026-10-13)

The manual run above is now automated in `scripts/e2e/` (`node scripts/e2e/run.mjs [--only S14,S15] [--keep] [--list]`;
how to run and per-scenario notes in `e2e-suite-G3.md` and `e2e-suite-G1.md`).

- Complete run on the fixed build: **53 PASS, 0 FAIL, 0 SKIP** (`e2e-runs/2610131635-9c1b.md`).
- Defects found by the suite and fixed: E2E-3 (empty GitHub body rejected by Plane), E2E-4 (`Ref KEY` also counted as a
  bare closing reference), E2E-5 (successful commit status produced no CI rollup). E2E-1 and E2E-2 confirmed fixed live.
- Correction: the first E2E-4 fix also stopped non-closing references from advancing state, following a wrong instruction;
  the spec (§6) says non-closing references advance but skip the merge state. Reverted; S34 and S35 rewritten to the spec
  and re-run with the PR and Smart Commit group: **14 PASS** (`e2e-runs/2610131712-bae7.md`, `2610131713-88f1.md`).
- Full check on the same tree: typecheck, stub checks, 11/11 oracles, unit tests 98 files / 1128 pass (the one failure,
  `a8/rule-engine` non-closing advance, passes after the correction).
