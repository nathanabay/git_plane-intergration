#!/usr/bin/env node
// Runs node:test over the given repo-relative test directories and requires a minimum number of
// passing tests with zero failures, so an empty or skipped suite cannot pass.
// usage: node scripts/run-tests.mjs <min-tests> <dir> [<dir> ...]
import { spawn } from "node:child_process";
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
// Bounded on purpose: each test file runs in its own child process and many start a PGlite
// (Postgres in WASM, ~0.8 GB), so unbounded parallelism exhausted the host (2026-10-11). The heap
// limit goes through NODE_OPTIONS because child workers do not inherit command-line flags, and the
// run gets its own process group so a timeout kills every worker instead of orphaning them.
const r = await new Promise((resolveRun) => {
  const child = spawn(process.execPath, ["--test", "--test-concurrency=2", "--test-reporter=tap", ...files], {
    cwd: root, detached: true, env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=1536"].filter(Boolean).join(" ") },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
  const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
  const timer = setTimeout(() => { stderr += "\nFAIL: test run exceeded 30 minutes; process group killed"; killGroup(); }, 30 * 60 * 1000);
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { killGroup(); process.exit(1); });
  child.on("close", (status) => { clearTimeout(timer); killGroup(); resolveRun({ status, stdout, stderr }); });
});
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
