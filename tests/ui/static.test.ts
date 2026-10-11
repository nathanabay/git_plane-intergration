import test, { after, before } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/index.ts";
import type { RunningServer } from "../../src/index.ts";
import { createUiRoutes } from "../../src/ui/api.ts";
import { buildUi } from "../../src/ui/build.mjs";

let dir: string;
let srv: RunningServer;
let url: string;
let outside: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gitsync-ui-test-"));
  outside = join(dir, "secret.txt");
  writeFileSync(outside, "TOP SECRET");
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, "assets", "app-1.js"), "console.log(1)");
  writeFileSync(join(dist, "assets", "app-1.css"), "body{}");
  srv = await startServer({ port: 0, host: "127.0.0.1", routes: createUiRoutes({ distDir: dist }) });
  url = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const status = (path: string) => new Promise<number>((res, rej) => {
  const r = request({ host: "127.0.0.1", port: srv.port, path }, (rs) => { rs.resume(); res(rs.statusCode ?? 0); });
  r.on("error", rej); r.end();
});

test("static: both entry routes and nested client routes serve the app shell as HTML", async () => {
  for (const p of ["/git-sync/ui", "/git-sync/ui/", "/git-sync/ui/admin", "/git-sync/ui/workspaces/acme", "/git-sync/ui/workspaces/acme/mappings/3/rules"]) {
    const r = await fetch(url + p);
    strictEqual(r.status, 200, p);
    ok((r.headers.get("content-type") ?? "").startsWith("text/html"), p);
    ok((await r.text()).includes('<div id="root"'), p);
  }
});

test("static: assets carry their types and long-lived caching; the shell is never cached", async () => {
  const js = await fetch(`${url}/git-sync/ui/assets/app-1.js`);
  strictEqual(js.status, 200);
  ok(/javascript/.test(js.headers.get("content-type") ?? ""));
  ok(/immutable/.test(js.headers.get("cache-control") ?? ""));
  const css = await fetch(`${url}/git-sync/ui/assets/app-1.css`);
  ok((css.headers.get("content-type") ?? "").startsWith("text/css"));
  strictEqual((await fetch(`${url}/git-sync/ui/admin`)).headers.get("cache-control"), "no-cache");
});

test("static: the shell restricts scripts to self and framing to the same origin", async () => {
  const csp = (await fetch(`${url}/git-sync/ui/admin`)).headers.get("content-security-policy") ?? "";
  ok(/script-src 'self'(;|$)/.test(csp), csp);
  ok(/frame-ancestors 'self'/.test(csp), csp);
  strictEqual((await fetch(`${url}/git-sync/ui/admin`)).headers.get("x-content-type-options"), "nosniff");
});

test("static: a missing asset is 404, not the HTML shell", async () => {
  strictEqual((await fetch(`${url}/git-sync/ui/assets/missing.js`)).status, 404);
});

test("static: path traversal is refused", async () => {
  for (const p of ["/git-sync/ui/%2e%2e/%2e%2e/etc/passwd", "/git-sync/ui/..%2f..%2fsecret.txt", "/git-sync/ui/assets/%2e%2e/%2e%2e/secret.txt", "/git-sync/ui/%00"]) {
    const s = await status(p);
    ok([400, 404].includes(s), `${p} → ${s}`);
  }
});

test("static: only GET is served", async () => {
  strictEqual((await fetch(`${url}/git-sync/ui/admin`, { method: "POST" })).status, 405);
});

test("build: bundles the real app into index.html, a hashed script and a stylesheet", async () => {
  const out = join(dir, "built");
  const r = await buildUi(out);
  ok(r.js.endsWith(".js") && r.css?.endsWith(".css"));
  const ui = await startServer({ port: 0, host: "127.0.0.1", routes: createUiRoutes({ distDir: out }) });
  try {
    const html = await (await fetch(`http://127.0.0.1:${ui.port}/git-sync/ui/workspaces/acme`)).text();
    ok(html.includes(`/git-sync/ui/assets/${r.js}`) && html.includes(`/git-sync/ui/assets/${r.css}`) && html.includes('<div id="root"></div>'));
    const js = await fetch(`http://127.0.0.1:${ui.port}/git-sync/ui/assets/${r.js}`);
    strictEqual(js.status, 200);
    ok((await js.text()).length > 10_000, "bundle looks empty");
  } finally { await ui.close(); }
});
