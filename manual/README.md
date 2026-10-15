# git-sync for Plane — Developer & Admin Manual (sources)

The illustrated manual for git-sync (two-way GitHub sync for self-hosted Plane CE v1.4.2).

| Output | Path |
|---|---|
| PDF | `manual/dist/git-sync-user-manual.pdf` |
| HTML (one file, images relative) | `manual/dist/git-sync-user-manual.html` |
| One-page cheat sheet | `manual/dist/cheat-sheet.pdf` |

## Layout

```
manual/
  README.md  outline.md  storyboard.yaml (all shots)  storyboard-new.yaml (capture input)  REVIEW_NOTES.md
  notes/      feature-inventory.md  discrepancies.md  glossary.md  verified-strings.md  style.md  demo-data.md
              label-allowlist.txt  demo-output/ (verbatim outputs of the demo run, dialog texts)
  content/    NN-*.md chapters (00 intro, Part A 01–19, Part B 20–30, appendices 90–95)
  images/     demo/ (new, from the demo instance)  handbook/ and userguide/ (reused real captures)
  diagrams/   SVG diagrams reused from the handbook and user guide (Mermaid diagrams live inline in the chapters)
  demo/       server.ts (demo instance), seed.ts, events.ts, restart.sh, run-loop.sh, try.mjs, dom.mjs
  scripts/    seed.mjs  capture.mjs  build.mjs  manual.css  grammar-tables.mjs  check-labels.mjs  verify.mjs  contact-sheet.mjs
  reports/    capture-report.md  qa-report.md  build.json
  dist/       outputs
```

## Commands

```sh
npm i --no-save --package-lock=false playwright markdown-it mermaid@11 && npx playwright install chromium
npm run manual:seed        # start the local demo instance (real git-sync code, throwaway data) on :3199
npm run manual:capture     # capture all demo screenshots (restarts the demo server); -- --only <id>[,<id>] for some
npm run manual:build       # regenerate grammar tables from the real parsers, then build PDF + HTML + cheat sheet
npm run manual:verify      # verifier: outputs, images, placeholders, secrets, labels, links, coverage
npm run manual:all         # capture + build + verify
```

Screenshots that need a real signed-in browser (GitHub forms, GitHub comments, Plane's own work-item sidebar) are
`[[SCREENSHOT NEEDED]]` placeholders; see `REVIEW_NOTES.md` → Blocked items for how to capture them.

Never commit `manual/.auth/` or `manual/.env` (both are git-ignored).
