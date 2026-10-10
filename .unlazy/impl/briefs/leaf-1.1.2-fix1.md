# Fix round 1 for leaf-1.1.2 (driver re-verification found defects)

Same contract, same OWNS, same rules as `.unlazy/impl/briefs/COMMON.md` and
`.unlazy/impl/briefs/leaf-1.1.2.md`. The driver re-ran your gates and reviewed the code. Your
runnable gates passed, but the review found the defects below. The driver strengthened
`scripts/verify-fork-patch.mjs` and `scripts/verify-identity-contract.mjs` so each defect now
fails a gate. Read both scripts again, fix every item, add tests for the B9 fixes, regenerate the
patches and mirrored files, then re-run your ledger with `gate-check --approve` until ALL MET. Do
not edit the scripts.

1. **BLOCKING — the web route registration breaks Plane's build.** Your `apps/web/app/routes.ts`
   change re-declares `./(all)/layout.tsx`, `./(all)/[workspaceSlug]/layout.tsx`,
   `.../(settings)/layout.tsx` and `.../settings/(workspace)/layout.tsx` outside `mergeRoutes`, so
   the final tree contains each layout twice. React Router derives a route id from the file path
   and rejects duplicate ids at build. The oracle now evaluates the merged route tree and reports
   exactly those four duplicates.
   Plane v1.4.2 ships the seam for this: `apps/web/app/routes/extended.ts` exports an empty
   `extendedRoutes`, and `apps/web/app/routes/helper.ts`'s `mergeRoutes` deep-merges an extended
   layout into the core layout with the same `file`. Register the route there, nested under the
   same layout chain the core webhooks route uses (read `apps/web/app/routes/core.ts` around the
   `:workspaceSlug/settings/webhooks` entry), and **leave `apps/web/app/routes.ts` untouched**.
2. **Type errors hidden with `as any`** in `packages/constants/src/settings/workspace.ts`.
   `WORKSPACE_SETTINGS` is `Record<TWorkspaceSettingsTabs, ...>` and `TWorkspaceSettingsTabs`
   lives in `@plane/types` (`packages/types`), so a `"git-sync"` key is an excess property, and
   `key: "webhooks"` duplicates the webhooks entry's key (React list key collision in
   `apps/web/core/components/settings/workspace/sidebar/item-categories.tsx`, which also looks up
   `WORKSPACE_SETTINGS_ICONS[item.key]`). No `as any`, `@ts-ignore` or `@ts-expect-error` anywhere
   in a patch — the oracle rejects them. Pick a nav seam that typechecks without editing
   `@plane/types`. Study how `item-categories.tsx` builds and renders the list; appending a
   properly typed, admin-only entry there (with its own icon and unique key) may be the cleanest
   option. The web surface must stay at **three files**: the page, `routes/extended.ts`, and
   one nav file. Admin gating of the nav entry must match the neighbouring admin-only entries.
3. **Truncated GCM tags are accepted.** `decryptSecret` never checks lengths, and Node accepts
   authentication tags shorter than 16 bytes, which weakens tamper detection. Require a 12-byte
   IV and a 16-byte tag, and pass `authTagLength: 16` to `createDecipheriv`.
4. **Malformed sender crashes `resolveActor`.** `{ id, type }` with no `login` throws on
   `.endsWith`. Any sender without a non-empty string `login` must resolve to the service identity
   (`unmapped`). Also treat the ghost account case-insensitively and by its id `10137`.
5. **`loadTokenKey` accepts garbage.** `Buffer.from(x, "base64")` silently skips invalid
   characters. Require strict base64 (the input must round-trip).
6. `assessServiceAccountRole`: use `role >= 20`, not `=== 20`.
7. The web page reads `params` from props: type it with the generated `Route.ComponentProps`
   (`import type { Route } from "./+types/page"`) as the neighbouring settings pages do.
