# Plane UI Forks

This directory contains patches and build scripts for the Plane UI forks needed to integrate GitHub Sync.

## Fork Surface

The fork surface is intentionally minimal to make upgrading to newer Plane versions easier. We only modify the following files:

### Admin App
- `apps/admin/app/(all)/(dashboard)/sidebar-menu.tsx` (nav entry)
- `apps/admin/app/routes.ts` (route registration)
- `apps/admin/app/(all)/(dashboard)/git-sync/page.tsx` (route component rendering the iframe)

### Web App
- `packages/constants/src/settings/workspace.ts` (nav entry)
- `apps/web/app/routes.ts` (route registration)
- `apps/web/app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/git-sync/page.tsx` (route component rendering the iframe)

The new routes render `<iframe>` elements pointing to the synchronization service.

## Upgrading Plane

To rebuild the fork for a newer Plane version:

1. Update the `v1.4.2` tags in `build-fork-image.sh` for both `apps/admin` and `apps/web`.
2. Generate new patches: clone the new Plane version, apply the changes manually following the fork surface above, and generate the patches using `git diff`.
3. Run the build scripts to build and tag the new Docker images.
4. Replace the old patches and build scripts in this repository.

Note that `apps/web` moves faster than `apps/admin` — expect the nav array to be the recurring conflict.

## GitHub App Permissions

To install the GitHub App, you must configure it with the following permission set:

- **Pull requests**: Read & write
- **Issues**: Read & write
- **Contents**: Read & write
- **Checks**: Read-only
- **Deployments**: Read-only
- **Members**: Read-only (Organization)
- **Administration**: Write-only (required ONLY if autolinks are enabled — note that adding this later forces a re-consent prompt for users)

## AGPL-3.0 Note

Internal use of a fork is fine, but publishing source becomes required if offered to third parties under the AGPL-3.0 license.
