# Automated end-to-end suite (two authors)

Goal: a re-runnable suite that drives the **real** test Plane v1.4.2 and the **real** GitHub App, with
many scenarios, each self-contained and reported PASS / FAIL / SKIP with evidence. It replaces the
manual run recorded in `docs/impl/e2e-results.md` (read it: it shows every call that worked).

## Hard rules

- **Test environment only.** The harness refuses to start unless the Plane URL is
  `http://100.85.50.109:8090` or a loopback address, and the repository is `nathanabay/gitsync-test`.
  Never touch the live Plane (tasks.qelal.et) or any other repository.
- Lives in `scripts/e2e/` (NOT `tests/`, so the unit runner never picks it up). Plain Node ESM `.mjs`.
- Every object a scenario creates carries the run id in its title or name (`[e2e <runId>] …`) and is
  cleaned up at the end (close issues and PRs, delete branches, delete Plane items) unless
  `--keep` is passed. Scenarios must not depend on each other's leftovers.
- Poll, never fixed sleeps: `waitFor` with a timeout (default 120 s; webhooks go through smee.io).
- Use Context7 (find-docs / `npx ctx7@latest`) for GitHub and Plane API details, and the
  security-audit skill's guidance when writing the security scenarios. Never print tokens.
- Do not edit `src/` or `tests/`. G4 and G5 are fixing E2E-1 and E2E-2; scenarios for those may fail
  until the build is redeployed. Report that as a known FAIL with the defect id, not as a skip.
- Run only your own scenarios, one at a time (`--only`), against the deployed build. Never stage,
  commit or push.

## Harness API (`scripts/e2e/lib.mjs`, G3 writes it first; G1 codes against this contract)

```js
export const cfg;                          // planeUrl, slug "gitsync-test", projectId (GITSY
                                           // 972d93a8-6889-46b8-9b47-93f9e7546afb), projectKey "GITSY",
                                           // mappingId 1, repo "nathanabay/gitsync-test", runId
export async function gh(method, path, body?)      // GitHub REST as the user (token from `gh auth token`);
                                                   // returns { status, data }
export async function plane(method, path, body?)   // Plane v1 API with the admin key from
                                                   // ~/plane-test/git-sync/.admin-pat; path relative to
                                                   // /api/v1/workspaces/<slug>; returns { status, data }
export async function sql(query, params?)          // gitsync DB via `docker --context rootless exec
                                                   // plane-test-plane-db-1 psql`; returns rows as objects
export async function planeOrm(pythonSnippet)      // Django shell in plane-test-api-1; returns stdout
export async function app(scriptBody)              // runs a Node snippet inside plane-test-git-sync-1 with the
                                                   // service's config, db and App credentials in scope
                                                   // (as e2e-results used for redelivery and reconcile)
export async function web(calls, { admin? })       // headless Chromium (Playwright image) logged in to the
                                                   // Plane web app (or God mode when admin); runs
                                                   // [[method, path, body?], …] as that session and can take
                                                   // screenshots; returns results
export async function waitFor(check, { timeout, interval, label })
export function scenario(id, title, fn, { needs? }) // registry; fn gets { log, evidence, cleanup(fn), skip(reason) }
export const name = (s) => `[e2e ${cfg.runId}] ${s}`;
```

Runner `scripts/e2e/run.mjs [--only S01,S14] [--keep] [--list]`: loads every `scripts/e2e/scenarios/*.mjs`,
runs scenarios sequentially in id order, enforces a per-scenario timeout, runs cleanups, and writes
`docs/impl/e2e-runs/<runId>.md` (table + evidence) and `.json`. Exit code non-zero on any FAIL.

## Scenarios (aim for all; add more where useful)

**G3: `scenarios/01-setup.mjs`, `02-security.mjs`, `03-mirror.mjs`**
- S01 health endpoint; S02 setup checklist items and statuses; S03 workspace health card data; S04 instance health
- S05 forged GitHub signature → 401; S06 missing signature → 401; S07 forged Plane signature → 401;
  S08 oversized webhook body → 413; S09 config API without a session → 401; S10 cross-origin and non-JSON
  writes → 403/415; S11 S1 traversal rule (plain and encoded) → 422 and nothing stored; S12 a non-admin cannot
  reach admin or another workspace's routes; S13 static file path traversal refused
- S14 GitHub issue with `plane` label → Plane item, mention component, issue-reference links, table kept,
  code literal, one cross-link each side; S15 Plane item with `github` label → GitHub issue, cross-linked;
  S16 GitHub title edit → Plane; S17 GitHub description edit → Plane; S18 Plane title edit not applied
  (source_of_truth github); S19 GitHub assignee (mapped user) → Plane assignee; S20 label add/remove both
  ways; S21 GitHub comment → Plane, attributed; S22 Plane comment → GitHub as the linked user; S23 GitHub
  close and reopen → Plane completed/unstarted; S24 Plane cancelled → GitHub closed not_planned;
  S25 two rapid GitHub title edits → final value wins; S26 an unlabelled issue is not mirrored;
  S27 echo safety: after each mirror, outbound write counts settle (no loop)

**G1: `scenarios/04-dev.mjs`, `05-smartcommit.mjs`, `06-reports.mjs`, `07-resilience.mjs`, `08-ui.mjs`**
- S28 Development panel data and branch-name template; S29 Create branch from the panel (201, branch exists,
  idempotent second call); S30 a pushed branch named after the key links the item and moves it to In
  Progress; S31 draft PR "Fixes KEY" → In Progress and one linkback comment; S32 ready + merge → Done and
  rollup MERGED; S33 PR closed unmerged → the closed_unmerged rule; S34 "Ref KEY" links without a state
  change; S35 `skip KEY` / `ignore KEY` not linked; S36 `GITSY-NEW` in a PR creates a new item;
  S37 a commit status (user token, `POST /repos/{owner}/{repo}/statuses/{sha}`) → CI rollup on the item
- S38 Smart Commit `#comment`; S39 Smart Commit transition `#done`; S40 Smart Commit applied once on
  redelivery; S41 Smart Commit with an unknown transition is rejected and audited
- S42 PR with an unknown key → one report comment (needs report_problems; set it through the API once
  E2E-1 is fixed, else mark the known FAIL); S43 bad Smart Commit → one commit comment; S44 report edited
  in place, not duplicated; S45 reports off → nothing posted
- S46 real GitHub redelivery has no second effect; S47 deleted Plane item → orphaned on the first sweep,
  GitHub issue untouched; S48 archived Plane item stays linked across two sweeps (E2E-2; known FAIL until
  fixed); S49 backfill links an existing PR that references a key
- S50 God mode GitHub Sync page renders with the sidebar entry (screenshot); S51 workspace GitHub Sync page
  renders the settings app at full height; S52 the Development panel renders on a work item (screenshot)

## When done

Report in `docs/impl/e2e-suite-<you>.md`: how to run, every scenario with its last result, and any scenario
you could not automate and why. Reply `<YOU> E2E SUITE DONE: <n> scenarios, <pass>/<fail>/<skip>`.
