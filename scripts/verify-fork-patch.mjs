#!/usr/bin/env node
// Oracle for tasks B1 and B2 (spec §8). Applies each fork patch to a pristine makeplane/plane
// v1.4.2 checkout, enforces the six-file fork surface, and checks the mirrored files are exactly
// the patched result. usage: node scripts/verify-fork-patch.mjs admin|web|all
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const which = process.argv[2];
if (!["admin", "web", "all"].includes(which)) { console.error("FAIL: usage: verify-fork-patch.mjs admin|web|all"); process.exit(1); }
const fails = [];
const fail = (m) => fails.push(m);
const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });

const cache = join(homedir(), ".cache", "gitsync", "plane-v1.4.2");
if (!existsSync(join(cache, ".git"))) {
  mkdirSync(dirname(cache), { recursive: true });
  let r = git(["clone", "--quiet", "--depth", "1", "--branch", "v1.4.2", "--filter=blob:none", "--sparse", "https://github.com/makeplane/plane.git", cache]);
  if (r.status !== 0) { console.error("FAIL: cannot clone makeplane/plane v1.4.2: " + r.stderr); process.exit(1); }
  r = git(["sparse-checkout", "set", "apps/admin", "apps/web", "packages/constants"], cache);
  if (r.status !== 0) { console.error("FAIL: sparse-checkout: " + r.stderr); process.exit(1); }
}
if (git(["status", "--porcelain"], cache).stdout.trim()) { console.error(`FAIL: pristine cache ${cache} has local edits; delete it and re-run`); process.exit(1); }

const APPS = {
  admin: { patch: "apps/admin/git-sync.patch", prefixes: ["apps/admin/"], routes: ["apps/admin/app/routes.ts"], ui: /\/git-sync\/ui\/admin\b/,
    routePath: "git-sync", ancestor: null },
  web: { patch: "apps/web/git-sync.patch", prefixes: ["apps/web/", "packages/constants/"], routes: ["apps/web/app/routes.ts", "apps/web/app/routes/extended.ts"], ui: /\/git-sync\/ui\/workspaces\//,
    routePath: ":workspaceSlug/settings/git-sync", ancestor: "./(all)/[workspaceSlug]/(settings)/settings/(workspace)/layout.tsx" },
};
// Evaluates the patched React Router route config with a stub of @react-router/dev/routes and
// enforces what React Router enforces at build time: unique route ids (id defaults to the file
// path without extension). Also locates the new route and its ancestor layout.
async function checkRouteTree(app, a, patchPath) {
  const tmp = mkdtempSync(join(tmpdir(), `gitsync-routes-${app}-`));
  const appDir = `apps/${app}/app`;
  spawnSync("cp", ["-r", join(cache, appDir), join(tmp, "app")]);
  const ap = spawnSync("git", ["apply", "--unsafe-paths", `-p3`, "--include=app/*", patchPath], { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_DIR: "/nonexistent" } });
  if (ap.status !== 0) { fail(`${app}: route-tree copy: patch failed: ${ap.stderr.trim()}`); return; }
  const stub = join(tmp, "node_modules", "@react-router", "dev");
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "@react-router/dev", type: "module", exports: { "./routes": "./routes.js" } }));
  writeFileSync(join(stub, "routes.js"), `
const opts = (o) => (o && !Array.isArray(o) ? o : {});
const kids = (o, c) => (Array.isArray(o) ? o : c);
export const route = (path, file, o, c) => ({ path, file, id: opts(o).id, children: kids(o, c) });
export const layout = (file, o, c) => ({ file, id: opts(o).id, children: kids(o, c) });
export const index = (file, o) => ({ index: true, file, id: opts(o).id });
export const prefix = (p, routes) => routes.map((r) => ({ ...r, path: r.path ? p + "/" + r.path : p }));
`);
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  // Plane uses bundler resolution (extensionless relative imports); rewrite them for Node.
  const fixImports = (dir) => {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      if (statSync(f).isDirectory()) { fixImports(f); continue; }
      if (!/\.ts$/.test(e)) continue;
      const src = readFileSync(f, "utf8").replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (m, a, spec, b) => {
        if (/\.[cm]?[jt]sx?$/.test(spec)) return m;
        const base = join(dirname(f), spec);
        if (existsSync(base + ".ts")) return a + spec + ".ts" + b;
        if (existsSync(join(base, "index.ts"))) return a + spec + "/index.ts" + b;
        return m;
      });
      writeFileSync(f, src);
    }
  };
  if (existsSync(join(tmp, "app", "routes"))) fixImports(join(tmp, "app", "routes"));
  if (existsSync(join(tmp, "app", "routes.ts"))) {
    const r = join(tmp, "app", "routes.ts");
    writeFileSync(r, readFileSync(r, "utf8").replace(/(from\s+["'])(\.\/routes\/[^"'.]+)(["'])/g, "$1$2.ts$3"));
  }
  let tree;
  try { tree = (await import(join(tmp, "app", "routes.ts"))).default; }
  catch (e) { fail(`${app}: patched routes.ts does not evaluate: ${e.message}`); rmSync(tmp, { recursive: true, force: true }); return; }
  const ids = new Map(); let found = null;
  const walk = (nodes, ancestors) => {
    for (const n of nodes || []) {
      const id = n.id || n.file.replace(/^\.\//, "").replace(/\.[jt]sx?$/, "");
      ids.set(id, (ids.get(id) || 0) + 1);
      if (n.path === a.routePath && /git-sync/.test(n.file)) found = { node: n, ancestors };
      walk(n.children, [...ancestors, n.file]);
    }
  };
  walk(tree, []);
  const dupes = [...ids].filter(([, c]) => c > 1).map(([id]) => id);
  if (dupes.length) fail(`${app}: duplicate route ids (React Router rejects these at build): ${dupes.join(", ")}`);
  if (!found) fail(`${app}: merged route tree has no route with path "${a.routePath}" pointing at a git-sync file`);
  else if (a.ancestor && !found.ancestors.includes(a.ancestor)) fail(`${app}: git-sync route is not nested under ${a.ancestor}`);
  rmSync(tmp, { recursive: true, force: true });
}

