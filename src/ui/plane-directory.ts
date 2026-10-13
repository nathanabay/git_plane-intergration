import type { PlaneClient } from "../sync/plane.ts";
import { planeWorkspacePath } from "../sync/plane.ts";
import type { PlaneMember, PlaneProject, PlaneState } from "./client/types.ts";
import { HttpError } from "./http.ts";

export type PlaneDirectory = Pick<PlaneClient, "listAll" | "listStates">;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

export async function listProjects(plane: PlaneDirectory, slug: string): Promise<PlaneProject[]> {
  const rows = await plane.listAll<Record<string, unknown>>(planeWorkspacePath(slug, "projects"));
  return rows.map((row) => {
    const id = text(row.id), name = text(row.name), identifier = text(row.identifier);
    if (!id || !name) throw new HttpError(502, "Plane returned an unreadable project");
    return { id, name, identifier, label: identifier ? `${identifier} · ${name}` : name };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listMembers(plane: PlaneDirectory, slug: string): Promise<PlaneMember[]> {
  const rows = await plane.listAll<Record<string, unknown>>(planeWorkspacePath(slug, "members-lite"));
  return rows.filter((row) => row.is_active !== false && row.is_bot !== true).map((row) => {
    const id = text(row.id);
    const email = text(row.email) || null;
    const name = text(row.display_name) || [text(row.first_name), text(row.last_name)].filter(Boolean).join(" ") || email || "Unnamed member";
    if (!id) throw new HttpError(502, "Plane returned an unreadable member");
    return { id, name, email };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listStates(plane: PlaneDirectory, slug: string, projectId: string): Promise<PlaneState[]> {
  const rows = await plane.listStates(encodeURIComponent(slug), encodeURIComponent(projectId));
  return rows.filter((row) => row.group !== "triage").map(({ id, name, group }) => {
    if (!id || !name || !group) throw new HttpError(502, "Plane returned an unreadable state");
    return { id, name, group };
  });
}
