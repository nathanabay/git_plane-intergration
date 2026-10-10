# Leaf brief: leaf-1.3.2 — B3 embedded React configuration app and config API (implementer B, wave 3)

Read `.unlazy/impl/briefs/COMMON.md` first. Its rules are part of this brief.

Your ledger: `docs/impl/agent-gates/leaf-1.3.2.GATES.md`

## OWNS

    src/ui/**, tests/ui/**, Dockerfile, .dockerignore, docs/impl/agent-gates/leaf-1.3.2.GATES.md

Implementer A works concurrently on `src/sync/**`, `src/queue/**`, `src/db/**`, `src/index.ts`.
You **read** `src/db/*` (A3's tables and `Db` type), `src/rules/engine.ts` (A6) and
`src/auth/identity.ts` (your B9) — never edit them. A3's final schema is `src/db/migrations/001-init.sql` (`repo_mappings.workspace_slug`,
`linkback_enabled`, `autolinks_enabled` default false, `user_map.gh_login`/`gh_id`,
`github_app_config.ghe_base_url`, unique policy per field). If it lacks something you need,
stop and say so in your report rather than working around it.

## Driver gates (copy all into your ledger, exactly)

    - [ ] G1: B3 config API and UI pass the driver oracle
      CHECK: node scripts/verify-b3-config-api.mjs
      EXPECT: B3 config API verification passed
      EVIDENCE: pending

    - [ ] G2: the image still meets the deploy contract
      CHECK: node scripts/verify-a1-deploy.mjs
      EXPECT: A1 deploy verification passed
      EVIDENCE: pending

    - [ ] G3: own tests run, at least 25 passing, none skipped
      CHECK: node scripts/run-tests.mjs 25 tests/ui
      EXPECT: tests passed
      EVIDENCE: pending

    - [ ] G4: typecheck clean, including the TSX app
      CHECK: node scripts/typecheck.mjs "src/ui/**/*.ts" "src/ui/**/*.tsx" "tests/ui/**/*.ts"
      EXPECT: typecheck passed
      EVIDENCE: pending

    - [ ] G5: no stubs or placeholders
      CHECK: node scripts/verify-no-stubs.mjs src/ui tests/ui Dockerfile
      EXPECT: stub scan passed
      EVIDENCE: pending

Read `scripts/verify-b3-config-api.mjs` in full first: it pins the contract below.

---

## What B3 is (spec §8, §7.3, §7.6, §9)

All real UI is **one React app in this repo with two entry routes**: `/git-sync/ui/admin`
(instance admin, embedded by your B1 iframe) and `/git-sync/ui/workspaces/:slug` (workspace
settings, embedded by your B2 iframe). Plus the **config API** under `/git-sync/api/`. It is
served from Plane's own origin (§3), so the browser sends Plane's session cookie with every
request; there is **no second auth system and no separate user store** (§8).

Dependencies installed by the driver: `react@19.3.0`, `react-dom@19.3.0`, dev `esbuild@0.28.2`,
`@types/react`, `@types/react-dom`. `tsconfig.json` now has `"jsx": "react-jsx"` and the DOM
libs. `package.json` has `"build:ui": "node src/ui/build.mjs --outdir dist/ui"` (`dist/` is
git-ignored). Node cannot run `.tsx`: the server side (`api.ts` and anything it imports) must be
plain `.ts`; only the browser bundle is `.tsx`.

## Server contract (the oracle imports exactly these from `src/ui/api.ts`)

```ts
export interface ConfigApiDeps { db: Db; planeInternalUrl: string; publicOrigin: string;
  tokenKey: Buffer; fetch?: typeof fetch }
export function createConfigRoutes(deps: ConfigApiDeps): Route[];   // Route from src/index.ts; handlers get (req, res, params)
export function createUiRoutes(opts: { distDir: string }): Route[];  // GET /git-sync/ui/* → assets by path, else index.html
```

`src/index.ts` (owned by A) supports `:param` segments and a trailing `/*` prefix route; handlers
receive `params` as the third argument. Wiring your routes into `src/index.ts` main happens in a
later wave — the oracle mounts them itself.

### Authentication — every request, no caching (§8)

Plane v1.4.2 facts, read from its source (`plane/settings/common.py`, `plane/app/urls/*.py`,
`plane/license/urls.py`):
- web session cookie `session-id`; admin-app session cookie `admin-session-id`.
- `GET {planeInternalUrl}/api/users/me/` → the viewer (`id`, `email`, …) or 401.
- `GET {planeInternalUrl}/api/workspaces/{slug}/workspace-members/me/` → `{ role }`
  (20 admin, 15 member, 5 guest) or 403/404.
- `GET {planeInternalUrl}/api/instances/admins/me/` with `admin-session-id` → instance admin or 401.

Rules:
- Forward **only** the relevant Plane cookie (`session-id=…` or `admin-session-id=…`) — never the
  rest of the browser's cookies.
- Workspace endpoints: no/invalid session → 401; role < 20 → 403 (reads and writes — §8 says check
  the role "before rendering or accepting mapping writes"). **Re-validate the session and role on
  every request**; no cache, so a demoted admin's next write fails.
