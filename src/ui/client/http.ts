// fetch wrapper for the config API. The browser attaches Plane's session cookie (same origin) and
// the right Origin header; nothing here handles credentials itself.
export const API_BASE = "/git-sync/api";

export class ApiError extends Error {
  status: number;
  readonly reason?: string;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export function isNotAuthorised(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

export function failedWriteId(entry: { kind: string; outcome: string; detail: unknown }): string | null {
  if (entry.kind !== "outbound_write_failed" || entry.outcome !== "failed" || !entry.detail || typeof entry.detail !== "object") return null;
  const id = (entry.detail as { outboxId?: unknown }).outboxId;
  return typeof id === "string" && /^[A-Za-z0-9_.:@-]{1,200}$/.test(id) ? id : null;
}

export function retryFailedWrite(slug: string, id: string): Promise<{ id: string; status: string }> {
  return api("POST", `/workspaces/${encodeURIComponent(slug)}/outbound-writes/${encodeURIComponent(id)}/retry`);
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Could not reach the git-sync service");
  }
  if (res.status === 204) return undefined as T;
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const msg = typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : `Request failed (${res.status})`;
    const reason = typeof payload === "object" && payload !== null && typeof (payload as { reason?: unknown }).reason === "string"
      ? (payload as { reason: string }).reason : undefined;
    throw new ApiError(res.status, msg, reason);
  }
  return payload as T;
}
