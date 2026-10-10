#!/usr/bin/env node
// Proves the agent committed once per planned task, after the review pass.
// Task ids are read from the authored part, so the required commit set is
// derived from the artifact and cannot be satisfied by a fixed number.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [part, prefix] = process.argv.slice(2);
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (!part || !prefix) fail("usage: verify-agent-commits.mjs <part-file> <prefix>");
if (!existsSync(part)) fail(`missing plan part: ${part}`);

const text = readFileSync(part, "utf8");
const ids = [...new Set([...text.matchAll(/^###\s+([A-Z]\d+)\b/gm)].map((m) => m[1]))]
  .filter((id) => id.startsWith(prefix));
if (!ids.length) fail(`no ${prefix}-prefixed task headings found in ${part}`);

let log;
try {
  log = execFileSync("git", ["log", "--pretty=format:%H%x09%s"], { encoding: "utf8" });
} catch (e) {
  fail("git log failed: " + (e.stderr?.toString().trim() || e.message));
}
const commits = log.split("\n").filter(Boolean).map((l) => {
  const [sha, ...rest] = l.split("\t");
  return { sha, subject: rest.join("\t") };
});
if (!commits.length) fail("repository has no commits");

// A commit must not only name the task, it must actually change the plan part.
// Subject-only matching certifies commit messages, not work.
const touches = (sha) => {
  try {
    const out = execFileSync("git", ["show", "--numstat", "--format=", sha, "--", part], { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
};

const missing = [];
const empty = [];
const seen = new Map();
for (const id of ids) {
  // Require the task id as a standalone token in the subject.
  const re = new RegExp(`(^|[^A-Za-z0-9])${id}([^A-Za-z0-9]|$)`);
  const named = commits.filter((c) => re.test(c.subject));
  if (!named.length) { missing.push(id); continue; }
  const real = named.find((c) => touches(c.sha));
  if (!real) { empty.push(id); continue; }
  seen.set(id, real.sha);
}
if (missing.length) fail(`no commit references task(s): ${missing.join(", ")}`);
if (empty.length) fail(`commit(s) name task(s) ${empty.join(", ")} but change nothing in ${part}; empty commits are not work`);

// Distinct commits: one shared commit for every task is not "a commit on every task".
const shas = new Set([...seen.values()]);
if (shas.size < ids.length) {
  fail(`${ids.length} tasks map to only ${shas.size} distinct commit(s); each task needs its own commit`);
}
console.log(`agent commit verification passed (${ids.length} tasks, ${shas.size} distinct commits)`);
