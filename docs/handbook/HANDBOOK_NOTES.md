# Handbook notes and evidence

## Scope and sources

The numbered chapters are a member-facing handbook for Plane Community Edition v1.4.2 and this repository's current git-sync implementation. The owner amendment authorized writes to the test Plane and real GitHub work only in `nathanabay/gitsync-test`. No handbook commit or push was made. No production system was accessed.

Plane behavior was checked in the running v1.4.2 interface. Context7 was queried with `npx ctx7@latest library Plane` and `npx ctx7@latest docs /makeplane/plane`; its results included preview-branch documentation, so runtime observations take precedence for edition availability. The observed project provides list, board, calendar, spreadsheet, Gantt, cycles, modules, views, pages, intake, estimates and project analytics. No paid-only functionality is presented as included. The keyboard table was transcribed from the running dialog, including its overlapping context-dependent bindings.

Context7 `/microsoft/playwright` confirmed that `page.pdf` supports `outline: true` since v1.42. The local build requests outline and tagged PDF and supplies explicit A4 pages, per-page chapter headers, footers, linked contents, readable type, unsplit images and row-split tables. Dependencies were installed locally with `npm i --no-save --package-lock=false`; package.json and the lockfile were not changed.

Git-sync facts were read from the parsers, Smart Commit processor, UI/router/auth code, push and PR handlers, mirror/rule/queue/reconciliation code and the design specification. Two writing workers cross-reviewed the reference chapters and ran focused parser and executor assertions. No full test suite ran.

## Historical live-sync verification limit

The first live checks found no workspace installation associations or repository mappings in the test git-sync API. The read-only setup check reported readable credentials, but could not read the GitHub App registration; it reported no verified GitHub deliveries. Plane deliveries were present. The amendment prohibited changing GitHub App or instance settings, so those settings were left intact. The owner subsequently confirmed that the test GitHub App no longer exists and explicitly excluded the real merge flow from the final task. PR #117 was left alone. The handbook retains its honest live-verification limitations; no complete real daily loop is claimed.

Personal GitHub account page discovery and its disconnected state were verified as an ordinary workspace member. Interactive GitHub OAuth authorization and disconnect of a successfully linked OAuth account were not exercised because the browser was not signed in to GitHub. Those procedures are documented from the actual route and client/server implementation. Email delivery was not exercised: SMTP is disabled on the capture instance. Independent teammate approval was not exercised: the real COMMENTED review is a walkthrough comment authored by the PR author, explicitly identified in the caption.

## Changes made on the test Plane

All content writes were through Plane's own UI or HTTP API. Existing workspaces, projects and work items were retained. No test container was restarted, recreated, installed into, or deleted. No instance setting or GitHub App credential was changed.

