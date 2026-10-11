// Client-side routing for the two entry routes (/git-sync/ui/admin and /git-sync/ui/workspaces/:slug).
// Pure functions so they can be tested without a DOM.
export const UI_BASE = "/git-sync/ui";

export type MappingTab = "settings" | "policies" | "rules" | "dry-run";

export type AppRoute =
  | { name: "admin" }
  | { name: "mappings"; slug: string }
  | { name: "mapping"; slug: string; id: number; tab: MappingTab }
  | { name: "users"; slug: string }
  | { name: "audit"; slug: string }
  | { name: "notfound" };

export function parseLocation(pathname: string): AppRoute {
  if (pathname !== UI_BASE && !pathname.startsWith(UI_BASE + "/")) return { name: "notfound" };
  let parts: string[];
  try {
    parts = pathname.slice(UI_BASE.length).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { name: "notfound" };
  }
  if (parts[0] === "admin" && parts.length === 1) return { name: "admin" };
  if (parts[0] !== "workspaces" || !parts[1]) return { name: "notfound" };
  const slug = parts[1];
  const rest = parts.slice(2);
  if (rest.length === 0) return { name: "mappings", slug };
  if (rest[0] === "users" && rest.length === 1) return { name: "users", slug };
  if (rest[0] === "audit" && rest.length === 1) return { name: "audit", slug };
  if (rest[0] === "mappings" && rest[1] && /^\d{1,9}$/.test(rest[1])) {
    const id = Number(rest[1]);
    if (rest.length === 2) return { name: "mapping", slug, id, tab: "settings" };
    if (rest.length === 3 && (rest[2] === "policies" || rest[2] === "rules" || rest[2] === "dry-run")) return { name: "mapping", slug, id, tab: rest[2] };
  }
  return { name: "notfound" };
}

export function workspaceHref(slug: string, ...segments: (string | number)[]): string {
  return [UI_BASE, "workspaces", encodeURIComponent(slug), ...segments.map((s) => encodeURIComponent(String(s)))].join("/");
}

export function mappingHref(slug: string, id: number, tab: MappingTab): string {
  return tab === "settings" ? workspaceHref(slug, "mappings", id) : workspaceHref(slug, "mappings", id, tab);
}
