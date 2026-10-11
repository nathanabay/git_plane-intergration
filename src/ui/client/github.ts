// Browser-side GitHub lookups, so the service never needs a user's GitHub credentials to fill in
// the numeric ids it keys on. The ids can also be typed in (GitHub Enterprise has another host).
async function getJson(url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  } catch {
    throw new Error("Could not reach api.github.com; enter the id by hand");
  }
  if (res.status === 404) throw new Error("GitHub does not know that name");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}; enter the id by hand`);
  const json: unknown = await res.json();
  if (typeof json !== "object" || json === null) throw new Error("Unexpected answer from GitHub");
  return json as Record<string, unknown>;
}

export async function lookupRepo(fullName: string): Promise<{ id: number; fullName: string }> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error("Enter the repository as owner/repo");
  const j = await getJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (typeof j.id !== "number" || typeof j.full_name !== "string") throw new Error("Unexpected answer from GitHub");
  return { id: j.id, fullName: j.full_name };
}

export async function lookupUser(login: string): Promise<{ id: number; login: string }> {
  const j = await getJson(`https://api.github.com/users/${encodeURIComponent(login)}`);
  if (typeof j.id !== "number" || typeof j.login !== "string") throw new Error("Unexpected answer from GitHub");
  return { id: j.id, login: j.login };
}