- Created the **Website** project, identifier **WEB**, project ID `bb57e81d-c161-441f-b50e-907af28f08c2`, in the existing `gitsync-test` workspace. A new project inside the existing workspace preserved the connection boundary: the code permits an installation to belong to only one workspace. The initial API connection was empty, and no existing mapping was moved.
- Created fictional accounts **Alex Developer**, `alex.developer@example.com`, and **Sam Reviewer**, `sam.reviewer@example.com`, through sign-up. Updated only their own profile/onboarding settings. Invited them to the existing workspace as members and joined them to Website. Alex's user ID is `6a57833d-4e43-49be-924c-f093cddfae76`; Sam's is `2f526b2d-ac50-4798-a13f-962b9e5dba94`. Their random credentials and browser sessions are outside this repository and are not published.
- Created WEB-1 through WEB-42 with fictional customer-website titles, descriptions, states, priorities and October 2026 dates. WEB-42 is **Make the checkout button visible on small screens**, item ID `458fec15-4298-4188-ba8a-31ad38ee3827`. Its state was manually changed from Todo to In Progress while capturing the start-work step.
- Created **In Review** in the Started group. The project's initial default states were created by Plane when the project was created.
- Created the project labels **frontend**, **bug**, **accessibility** and **documentation**. Populated WEB-1 through WEB-42 with varied labels, fictional assignees and Fibonacci estimates. WEB-42 has frontend and accessibility, is assigned to Alex, and has estimate 2. Some other items were intentionally left unassigned.
- Created the cycle **October customer experience**, ID `bd567583-6209-4a5c-ab61-5aec9d084d14`, and added WEB-32 through WEB-42.
- Created the module **Checkout experience**, ID `8c2ca61e-b9f6-4686-b5ea-529f2047c5c4`, and added WEB-32 through WEB-42.
- Set WEB-40 as a sub-work item of WEB-42. Added a Relates to relation from WEB-42 to WEB-41.
- Created **Website working agreement**, page ID `d418c5cd-774d-478a-bddc-2673859c1720`, with a short working agreement and review checklist, associated only with Website. No public page publication was performed.
- Enabled Intake for Website and created the pending **Checkout label wraps on a narrow screen** request, WEB-43. It was left pending for triage.
- Created the saved project view **Website delivery overview**.
- Created and enabled the **Points** estimate system using the Fibonacci template `1, 2, 3, 5, 8, 13` on Website.
- Created an unfinished draft **Improve the empty-cart message**, owned by Alex, to demonstrate Save to Drafts.
- Added three substantive comments to WEB-42: initial implementation intent (administrator), implementation/checking intent (Alex), and a review note about the button label/focus indicator (Sam).
- Added the external example link **Checkout acceptance notes** pointing to `https://example.com/checkout-notes` and uploaded the harmless PNG attachment **checkout-layout-example.png**, a screenshot of the self-contained teaching checkout page. Text-file upload attempts were rejected as an invalid file type, including with an explicit text/plain MIME type; no text attachment was created.
- Alex became subscribed to WEB-42 through work-item activity. Capture interactions changed only demo-member presentation preferences, such as selected layout/grouping, and opened/read inbox content.

Undo content changes by removing the Website project after checking its demonstration items, cycle, module, view, page, estimate system, draft and uploaded attachment. Remove the project-associated page/draft explicitly if Plane retains them. Remove only the two named fictional member invitations/accounts if desired; do not delete the workspace or existing members. Any future mapping or real synced issue must be disconnected/removed deliberately before deleting its source records, to avoid unintended reverse effects.

## Changes made on GitHub

Only the owner's authorized repository was modified. No repository setting, visibility, GitHub App registration or other repository was changed. No force-push occurred.

