#!/usr/bin/env node
// Runs node:test over the given repo-relative test directories and requires a minimum number of
// passing tests with zero failures, so an empty or skipped suite cannot pass.
// usage: node scripts/run-tests.mjs <min-tests> <dir> [<dir> ...]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [minArg, ...dirs] = process.argv.slice(2);
const min = Number(minArg);
if (!Number.isInteger(min) || min < 1 || !dirs.length) { console.error("FAIL: usage: run-tests.mjs <min-tests> <dir> [<dir> ...]"); process.exit(1); }
const files = [];
const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.test\.ts$/.test(e)) files.push(p); } };
for (const d of dirs) { const p = join(root, d); if (!existsSync(p)) { console.error(`FAIL: ${d} does not exist`); process.exit(1); } walk(p); }
if (!files.length) { console.error(`FAIL: no *.test.ts files under ${dirs.join(" ")}`); process.exit(1); }
const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: root, encoding: "utf8", timeout: 300000 });
const out = (r.stdout || "") + (r.stderr || "");
const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)$`, "m")) || [])[1] ?? NaN);
const pass = num("pass"), fail = num("fail"), skipped = num("skip"), todo = num("todo"), cancelled = num("cancelled");
if (r.status !== 0 || fail !== 0 || cancelled > 0) {
  console.error(out.split("\n").filter((l) => /^not ok|^\s+(error|message|expected|actual):|FAIL/.test(l)).slice(0, 40).join("\n"));
  console.error(`FAIL: node --test exit ${r.status}, fail=${fail}, cancelled=${cancelled}`); process.exit(1);
}
if (skipped > 0 || todo > 0) { console.error(`FAIL: ${skipped} skipped and ${todo} todo tests; every test must run`); process.exit(1); }
if (!(pass >= min)) { console.error(`FAIL: ${pass} passing tests, at least ${min} required`); process.exit(1); }
console.log(`tests passed (${pass} tests in ${files.length} files)`);
