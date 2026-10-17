# Demo data

## Why a local demo instance

The brief expected saved browser sessions (`manual/.auth/*.json`), a `manual/.env` with a demo Plane PAT and a scoped GitHub
token, and a working test GitHub App. None of these existed when the run started; `gh` was not logged in and
`nathanabay/gitsync-test` answered 404 (private). Signing in or creating credentials was not allowed, and the owner said
during the run that Plane containers are read-only. So no data was created in Plane workspace `gitsync-test` or in the
GitHub repository.

Instead, the new screenshots come from a **local demo instance**: `manual/demo/server.ts` runs the real git-sync service
code (`composeRoutes()` — the config API, Development panel API, OAuth/install callbacks, signed webhook ingress and the
built React UI — plus the real reducers, rule engine, Smart Commit processor, mirror and ordered outbox) on a throwaway
in-memory PGlite database. Only the two network edges are stand-ins: a small in-memory Plane (session endpoints for the UI
and `/api/v1` for the service) and an in-memory GitHub behind a fake Octokit / `fetch`. Every state shown in the
screenshots was produced by the real code reacting to realistic webhook deliveries.

## What it contains

| Thing | Demo value |
|---|---|
| Workspace | `acme` (display "Acme"); second workspace `beta` ("Beta Labs", nothing configured) |
| Projects | Website `WEB` (WEB-1…WEB-45, WEB-43 left out as the handbook's intake request), Public API `API`, Design system `DES` (no mapping) |
| States | Backlog, Todo, In Progress, In Review, In QA (started), Done, Cancelled, Triage |
| Labels | frontend, bug, accessibility, documentation, github, plane, backend |
| People (Plane / GitHub) | Jordan Admin `jordan-acme` (workspace admin, instance admin), Alex Developer `alex-dev`, Sam Reviewer `sam-reviews`, Riley New (not connected), git-sync bot (service user) |
| GitHub | org `acme`, repos `acme/website` (id 812345678) and `acme/public-api`, App `acme-git-sync`, installation 51234567 |
| Mappings | `acme/website` ↔ WEB two-way, Smart Commits, link-back, report problems; `acme/public-api` ↔ API GitHub to Plane only |
| Rules | v1 = shipped lifecycle table, v2 = + branch-aware rule "merged into `^staging$` → started:In QA" |
| Conflict policies | defaults, except Labels = Plane is the source of truth |
| User links | Jordan and Alex through the real OAuth callback; Sam linked manually by the admin |

Scenario events (`manual/demo/events.ts`): multi-key Smart Commit (WEB-33/34), malformed `#time 3x` and unknown state
`#shipped` (WEB-35), unknown key WEB-999, `Refs WEB-41`, `Relates to WEB-40`, `WEB-NEW` (→ WEB-46), failing check (WEB-37),
merge guard with two PRs (WEB-36), merge into `staging` (WEB-39 → In QA), GitHub issue #131 labelled `plane` (→ WEB-47)
with a comment that mentions `@alex-dev`, Plane WEB-44 labelled `github` (→ GitHub issue #120), and the full WEB-42 day
(branch → push with `#comment`/`#time` → draft PR → CI → preview deployment → ready → review requested → changes requested
→ fix → approved → merged → Done). Failure states for health/audit shots are produced through the real code paths:
a GitHub 403 rate-limit response, an `installation_repositories` "removed" delivery, a Plane 400 on one write, a missing App
webhook event, and an undecryptable stored App key.

Verbatim outputs: `manual/notes/demo-output/README.md` (states, Plane comments, links, GitHub comments) and `dialogs.md`.

## Run, reset, undo

```sh
npm run manual:seed          # start + seed on 127.0.0.1:3199 (log: manual/reports/demo-server.log)
PORT=3198 sh manual/demo/run-loop.sh   # replay the WEB-42 day on another instance and print the state after each step
npm run manual:capture       # restarts the server, then captures every shot in manual/storyboard-new.yaml
```

Everything lives in the server process; stopping it (`kill` the process listening on the port) removes all demo data.
There is nothing to undo anywhere else: no Plane, GitHub, Docker container or file outside `manual/` was changed.

## When real sessions become available

Put the storageState files in `manual/.auth/` and `manual/.env` as described in the brief, then capture the placeholders
listed in `manual/REVIEW_NOTES.md` ("Blocked items"). The demo-instance screenshots can stay: they show the same UI code.
