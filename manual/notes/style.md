# Writing conventions for the manual (all chapter writers follow these)

## Files
- Chapters: `manual/content/NN-slug.md`, two-digit number = chapter number (00 = front matter, 90+ = appendices).
- First line: `# NN · Title` (e.g. `# 09 · Linking branches, commits and PRs`). Appendices: `# Appendix A · All routes`.
- Part dividers are separate files: `manual/content/00a-part-a.md` and `19z-part-b.md`, containing only `<div class="part">…</div>`.
- Paths in Markdown are relative to `manual/content/`.

## Images
- Demo-instance screenshots: `![Screenshot (demo instance): <caption>](../images/demo/<id>.png)`.
- Handbook screenshots (real test Plane / GitHub): `![Screenshot (test Plane): <caption>](../images/handbook/<file>.png)`
  or `Screenshot (GitHub)`. Admin-guide ones: `../images/userguide/<file>.png`.
- Diagrams: `![Diagram: <caption>](../diagrams/<file>.svg)`; drawings of screens we could not capture: `![Illustration: …]`.
- Every image alt text MUST start with `Screenshot (…):`, `Diagram:`, `Illustration:` or `Strip (demo instance):`.
- An image is its own paragraph. Numbers in the caption/steps match the orange callouts (①②… in the image).
- When no real screenshot can exist, write one paragraph exactly like:
  `[[SCREENSHOT NEEDED: <id> — <what to capture>. Capture later with npm run manual:capture -- --only <id>]]`
- "demo instance" = the real git-sync service code and UI, run locally on a throwaway database with demo data and stand-ins
  for Plane's and GitHub's APIs (see the Introduction, "About the screenshots"). Never call those Plane screenshots.

## Boxes (blockquotes whose first word is bold)
`> **Tip:** …`, `> **Note:** …`, `> **Warning:** …`, `> **Example:** …`, `> **Admin only:** …`

## Procedures
```
### Goal: <what the reader achieves>
**Before you start:** …
**Steps**
1. Open **Workspace settings → GitHub Sync**. ①
2. …
**Result:** … (followed by the result screenshot)
**If it went wrong:** … (bullets: symptom → cause → fix)
```

## Language
- UI labels in **bold**, exactly as on screen (check `manual/notes/verified-strings.md`). Plane menu = **GitHub Sync**;
  git-sync page headings = **Git sync: <slug>** / **Git sync: instance settings**. Field is **Sync direction**.
- Code, keys, branch names, env vars, routes in `backticks`. Use the demo names: workspace **Acme** (slug `acme`), project
  **Website** (`WEB`), repo `acme/website`, people Alex Developer (`alex-dev`), Sam Reviewer (`sam-reviews`),
  Jordan Admin (`jordan-acme`), Riley New (not yet connected).
- Plain, direct sentences; second person ("you"). Short paragraphs. No marketing words.
- Never invent a feature; code wins over old docs (see `manual/notes/discrepancies.md`). State limitations honestly.
- Every chapter ends with `## What you learned` (3–5 bullets) and `## Source files` (bullets of repo paths, for maintainers).

## Mermaid
Fenced blocks with language `mermaid` are rendered at build time. Keep them small (≤ 12 nodes), `flowchart TD` or `LR`.
Caption a diagram with a following paragraph `*Diagram: …*`.

## Text posted to GitHub
We have no GitHub screenshots of git-sync's own comments. Show them as verbatim text captured from the demo run, in a fenced
block with a caption paragraph `*Text git-sync posted to GitHub in the demo run.*` (files in `manual/notes/demo-output/`).
