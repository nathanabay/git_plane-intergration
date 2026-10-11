import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res: ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}): void {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function hasBody(req: IncomingMessage): boolean {
  const len = req.headers["content-length"];
  if (req.headers["transfer-encoding"] !== undefined) return true;
  return len !== undefined && len !== "0";
}

export function isJsonContentType(header: string | undefined): boolean {
  return (header ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Reads and parses a JSON request body, refusing anything over `limit` bytes. */
export async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "Request body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(buf);
  }
  if (size === 0) throw new HttpError(400, "Request body required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}
