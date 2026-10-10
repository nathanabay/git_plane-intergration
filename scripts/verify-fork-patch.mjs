#!/usr/bin/env node
// Oracle for tasks B1 and B2 (spec §8). Applies each fork patch to a pristine makeplane/plane
// v1.4.2 checkout, enforces the six-file fork surface, and checks the mirrored files are exactly
// the patched result. usage: node scripts/verify-fork-patch.mjs admin|web|all
import { existsSync, readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
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
  admin: { patch: "apps/admin/git-sync.patch", prefixes: ["apps/admin/"], routes: "apps/admin/app/routes.ts", ui: /\/git-sync\/ui\/admin\b/ },
  web: { patch: "apps/web/git-sync.patch", prefixes: ["apps/web/", "packages/constants/"], routes: "apps/web/app/routes.ts", ui: /\/git-sync\/ui\/workspaces\// },
};
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
  if (!files.includes(a.routes)) fail(`${app}: patch does not register the route in ${a.routes}`);
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
  const routesHunk = patch.split(/^diff --git /m).find((h) => h.startsWith(`a/${a.routes} `)) || "";
  if (!/^\+.*\broute\(/m.test(routesHunk)) fail(`${app}: routes.ts hunk adds no route(...) entry`);
}
if (which === "all" && total > 6) fail(`fork surface is ${total} files across both apps; the limit is six`);

if (fails.length) { for (const f of fails) console.error("FAIL: " + f); process.exit(1); }
console.log(`fork patch verification passed (${which})`);
