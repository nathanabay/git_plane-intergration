# Parity wave 2 — G1

Scope: approved A1 C8 host/client/mirror wiring and N7 setup-check server. Owns `src/app/credentials.ts`, `src/app/github.ts`, `src/app/context.ts`, `src/app/issues.ts`, `src/ui/setup-check.ts`, `tests/github/parity2-g1.test.ts`, and this report.

Acceptance recorded before implementation (unlazy discipline within the driver's file ownership and typecheck-only rules):

- [x] Stored App edition/subdomain uses G4's reader and the pure host module; bootstrap retirement and credential secrecy stay intact.
- [x] All App/installation/public clients follow the active host and refresh after host changes; the context exposes the active web origin.
- [x] Every mirror entry/continuation receives the selected GitHub web origin.
- [x] Export a setup-check handler for G5: decryption, App-JWT permissions/events including statuses, genuine delivery timestamps, and honest Plane rate-limit comparison.
- [x] Write meaningful regressions in the owned test file without running tests.
- [x] Typecheck only, cite Context7 library IDs per API fact, and document the route/response seam for G5.

## C8 credentials, clients and mirrors

- `src/app/credentials.ts:39` adds `hostsFromAppConfig`, using the approved edition/subdomain and normalizing the historical API-base interpretation of `ghe_base_url`. `:89` obtains those fields through G4's `readGithubAppClient`, without duplicating its reader. `:53` uses the same host module for environment bootstrap. Stored credentials include resolved `hosts`; stored GitHub.com remains authoritative over an Enterprise environment, and preserves the old unset `baseUrl` convention. Existing retirement markers, last-good database credentials during outages, five-second cache, and refusal of deleted/undecryptable stored rows remain intact.
- `src/app/github.ts:26` uses the resolved API base for the App's custom Octokit class, installation clients, repository-installation discovery and public profiles. The App fingerprint includes edition/API/web hosts, so changing a host rebuilds the App and installation authentication cache. `:43` exposes `hosts()` from the same active credential source. The optional injected `fetch` is a documented SDK transport seam used by the new regressions; production keeps its default transport.
- `src/app/context.ts:50` exports `githubHostsFor(ctx)`. Production uses the active client's host; lightweight contexts use G4's stored reader, then bootstrap only when no stored row exists.
- `src/app/issues.ts:98` passes `githubWebOrigin` to the mirror. All four callers await the now-async dependency builder: fresh GitHub/Plane events and both pending-mirror continuation paths. G3/G2's mirror can therefore build Enterprise cross-links and convert references with the correct web origin.

## N7 setup-check server

`src/ui/setup-check.ts:45` exports `createSetupCheckHandler(deps): () => Promise<SetupCheckResult>`; `checkSetup(deps)` is also exported. It produces six checks and sends no remote writes:

1. Active credential read/decryption status, using the actual credential source rather than guessing from row existence.
2. App registration permissions from **App-JWT `GET /app`**, including `statuses: read`. Read grants accept higher recognized levels; write requirements reject read-only grants. Administration write is conditional on configured autolinks. Missing/malformed grants fail closed, including unexpected prototype-property strings. If optional mapping requirements cannot be read, the check is unknown rather than falsely verified.
3. The nine manually selectable event subscriptions used by the reducers. Automatic installation events are not required in the selectable list. Missing/malformed event lists fail closed.
4. The last genuine signed GitHub transport delivery recorded by processing/audit/spool.
5. The last genuine Plane transport delivery recorded by processing/audit/spool.
6. The active Plane client limit versus `PLANE_API_RATE_PER_MINUTE`, and versus an authoritative Plane deployment limit when a reader is supplied. Invalid settings and mismatches fail; an unavailable server setting is explicitly unknown.

Delivery aggregation excludes cooldown metadata, content claims, explicit replay/backfill IDs and future timestamps. A signed delivery that ultimately failed processing still counts through its inbound audit record; a verified Plane delivery waiting in the durable spool also counts. The timestamp basis is **processed or spooled**, not an invented ingress timestamp; the existing ledger does not persist every signature-verified request's original arrival time. An empty/inaccessible history stays unknown. This deliberately avoids the existing unfiltered `lastDeliveryAt` helper, which includes internal cooldown rows.

Errors are classified/sanitized rather than echoing private keys, ciphertext errors, JWTs or database messages. A rate-limited App check retains its full `retryAt`; no HTTP retry or sleep occurs here. Concurrent independent reads use `Promise.allSettled`, including synchronous dependency failures, so one failed prerequisite does not hide the other checks. `ok` is true only when every check passes.

## G5 route/UI seam and operational limits

G5 should use the existing instance-admin wrapper with `GET /git-sync/api/instance/setup-check` and `sendJson(res, 200, await setupCheck())`:

```ts
createSetupCheckHandler({ db, credentials, github: ghClient, plane: planeClient, config,
  // Optional authoritative deployment-setting reader:
  // readPlaneRateLimit: async () => <Plane requests per minute, or null when unavailable>,
});
```

Result shape: `{ checkedAt: string, ok: boolean, checks: SetupCheckItem[] }`. Each item has `id`, `title`, `status` (`pass|fail|unknown`), `detail`, `runbookAnchor`, and safe `data`. IDs: `credentials`, `github_permissions`, `github_events`, `github_delivery`, `plane_delivery`, `plane_rate_limit`. Missing permission/event details and `retryAt` are under `data`; delivery checks include `data.lastDeliveryAt`. Resolve `runbookAnchor` against `deploy/APPLY.md` for each prerequisite's link.

The shared tree confirms G5 already wired the exported handler in `src/app/main.ts`, the authorized API route in `src/ui/api.ts`, and the result rendering in `src/ui/client/Admin.tsx`. Those are G5 edits; G1 did not edit them. The current composition supplies no `readPlaneRateLimit`, so server-rate verification remains “Not verified,” while the actual client/config comparison runs. This is intentional: **Plane v1.4.2 does not expose a total-limit header**, and remaining quota is not the configured total. Supply an authoritative deployment-setting reader to obtain a verified server comparison; otherwise the UI directs the operator to confirm Plane's setting separately.

`GET /app` verifies the App registration. It cannot establish that each installation owner has accepted a new permission grant; the result says to verify that separately (`data.scope = "app_registration"`). When changing editions in the App UI, clear host/subdomain fields belonging to the previous edition rather than preserving contradictory settings.

The wave-1 migration handoff is still outstanding in the shared migration 010: an existing stored `https://api.github.com` URL is classified as GHES. Driver/G4 must insert `WHEN lower(rtrim(ghe_base_url, '/')) = 'https://api.github.com' THEN 'github'` before the Cloud case. G1 did not edit the migration or any file outside its row.

## Context7 evidence

Applied `$HOME/.claude/skills/find-docs/SKILL.md`, resolving libraries before documentation lookup with `npx ctx7@latest library ...`, then `npx ctx7@latest docs <id> "<behavior>"`. GitHub host facts reuse the already resolved/fetched wave-1 sources; GET /app and SDK behavior were refreshed for this wave. API facts were not supplied from memory.

| Fact used | Context7 library ID | Primary supporting source |
| --- | --- | --- |
| `GET /app` requires the App JWT and returns `permissions`, `events`, `id`, `slug`, `client_id`; installation endpoints expose installation-specific grants separately. | `/websites/github_en_rest` | [App API](https://docs.github.com/en/rest/apps/apps) |
| Required grant categories and levels include separate Checks and Commit statuses read permissions, plus conditional Administration for autolinks. | `/websites/github_en_rest`, `/websites/github_en` | [App permission table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), [autolinks](https://docs.github.com/en/rest/repos/autolinks), [webhook permissions](https://docs.github.com/en/webhooks/webhook-events-and-payloads) |
| `installation` and `installation_repositories` arrive automatically; completed check suites need read access rather than requested/rerequested write access. | `/websites/github_en` | [Webhook reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads); fetched in wave 1 and refreshed for this wave |
| GitHub.com, ghe.com API/web separation and GHES `/api/v3` / web-host handling. | `/websites/github_en` | [GitHub product hosts](https://docs.github.com/en/get-started/learning-about-github/about-versions-of-github-docs), [GHES App URLs](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/making-your-github-app-available-for-github-enterprise-server) |
| App accepts a custom Octokit class; `Octokit.defaults` supplies `baseUrl`; `app.octokit` authenticates as App JWT; `getInstallationOctokit` authenticates as the installation. | `/octokit/octokit.js` | [App API/constructor](https://github.com/octokit/octokit.js/blob/main/_autodocs/api-reference/app.md), [Octokit defaults](https://github.com/octokit/octokit.js/blob/main/_autodocs/api-reference/octokit.md) |
| Octokit accepts `request.fetch` as an injected transport and carries it through auth hooks. | `/octokit/octokit.js` | [SDK configuration](https://github.com/octokit/octokit.js/blob/main/README.md), [configuration reference](https://github.com/octokit/octokit.js/blob/main/_autodocs/configuration.md) |
| Plane's documented remaining/reset headers describe available quota and epoch reset, not a total-limit measurement. | `/websites/developers_plane_so` | [Rate-limit introduction](https://developers.plane.so/api-reference/introduction) |
| PGlite supports the real PostgreSQL fixture, parameterized `query`, migration `exec`, `waitReady`, and clean shutdown. | `/electric-sql/pglite` | [PGlite API](https://github.com/electric-sql/pglite/blob/main/docs/docs/api.md), [parameterized queries](https://github.com/electric-sql/pglite/blob/main/docs/docs/index.md) |
| Node RSA PEM generation and file fixtures used by the unexecuted SDK/credential regressions. | `/nodejs/node` | [Crypto API](https://github.com/nodejs/node/blob/main/doc/api/crypto.md), [FS API](https://github.com/nodejs/node/blob/main/doc/api/fs.md) |

As the brief requires, Plane current-doc behavior was checked against **v1.4.2** source: [API throttle](https://raw.githubusercontent.com/makeplane/plane/v1.4.2/apps/api/plane/api/rate_limit.py) reads `settings.API_KEY_RATE_LIMIT`, sets remaining/reset only; [base response](https://raw.githubusercontent.com/makeplane/plane/v1.4.2/apps/api/plane/api/views/base.py) copies those two headers; [settings](https://raw.githubusercontent.com/makeplane/plane/v1.4.2/apps/api/plane/settings/common.py) defaults the deployment setting to `60/minute`. The setup check does not treat that default as proof of the actual deployment value and assumes no Plane v2 endpoint.

## Regression coverage and allowed validation

`tests/github/parity2-g1.test.ts` contains **13 new regressions**, written and typechecked but **not run**:

- `:45`, `:63`: stored/bootstrap host authority, live edition changes, retained stored credentials during outages, corrupted ciphertext and bootstrap-retirement protection.
- `:84`: real SDK App/installation/public clients through fake fetch, all three host editions, JWT versus installation/public authentication, and host changes with a stale legacy base overridden by resolved hosts.
- `:119`: context's stored reader and current-client authority; a real Plane→GitHub mirror creates its cross-link on the selected Enterprise web origin.
- `:151`, `:163`, `:175`, `:189`: handler/result contract, statuses versus Checks, missing events, stronger grants, conditional autolinks, malformed fields and unexpected grant names.
- `:199`, `:209`: unreadable credentials, sanitized errors, no App request when decryption fails, and a complete 15-minute rate deadline.
- `:220`, `:236`: processed/failed/spooled deliveries, exclusion of internal/replay/future rows, empty history and unavailable storage.
- `:249`: client/server mismatches, invalid server values, unknown server configuration, verified match and synchronous reader failure without secret leakage.

Only the scoped compiler check was run, repeated after corrections:

```text
node scripts/typecheck.mjs src/app/credentials.ts src/app/github.ts src/app/context.ts src/app/issues.ts src/ui/setup-check.ts tests/github/parity2-g1.test.ts
```

Result: **`typecheck passed (46 project files)`**. No tests, project runtime probes, gate scripts, staging, commits or pushes were run. Acceptance: **6 met, 0 unmet, 0 abandoned**. Runtime regression execution, route/UI work, deployment-setting provenance and the already-relayed migration fix remain with their assigned owners/driver.
