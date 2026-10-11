import { createHash } from "node:crypto";

export type Side = "plane" | "github";

const isScalar = (v: unknown): boolean => v === null || v === undefined || typeof v !== "object";

function canonical(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    // Only arrays of scalars are sets (labels, assignees); object arrays keep their order.
    if (value.every(isScalar)) return items.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
    return items;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Canonical JSON of a field value. Strings are never trimmed or case-folded: Plane compares exact values. */
export function normalizeValue(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** The one hash both the write path (when recording) and ingress (when consuming) use. Field-granular (§5). */
export function opHash(side: Side, targetId: string, field: string, value: unknown): string {
  return createHash("sha256").update(JSON.stringify([side, targetId, field, normalizeValue(value)])).digest("hex");
}
