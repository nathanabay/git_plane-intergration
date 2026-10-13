# Parity wave 1 — G1

Scope: C8 pure host derivation and N7 setup documentation. Owns `src/github/hosts.ts`, `src/config/env.ts`, `deploy/APPLY.md`, `apps/README.md`, `deploy/git-sync.env.example`, `tests/github/parity-g1.test.ts`, and this report.

Acceptance recorded before implementation using the unlazy skill. The driver's file ownership and typecheck-only instructions override creating an additional gates file or running gate scripts.

- [x] Derive API/web hosts for GitHub.com, Enterprise Cloud on ghe.com, and Enterprise Server.
- [x] Build OAuth and App installation URLs from the selected web origin; keep service callback paths consistent with C0.
- [x] Reject malformed/conflicting edition inputs and preserve the legacy Enterprise API URL bootstrap.
- [x] Add optional client ID/secret/App slug and edition bootstrap configuration without exposing secrets in errors.
- [x] Document the exact required App permissions and events, both callbacks and App setup options, and the new environment variables in the owned docs.
- [x] Write regression tests for every host edition, URL derivation, invalid inputs, and bootstrap compatibility; do not execute them.
- [x] Complete the scoped typecheck and record Context7 library IDs for all relied-on API facts, plus wave 2 integration handoffs.

## C8 — pure host and URL derivation

`src/github/hosts.ts:2` exports `GithubEdition = "github" | "ghe_cloud" | "ghes"`, `GithubHostInput`, and `GithubHosts`. `deriveGithubHosts(input)` (`:53`) returns the edition, REST API base, web origin, OAuth authorization URL and OAuth access-token URL. GitHub.com is the default; Cloud derives `api.<sub>.ghe.com` / `<sub>.ghe.com`; Server derives `<origin>/api/v3` / `<origin>`. Server ports survive normalization and an existing `/api/v3` suffix is never appended twice.

`githubAppInstallUrl(hosts, appSlug, state?)` (`:92`) puts installation links on the chosen web host and encodes opaque state as one query parameter. Signing and verifying state belongs to the wave 2 flow. `githubServiceUrls(publicOrigin)` (`:100`) returns the C0 OAuth/install callback paths plus the existing webhook path on the service origin, independently of the GitHub edition.

Local validation rejects unknown editions, malformed/multi-label Cloud subdomains, non-HTTPS GitHub bases, embedded credentials, query/fragment/path injection, and disagreement between explicit host settings and the legacy API URL. Cloud domains cannot be mistaken for Server domains. Service callbacks accept HTTP(S) origins for local development. These are local configuration constraints, not claims about extra GitHub API requirements.

## C0/C8 — environment bootstrap

`src/config/env.ts:30` adds optional `GITHUB_EDITION`, `GITHUB_GHE_SUBDOMAIN`, `GITHUB_GHES_BASE_URL`, derived `GITHUB_WEB_ORIGIN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_APP_SLUG`. `loadConfig` (`:88`) uses the pure host module. A legacy API-only bootstrap infers the edition/web host. GitHub.com's existing unset API-base default is preserved; Enterprise bootstraps populate the existing `GITHUB_API_BASE_URL` consumed by the credential source. Conflicting hosts fail startup instead of silently selecting a different edition.

OAuth client ID/secret are optional together, with a safe App-slug path check. Startup errors contain field names and generic validation descriptions rather than credential values. `deploy/git-sync.env.example:32` documents the OAuth bootstrap; `:61` documents all editions, legacy compatibility and the derived web-origin output. The stale comment describing the required Plane service-user ID as optional was corrected.

These additions parse bootstrap values; persisting/reading encrypted OAuth credentials and stored host settings remains the wave 2 credential owner's work. This wave changes no App authentication, OAuth callback handler or browser credential response.

## N7 — exact setup documentation

`deploy/APPLY.md:56` and `apps/README.md:32` document the permission set, including **Commit statuses: Read**, separate Checks: Read, Metadata: Read, Organization Members: Read, and conditional Repository Administration: Read & write for autolinks. The contents/pull-request/issues grants retain Read & write. The previously incorrect “Write-only” Administration wording is fixed.

