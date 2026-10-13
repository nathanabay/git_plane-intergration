// C3 fixtures for mapping saves: since parity C3 the service re-checks, at save time, that the repository is in the
// saving admin's own GitHub listing (GET /user/installations/{id}/repositories through their linked account). Route
// tests that save mappings supply a linked GitHub user and a fake of that listing with these helpers.
import type { PGlite } from "@electric-sql/pglite";
import { encryptSecret } from "../../src/auth/identity.ts";
import { putGithubOAuthToken } from "../../src/db/parity.ts";

/** The OAuth client the token store needs before it will use a stored token. */
export const GITHUB_OAUTH_CONFIG = { GITHUB_CLIENT_ID: "Iv1.fixture", GITHUB_CLIENT_SECRET: "fixture-secret" };

/** Triage is the least a repository needs to be pickable (install-flow `canManageIssues`). */
const TRIAGE = { admin: false, maintain: false, push: false, triage: true, pull: true };

/** Stores a non-expiring personal GitHub token for `planeUserId`, as the OAuth callback would. */
export async function linkGithubUser(db: PGlite, tokenKey: Buffer, planeUserId: string, token = "gho_fixture"): Promise<void> {
  await putGithubOAuthToken(db, planeUserId, { accessCiphertext: encryptSecret(token, tokenKey), refreshCiphertext: null, accessExpiresAt: null, refreshExpiresAt: null });
}

/**
 * A fetch that answers the user's per-installation repository listing on api.github.com from `listing`
 * (installation id → repositories) and passes every other request to `next` (the Plane fake, the test's own calls).
 */
export function githubListingFetch(listing: Record<number, { id: number; full_name: string }[]>, next: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.github.com") return next(input as any, init);
    const m = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    const repos = m ? listing[Number(m[1])] : undefined;
    if (!repos) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ total_count: repos.length, repositories: repos.map((r) => ({ ...r, private: false, permissions: TRIAGE })) });
  }) as typeof fetch;
}

/**
 * `composeRoutes` has no fetch dependency (production uses the global), so composed-route tests swap the global
 * for the duration of `work`; non-GitHub requests still reach the real fetch.
 */
export async function withGithubListing<T>(listing: Record<number, { id: number; full_name: string }[]>, work: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = githubListingFetch(listing, real);
  try { return await work(); } finally { globalThis.fetch = real; }
}