- Instance endpoints (`/git-sync/api/instance/*`): require a valid `admin-session-id`; else 401.
- Cross-site write protection (cookie auth makes CSRF the main threat): every non-GET request must
  carry `Origin` equal to `publicOrigin` (missing or different → 403) and
  `Content-Type: application/json` (else 415). Body limit 1 MiB (413).
- Error bodies are `{"error": "<message>"}` and never echo secrets or Plane responses verbatim.

### Endpoints (all JSON; camelCase in bodies, A3's snake_case columns in the DB)

Workspace (`:slug` must equal the mapping's stored workspace slug, else 404):
- `GET|POST /git-sync/api/workspaces/:slug/mappings`; `PATCH|DELETE .../mappings/:id`.
  Body: `ghRepoId` (number), `ghRepoFullName`, `planeProjectId`, `syncDirection`
  (`bidirectional|github_to_plane`, §7.3), `smartCommitsEnabled`, `linkbackComments`,
  `autolinks` (§7.4, default false). Validation failure → 422. Create → 201 `{ id }`.
- `GET|PUT .../mappings/:id/rules` — body `{ yaml }`; validate with A6's `parseRules` and return
  its error message in a 422; store each accepted save as a new `rule_sets` version (§7.5:
  state mappings compile into rules, so this is the one rules surface).
- `GET|PUT .../mappings/:id/conflict-policies` — body `{ <field>: <policy> }`, fields
  `title, description, state, assignees, labels, comments`, policies
  `last_write_wins | source_of_truth:github | source_of_truth:plane`. GET returns every field,
  filling unset ones with the §7.3 defaults: `source_of_truth:github` for title and description,
  `last_write_wins` for everything else.
- `GET .../user-links`, `PUT .../user-links/:planeUserId` `{ githubLogin, githubId }` (both
  required, 422 otherwise — `gh_id` is the stable GitHub identity; the UI can look the id up from
  the browser with `GET https://api.github.com/users/{login}`),
  `DELETE .../user-links/:planeUserId` → removes the `user_map` row **and** revokes the user's
  stored tokens through B9's `TokenVault` + A3's `PgTokenStore` (§9 revocation path) → 204.
- `GET .../audit?limit=&before=` — newest first, from A3's `audit_log` (read only here; dry-run,
  replay and backfill are B8's next wave).

Instance:
- `GET|PUT /git-sync/api/instance/github-app` — `{ appId, privateKey, webhookSecret, gheBaseUrl }`.
  Store `privateKey` and `webhookSecret` encrypted with B9's `encryptSecret(…, tokenKey)`. GET
  returns `{ appId, gheBaseUrl, configured: true|false }` — **never** the secrets.
- `GET|PUT /git-sync/api/instance/magic-words` — `{ closing, non_closing, relation }`, each a
  non-empty array of strings; unknown tiers → 422 (§6 says all three lists are configurable).
- `GET|PUT /git-sync/api/instance/settings` — smart-commits default for new repos (§7.2), the
  reconciliation interval (§1.3), op TTL minutes.

**No Plane writes.** Configuration is stored only in the `gitsync` database. The config API must
never call a Plane endpoint other than the three GETs above — this resolves the plan's residual
risk (IMPLEMENTATION_PLAN.md, "Known residual risk"); the oracle asserts it.

## The React app (`src/ui/app.tsx` + components, `src/ui/build.mjs`)

- `build.mjs --outdir <dir>` bundles with esbuild (minified, `NODE_ENV=production`), writes
  `index.html` with `<div id="root"></div>` and a script tag whose src works when the shell is
  served at any depth under `/git-sync/ui/` (use an absolute `/git-sync/ui/…` path).
- Client-side routing by `location.pathname`: `/git-sync/ui/admin` → instance screens (GitHub
  App credentials, connection health from the API, magic words, smart-commits default);
  `/git-sync/ui/workspaces/:slug[/…]` → mappings list and editor, rules editor (YAML textarea
  showing the API's 422 message inline), sync direction and per-field conflict policy, per-repo
  toggles, user links with an unlink action, audit log list.
- `fetch` with `credentials: "same-origin"` and `Content-Type: application/json` (the browser
  adds the right `Origin`). Show 401/403 as a clear "not authorised" state.
- Plain, accessible HTML and a small amount of CSS; it sits inside Plane's settings frame. No
  new dependencies.

## Dockerfile (you own it this wave)

Make it multi-stage: a build stage runs `npm ci` and `npm run build:ui`; the runtime stage is
`node:24-alpine` (or slim) with `npm ci --omit=dev`, `src/`, and `dist/ui`, non-root `node` user,
`EXPOSE 3100`, `CMD ["node", "src/index.ts"]`. Keep the A1 oracle passing (G2).

## Tests (`tests/ui/`)

Cover the auth matrix (401/403/role re-check), Origin/Content-Type, every endpoint's validation,
the defaults, encryption-at-rest, cookie forwarding, revocation, and the static server (content
types, SPA fallback, traversal). Use PGlite and a local fake Plane server, as the oracle does.
