# 00 · Introduction

Your team keeps its plans in **Plane** and its code in **GitHub**. **git-sync** is the service that connects the two. It reads Plane work-item keys such as `WEB-42` in branches, pull requests and commits. It then adds development links to the work item, moves it through the workflow your team configured, and can mirror issues between the two tools.

This manual explains how to use all three together, from your first sign-in to your next merged pull request. It also explains how administrators install and run git-sync.

![Diagram: Plane holds tasks, GitHub holds code, and git-sync connects them through identifiers and events.](../diagrams/diagram-system.svg)

## Who this manual is for

*Part A — Developer guide (chapters 1–19)* is written for a developer who has just joined a team that uses Plane for tasks and GitHub for code. You do not need to install anything on a server. After reading Part A you should be able to do all of the following without asking anyone:

- Understand Plane's building blocks (workspace, project, work item, cycle, module, view, page, intake) and what git-sync adds to them.
- Sign in, set up your profile and find and work on your tasks every day.
- Connect your personal GitHub account, and tell apart the four different "connections" git-sync uses.
- Link branches, commits and pull requests to work items, use magic words and Smart Commits correctly, and read the **Development** panel.
- Know exactly what synchronizes, in which direction, and what never does.
- Fix common problems yourself, and send an administrator a report they can act on.

*Part B — Admin guide (chapters 20–30)* is for workspace administrators and instance (God mode) administrators. It covers installation, registering the GitHub App, mapping repositories, rules and conflict policies, user links, sync health, the audit log and day-to-day operations.

The *appendices* are reference material: every route, setting and environment variable; the exact grammar of references, magic words and Smart Commits, with valid and invalid examples; the full rule reference; known limitations; and the exact version this manual describes.

## How to read it

If you are new, read chapters 1–3 before you change anything. Then read chapter 8 (connections and your GitHub account) and chapter 15 (a day in the life), which shows the whole loop end to end with one screenshot per step. Use the other chapters as reference when you need them.

If you already know Plane, skip to chapter 8. If you only need a reminder, use the one-page cheat sheet in chapter 19. It is also built as a separate printable PDF.

Most procedures follow the same pattern:

- **Goal** — what you will achieve.
- **Before you start** — what must already be true, such as your role or an existing mapping.
- **Steps** — numbered actions. Where a screenshot has orange numbered badges (callouts), the step numbers match the badges.
- **Result** — what you should see, usually with a screenshot.
- **If it went wrong** — the common symptoms, their causes and their fixes.

Boxes highlight special information:

> **Tip:** a useful habit or shortcut.

> **Note:** extra detail that helps you understand a behavior.

> **Warning:** a consequence to think about before you continue.

> **Example:** sample wording or a worked scenario.

> **Admin only:** a step that needs a workspace or instance administrator.

On-screen labels are shown in **bold** exactly as they appear, for example **Workspace settings → GitHub Sync**. Keys, branch names, commands and file paths are shown in `code`. Every chapter ends with **What you learned**, a short summary, and **Source files**, a list of the repository files that implement the behavior. Source files are there for maintainers and curious readers; you do not need to open them.

## The example team

All examples use one fictional team. Names, addresses and data are invented.

| Thing | Name in this manual |
|---|---|
| Plane workspace | **Acme** (address slug `acme`) |
| Plane project | **Website**, identifier `WEB` |
| Example work item | `WEB-42` *Make the checkout button visible on small screens* |
| GitHub repository | `acme/website` |
| Developer | Alex Developer (GitHub `alex-dev`) |
| Reviewer | Sam Reviewer (GitHub `sam-reviews`) |
| Workspace administrator | Jordan Admin (GitHub `jordan-acme`) |
| A brand-new member | Riley New (not yet connected to GitHub) |
| Plane address | `plane.example.com` |

## About the screenshots

The manual uses three kinds of figures. The caption always tells you which kind you are looking at.

**Screenshot (test Plane)** and **Screenshot (GitHub)** are real browser captures made for the earlier developer handbook, on a running Plane Community Edition v1.4.2 test instance and on GitHub. They show Plane's own screens: sign-in, profile, work items, layouts, cycles, modules, pages, intake and the inbox. Visible addresses, emails and unrelated test data were replaced with the fictional values above before capture; the underlying records were not changed.

**Screenshot (demo instance)** figures show git-sync's own pages: the **Development** panel, **My GitHub account**, the workspace **Git sync** settings and God mode's **Git sync: instance settings**. No signed-in browser sessions for the test system were available for this edition. These pages were therefore captured from a *demo instance*: the real git-sync service and the real git-sync user interface, built from this repository and run locally on a throwaway database. The demo data was produced by feeding realistic GitHub and Plane webhook events through git-sync's real webhook endpoints, handlers, rules and write paths. Only Plane's and GitHub's APIs were replaced by small stand-ins that answer the way those services do. The screens, labels, badges, states, error messages and audit entries are what the code really produces. The demo instance shows the git-sync pages on their own, outside Plane's surrounding window. In a real installation, administrators see the same pages embedded in Plane's settings, and members see the Development panel inside the work item's sidebar.

**Diagram** and **Illustration** figures are drawings. A diagram explains a flow or a concept. An illustration is a drawing of a screen we could not capture, such as GitHub's App registration form; it is never presented as a screenshot.

Some places show a marker like this:

<div class="placeholder sample"><strong>Screenshot needed</strong> — example: a real capture that is still owed. Capture later with <code>npm run manual:capture -- --only &lt;id&gt;</code>.</div>

A marker means a real screenshot of that exact screen is still owed, usually because it needs a signed-in GitHub or Plane browser session. The text around the marker still describes the behavior accurately from the code and the demo run. Administrators can capture the missing images later with the command shown in the marker.

Orange numbered badges in a screenshot point at the controls discussed in its caption and steps. They were added to the image; they are not part of the product.

## Version

This manual describes *git-sync 0.1.0* running with **Plane Community Edition v1.4.2** and the patched Plane web and admin images that git-sync's installer builds. The exact repository commit is printed on the cover and in Appendix F. Where older documentation disagrees with the code, this manual follows the code. The differences are listed in Appendix E.

> **Note:** Plane Community Edition has no built-in GitHub integration; that feature is part of Plane's commercial editions. git-sync is a separate, self-hosted service that adds one to Community Edition. When this manual says "git-sync does X", it means this service, not a feature of Plane itself.

## What you learned

- Part A is for developers using Plane and GitHub every day; Part B is for administrators; the appendices are reference.
- Procedures follow Goal → Before you start → Steps → Result → If it went wrong, and step numbers match the orange callouts.
- Figures are real test-Plane/GitHub captures, demo-instance captures of git-sync's real UI, or labelled drawings.
- A `[[SCREENSHOT NEEDED]]` marker shows a capture that is still owed; the text beside it is still accurate.

## Source files

- `package.json` (git-sync version)
- `src/ui/client/` (the git-sync pages shown in demo-instance screenshots)
- `manual/demo/server.ts`, `manual/demo/seed.ts`, `manual/demo/events.ts` (the demo instance)
- `docs/handbook/HANDBOOK_NOTES.md` (provenance of the test-Plane screenshots)
