# Review notes

Run of 15 October 2026 on branch `docs/user-manual` (local only, not pushed). Base: `95cc855` (handbook + user guide,
fetched from the sibling checkout `/home/claudeuser/git_plane-intergration`, where those two docs commits existed but
had never reached this repository's `master`).

## Decisions made without asking

1. **Where the existing docs came from.** `docs/handbook`, `docs/manual`, `scripts/capture-handbook.mjs`,
   `scripts/build-handbook.mjs` and the two verifiers were missing from this checkout. They existed as commits `c0da984`
   and `95cc855` in `/home/claudeuser/git_plane-intergration` on top of the same base (`e0b3a58`). I fetched those
   commits locally and branched `docs/user-manual` from them, so the manual builds on them as the brief intended.
2. **Local demo instance instead of the live environment.** No `manual/.auth/*.json`, no `manual/.env`, `gh` not logged
   in, and `nathanabay/gitsync-test` answers 404 (private). Signing in myself was not allowed. During the run the owner
   added "read only Plane containers". I therefore did **not** create demo data in `gitsync-test` or the GitHub repo.
   The new screenshots come from `manual/demo/server.ts`, which runs the real git-sync code and UI on a throwaway
   database with stand-ins only for Plane's and GitHub's HTTP APIs. Every figure from it is captioned
   **Screenshot (demo instance)**, and the Introduction explains this. That made the full daily loop verifiable end to end
   in the real code (the merge moved WEB-42 to Done), even though it is not a live Plane + GitHub run.
3. **No Plane-side screenshots of the loop.** Showing git-sync's results inside Plane's own UI would need a real Plane
   session, and drawing a fake Plane screen would be fabricating. I used the real Development panel page, which Plane
   embeds in its sidebar. Plane's own views of the results are `[[SCREENSHOT NEEDED]]`, and the exact Plane comment HTML
   that git-sync wrote is quoted verbatim from the run.
4. **Native confirmation dialogs.** `window.confirm()`/`prompt()` dialogs are not drawn in headless screenshots. Their exact
   texts were recorded from the running UI (`notes/demo-output/dialogs.md`) and are quoted in the chapters. I did not fake
   the dialogs. The storyboard entries `acct-05`, `ws-08`, `users-03` therefore show the page state, not the dialog.
5. **Reused real screenshots.** I reused all 53 handbook PNGs and 19 user-guide PNGs (Plane CE v1.4.2 UI, unchanged since).
   GitHub-side images 45–48 show PR #117 from the earlier real test, not this run, and their captions say so.
6. **Code wins.** Where old docs or the brief's catalogue disagreed with the source, the manual follows the code; see
   `notes/discrepancies.md` (D-01 … D-23). The most important ones are listed below.
7. **Callout colour and style.** I kept the handbook's orange numbered badges. Placement was extended to avoid covering
   any text or control (left → above → below → right).
8. **Branch name in the demo.** The demo repository is `acme/website` (fictional), not `nathanabay/gitsync-test`. The
   handbook's GitHub shots keep the real repository name, as they were authorised for publication.
9. **Cover company name.** I used "Bespo EMS PLC" as the brief specified.
10. **`package.json`.** Only the five `manual:*` scripts were added. Playwright, markdown-it, mermaid and cspell are
    installed with `--no-save`.

## Blocked items (and how to fix each)

The placeholders need a signed-in browser. Each one has an id in `storyboard.yaml` (placeholder: true):

| Id | What | Needs | How to capture |
|---|---|---|---|
| gh-01-new-app-form | GitHub's **New GitHub App** form (not submitted) | `manual/.auth/github.json` | Open `https://github.com/organizations/<org>/settings/apps/new`, redact, screenshot; add a shot function to `capture.mjs` and run `npm run manual:capture -- --only gh-01-new-app-form` |
| gh-02-app-permissions | The test App's **Permissions & events** page | github.json and a re-created test App | Same as gh-01, page `…/settings/apps/<slug>/permissions` (slug masked) |
| gh-03-oauth-consent | GitHub's authorize screen during **Connect personal account** | github.json | Click **Connect personal account** on the demo or real instance and capture github.com before approving |
| gh-04-pr-linkback | A PR with git-sync's "Linked Plane work item" comment | github.json, working App + webhooks | Open a PR in `nathanabay/gitsync-test` with `Closes WEB-x` on the real instance |
| gh-05-problem-comment | A commit comment reporting a Smart Commit problem | as gh-04, Report problems on | Push `WEB-x #time 3x` to the test repo |
| plane-01-dev-sidebar | The **Development** section inside Plane's work-item sidebar | plane-alex.json and a live mapping | Open a linked work item in the test Plane |
| plane-02-smart-comment | Smart Commit `#comment` / "Time logged" comments in Plane activity | plane-alex.json and a live mapping | Push a Smart Commit to the mapped test repo |
| plane-03-mirrored-item | A Plane item created from a GitHub issue labelled `plane` | plane-alex.json and a live mapping | Label a test-repo issue `plane` |
| plane-04-done-after-merge | WEB-42 in **Done** in Plane after the merge | plane-alex.json and a live mapping | Merge a `Closes` PR in the test repo |

Other blocked items:
- **Live end-to-end run against the test Plane and GitHub.** It needs a working test GitHub App (the old one was deleted), a
  public webhook URL and the tokens above. To fix it, register the App (Chapter 22), allow-list the installation, map
  the test repo, then run `node scripts/e2e/run.mjs`.
- **Email notifications.** Not exercised: SMTP is disabled on the test instance (unchanged from the handbook).

## Defects and doc errors found while writing (not fixed: the code was out of scope)

1. **`WEB-NEW` link-back comment** lists `- WEB: <url>` instead of the new key (e.g. `WEB-46`). Seen verbatim in
   `notes/demo-output/README.md`; source `src/app/pr.ts:167`. Documented in Chapters 10 and 15 and in Appendix E.
2. **Signed-commit checkbox** (God mode **Require signed commits for Smart Commits**) is saved but never read by the push
   path; only `REQUIRE_VERIFIED_COMMITS` enforces it (D-01).
3. **Mirrored issue not closed when git-sync itself moves the item to Done.** The service-user filter drops that Plane event
   (`src/queue/workers.ts:233`). The manual advises writing `Closes #N` in the PR.
4. **Revert PRs.** GitHub's Revert creates `revert-121-WEB-42-…`, which is a closing reference to WEB-42. The manual advises
   adding `skip WEB-42`.
5. **Installer.** The `-y` error message names a non-existent `--plane-webhook-secret` flag. `install.sh --help` says
   "adds Git Sync to Plane's menus", but the menu label is **GitHub Sync** (D-02).
6. **Audit Detail column.** It never shows rule names, because `rule_match` stores `rule`, not `ruleName`.
7. **Stale-slug cleanup** has no button; it is only available as `DELETE /git-sync/api/instance/workspaces/<slug>/stale-data`.
8. **Previews.** Only deployment URLs on Vercel, Netlify, Cloudflare Pages or Amplify become previews. The Markdown
   "…Preview" link detection exists in code but is never called (D-11).
9. **Problem reports with env-only App credentials.** In the demo, the problem-report write needed the App slug, which is
   read through an App-authenticated `GET /app`. Production uses that path, so this is a note rather than a defect.

## What was verified how

| Area | How |
|---|---|
| Plane CE basics (Chapters 2–7) | Live captures on the test Plane from the handbook (unchanged UI) |
| git-sync UI pages (all tabs, God mode, account, dev panel) | Real UI and API code rendered from the demo instance |
| Daily loop, Smart Commits, merge guard, staging rule, WEB-NEW, mirroring both ways, problem reports, rate-limit/disabled/failed-write states | Real reducers and write paths on demo deliveries; outputs quoted verbatim |
| GitHub-side presentation of git-sync's comments | Text only (verbatim); screenshots are placeholders |
| Grammar tables | Generated by running each example through the real parsers (`scripts/grammar-tables.mjs`) |
| Install, GitHub App registration, operations | Source (`install.sh`, `src/install/*`, `deploy/APPLY.md`) plus the earlier real installer runs (user-guide terminal shots) and `install.sh --help` |