let total = 0;
for (const app of which === "all" ? ["admin", "web"] : [which]) {
  const a = APPS[app];
  const patchPath = join(root, a.patch);
  if (!existsSync(patchPath)) { fail(`${app}: ${a.patch} missing`); continue; }
  const patch = readFileSync(patchPath, "utf8");
  const files = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => m[2]);
  total += files.length;
  if (files.length === 0) { fail(`${app}: patch touches no files`); continue; }
  if (files.length > 3) fail(`${app}: patch touches ${files.length} files; the fork surface is three files per app`);
  const routesFile = a.routes.find((r) => files.includes(r));
  if (!routesFile) fail(`${app}: patch registers no route in ${a.routes.join(" or ")}`);
  for (const f of files) if (!a.prefixes.some((p) => f.startsWith(p))) fail(`${app}: patch touches ${f}, outside ${a.prefixes.join(", ")}`);

  const chk = git(["apply", "--check", patchPath], cache);
  if (chk.status !== 0) { fail(`${app}: patch does not apply to pristine v1.4.2: ${chk.stderr.trim()}`); continue; }

  const tmp = mkdtempSync(join(tmpdir(), `gitsync-fork-${app}-`));
  for (const f of files) {
    const src = join(cache, f);
    if (existsSync(src)) { mkdirSync(dirname(join(tmp, f)), { recursive: true }); copyFileSync(src, join(tmp, f)); }
  }
  const ap = spawnSync("git", ["apply", "--unsafe-paths", "--directory=.", patchPath], { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_DIR: "/nonexistent" } });
  if (ap.status !== 0) { fail(`${app}: patch failed in scratch copy: ${ap.stderr.trim()}`); rmSync(tmp, { recursive: true, force: true }); continue; }

  let iframe = false, ui = false;
  for (const f of files) {
    const patched = existsSync(join(tmp, f)) ? readFileSync(join(tmp, f), "utf8") : null;
    const mirror = existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null;
    if (patched === null) continue; // deletions are not expected; a deleted file simply has no mirror
    if (mirror === null) fail(`${app}: mirrored copy ${f} missing from this repo`);
    else if (mirror !== patched) fail(`${app}: mirrored ${f} differs from pristine v1.4.2 + patch`);
    if (/<iframe\b/.test(patched)) iframe = true;
    if (a.ui.test(patched)) ui = true;
  }
  rmSync(tmp, { recursive: true, force: true });
  if (!iframe) fail(`${app}: no patched file renders an <iframe>`);
  if (!ui) fail(`${app}: no patched file points at the service UI path ${a.ui}`);
  const routesHunk = patch.split(/^diff --git /m).find((h) => routesFile && h.startsWith(`a/${routesFile} `)) || "";
  if (!/^\+.*\broute\(/m.test(routesHunk)) fail(`${app}: route registration hunk adds no route(...) entry`);
  if (/\bas any\b|@ts-ignore|@ts-expect-error/.test(patch)) fail(`${app}: patch suppresses type errors (as any / @ts-ignore / @ts-expect-error)`);
  await checkRouteTree(app, a, patchPath);
}
if (which === "all" && total > 6) fail(`fork surface is ${total} files across both apps; the limit is six`);

if (fails.length) { for (const f of fails) console.error("FAIL: " + f); process.exit(1); }
console.log(`fork patch verification passed (${which})`);