`deploy/APPLY.md:78` and `apps/README.md:50` list the nine actual reducer subscriptions: `pull_request`, `pull_request_review`, `push`, `issues`, `issue_comment`, `check_suite`, `check_run`, `status`, `deployment_status`. Installation/repository-access events are explicitly described as automatic. Read-only Checks does not promise suite requested/rerequested actions. Subscription inventory was compared with `src/app/reducers.ts`, read without editing it.

`deploy/APPLY.md:92` and `apps/README.md:68` document the C0 callback/setup paths, enable `setup_on_update`, leave `request_oauth_on_install` off, distinguish Client ID from App ID, and explain when to activate the wave 2 callbacks. Both docs contain the edition/host matrix and environment names. `deploy/APPLY.md:259` adds manual registration/grant verification using `GET /app` and the installation's actual permissions. The live in-product setup checklist remains wave 2 scope as specified by the brief.

## Context7 API evidence

Applied `$HOME/.claude/skills/find-docs/SKILL.md`. Library resolution was performed with `npx ctx7@latest library GitHub "GitHub Enterprise Cloud ghe.com REST API base URLs and GitHub App setup callback configuration"`, `library "GitHub REST API" "GitHub App repository permissions webhook events statuses autolinks git refs checks deployments"`, and `library Node.js "WHATWG URL origin searchParams and node:test node:assert strict regression tests"`. Selected IDs were `/websites/github_en`, `/websites/github_en_rest`, `/github/docs`, and `/nodejs/node`; an additional resolved OpenAPI schema ID is recorded below. Documentation was queried with `npx ctx7@latest docs <id> "<specific behavior>"`. No API behavior was answered from memory.

