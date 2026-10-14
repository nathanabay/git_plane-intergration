// Installer: turns the service account's Plane API key into its user id (PLANE_SERVICE_USER_ID), and proves the
// key works before anything is started. GET /api/v1/users/me/ with X-API-Key returns the key's user
// (Context7 /websites/developers_plane_so, "Get current user"; checked on Plane v1.4.2: 200 with id, 403 for a bad key).

export interface PlaneUser { id: string; email: string; displayName: string }

export async function planeUserForKey(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<PlaneUser> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/v1/users/me/`, {
      headers: { "X-API-Key": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Could not reach Plane's API at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401 || res.status === 403) throw new Error("Plane rejected the API key. Create one in Plane under Profile settings > Personal access tokens and paste it again.");
  if (!res.ok) throw new Error(`Plane's API answered ${res.status} for /api/v1/users/me/`);
  const body = await res.json().catch(() => null) as { id?: unknown; email?: unknown; display_name?: unknown } | null;
  if (!body || typeof body.id !== "string" || !body.id) throw new Error("Plane's /api/v1/users/me/ did not return a user id");
  return { id: body.id, email: typeof body.email === "string" ? body.email : "", displayName: typeof body.display_name === "string" ? body.display_name : "" };
}
