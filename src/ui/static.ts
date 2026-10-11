// Serves the built React app: GET /git-sync/ui/* maps to files under distDir, and any path that is
// not a file falls back to index.html so both entry routes (and every client-side route) load.
import { readFile } from "node:fs/promises";
import { join, resolve, sep, extname } from "node:path";
import type { Route } from "../index.ts";
import { sendJson } from "./http.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// Served from Plane's own origin and embedded by Plane's frontends: same-origin framing only, no
// third-party scripts. api.github.com is for the browser-side GitHub id lookup.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "connect-src 'self' https://api.github.com",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/** dist/ui next to the source tree, which is where the Dockerfile puts the build. */
export function defaultUiDistDir(): string {
  return resolve(import.meta.dirname, "../../dist/ui");
}

export function createUiRoutes(opts: { distDir: string }): Route[] {
  const dist = resolve(opts.distDir);

  const serve = async (res: import("node:http").ServerResponse, file: string, immutable: boolean) => {
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      sendJson(res, 404, { error: "Not Found" });
      return;
    }
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "content-type": type,
      "content-length": String(data.length),
      "x-content-type-options": "nosniff",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (type.startsWith("text/html")) {
      headers["content-security-policy"] = CSP;
      headers["referrer-policy"] = "same-origin";
    }
    res.writeHead(200, headers);
    res.end(data);
  };

  const handler: Route["handler"] = async (_req, res, params) => {
    const rel = params["*"] ?? "";
    if (rel.includes("\0")) { sendJson(res, 400, { error: "Bad Request" }); return; }
    const target = resolve(join(dist, rel));
    if (target !== dist && !target.startsWith(dist + sep)) { sendJson(res, 404, { error: "Not Found" }); return; }
    const ext = extname(rel).toLowerCase();
    if (rel !== "" && ext !== "" && ext !== ".html") {
      // A missing asset is a 404, not the app shell: serving HTML for a .js URL hides deploy mistakes.
      await serve(res, target, rel.startsWith("assets/"));
      return;
    }
    await serve(res, join(dist, "index.html"), false);
  };

  return [{ method: "GET", path: "/git-sync/ui/*", handler }];
}
