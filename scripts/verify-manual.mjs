#!/usr/bin/env node
// Oracle for docs/manual: structure, coverage, working links and images, and no leaked secrets.
// Prints "MANUAL VERIFIED" only when every check passes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = join(ROOT, "docs", "manual");
const fail = [];
const need = (cond, msg) => { if (!cond) fail.push(msg); };
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const words = (t) => t.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;

const pages = { index: "README.md", user: "user-guide.md", dev: "developer-guide.md" };
const text = Object.fromEntries(Object.entries(pages).map(([k, f]) => [k, read(join(DIR, f))]));
for (const [k, f] of Object.entries(pages)) need(text[k], `docs/manual/${f} is missing`);
need(words(text.user) >= 3500, `user guide has ${words(text.user)} words, needs at least 3500`);
need(words(text.dev) >= 3500, `developer guide has ${words(text.dev)} words, needs at least 3500`);

// Every markdown file under docs/manual: relative links and images must resolve.
const md = [];
const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".md")) md.push(p); } };
if (existsSync(DIR)) walk(DIR);
let imageRefs = 0;
for (const file of md) {
  const t = read(file);
  for (const m of t.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const [, bang, target] = m;
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = resolve(dirname(file), decodeURIComponent(target.split("#")[0]));
    need(existsSync(path), `${file.replace(ROOT + "/", "")}: broken ${bang ? "image" : "link"} ${target}`);
    if (bang) imageRefs++;
  }
  for (const m of t.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    if (/^https?:/.test(m[1])) continue;
    need(existsSync(resolve(dirname(file), m[1])), `${file.replace(ROOT + "/", "")}: broken <img> ${m[1]}`);
    imageRefs++;
  }
}
need(imageRefs >= 15, `${imageRefs} images referenced, needs at least 15`);
const imgDir = join(DIR, "images");
const imgs = existsSync(imgDir) ? readdirSync(imgDir) : [];
const png = imgs.filter((f) => f.endsWith(".png")), svg = imgs.filter((f) => f.endsWith(".svg"));
need(png.length >= 8, `${png.length} PNG screenshots in docs/manual/images, needs at least 8`);
need(svg.length >= 3, `${svg.length} SVG diagrams in docs/manual/images, needs at least 3`);
for (const f of png) { const b = readFileSync(join(imgDir, f)); need(b.length > 2000 && b.subarray(1, 4).toString() === "PNG", `images/${f} is not a real PNG`); }
for (const f of svg) need(/<svg[\s>]/.test(read(join(imgDir, f))), `images/${f} is not an SVG`);

// Coverage: the topics a reader needs.
const topics = {
  user: [/install\.sh/, /bot|service account/i, /webhook/i, /git-sync\.internal/, /WEBHOOK_ALLOWED_HOSTS/, /GitHub App/, /client (ID|secret)/i,
    /private key/i, /connect.{0,40}repositor/i, /smart commit|magic word/i, /troubleshoot/i, /--uninstall/, /God mode/i],
  dev: [/architecture/i, /webhook/i, /queue|BullMQ/i, /Postgres/i, /src\/install/, /verify-install-e2e/, /verify-install-real-plane/,
    /npm test|run-tests/, /migration/i, /echo/i, /GITSYNC_TOKEN_KEY/, /docker-compose\.override/],
};
for (const [k, list] of Object.entries(topics)) for (const re of list) need(re.test(text[k]), `${pages[k]} does not cover ${re}`);

// Every setting in the env example and in the config loader is documented in the developer guide.
const envKeys = new Set([...read(join(ROOT, "deploy/git-sync.env.example")).matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]));
for (const m of read(join(ROOT, "src/config/env.ts")).matchAll(/\b(?:req\(|env\.)"?([A-Z][A-Z0-9_]{2,})/g)) envKeys.add(m[1]);
for (const k of envKeys) need(text.dev.includes(k), `developer guide does not document ${k}`);

// No secrets anywhere in the manual (text files; screenshots are reviewed by hand).
const secretRes = [/plane_api_[0-9a-f]{8,}/, /plane_wh_[0-9a-f]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bgh[opsu]_[A-Za-z0-9]{20,}/, /58b72701b724/, /\b[0-9a-f]{64}\b/];
const textFiles = [];
const walkAll = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walkAll(p); else if (/\.(md|svg|html|txt|json)$/.test(p)) textFiles.push(p); } };
if (existsSync(DIR)) walkAll(DIR);
for (const f of textFiles) { const t = read(f); for (const re of secretRes) need(!re.test(t), `${f.replace(ROOT + "/", "")} contains something that looks like a secret (${re})`); }

if (fail.length) { console.log(`MANUAL CHECK FAILED (${fail.length}):\n - ${fail.join("\n - ")}`); process.exit(1); }
console.log(`MANUAL VERIFIED: ${md.length} pages, ${words(text.user)} + ${words(text.dev)} words, ${imageRefs} image references (${png.length} PNG, ${svg.length} SVG), ${envKeys.size} settings documented`);