- Created feature branch `web-42-checkout-button` from `main`.
- Committed `handbook-demo/checkout.html`, a self-contained teaching checkout layout. Its commit message includes `WEB-42 #time 45m #comment Checked 320, 375 and 390 pixel widths.` The bounds/focus checks actually ran at all three widths using local Playwright before creating the commit.
- Opened [PR #117](https://github.com/nathanabay/gitsync-test/pull/117), **WEB-42 Keep checkout button visible**, targeting main, with `Closes WEB-42` in the body.
- Added a real COMMENTED review, review ID `5529704680`, explaining the checked demonstration behavior and the need for a separate teammate's production review. This was not an independent approval.

The PR and branch were left unchanged. The owner's latest instruction excludes finishing PR #117 or attempting the real merge walkthrough. The driver owns repository visibility; it was not changed by the handbook work.

## Disposable environment cleanup

Before the amendment, the prescribed real-install verification started one disposable Compose project named `plane-app`. After the amendment, its verifier process was terminated by its specific PID. Under the shared heavy-job lock, Compose down removed only that project's containers, network and volumes. Its temporary folder was removed. A subsequent Docker process listing contained the pre-existing test and oracle containers and no `plane-app-*` container. No root Docker daemon or prohibited path was accessed.

## Screenshot capture and redaction

All PNGs are real browser captures from the running Plane UI or public GitHub pages. The browser viewport was 1440 × 900, with some images cropped to the relevant modal or panel. Numbered orange callouts and short arrows were injected as CSS/DOM overlays before capture. No GitHub UI illustration is passed off as a screenshot. All SVGs are explanatory diagrams, visibly labeled Diagram.

For every Plane screenshot, browser chrome is excluded. Before capture, visible network addresses become `plane.example.com`; non-example emails become `member@example.com`; test workspace display text becomes **Acme**; test display names are replaced with the fictional developer/reviewer names; unrelated project navigation is hidden. These are visual redactions only: the underlying workspace slug and server configuration are unchanged. Screenshots of the new fictional user preserve its safe example.com address. Some administrator-created activity still shows the generic display name `admin`.

The separate text-attachment attempt was rejected by the API as Invalid file type, both without an inferred MIME and with text/plain. The PNG upload succeeded through the real file input and the attachment name appeared in the item. The attached image contains only the fictional checkout demonstration.

For GitHub screenshots, the public repository owner/name and PR numbers are retained as authorized. Email addresses and Plane addresses are hidden or replaced, avatar images are hidden, and sign-in/sign-up/cookie banners are hidden. DOM redaction does not alter repository records. The comment review is labeled accurately.

| PNG | Captured UI and location | Caption / callout intent | Hidden data |
| --- | --- | --- | --- |
| [01-workspace-invitation.png](images/01-workspace-invitation.png) | Plane CE v1.4.2 `/onboarding/` | Accept the invitation: (1) select the workspace checkbox; (2) Continue. | Standard Plane redactions described above. |
| [02-sign-in.png](images/02-sign-in.png) | Plane CE v1.4.2 `/` | Sign in: (1) email field; (2) Continue. The next screen asks for a password. | Standard Plane redactions described above. |
| [03-personal-menu.png](images/03-personal-menu.png) | Plane CE v1.4.2 `/gitsync-test/` | Personal menu: (1) avatar; (2) Settings; (3) Preferences. | Standard Plane redactions described above. |
| [04-profile.png](images/04-profile.png) | Plane CE v1.4.2 `/gitsync-test/` | Profile: (1) avatar; (2) name; (3) display name; (4) Save changes. | Standard Plane redactions described above. |
| [05-join-project.png](images/05-join-project.png) | Plane CE v1.4.2 `/gitsync-test/projects/` | Join Website: (1) confirm the project name; (2) Join Project. | Standard Plane redactions described above. |
| [06-home.png](images/06-home.png) | Plane CE v1.4.2 `/gitsync-test/` | Home: (1) sidebar Home; (2) Quicklinks; (3) Recents. | Standard Plane redactions described above. |
| [07-preferences.png](images/07-preferences.png) | Plane CE v1.4.2 `/gitsync-test/` | Preferences: (1) theme; (2) timezone; (3) first day of the week. | Standard Plane redactions described above. |
| [08-notification-preferences.png](images/08-notification-preferences.png) | Plane CE v1.4.2 `/gitsync-test/` | Email notifications: (1) property-change switch; (2) Mentions category and its switch. | Standard Plane redactions described above. |
| [09-workspace-switcher.png](images/09-workspace-switcher.png) | Plane CE v1.4.2 `/gitsync-test/` | Workspace switcher: (1) current workspace control; (2) Settings; (3) Workspace invites. | Standard Plane redactions described above. |
| [10-your-work.png](images/10-your-work.png) | Plane CE v1.4.2 `/gitsync-test/profile/6a57833d-4e43-49be-924c-f093cddfae76/assigned/` | Your work: (1) Assigned category; (2) matching item WEB-42; (3) Display controls. | Standard Plane redactions described above. |
| [11-command-palette.png](images/11-command-palette.png) | Plane CE v1.4.2 `/gitsync-test/` | Command palette: (1) search field; (2) a creation action in the results. | Standard Plane redactions described above. |
| [12-work-items-list.png](images/12-work-items-list.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | List layout: (1) project navigation; (2) layout buttons; (3) filter button; (4) Add work item. | Standard Plane redactions described above. |
| [13-keyboard-shortcuts.png](images/13-keyboard-shortcuts.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Keyboard shortcuts: (1) Work item actions category; (2) action labels with their adjacent keys. | Standard Plane redactions described above. |
| [14-board.png](images/14-board.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | Board layout: (1) state columns; (2) work item cards; (3) layout selector. | Standard Plane redactions described above. |
| [15-calendar.png](images/15-calendar.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | Calendar: (1) displayed month; (2) WEB-42 on its due date; (3) calendar layout button. | Standard Plane redactions described above. |
| [16-spreadsheet.png](images/16-spreadsheet.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | Spreadsheet: (1) WEB-42 row; (2) state cell; (3) spreadsheet layout button. | Standard Plane redactions described above. |
| [17-gantt.png](images/17-gantt.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | Gantt: (1) time scale; (2) dated work-item bar; (3) Gantt layout button. | Standard Plane redactions described above. |
| [18-work-item.png](images/18-work-item.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | WEB-42: (1) title and identifier; (2) description; (3) properties; (4) sub-work items. | Standard Plane redactions described above. |
| [19-state-selector.png](images/19-state-selector.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | State: (1) current state control; (2) In Review among the project choices. | Standard Plane redactions described above. |
| [20-priority.png](images/20-priority.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Priority: (1) current priority; (2) Urgent among the available priorities. | Standard Plane redactions described above. |
| [21-relations.png](images/21-relations.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Relations: (1) Add relation; (2) Blocked by, alongside Relates to, Duplicate of and Blocking. | Standard Plane redactions described above. |
| [22-add-link.png](images/22-add-link.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Add link: (1) URL field; (2) display-title field; (3) Add Link. | Standard Plane redactions described above. |
| [23-description-editor.png](images/23-description-editor.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Description: (1) customer problem; (2) acceptance criteria. | Standard Plane redactions described above. |
| [24-comment-editor.png](images/24-comment-editor.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Comment editor: (1) write the update; (2) Comment submits it. | Standard Plane redactions described above. |
| [25-display-options.png](images/25-display-options.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | Display: (1) visible properties; (2) Group by; (3) Show sub-work items. Ordering is also in this menu. | Standard Plane redactions described above. |
| [26-filters.png](images/26-filters.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | Filters: (1) search field; (2) available property categories. Choose a category to select its values. | Standard Plane redactions described above. |
| [27-create-work-item.png](images/27-create-work-item.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | Create a work item: (1) title; (2) description; (3) properties; (4) Save. | Standard Plane redactions described above. |
| [28-save-draft.png](images/28-save-draft.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | Unfinished item: (1) Save to Drafts preserves the writing; (2) Discard removes it. | Standard Plane redactions described above. |
| [29-drafts.png](images/29-drafts.png) | Plane CE v1.4.2 `/gitsync-test/drafts/` | Drafts: (1) the saved unfinished item. Open it to continue editing. | Standard Plane redactions described above. |
| [30-quick-add.png](images/30-quick-add.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | Quick add: (1) inline title input. Enter submits; Escape cancels. | Standard Plane redactions described above. |
| [31-assignees-labels.png](images/31-assignees-labels.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Labels: (1) Add labels; (2) accessibility in the project label choices. | Standard Plane redactions described above. |
| [32-date-selector.png](images/32-date-selector.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Due date: (1) month selector; (2) selected day, 21 October. | Standard Plane redactions described above. |
| [33-attachment.png](images/33-attachment.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Attachment: (1) uploaded checkout-layout-example.png; (2) attachment section. | Standard Plane redactions described above. |
| [34-item-actions.png](images/34-item-actions.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Item menu: (1) menu button; (2) archive availability; (3) Delete. | Standard Plane redactions described above. |
| [35-start-work.png](images/35-start-work.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Starting work: (1) In Progress state; (2) assigned developer; (3) acceptance criteria. | Standard Plane redactions described above. |
| [36-cycles.png](images/36-cycles.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/cycles/` | Cycles: (1) cycle name; (2) scheduled date range. | Standard Plane redactions described above. |
| [37-cycle-detail.png](images/37-cycle-detail.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/cycles/bd567583-6209-4a5c-ab61-5aec9d084d14/` | Inside a cycle: (1) included work items; (2) dates and progress. | Standard Plane redactions described above. |
| [38-modules.png](images/38-modules.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/modules/` | Modules: (1) Checkout experience; (2) In Progress status. | Standard Plane redactions described above. |
| [39-module-detail.png](images/39-module-detail.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/modules/8c2ca61e-b9f6-4686-b5ea-529f2047c5c4/` | Inside a module: (1) included work items; (2) module properties and progress. | Standard Plane redactions described above. |
| [40-pages.png](images/40-pages.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/pages/` | Pages: (1) the shared working agreement; (2) Add page. | Standard Plane redactions described above. |
| [41-page-document.png](images/41-page-document.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/pages/d418c5cd-774d-478a-bddc-2673859c1720/` | Shared page: (1) document title; (2) review checklist. | Standard Plane redactions described above. |
| [42-saved-views.png](images/42-saved-views.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/views/` | Project Views: (1) Website delivery overview; (2) Add view creates another saved selection. | Standard Plane redactions described above. |
| [43-intake.png](images/43-intake.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/intake/` | Intake: (1) pending request WEB-43; (2) report title; (3) Accept action. | Standard Plane redactions described above. |
| [44-estimates.png](images/44-estimates.png) | Plane CE v1.4.2 `/gitsync-test/settings/projects/bb57e81d-c161-441f-b50e-907af28f08c2/estimates/` | Estimates: (1) project enable control; (2) configured Fibonacci Points scale. Administrator view. | Standard Plane redactions described above. |
| [45-github-branches.png](images/45-github-branches.png) | GitHub public page `/nathanabay/gitsync-test/branches` | Real GitHub branches: (1) web-42-checkout-button; (2) Check status column. The branch row also links PR #117. | Standard GitHub redactions described above. |
| [46-github-pr-open.png](images/46-github-pr-open.png) | GitHub public page `/nathanabay/gitsync-test/pull/117` | Real PR #117: (1) title; (2) feature branch targeting main; (3) Closes WEB-42. | Standard GitHub redactions described above. |
| [47-github-smart-commit.png](images/47-github-smart-commit.png) | GitHub public page `/nathanabay/gitsync-test/commit/045a3f6485c477ab60c392a653704c0e0d68f3ba` | Real GitHub commit: (1) author and commit time; (2) Smart Commit message; (3) changed demonstration file. | Standard GitHub redactions described above. |
| [48-github-review.png](images/48-github-review.png) | GitHub public page `/nathanabay/gitsync-test/pull/117` | Real COMMENTED review: (1) walkthrough review text; (2) author identity on the review. This is not independent approval. | Standard GitHub redactions described above. |
| [50-project-states.png](images/50-project-states.png) | Plane CE v1.4.2 `/gitsync-test/settings/projects/bb57e81d-c161-441f-b50e-907af28f08c2/states/` | Project states: (1) Started group; (2) In Review state in that group. Administrator view. | Standard Plane redactions described above. |
| [51-project-analytics.png](images/51-project-analytics.png) | Plane CE v1.4.2 `/gitsync-test/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/` | Project analytics: (1) total work-item summary; (2) Created vs Resolved chart. | Standard Plane redactions described above. |
| [52-inbox.png](images/52-inbox.png) | Plane CE v1.4.2 `/gitsync-test/notifications/` | Inbox: (1) All category; (2) Sam’s comment notification; (3) Mentions category. | Standard Plane redactions described above. |
| [53-personal-github.png](images/53-personal-github.png) | Git Sync member UI `/git-sync/ui/workspaces/gitsync-test/account` | Personal GitHub account: (1) member account tab; (2) current connection status; (3) Connect personal account. | Standard Plane redactions described above. |
| [54-relation-picker.png](images/54-relation-picker.png) | Plane CE v1.4.2 `/gitsync-test/browse/WEB-42/` | Choose a related item: (1) search by identifier; (2) selected result; (3) Add selected work items. | Standard Plane redactions described above. |

## SVG provenance

The eight `diagram-*.svg` files were drawn directly for this handbook. They explain tool boundaries, the first day, work-item information, state groups, planning containers, reference tiers, durable delivery and the review loop. They contain only fictional examples and no captured account data.

## Visual and build verification

The final content build contains **139 A4 pages**, **29,344 words**, **55 embedded raster-image placements**, **53 PNG screenshot files**, **eight SVG diagrams** and all **45 acceptance topics**. The supplied, unmodified `node scripts/verify-handbook.mjs` printed `HANDBOOK VERIFIED` with those measurements. The PDF is tagged and has an outline plus clickable contents. The build checks found no vertical overflow, horizontal image/table/code overflow or trailing orphan headings.

Rendered all 139 pages with `pdftoppm -r 50 -png` and visually viewed every page in numbered contact sheets (pages 1–12, 13–24, 25–36, 37–48, 49–60, 61–72, 73–84, 85–96, 97–108, 109–120, 121–132 and 133–139). The first-day checklist is one page (6); the printable cheat sheet is one page (139). Table continuations repeat their column headers, images and captions remain together, and no blank, cut or overflowing pages remain. Earlier review found a trailing troubleshooting heading and clipped screenshot callouts; those were corrected before this final render.

Visually inspected every one of the 53 PNGs for safe content and agreement with its caption, including the final replacements. Visually inspected all eight SVGs. Capture captions and the provenance table above were synchronized from the last capture record for each file. The final notes-only rebuild uses identical paginated body HTML to the reviewed render.

The final read-only connection recheck still returned an empty installation list and empty repository mapping list. Credentials were readable, but the setup check could not read the App registration and still had no verified GitHub transport delivery. Plane delivery was recorded. The real Smart Commit/linked Development/review/merge-to-Done flow was not verified, and the owner explicitly removed that flow from the final scope. Screenshots and source-based explanations must not be mistaken for verified live sync. No further PR or integration changes were attempted.


## Final callout recapture — 15 October 2026

The owner requested only a callout correction and retained the existing handbook content. Restarted the browser server to load the driver's updated `scripts/capture-handbook.mjs`, then re-captured **all 53 PNGs with numbered callouts** from the same Plane/GitHub pages, using the existing fictional records, captions, redactions and crop dimensions. The four public GitHub pages (45–48) were captured first, within the owner's temporary public window, through an unsigned-in browser. This pass made no GitHub write, review, merge, visibility or settings change.

Badges and leader lines sit outside their targets. Placement also checks neighboring text, text still visible through dimmed dialog backgrounds, crop boundaries and settled UI geometry. A few packed controls use a short vertical leader in clear space above or below the control. Every final replacement PNG was visually inspected; no callout covers readable text and no secret, personal email, network address or personal avatar is visible. Public owner/repository/PR handles remain as explicitly authorized. The sign-in placeholder is Plane's generic placeholder, not an account address.

The invitation had already been accepted, Website had already been joined, and WEB-41 was already related to WEB-42. To re-present those original capture states without changing server data, the capture browser alone previewed the original onboarding flags/invitation card for the same fictional member/workspace (01), Website's unjoined presentation flag (05), and the existing WEB-41 search result without its already-related exclusion (54). These were browser-only read-response previews of the existing demo records, not new accounts, invitations, memberships or relations. No confirmation that would save those actions was submitted. Creation and quick-add fields were filled only for capture and discarded; no additional item, draft, link, attachment or comment was saved. Normal viewing updated recents/read indicators and temporary presentation preferences; the Website layout was returned to Board, its starting layout.

All 16 chapter source files and their captions remain byte-for-byte unchanged. All 53 PNGs differ from the pre-correction files while retaining their original pixel dimensions. The PDF was rebuilt with the replacement images and checked with the supplied, unmodified verifier. The revised scope is complete without the excluded live merge flow.
