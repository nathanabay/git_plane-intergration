# Outline — git-sync for Plane: Developer & Admin Manual

Sources per chapter: HB = `docs/handbook/NN-*.md`, UG = `docs/manual/user-guide.md`, DG = `docs/manual/developer-guide.md`,
INV = `manual/notes/feature-inventory.md`, DISC = `manual/notes/discrepancies.md`, OUT = `manual/notes/demo-output/README.md`.
Image ids refer to `manual/storyboard.yaml` (demo shots → `images/demo/<id>.png`; handbook shots → `images/handbook/…`).

| File | Chapter | Builds on | Key images |
|---|---|---|---|
| 00-introduction.md | Introduction: who this is for, how to read, **About the screenshots** (test Plane vs demo instance vs diagram), version | HB01 | diagram-system.svg |
| 00a-part-a.md | Part A divider — Developer guide | — | — |
| 01-welcome.md | 1 Welcome: Plane concepts (workspace, project, work item, cycle, module, view, page, intake) and what git-sync adds | HB01 | diagram-system, diagram-item-structure |
| 02-getting-in.md | 2 Getting in: invitation, sign-in, profile, preferences, notification preferences, join project | HB02 | handbook 01–05, 07, 08 |
| 03-finding-your-way.md | 3 Finding your way: workspace switcher, Home, Your work, command palette, shortcuts | HB03 | handbook 06, 09–11, 13 |
| 04-work-items.md | 4 Work items: create, quick add, drafts, editor, properties, estimates, attachments, links, relations, sub-items, comments, mentions, archive/delete | HB04 | handbook 18–24, 27–35, 54 |
| 05-views-and-layouts.md | 5 Views and layouts: List, Board, Calendar, Spreadsheet, Gantt, Display, Filters | HB05 | handbook 12, 14–17, 25, 26 |
| 06-planning.md | 6 Planning: cycles, modules, pages, saved views, intake, estimates, states, analytics | HB06 | handbook 36–44, 50, 51 |
| 07-notifications.md | 7 Notifications and Inbox | HB07 | handbook 52, 08 |
| 08-connections-and-account.md | 8 The four connections + your personal GitHub account (states, connect, reconnect, disconnect, errors, member navigation) | HB08, INV C | diagram four-connections (mermaid), acct-01…08, handbook 53, gh-03 placeholder |
| 09-linking.md | 9 Linking branches, commits and PRs: key format, deny-list, where scanned, tiers, strongest wins, skip/ignore, link-back | HB09, DISC D-04..06 | diagram-reference-tiers, dev-17, handbook 45–46, gh-04 placeholder |
| 10-magic-words.md | 10 Magic words and WEB-NEW: default lists, multiple keys, colon rule, admin-edited lists, WEB-NEW, merge guard intro | HB10, INV D | dev-15, grammar tables (generated) |
| 11-smart-commits.md | 11 Smart Commits: grammar, #comment, #time, state commands, multi-key, partial success, idempotency, actor, signed commits (truth), Report problems | HB10, INV F, DISC D-01/D-03 | handbook 47, OUT problem comments, plane-02/gh-05 placeholders, grammar tables |
| 12-development-panel.md | 12 The Development panel: sections, badges, Copy branch name, Create branch, previews, native link prefixes, direct route | HB09/11, INV E | dev-01…04, dev-13, development-panel.png, plane-work-item.png, plane-01 placeholder |
| 13-mirroring.md | 13 Issue mirroring and what syncs: labels, six fields, create copies, conflict policies (reader view), state mapping, assignees/mentions, never synced, deletes, echo/dedupe/retries | HB11, INV G | dev-16, diagram-delivery, OUT mirrored text, plane-03 placeholder |
| 14-pr-automation.md | 14 PR automation from a developer's view: triggers, defaults, tier gating, ready-for-merge, merge guard, staging example | HB11, INV H | dev-14, diagram-review-loop, mermaid merge guard |
| 15-day-in-the-life.md | 15 A day in the life: the full WEB-42 loop, one screenshot per step + variants (bug from GitHub issue, split work, one PR → two items, revert, PR-first WEB-NEW) | HB12 | dev-02…12, strip-web42-loop, handbook 35/45–48, plane-04 placeholder |
| 16-team-conventions.md | 16 Team conventions | HB13 | — |
| 17-troubleshooting.md | 17 Troubleshooting for developers + how to send a useful report | HB14 | acct-04, dev-13, audit-03 |
| 18-faq-glossary.md | 18 FAQ & glossary | HB15, manual/notes/glossary.md | — |
| 19-cheat-sheet.md | 19 Cheat sheet (exactly one page; also built as dist/cheat-sheet.pdf) | HB16 | — |
| 19z-part-b.md | Part B divider — Admin guide | — | — |
| 20-architecture.md | 20 Architecture & requirements | UG, DG, spec | overview.svg, internals.svg, event-flow.svg |
| 21-install.md | 21 Install (install.sh, prompts, options, Plane UI fork build, webhook, safety on a live Plane, blank iframe) | UG, INSTALL.md | install-flow.svg, installer-output, installer-next-steps, term-01, plane-webhooks, plane-webhook-dialog, plane-personal-tokens, plane-token-dialog |
| 22-github-app.md | 22 Register the GitHub App (URLs, permissions, events, key, secret, slug) | UG, deploy/APPLY.md | github-app-urls.svg, github-app-permissions.svg, gh-01/gh-02 placeholders |
| 23-god-mode.md | 23 God mode settings | UG, INV J | god-mode-navigation, gm-01…09 |
| 24-connect-and-map.md | 24 Connect GitHub & map repositories | UG, INV I | plane-gitsync-navigation, ws-01…06, ws-08 |
| 25-mapping-settings.md | 25 Mapping settings & conflict policies | INV G/I | map-01, map-02, rules-and-policies.svg |
| 26-rules.md | 26 Rules: lifecycle table, branch-aware rules, YAML, versions, Test rules | INV H/I | map-03…10, mermaid rule evaluation |
| 27-user-links.md | 27 User links | INV I | users-01…03 |
| 28-health-and-audit.md | 28 Sync health & audit log | INV I | ws-07, health-01/02, audit-01…03, gm-10, workspace-audit |
| 29-operations.md | 29 Operations: update, rotate PAT, token key, replay/redeliver, retry write, backups, uninstall, purge, healthz | UG, deploy/APPLY.md | audit-04, audit-05, term-02 |
| 30-admin-troubleshooting.md | 30 Admin troubleshooting | UG, APPLY | gm-02, gm-11 |
| 90-appendix-routes.md | Appendix A: all routes | INV, src/ui/client/router.ts | — |
| 91-appendix-settings.md | Appendix B: settings and environment variables | src/config/env.ts | — |
| 92-appendix-grammar.md | Appendix C: reference, magic-word and Smart Commit grammar with valid/invalid examples (GENERATED by scripts/grammar-tables.mjs) | tests | — |
| 93-appendix-rules.md | Appendix D: rule triggers, conditions, actions reference | src/rules | — |
| 94-appendix-limitations.md | Appendix E: known limitations and defects found | DISC, REVIEW_NOTES | — |
| 95-appendix-version.md | Appendix F: version, commit and how this manual was made | — | — |
