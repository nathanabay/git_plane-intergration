# Leaf brief: leaf-1.1.2 — B1, B2 Plane forks + B9 identity (implementer B, wave 1)

Read `.unlazy/impl/briefs/COMMON.md` first. Its rules are part of this brief.

Your ledger: `docs/impl/agent-gates/leaf-1.1.2.GATES.md`

## OWNS

    apps/admin/**, apps/web/**, packages/constants/**, src/auth/**, tests/auth/**,
    docs/impl/agent-gates/leaf-1.1.2.GATES.md

## Driver gates (copy all into your ledger, exactly)

    - [ ] G1: both fork patches pass the driver oracle
      CHECK: node scripts/verify-fork-patch.mjs all
      EXPECT: fork patch verification passed
      EVIDENCE: pending

    - [ ] G2: B9 satisfies the driver-held identity contract
      CHECK: node scripts/verify-identity-contract.mjs
      EXPECT: identity contract verification passed
      EVIDENCE: pending

    - [ ] G3: own tests run, at least 12 passing, none skipped
      CHECK: node scripts/run-tests.mjs 12 tests/auth
      EXPECT: tests passed
      EVIDENCE: pending

    - [ ] G4: typecheck clean
      CHECK: node scripts/typecheck.mjs "src/auth/**/*.ts" "tests/auth/**/*.ts"
      EXPECT: typecheck passed
      EVIDENCE: pending

    - [ ] G5: no stubs or placeholders
      CHECK: node scripts/verify-no-stubs.mjs src/auth tests/auth apps
      EXPECT: stub scan passed
      EVIDENCE: pending

Read `scripts/verify-fork-patch.mjs` and `scripts/verify-identity-contract.mjs` in full before
you start: they are the acceptance tests and pin details this brief summarises.

---

## Tasks B1 and B2 — Plane UI forks (spec §8; §8 was corrected to six files)

**The plan's file paths are wrong for v1.4.2.** `apps/*/app/(all)/(dashboard)/components/nav.tsx`
does not exist. The driver checked the real tree at tag `v1.4.2`:

- admin nav: `apps/admin/app/(all)/(dashboard)/sidebar-menu.tsx`
- admin routes: `apps/admin/app/routes.ts` (explicit React Router config)
- workspace settings nav entries: `packages/constants/src/settings/workspace.ts`
  (confirm how `apps/web` renders them, and whether an icon map in `apps/web` also needs an
  entry — if it does, that file counts toward the three)
- web routes: `apps/web/app/routes.ts`
- existing workspace settings pages live under
  `apps/web/app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/` — put the new page there,
  following the shape of a neighbour such as `webhooks/page.tsx`.

Hard limit: **at most three files per app, six total** (nav entry, route component, route
registration). Prefer editing existing files minimally over adding abstractions — the point is
a diff that survives upstream rebases.

How to work:
1. Clone your own working copy: `git clone --depth 1 --branch v1.4.2 https://github.com/makeplane/plane.git /tmp/gitsync-fork-work`
   (or a sparse clone). Do **not** edit `~/.cache/gitsync/plane-v1.4.2` — that is the oracle's
   pristine copy.
2. Make the edits there, matching upstream code style, and read enough of the surrounding code
   (layouts, existing settings pages, permission hooks) to use Plane's real APIs.
3. Produce `apps/admin/git-sync.patch` with `git diff -- apps/admin` and
   `apps/web/git-sync.patch` with `git diff -- apps/web packages/constants` (`git add -N` new
   files first so they appear in the diff). Paths in the patch are `a/apps/...` / `b/apps/...`.
4. Copy each post-patch file into this repo at the **same relative path** (e.g.
   `apps/admin/app/routes.ts`). The oracle byte-compares them with pristine v1.4.2 + patch.
5. Add `apps/admin/build-fork-image.sh` and `apps/web/build-fork-image.sh`: clone v1.4.2, apply
   the patch, `docker build` with the upstream Dockerfile for that app, tag
   `plane-admin-gitsync:v1.4.2` / `plane-frontend-gitsync:v1.4.2` (the tags Part A's compose
   fragment expects — exact strings). Find the upstream Dockerfile paths in the v1.4.2 tree;
   do not guess. `set -euo pipefail`. Add `apps/README.md` explaining the fork surface, how to
   rebuild on a Plane upgrade, and the AGPL-3.0 note from spec §11.

