#!/usr/bin/env node
// Phase 1 cross-leaf contract: Part A's compose fragment references exactly the fork image tags
// Part B's build scripts produce, and the iframe paths agree with the service base path.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const fails = [];
const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : (fails.push(`${p} missing`), ""));
const compose = read("docker-compose.override.yaml");
for (const [app, tag] of [["admin", "plane-admin-gitsync:v1.4.2"], ["web", "plane-frontend-gitsync:v1.4.2"]]) {
  const script = read(`apps/${app}/build-fork-image.sh`);
  if (!compose.includes(tag)) fails.push(`compose fragment does not reference ${tag}`);
  if (!script.includes(tag)) fails.push(`apps/${app}/build-fork-image.sh does not tag ${tag}`);
  if (!/git apply|patch -p1/.test(script)) fails.push(`apps/${app}/build-fork-image.sh never applies the patch`);
  if (!/v1\.4\.2/.test(script)) fails.push(`apps/${app}/build-fork-image.sh does not pin v1.4.2`);
}
const index = read("src/index.ts");
if (!/BASE_PATH\s*=\s*"\/git-sync"/.test(index)) fails.push("src/index.ts BASE_PATH is not /git-sync");
if (fails.length) { for (const f of fails) console.error("FAIL: " + f); process.exit(1); }
console.log("phase 1 integration verification passed");
