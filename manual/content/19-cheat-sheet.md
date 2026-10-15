# 19 · Cheat sheet

<div class="cheat">

**Daily loop:** open the item → In Progress → **Create branch** → `git fetch && git switch <branch>` → commit + push → draft PR → ready + request a reviewer → fix → approve → merge → check that the item is **Done**.

| Intent | Write in the PR | Merge moves the item? |
|---|---|---|
| Finish | branch `WEB-42-…`, title `WEB-42 …`, `Closes WEB-42` | Yes (merge guard) |
| Part of it | branch with no key, `Refs WEB-42` | No |
| Context | `Relates to WEB-42` | Never changes state |
| Exclude a copied key | `skip WEB-42` (body; does not unlink) | — |
| No item yet | `WEB-NEW` in the title | Creates the item |
| Two items | `Closes WEB-42, WEB-45` | Each checked separately |

**Keys:** `WEB-42` (not `WEB_42`, not `WEB-42_x`). Branch keys are any case; title and body keys must be uppercase. `Closes:WEB-42` fails, because a space is needed. The strongest tier wins.

| Smart Commit (runs on **push**, once per SHA) | Effect |
|---|---|
| `WEB-42 #comment Checked at 320 px.` | Plane comment "via &lt;sha&gt; by &lt;login&gt;" |
| `WEB-42 #time 1h 30m` | Comment "Time logged: 1h 30m (90 minutes)"; 1d = 8h, 1w = 5d |
| `WEB-42 #in-review` | Moves to In Review (full hyphenated name) |
| `WEB-33 WEB-34 #in-progress #comment …` | Both items; `#comment` last |

Keys first, on the same line. A rebased or amended commit runs again.

| Default rule | State |
|---|---|
| Branch pushed / PR drafted / PR opened | In Progress |
| Review requested | In Review |
| Merged into `main` | Done (no other linked PR still open) |
| Approved / ready for merge / closed without merge | no change |

| Badge | Means |
|---|---|
| `OPEN · REVIEW` / `REJECTED` / `APPROVAL` | Open: no decision / changes requested / approved |
| `MERGED` / `DECLINED` | Merged / closed without merge |
| `[CI]` `[Deploy]` `[Preview]` | Build, deployment, preview (.vercel.app, .netlify.app, .pages.dev, .amplifyapp.com) |

**Mirroring:** `plane` label on a GitHub issue, `github` label on a Plane item. Six fields: title, description, state, assignees, labels, new comments. GitHub owns title and description by default. Deleting never closes.

*Stuck?* Send your admin the key, PR/commit URL, SHA, time + timezone, expected vs. seen. Never send tokens.

**My GitHub account:** `/git-sync/ui/workspaces/<slug>/account`

**What you learned:** the daily loop, tiers, Smart Commits, defaults, badges and mirroring on one page. **Source files:** `src/parse/references.ts`, `src/github/smart-commits.ts`, `src/github/pr-automation.ts`, `src/sync/dev-info.ts`

</div>
