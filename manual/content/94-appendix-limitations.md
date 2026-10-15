# Appendix E · Known limitations and defects

This appendix lists what git-sync does **not** do in this release, and the defects found while writing this manual. Each limitation was checked in the code. Where older documents said otherwise, the code wins. The evidence is in `manual/notes/discrepancies.md`.

## Limitations by design or not yet built

| Limitation | What to do instead | Evidence |
|---|---|---|
| **Time is a comment only.** `#time` posts `Time logged: <duration> (<n> minutes)`, and the rule action `log_time` posts `Time logged: <duration>`. Plane CE has no time tracking to write to. | Read the comments, or keep time in another tool | `src/github/smart-commits.ts`, `src/github/pr-automation.ts` |
| **Plane-side changes are authored by the bot.** Smart Commit comments, rule changes and mirrored edits in Plane show the git-sync service account. The commit's GitHub login appears in the comment ("via 3b2335d by alex-dev"). | Connect your GitHub account anyway: changes you make in Plane then reach GitHub as you, and git-sync can recognize you | D-07 |
| **The signed-commit checkbox is not enforced.** God mode's **Require signed commits for Smart Commits** is saved and shown, but the push handler reads only the environment variable. | Set `REQUIRE_VERIFIED_COMMITS=true` in `git-sync.env` and restart git-sync | D-01, `src/app/push.ts` |
| **GitHub autolink references are unavailable.** The option is shown disabled. | Keys in GitHub text are still linked by the Development panel and link-back comments | `Workspace.tsx` |
| **The branch name template cannot be edited.** It is always `{key}-{title-slug}`, which can also use `{username}`. | — | D-09 |
| **The Development panel has no commit list.** It shows pull requests, builds, deployments, previews and branches. | Open the branch or PR on GitHub | `DevPanel.tsx` |
| **Previews come only from deployments.** A deployment URL on `*.vercel.app`, `*.netlify.app`, `*.pages.dev` or `*.amplifyapp.com` becomes a preview. A Markdown "… Preview" link in a PR body is **not** detected. | Have your host report a GitHub deployment | D-11 |
| **Commit messages never link a pull request.** Only the branch name, title and body do. | Put the key in the branch or PR title | D-06 |
| **The merge guard is checked once.** If WEB-36 has two PRs and one merges while the other is open, the item stays put. Closing the other PR later does not move it. | Move the item by hand, or merge the last PR | D-08 |
| **Deleting a Plane item does not close the GitHub issue.** Plane v1.4.2 sends no delete webhook. Reconciliation (hourly by default) marks the link orphaned and comments on GitHub; archived items are recorded silently. | Close the GitHub issue yourself | D-15 |
| **Comment edits and deletions are not mirrored.** Only new comments are copied. | Post a follow-up comment | `src/sync/mirror.ts` |
| **Unmapped GitHub assignees are dropped**, not guessed. Unmapped `@mentions` become links to the GitHub profile. | Link every member under **User links** | D-16 |
| **Never synced:** priority, dates, estimates, cycles, modules, parent and sub-items, relations, attachments, pages, views and pull requests (PRs are never mirrored as issues). | — | Chapter 13 |
| **Members cannot see the GitHub Sync menu.** In Plane, **Workspace settings → GitHub Sync** is for admins only. | Members open `/git-sync/ui/workspaces/<slug>/account` directly | `packages/constants/src/settings/workspace.ts` |
| **The audit log has no filter controls.** Filters work only as URL parameters (`?errors=1`, `?mappingId=`, `?hours=`). | Use the **Errors in the last 24 hours** link, or edit the URL | D-12 |
| **Saving YAML replaces the default rules.** | Keep the defaults in your YAML, or use the lifecycle table | Appendix D |
| **The review-requested default needs an In Review state.** If the project has no In Review state but has several started states, the rule fails and the failure is audited. | Add an **In Review** state in the Started group | D-20 |
| **The Plane request-rate setup check can say "Needs attention".** It compares git-sync's active client limit with `PLANE_API_RATE_PER_MINUTE`. Plane CE v1.4.2 does not report its own limit, so git-sync cannot verify Plane's `API_KEY_RATE_LIMIT`. | Keep `PLANE_API_RATE_PER_MINUTE` equal to Plane's `API_KEY_RATE_LIMIT`, then restart git-sync | `src/ui/setup-check.ts` |
| **Installer wording.** `install.sh --help` says "adds Git Sync to Plane's menus", but the menu is labelled **GitHub Sync**. | — | D-22 |

## Defect found while making this manual

1. **The link-back comment for a `WEB-NEW` pull request shows the project, not the new key.** When a PR titled `WEB-NEW Add rate limiting to the sign-up form` created WEB-46 in the demo run, git-sync commented on GitHub:

   ```text
   Linked Plane work item:
   - WEB: http://plane.example.com/acme/projects/…/issues/…
   ```

   The comment should say `WEB-46`. The link URL is correct; only the label is wrong. The cause is that `createRequested` in `src/app/pr.ts` (around line 167) passes the project identifier as the item's identifier. *Found in the demo run; text in `manual/notes/demo-output/README.md`.*

## Source files

- `manual/notes/discrepancies.md` (D-01 … D-23)
- `src/app/pr.ts`, `src/app/push.ts`, `src/sync/mirror.ts`, `src/sync/dev-info.ts`, `src/sync/github.ts`
