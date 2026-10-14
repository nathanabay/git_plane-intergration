// Installer: adds the /git-sync/* route to the Caddyfile shipped inside Plane's own proxy image. install.sh copies
// that file out of the running proxy, so the route is added to whatever Caddyfile this Plane release ships.

export const GITSYNC_ROUTE = "reverse_proxy /git-sync/* git-sync:3100";
const COMMENT = "# git-sync: webhooks, config API and settings app (added by install.sh)";

/** Inserts the git-sync route before Plane's catch-all `reverse_proxy /* web:3000`. Idempotent. */
export function addGitSyncRoute(caddyfile: string): string {
  if (caddyfile.split("\n").some((l) => l.trim() === GITSYNC_ROUTE)) return caddyfile;
  const lines = caddyfile.split("\n");
  const at = lines.findIndex((l) => /^\s*reverse_proxy\s+\/\*\s+web:\d+\s*$/.test(l));
  if (at < 0) throw new Error("Could not find Plane's catch-all route (reverse_proxy /* web:3000) in the proxy Caddyfile; use --proxy external and add the route yourself");
  const indent = /^\s*/.exec(lines[at] ?? "")?.[0] ?? "";
  lines.splice(at, 0, `${indent}${COMMENT}`, `${indent}${GITSYNC_ROUTE}`, "");
  return lines.join("\n");
}

