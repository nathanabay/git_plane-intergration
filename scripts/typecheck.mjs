#!/usr/bin/env node
// Typechecks only the given repo-relative globs against the shared tsconfig.json, so one leaf's
// gate is not failed by another leaf's in-progress files in the shared working tree.
// usage: node scripts/typecheck.mjs "src/rules/**/*.ts" "tests/rules/**/*.ts"
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const globs = process.argv.slice(2);
if (!globs.length) { console.error("FAIL: usage: typecheck.mjs <glob> [<glob> ...]"); process.exit(1); }

const dir = join(root, "node_modules", ".cache");
mkdirSync(dir, { recursive: true });
const cfg = join(dir, `typecheck-${process.pid}.json`);
writeFileSync(cfg, JSON.stringify({
  extends: join(root, "tsconfig.json"),
  include: globs.map((g) => join(root, g)),
}));
const tsc = join(root, "node_modules", ".bin", "tsc");
const r = spawnSync(tsc, ["--noEmit", "-p", cfg, "--listFilesOnly"], { encoding: "utf8" });
const files = (r.stdout || "").split("\n").filter((f) => f.startsWith(root + "/src/") || f.startsWith(root + "/tests/"));
const t = spawnSync(tsc, ["--noEmit", "-p", cfg], { encoding: "utf8" });
rmSync(cfg, { force: true });
if (!files.length) { console.error(`FAIL: no source files matched ${globs.join(" ")}`); process.exit(1); }
if (t.status !== 0) {
  process.stdout.write(t.stdout || ""); process.stderr.write(t.stderr || "");
  console.error(`FAIL: tsc reported errors (exit ${t.status})`);
  process.exit(1);
}
console.log(`typecheck passed (${files.length} project files)`);
