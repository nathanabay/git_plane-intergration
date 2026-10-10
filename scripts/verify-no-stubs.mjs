#!/usr/bin/env node
// Fails when any file under the given repo-relative paths carries a placeholder marker or a stub
// body. usage: node scripts/verify-no-stubs.mjs <path> [<path> ...]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const paths = process.argv.slice(2);
if (!paths.length) { console.error("FAIL: usage: verify-no-stubs.mjs <path> [<path> ...]"); process.exit(1); }
const PATTERNS = [
  /\b(TBD|TODO|FIXME|XXX|PLACEHOLDER)\b/,
  /not (yet )?implemented/i,
  /\bunimplemented\b/i,
  /throw new Error\(\s*["'`](stub|todo|implement me)/i,
];
const hits = []; let scanned = 0;
const scan = (p) => {
  if (statSync(p).isDirectory()) { for (const e of readdirSync(p)) if (e !== "node_modules") scan(join(p, e)); return; }
  if (!/\.(ts|tsx|mjs|js|sql|ya?ml|md|json|patch)$|Dockerfile$|Caddyfile$/.test(p)) return;
  scanned++;
  readFileSync(p, "utf8").split("\n").forEach((line, i) => {
    for (const re of PATTERNS) if (re.test(line)) hits.push(`${relative(root, p)}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
};
for (const p of paths) { const abs = join(root, p); if (!existsSync(abs)) { console.error(`FAIL: ${p} does not exist`); process.exit(1); } scan(abs); }
if (!scanned) { console.error("FAIL: no files scanned"); process.exit(1); }
if (hits.length) { for (const h of hits) console.error("FAIL: " + h); process.exit(1); }
console.log(`stub scan passed (${scanned} files)`);
