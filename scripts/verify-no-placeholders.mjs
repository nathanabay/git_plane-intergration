#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from "node:fs";
const DIR = "docs/plan";
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (!existsSync(DIR)) fail(`missing ${DIR}`);
const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
if (files.length < 4) fail(`expected the four plan artifacts, found ${files.length}: ${files.join(", ")}`);
let scanned = 0;
for (const f of files) {
  const t = readFileSync(`${DIR}/${f}`, "utf8");
  const hits = [...t.matchAll(/\b(TBD|TODO|FIXME|XXX|PLACEHOLDER)\b/g)].map((m) => m[0]);
  if (hits.length) fail(`${f} contains ${[...new Set(hits)].join(", ")}`);
  scanned++;
}
console.log(`placeholder scan passed (${scanned} files)`);