Behaviour:
- **Admin (B1):** nav entry "GitHub Sync" → route `/git-sync` (under the admin app's base path)
  rendering a full-height `<iframe src="/git-sync/ui/admin">`. The admin app is already gated to
  instance admins by its layout; say in your report which guard covers the new route.
- **Web (B2):** workspace settings entry "GitHub Sync" → route
  `/:workspaceSlug/settings/git-sync` rendering `<iframe src={`/git-sync/ui/workspaces/${workspaceSlug}`}>`.
  Gate rendering on workspace role admin (Plane's `EUserPermissions.ADMIN`, value 20 — verify in
  the source) using the same permission hook the neighbouring admin-only settings pages use, and
  show Plane's existing not-authorized treatment otherwise. Also restrict the nav entry the same
  way neighbouring admin-only entries are restricted. Server-side enforcement of writes belongs
  to the config API (B3), not here — say so in a code comment.
- Both iframes are same-origin (spec §3), so no `sandbox` relaxation tricks are needed; give the
  iframe a `title` for accessibility.
- B1's GitHub App permission set (plan B1) goes into `apps/README.md` as the installation
  reference: Pull requests R/W, Issues R/W, Contents R/W, Checks R, Deployments R, Members R
  (org), Administration W only if autolinks are enabled — and that adding one later forces
  re-consent.

## Task B9 — attribution, identity and credentials (spec §9, §7.2)

File: `src/auth/identity.ts` (more modules under `src/auth/` are fine; `identity.ts` must export
everything below). Persistence is task A3's job later — take storage as an injected interface.
Public contract — `scripts/verify-identity-contract.mjs` imports `src/auth/identity.ts`:

```ts
export interface GithubSender { login: string; id: number; type: string }   // payload `sender`
export type ActorResolution =
  | { kind: "user"; planeUserId: string; githubLogin: string }
  | { kind: "service"; reason: "ghost" | "bot" | "unmapped"; githubLogin: string | null };
export interface UserMapLookup { planeUserIdForGithubLogin(login: string): Promise<string | null> }
export function resolveActor(sender: GithubSender | null | undefined, users: UserMapLookup): Promise<ActorResolution>;

export interface PlaneMemberLite { id: string; email: string | null }
export type EmailMatch =
  | { ok: true; planeUserId: string }
  | { ok: false; reason: "none" | "multiple" | "invalid_email"; candidates: string[] };
export function matchPlaneUserByEmail(email: string, members: PlaneMemberLite[]): EmailMatch;

export function encryptSecret(plaintext: string, key: Buffer): string;   // "v1:<iv>:<tag>:<ciphertext>", base64url parts, AES-256-GCM, random 12-byte IV
export function decryptSecret(blob: string, key: Buffer): string;        // throws on tamper, wrong key, unknown version, malformed
export function loadTokenKey(env: Record<string, string | undefined>): Buffer;   // GITSYNC_TOKEN_KEY, base64 → exactly 32 bytes, else throw

export class SecretString { constructor(value: string); reveal(): string }   // String(), JSON, util.inspect all render "[redacted]"

export type TokenKind = "plane_pat" | "github_oauth";
export interface TokenStore {
  get(planeUserId: string, kind: TokenKind): Promise<string | null>;     // returns the encrypted blob
  put(planeUserId: string, kind: TokenKind, blob: string): Promise<void>;
  delete(planeUserId: string): Promise<boolean>;                         // all kinds; true if anything was removed
}
export class TokenVault {
  constructor(store: TokenStore, key: Buffer);
  store(planeUserId: string, kind: TokenKind, token: string): Promise<void>;
  load(planeUserId: string, kind: TokenKind): Promise<SecretString | null>;
  revoke(planeUserId: string): Promise<boolean>;
}
export function loadServiceCredentials(env: Record<string, string | undefined>): { planePat: SecretString };
export function assessServiceAccountRole(role: number): { ok: boolean; warning?: string };
```

Semantics (each is a spec requirement — cite the section in a comment where it applies):
- **Attribution from `sender` only** (§7.2, §9). `resolveActor` takes the sender and nothing
  else, so `pusher` and commit author fields cannot reach it. `ghost` (login `ghost`) → service
  `ghost`; `type === "Bot"` or a login ending in `[bot]` → service `bot` **before** any user-map
  lookup; null/absent sender or no mapping → service `unmapped`. Never guess.
- **Email matching needs exactly one match** (§9): trim + case-insensitive; zero → `none`,
  several → `multiple` with all candidate ids; empty/malformed → `invalid_email`. Members with a
  null email never match.
- **PATs are full-privilege** (§9): encrypt at rest (the vault hands the store ciphertext only),
  never log them (`SecretString` everywhere a token travels), revocation deletes every stored
  token for the user so a later `load` returns null.
- `loadServiceCredentials` requires a non-blank `PLANE_SERVICE_PAT`; its error names the missing
  variable and never echoes any env value.
- `assessServiceAccountRole`: Plane workspace roles are 20 admin, 15 member, 5 guest (verify in
  Plane source). The service account must be least-privileged: role 20 → `ok: false` with a
  warning explaining why (§9: a compromised admin token hands over full admin access).
- Rate-limit backoff is **not** yours — it belongs to A4's outbound workers.

Tests in `tests/auth/` should go beyond the oracle: IV uniqueness over many encryptions, every
tamper position (iv, tag, ciphertext), unicode secrets, store receives no plaintext, inspect at
depth, revocation idempotence.
