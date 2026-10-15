# Capture report

Run: 2026-10-15T16:44:32.601Z · demo server http://127.0.0.1:3199 · full run

Captured: 73 · failed: 0 · placeholders (need a signed-in browser): 9

| Id | Callouts | Source |
|---|---|---|
| acct-01-not-connected | 2 | `/git-sync/ui/workspaces/acme/account` |
| acct-02-connected | 2 | `/git-sync/ui/workspaces/acme/account?github=linked` |
| acct-03-connected-idle | 3 | `/git-sync/ui/workspaces/acme/account` |
| acct-04-needs-reauth | 2 | `/git-sync/ui/workspaces/acme/account` |
| acct-06-error-denied | 1 | `/git-sync/ui/workspaces/acme/account?github=error&reason=denied` |
| acct-07-error-already-linked | 1 | `/git-sync/ui/workspaces/acme/account?github=error&reason=already_linked` |
| acct-08-member-no-admin | 1 | `/git-sync/ui/workspaces/acme` |
| acct-05-disconnect-confirm | 1 | `/git-sync/ui/workspaces/acme/account` |
| dev-01-not-mapped | 1 | `/git-sync/ui/workspaces/acme/projects/4d5e6f70-8192-4a3b-8c4d-5e6f708192a3/work-items/efc828ab-2ccb-4758-aa9e-22365a8d6fa6/development` |
| dev-02-start-work | 3 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-03-branch-created | 1 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-04-branch-exists | 1 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-05-first-push | 1 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-06-draft-pr | 2 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-07-build-pending | 1 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-08-build-pass-preview | 3 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-09-review-requested | 1 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-10-changes-requested | 1 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-11-approved | 1 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-12-merged | 1 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/ad96620d-677d-4322-8938-944ad68c1202/development` |
| dev-13-failing-build | 1 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/03a21803-bbcf-4e8b-b432-f210f8cdebdd/development` |
| dev-14-merge-guard | 2 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/07f13a9c-7193-4f9f-bc6a-101d328ccfdd/development` |
| dev-15-web-new | 2 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/3aa2d851-e33f-4e07-8926-a4ab38f61ebd/development` |
| dev-16-mirrored-issue | 0 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/a095b071-b7ce-447c-8a57-577d205d11f8/development` |
| dev-17-refs-non-closing | 1 | `/git-sync/ui/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/fd85c0fd-6e7a-43d7-a9a9-163427e0c2df/development` |
| ws-01-setup-checklist | 3 | `/git-sync/ui/workspaces/beta` |
| ws-02-connected | 3 | `/git-sync/ui/workspaces/acme` |
| ws-03-owner-link | 2 | `/git-sync/ui/workspaces/beta` |
| ws-04-map-form | 5 | `/git-sync/ui/workspaces/acme` |
| ws-05-custom-states | 2 | `/git-sync/ui/workspaces/acme` |
| ws-06-backfill-offer | 2 | `/git-sync/ui/workspaces/acme` |
| ws-07-mapped-list | 4 | `/git-sync/ui/workspaces/acme` |
| map-01-settings | 4 | `/git-sync/ui/workspaces/acme/mappings/1` |
| map-02-policies | 3 | `/git-sync/ui/workspaces/acme/mappings/1/policies` |
| map-03-rules-table | 2 | `/git-sync/ui/workspaces/acme/mappings/1/rules` |
| map-04-branch-rules | 3 | `/git-sync/ui/workspaces/acme/mappings/1/rules` |
| map-05-yaml | 3 | `/git-sync/ui/workspaces/acme/mappings/1/rules` |
| map-06-yaml-error | 1 | `/git-sync/ui/workspaces/acme/mappings/1/rules` |
| map-07-versions | 2 | `/git-sync/ui/workspaces/acme/mappings/1/rules` |
| map-08-dryrun-input | 5 | `/git-sync/ui/workspaces/acme/mappings/1/dry-run` |
| map-09-dryrun-result | 2 | `/git-sync/ui/workspaces/acme/mappings/1/dry-run` |
| map-10-dryrun-none | 1 | `/git-sync/ui/workspaces/acme/mappings/1/dry-run` |
| users-01-list | 2 | `/git-sync/ui/workspaces/acme/users` |
| users-02-link-form | 4 | `/git-sync/ui/workspaces/acme/users` |
| health-02-disabled | 1 | `/git-sync/ui/workspaces/acme` |
| health-01-rate-limited | 1 | `/git-sync/ui/workspaces/acme` |
| audit-01-log | 4 | `/git-sync/ui/workspaces/acme/audit` |
| audit-02-raw | 2 | `/git-sync/ui/workspaces/acme/audit` |
| audit-03-errors-only | 1 | `/git-sync/ui/workspaces/acme/audit?errors=1` |
| audit-04-replay | 1 | `/git-sync/ui/workspaces/acme/audit` |
| audit-05-retry-write | 1 | `/git-sync/ui/workspaces/acme/audit?errors=1` |
| map-11-dryrun-custom-yaml | 2 | `/git-sync/ui/workspaces/acme/mappings/1/dry-run` |
| audit-06-mapping-filter | 1 | `/git-sync/ui/workspaces/acme/audit?mappingId=1&hours=24` |
| users-04-after-link | 1 | `/git-sync/ui/workspaces/acme/users` |
| ws-09-overview | 4 | `/git-sync/ui/workspaces/acme` |
| acct-09-admin-tab | 2 | `/git-sync/ui/workspaces/acme/account` |
| gm-12-instance-audit-default | 1 | `/git-sync/ui/admin/audit` |
| gm-01-overview | 3 | `/git-sync/ui/admin` |
| gm-03-github-app | 6 | `/git-sync/ui/admin` |
| gm-04-edition | 1 | `/git-sync/ui/admin` |
| gm-05-defaults | 3 | `/git-sync/ui/admin` |
| gm-06-magic-words | 2 | `/git-sync/ui/admin` |
| gm-07-installations | 2 | `/git-sync/ui/admin` |
| gm-08-mappings | 2 | `/git-sync/ui/admin` |
| gm-09-manual-recovery | 3 | `/git-sync/ui/admin` |
| gm-10-instance-audit | 2 | `/git-sync/ui/admin/audit?scope=all` |
| gm-02-setup-fail | 1 | `/git-sync/ui/admin` |
| gm-11-decrypt-error | 1 | `/git-sync/ui/admin` |
| term-01-install-help | 0 | `terminal: ./install.sh --help` |
| term-02-healthz | 0 | `terminal: curl -i http://git-sync.internal:3100/git-sync/healthz` |
| strip-web42-loop | 0 | `strip of dev-05-first-push, dev-06-draft-pr, dev-09-review-requested, dev-12-merged` |
| strip-account-states | 0 | `strip of acct-01-not-connected, acct-02-connected, acct-04-needs-reauth` |
| strip-review-badges | 0 | `strip of dev-09-review-requested, dev-10-changes-requested, dev-11-approved` |

## Failures

None.

## Placeholders

- **gh-01-new-app-form** (github): GitHub's New GitHub App form (do not submit).
- **gh-02-app-permissions** (github): The test App's Permissions & events page.
- **gh-03-oauth-consent** (github): GitHub's authorize screen during Connect personal account.
- **gh-04-pr-linkback** (github): A PR on GitHub with git-sync's 'Linked Plane work item' comment.
- **gh-05-problem-comment** (github): A commit comment from git-sync reporting a Smart Commit problem.
- **plane-01-dev-sidebar** (plane-alex): The Development section inside a real Plane work item sidebar with PR, build and preview.
- **plane-02-smart-comment** (plane-alex): A Smart Commit #comment and Time logged comment in Plane's activity.
- **plane-03-mirrored-item** (plane-alex): A Plane work item created from a GitHub issue labelled plane.
- **plane-04-done-after-merge** (plane-alex): WEB-42 in Done in Plane after the merge.
