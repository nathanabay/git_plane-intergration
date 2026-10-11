#!/usr/bin/env node
// Bundles the React config app with esbuild and writes the HTML shell.
// usage: node src/ui/build.mjs --outdir dist/ui
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const UI_BASE = "/git-sync/ui";

export async function buildUi(outdir) {
  const out = resolve(outdir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const result = await build({
    entryPoints: [join(import.meta.dirname, "app.tsx")],
    outdir: join(out, "assets"),
    entryNames: "[name]-[hash]",
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
  });
  const outputs = Object.keys(result.metafile.outputs);
  const js = outputs.find((f) => f.endsWith(".js"));
  const css = outputs.find((f) => f.endsWith(".css"));
  if (!js) throw new Error("esbuild produced no JavaScript bundle");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Git sync</title>
${css ? `<link rel="stylesheet" href="${UI_BASE}/assets/${basename(css)}">\n` : ""}</head>
<body>
<div id="root"></div>
<script type="module" src="${UI_BASE}/assets/${basename(js)}"></script>
</body>
</html>
`;
  writeFileSync(join(out, "index.html"), html);
  return { js: basename(js), css: css ? basename(css) : null };
}

// @ts-ignore - import.meta.main is available in Node 24
if (import.meta.main) {
  const i = process.argv.indexOf("--outdir");
  const outdir = i >= 0 ? process.argv[i + 1] : undefined;
  if (!outdir) {
    console.error("usage: node src/ui/build.mjs --outdir <dir>");
    process.exit(2);
  }
  buildUi(outdir).then(
    (r) => console.log(`built ${r.js}${r.css ? ` and ${r.css}` : ""} into ${outdir}`),
    (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); },
  );
}