| API fact used | Context7 library ID | Supporting source |
| --- | --- | --- |
| GitHub.com REST base is `https://api.github.com`; its browser origin is `https://github.com`. | `/websites/github_en` | [App URLs across GitHub products](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/making-your-github-app-available-for-github-enterprise-server) |
| Enterprise Cloud data residency uses `<sub>.ghe.com` for web and `api.<sub>.ghe.com` for REST, without `/api/v3`. | `/websites/github_en` | [Product domains](https://docs.github.com/en/get-started/learning-about-github/about-versions-of-github-docs), [migration API-base example](https://docs.github.com/en/migrations/using-github-enterprise-importer/migrating-between-github-products/migrating-organizations-from-githubcom-to-github-enterprise-cloud) |
| GHES REST uses `https://HOSTNAME/api/v3`; OAuth endpoints use HOSTNAME; the App must be registered on that Server. | `/websites/github_en` | [GHES App URLs and registration](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/making-your-github-app-available-for-github-enterprise-server) |
| Browser authorization and token exchange use `/login/oauth/authorize` and `/login/oauth/access_token`; user-token exchange requires Client ID/secret. | `/websites/github_en` | [GitHub App authorization example](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app) |
| Installation link path is `/apps/<app-slug>/installations/new`. | `/websites/github_en` | [Installation links](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/migrating-oauth-apps-to-github-apps) |
| OAuth callback and post-install Setup URL have distinct purposes; `setup_on_update` redirects after installation updates; OAuth-on-install makes Setup URL unavailable. | `/websites/github_en` | [App registration settings](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app-using-url-parameters) |
| Repository grant categories/levels in the runbook correspond to issue/PR writes, content/refs, checks, statuses, deployments and repository metadata; Organization Members has read access; autolink management uses repository Administration write. | `/websites/github_en_rest`, `/github/docs` | [Permission table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), [autolinks](https://docs.github.com/en/rest/repos/autolinks), [granular grants](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps) |
| Adding App permissions requires installation/user approval, subject to enterprise-owned App acceptance rules. | `/github/docs` | [Changing permissions](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration) |
| The selected event names are documented webhook events; installation and installation-repository events are automatic. | `/websites/github_en` | [Webhook reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads) |
| `status` requires Commit statuses Read; deployment status requires Deployments Read; suite completions use Checks Read while requested/rerequested require Write. | `/websites/github_en`, `/websites/github_en_rest` | [Webhook permissions](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [combined status endpoint](https://docs.github.com/en/rest/commits/statuses) |
| App-JWT `GET /app` returns `permissions`, `events`, `slug` and `client_id`; installation endpoints expose installation grants. | `/websites/github_en_rest` | [App API](https://docs.github.com/en/rest/apps/apps) |
| WHATWG URL exposes normalized origin and components; URLSearchParams encodes state; Node's test/assert APIs support the written regressions; `process.exit(1)` rejects invalid startup. | `/nodejs/node` | [URL API](https://github.com/nodejs/node/blob/main/doc/api/url.md), [assert API](https://github.com/nodejs/node/blob/main/doc/api/assert.md), [test API](https://github.com/nodejs/node/blob/main/doc/api/test.md), [process API](https://github.com/nodejs/node/blob/main/doc/api/process.md) |

Additional schema corroboration used Context7 `/openapi/raw_githubusercontent_github_rest-api-description_main_descriptions_api_github_com_api_github_com_json`: [App permission schema and autolink route](https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json). Some Context7 snippets omit exact permission-table rows; the linked GitHub permission/webhook references were followed to inspect those rows directly. This report does not infer write requirements from adjacent or unrelated permission categories.

No new Plane API behavior or Plane version assumption was introduced. Existing Plane delivery/rotation documentation was preserved; the service-user requirement correction comes from `loadConfig` rather than a Plane API claim. No Octokit, React or other third-party library was used or changed by this row.

## Regression coverage and validation

`tests/github/parity-g1.test.ts` contains **11 new tests**, written and typechecked but **not run**:

- `:13`, `:21`, `:29`: all three API/web/OAuth derivations, Cloud case normalization, Server port/trailing-slash behavior.
- `:39`, `:71`: legacy edition inference and agreement between explicit and old host settings.
- `:54`: malformed inputs, conflicting editions/hosts, invalid Cloud labels, credentials and URL path/query/fragment injection.
- `:78`, `:97`: installation paths/state encoding and unchanged service callback paths across editions.
- `:108`, `:121`, `:138`: environment defaults, optional OAuth bootstrap, Enterprise/legacy startup, and failures without credential logging.

Only check executed:

```text
node scripts/typecheck.mjs src/github/hosts.ts src/config/env.ts tests/github/parity-g1.test.ts
```

Result: `typecheck passed (3 project files)`. It was repeated after strengthening URL validation. Tests, gate commands, runtime probes and full-suite checks were not executed. Nothing was staged, committed or pushed. All edits remain within G1's wave 1 row plus this required report. Acceptance accounting: **7 met, 0 unmet, 0 abandoned**; runtime verification remains assigned to the driver.

## Driver / wave 2 integration handoffs

- Wire `deriveGithubHosts` into stored App credentials and the UI edition selector. Existing `ghe_base_url` stores an API URL; pass it as `apiBaseUrl` when inferring/validating legacy Cloud rows, and as `gheBaseUrl` (origin or old `/api/v3`) for Server rows. Use the returned web origin in the C7 converter, OAuth, App installation and any GitHub-profile links. The helper itself performs no credential persistence or network access.
- Consume optional Client ID/secret/App slug from the config into the migration-010 encrypted credential fields when no stored credential row takes precedence. Keep the existing bootstrap-retirement rules. Add the wave 2 callback handlers before enabling the documented redirects; apply the approved spec amendment before that UI work.
- **Exact migration change relayed to driver/G4 through commentary, outside G1 ownership:** migration 010's existing-row edition backfill currently classifies an explicitly stored `https://api.github.com` API base as `ghes`. Insert `WHEN lower(rtrim(ghe_base_url, '/')) = 'https://api.github.com' THEN 'github'` before its Cloud `WHEN`. The host module already infers that value as GitHub.com; the stored backfill should agree. G1 did not edit the migration.
- N7's live admin setup checklist is explicitly wave 2; the documentation prerequisites and manual verification instructions in this row are complete.
