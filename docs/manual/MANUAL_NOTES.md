# Manual evidence and screenshot notes

Captured on 2026-10-14 with Playwright Chromium in this worktree at a 1440×900 viewport. Plane images came from the read-only test Plane v1.4.2 at `http://100.85.50.109:8090`, workspace `gitsync-test`. Normal and God mode logins used credentials read only into process memory; credentials and session state were not exported. No form was submitted except login. Browser mutation requests were blocked after login, with the separate God mode login endpoint allowed. Dialog examples were cancelled; project selection was local form state only.

Sanitization happened **in the page before each capture**: email text/values became `bot@example.com`, secret/token patterns and long IDs were masked, secret inputs were empty, personal GitHub login occurrences became `example-owner`, and avatar image sources were hidden where applicable. App slug and OAuth Client ID fields were additionally masked. Embedded frames were sanitized too. Numbered blue callouts were inserted locally. Every final PNG listed below was opened and visually checked against its caption and for private data; retaken files were checked again.

All source paths below are relative to the test origin unless labelled terminal.

| Screenshot | Source page / state | Hidden or simplified |
| --- | --- | --- |
| [plane-signup.png](images/plane-signup.png) | `/sign-up/`, separate unauthenticated browser context | Example `bot@example.com` entered; Continue not pressed; no account created. |
| [plane-members.png](images/plane-members.png) | `/gitsync-test/settings/members/` | Existing test member emails replaced; Add member located but not used. |
| [plane-profile-menu.png](images/plane-profile-menu.png) | `/gitsync-test/`, avatar menu open | Email replaced; personal avatars suppressed where applicable; Settings callout. |
| [plane-personal-tokens.png](images/plane-personal-tokens.png) | Same page, Profile settings → Personal Access Tokens modal | Email replaced; only existing token titles/status visible; no key revealed. |
| [plane-token-dialog.png](images/plane-token-dialog.png) | Same modal, Add access token → Create token | Example title entered, then cancelled; no token generated; email replaced. |
| [plane-webhooks.png](images/plane-webhooks.png) | `/gitsync-test/settings/webhooks/` | No secret visible; existing test sink addresses retained and explicitly distinguished from the correct setup URL. |
| [plane-webhook-dialog.png](images/plane-webhook-dialog.png) | Same page, Create webhook dialog | Correct internal URL filled locally; all events selected by existing default; cancelled without creating. |
| [plane-gitsync-navigation.png](images/plane-gitsync-navigation.png) | `/gitsync-test/settings/git-sync/`, loaded iframe | Sanitized both parent and embedded UI; no connection initiated. |
| [god-mode-navigation.png](images/god-mode-navigation.png) | `/god-mode/git-sync/` | Navigation only with the actual iframe; no personal admin settings captured. |
| [admin-setup.png](images/admin-setup.png) | `/git-sync/ui/admin`, health/setup checks | Secrets not returned; identifying App fields masked where visible. Actual unknown checks retained. |
| [admin-github-app.png](images/admin-github-app.png) | Same page, scrolled to GitHub App form | Private key/webhook/client-secret fields empty; slug and Client ID masked; no save. |
| [admin-defaults.png](images/admin-defaults.png) | Same page, Defaults and adjacent magic words | No secrets on screen; values left as read; no save. |
| [workspace-connection.png](images/workspace-connection.png) | `/git-sync/ui/workspaces/gitsync-test` | Actual unlinked personal account and empty repository mapping state; no Connect click. |
| [workspace-mapping.png](images/workspace-mapping.png) | Same page, Map a repository form | Plane project selected locally; no repository authorization or mapping save. |
| [workspace-audit.png](images/workspace-audit.png) | `/git-sync/ui/workspaces/gitsync-test/audit` | Actual handled Plane delivery; raw payload collapsed; Replay not invoked. |
| [plane-work-item.png](images/plane-work-item.png) | `/gitsync-test/browse/GITSY-10/` | Existing historical test item, links and loaded Development iframe; personal login text replaced in parent/frame. No item changes. |
| [development-panel.png](images/development-panel.png) | `/git-sync/ui/workspaces/gitsync-test/projects/972d93a8-6889-46b8-9b47-93f9e7546afb/work-items/352bbf1f-5bfc-4379-8b9a-26b842da26e3/development` | Same item's real historical PR/branch links and no-current-mapping message; no branch creation. |
| [installer-output.png](images/installer-output.png) | Terminal: real `SHOW_OUTPUT=1 sh scripts/heavy.sh node scripts/verify-install-e2e.mjs` output | Scratch directory became `/root/plane`, random project became `plane`, loopback origin became `https://plane.example.com`, backup timestamp simplified. No secret output used. |
| [installer-next-steps.png](images/installer-next-steps.png) | Terminal: same run's printed next steps and restart command | Same path/project/origin simplification; rendered verbatim otherwise in terminal-styled HTML. |

Terminal `/root/plane` text is a substitution only: no `/root` files or production Docker daemon were touched. Docker context was rootless, using the current user's socket. The one Docker-heavy command was run under `scripts/heavy.sh`; its disposable stack cleaned itself up. The installer oracle printed **INSTALL E2E PASSED**. This does not verify an actual first Plane UI fork build, since that stack uses API/web stand-ins.

Seven SVGs are hand-written diagrams/illustrations: overview, event flow, install flow, queue/database internals, GitHub App URLs, GitHub App permissions/events, and mapping rules/policies. They use no external scripts/fonts. GitHub forms and mapping-dependent pages are drawings explicitly captioned Illustration, never presented as screenshots.

Verification limits:

- No bot/user, PAT, webhook, App, mapping or branch was created on the screenshot system. Final secret-download and successful save screens were not inspected. Existing token titles are not bot-provisioning evidence.
- No GitHub login, App registration, repository installation, personal OAuth journey or live bidirectional edit was executed. Registration choices are documented from current source/runbook plus Context7 GitHub docs; `Iv`/`Ov` is the brief's GitHub.com diagnostic and is not enforced by the service parser. Gmail plus-addressing was not exercised.
- The workspace had zero current repository mappings and zero linked members. Mapping Edit/Rules/Conflict policies/Test rules pages and populated health cards could not be captured without changing it. The illustrated settings diagram uses repository evidence. Historical Development links still exist on GITSY-10 and are shown accurately.
- A header read confirmed Plane's normal page has `X-Frame-Options: DENY`, while `/git-sync/ui/admin` omits it and returns `frame-ancestors 'self'`. The final screenshots show loaded frames. An initially loading blank view was replaced; no actual frame-denial failure was induced. Caddy/nginx framing examples were checked with Context7/official documentation but not applied.
- The instance health display said no stored App was configured while active bootstrap credentials were readable; registration checks could not verify GitHub permissions/events. Unknown results and Plane rate-verification limits remain visible.
- The full test suite, typecheck, real-Plane installer oracle and mutating `scripts/e2e/` scenarios were not run for this documentation task. Their behavior is described from their scripts. Only the disposable installer oracle and manual/format checks supplied new execution evidence.
- Source review found the stored signature-preference checkbox is not read by the live Smart Commit push handler. Both guides direct operators to `REQUIRE_VERIFIED_COMMITS` for enforcement. Branch template persistence/renderer exists without a normal mapping form/API editor; autolinks are unavailable in the current UI.

The final manual oracle, relative links, image alt text, italic captions, topic order and configuration coverage were checked after authoring. No commit or push was made. Local completion-ledger evidence lives outside the published manual to keep machine-generated digests out of its secret scanner.
