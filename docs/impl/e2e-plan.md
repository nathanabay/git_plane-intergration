# Deep end-to-end test: plan

Environment: test Plane v1.4.2 at `http://100.85.50.109:8090` (Tailscale only), workspace
`gitsync-test`, project QLL; GitHub App `gitsync-test-nathanabay` (App ID 5282874), installation
170512646 on the private repo `nathanabay/gitsync-test`; webhooks through the smee.io relay; the
service runs as `plane-test-git-sync-1` from the `git-sync:local` image. Drivers: the GitHub CLI
(`gh`) for GitHub actions, the Plane API with the admin token, the gitsync database for audit and
state, and headless Chromium (Playwright image) for the UI and screenshots.

Each scenario records: the action, what was observed on both sides, the audit rows, and PASS/FAIL.
Results go to `docs/impl/e2e-results.md`.

## 0. Deploy the verified build

- Rebuild `git-sync:local` and both fork images (the web fork now carries the Development panel),
  recreate the containers, and confirm migrations 001–010 applied and health is green.
- Confirm GitHub deliveries verify (the webhook secret was synchronised through the App API).

## 1. Setup and health (N1, N5, N7)

1. Admin page: the setup checklist (N7) reports credentials, App permissions and events, last
   GitHub and Plane deliveries, and the rate-limit setting; each failing item names its fix.
2. Workspace page: the health card and banners (N1) reflect real state; a disabled mapping shows
   its reason.

## 2. Connect and identity (C1, C2, C3) — needs the user in the browser

These need the App's Client ID, Client secret, callback URL and setup URL configured, and an
OAuth authorization by a real GitHub user, so the user performs the clicks:
1. Connect (C1): install-return claims the installation for `gitsync-test`; a non-owner is refused;
   the owner hand-off link works once.
2. Personal account (C2): link, see attribution on a mirrored comment, disconnect (token revoked on
   GitHub).
3. Repository picker (C3): lists only repos the user can access; a forged repo is refused.

## 3. Mapping and states (C4, N4, N6)

- Create the mapping `nathanabay/gitsync-test` ↔ QLL through the UI, choosing open and closed
  states; N6: the Smart Commits default applies, and autolinks survive a save.

## 4. Issue mirroring (C5, C6, C7, A3/A10 ordering)

1. GitHub → Plane: open an issue labelled `plane` with an @mention of a mapped user, `#1`, a table
   and a code block → a work item appears with converted mentions and references, untouched code,
   one cross-link each side.
2. Plane → GitHub: label a work item `github` → a GitHub issue appears, cross-linked once.
3. Edit the title, description, assignees and labels on each side → mirrored, with no echo loop.
4. Close on GitHub → the chosen closed state; move to a cancelled state in Plane → closed as
   `not_planned`.
5. Comments both ways, attributed correctly.
6. Out-of-order: two quick edits → the final value wins.

## 5. PR automation, dev info and branch helpers (N3, rules)

1. Create a branch from the Development panel (also settles whether Contents: write suffices or
   Workflows: write is required), push a commit, open a draft PR "Fixes QLL-n" → linked, In Progress.
2. Ready for review, approve, merge → the mapped lifecycle states; the PR rollup link and the
   Development panel show the PR and checks.
3. Smart Commit `QLL-n #comment hello #done` → comment and state change, run once.

## 6. Failure reporting (N2)

- A PR referencing `QLL-9999` → one bot comment on the PR; a bad Smart Commit → one commit
  comment; both once only, and none when reporting is off.

## 7. Resilience and security

- Re-deliver a GitHub webhook → no duplicate effect. Wrong signature → 401.
- Delete a mirrored Plane item → orphaned after confirmation, never closed; archive one → stays
  linked (Plane A2).
- S1 regression: a rule `create_issue` with a traversal project id is refused at save time.
- Rate-limit headers, the silent-webhook banner, and the retry of a failed write from the UI.
