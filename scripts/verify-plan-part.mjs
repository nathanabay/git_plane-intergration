#!/usr/bin/env node
// Verifies one authored implementation-plan part against structural rules and
// cross-checks every spec reference against the real spec headings.
// Exits nonzero on any failure; prints the success marker only at the end.
import { readFileSync, existsSync } from "node:fs";

const [file, prefix] = process.argv.slice(2);
const SPEC = "docs/superpowers/specs/2026-10-10-plane-github-sync-design.md";
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };

if (!file || !prefix) fail("usage: verify-plan-part.mjs <file> <taskPrefix>");
if (!existsSync(file)) fail(`missing plan part: ${file}`);
if (!existsSync(SPEC)) fail(`missing spec: ${SPEC}`);

const text = readFileSync(file, "utf8");
const spec = readFileSync(SPEC, "utf8");
if (text.trim().length < 800) fail(`${file} is too short to be a real plan (${text.trim().length} bytes)`);

// 1. no placeholders
const ph = [...text.matchAll(/\b(TBD|TODO|FIXME|XXX|PLACEHOLDER)\b/gi)].map((m) => m[0]);
if (ph.length) fail(`placeholder tokens present: ${[...new Set(ph)].join(", ")}`);

// 2. task headings, correctly prefixed and contiguous from 1
const heads = [...text.matchAll(/^###\s+([A-Z])(\d+)\b[^\n]*/gm)];
if (!heads.length) fail("no task headings found (expected '### <PREFIX><n> ...')");
const wrong = heads.filter((h) => h[1] !== prefix);
if (wrong.length) fail(`task ids must use prefix ${prefix}; found ${wrong.map((w) => w[1] + w[2]).join(", ")}`);
const nums = heads.map((h) => Number(h[2]));
if (new Set(nums).size !== nums.length) fail(`duplicate task ids: ${nums.join(",")}`);
const sorted = [...nums].sort((a, b) => a - b);
for (let i = 0; i < sorted.length; i++) {
  if (sorted[i] !== i + 1) fail(`task ids must run 1..n with no gaps; got ${sorted.join(",")}`);
}
if (nums.length < 4) fail(`only ${nums.length} tasks; a plan part this size needs real decomposition`);

// 3. every task carries Files / Depends / Acceptance
const blocks = text.split(/^###\s+/m).slice(1);
for (const b of blocks) {
  const id = prefix + (b.match(/^(\d+)/)?.[1] ?? "?");
  for (const field of ["Files:", "Depends:", "Acceptance:"]) {
    if (!new RegExp("\\*\\*" + field + "\\*\\*").test(b)) fail(`task ${id} is missing **${field}**`);
  }
  const acc = b.match(/\*\*Acceptance:\*\*\s*([^\n]+)/)?.[1]?.trim() ?? "";
  if (acc.length < 20) fail(`task ${id} has a non-substantive Acceptance line`);
  const files = b.match(/\*\*Files:\*\*\s*([^\n]+)/)?.[1] ?? "";
  if (/(^|[\s,`])\//.test(files) || files.includes("..")) fail(`task ${id} Files must be repo-relative without traversal: ${files}`);
  if (!/[a-zA-Z0-9]/.test(files)) fail(`task ${id} Files is empty`);
}

// 4. every spec reference resolves to a real spec heading
const specHeads = new Set();
for (const m of spec.matchAll(/^#{2,3}\s+(\d+(?:\.\d+)?)\./gm)) specHeads.add(m[1]);
if (specHeads.size === 0) fail("could not parse any headings out of the spec; check parser");
const refs = [...new Set([...text.matchAll(/§(\d+(?:\.\d+)?)/g)].map((m) => m[1]))];
if (!refs.length) fail("plan part cites no spec sections (§N); it must trace to the spec");
const dangling = refs.filter((r) => !specHeads.has(r));
if (dangling.length) fail(`plan cites spec sections that do not exist: ${dangling.join(", ")}`);

console.log(`plan part verification passed (${nums.length} tasks, ${refs.length} spec refs)`);
