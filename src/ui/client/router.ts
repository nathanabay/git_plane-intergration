// Client-side routing for the two entry routes (/git-sync/ui/admin and /git-sync/ui/workspaces/:slug).
// Pure functions so they can be tested without a DOM.
export const UI_BASE = "/git-sync/ui";

export type MappingTab = "settings" | "policies" | "rules" | "dry-run";
export interface AuditFilters { mappingId?: number; errorsOnly?: boolean; hours?: number; allWorkspaces?: boolean }

export type AppRoute =
  | { name: "admin"; tab?: "audit"; filters?: AuditFilters }
  | { name: "mappings"; slug: string }
  | { name: "mapping"; slug: string; id: number; tab: MappingTab }
  | { name: "development"; slug: string; projectId: string; issueId: string }
  | { name: "account"; slug: string }
  | { name: "users"; slug: string }
  | { name: "audit"; slug: string; filters?: AuditFilters }
  | { name: "notfound" };

export function parseLocation(pathname: string): AppRoute {
  const [path, query] = pathname.split("?", 2);
  pathname = path!;
  const search = new URLSearchParams(query ?? "");
  const filters: AuditFilters = { ...(search.get("errors") === "1" ? { errorsOnly: true } : {}),
    ...(search.get("scope") === "all" ? { allWorkspaces: true } : {}) };
  if (/^[1-9]\d{0,8}$/.test(search.get("mappingId") ?? "")) filters.mappingId = Number(search.get("mappingId"));
  if (/^[1-9]\d{0,3}$/.test(search.get("hours") ?? "") && Number(search.get("hours")) <= 8760) filters.hours = Number(search.get("hours"));
  if (pathname !== UI_BASE && !pathname.startsWith(UI_BASE + "/")) return { name: "notfound" };
  let parts: string[];
  try {
    parts = pathname.slice(UI_BASE.length).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { name: "notfound" };
  }
  if (parts[0] === "admin" && parts.length === 1) return { name: "admin" };
  if (parts[0] === "admin" && parts[1] === "audit" && parts.length === 2) return { name: "admin", tab: "audit", ...(Object.keys(filters).length ? { filters } : {}) };
  if (parts[0] !== "workspaces" || !parts[1]) return { name: "notfound" };
  const slug = parts[1];
  const rest = parts.slice(2);
  if (rest.length === 5 && rest[0] === "projects" && rest[2] === "work-items" && rest[4] === "development" && /^[A-Za-z0-9_-]{1,100}$/.test(rest[1] ?? "") && /^[A-Za-z0-9_-]{1,100}$/.test(rest[3] ?? "")) return { name: "development", slug, projectId: rest[1]!, issueId: rest[3]! };
  if (rest.length === 0) return { name: "mappings", slug };
  if (rest[0] === "account" && rest.length === 1) return { name: "account", slug };
  if (rest[0] === "users" && rest.length === 1) return { name: "users", slug };
  if (rest[0] === "audit" && rest.length === 1) return { name: "audit", slug, ...(Object.keys(filters).length ? { filters } : {}) };
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
