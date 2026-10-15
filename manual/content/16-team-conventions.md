# 16 · Team conventions

Everything in this chapter is a **suggested team convention**. None of it is enforced by git-sync. These are habits that make the automation predictable and the history readable. Agree on a short list with your team, write it on a Plane **Page** (the demo project keeps *Website working agreement* for this), and review it when something surprises you.

## Work items

- **Write an outcome, not a topic.** "Keep the checkout button visible on small screens" can be finished; "Checkout improvements" cannot.
- **Put acceptance checks in the description.** Say what proves the work is done, for example: *Button visible at 320, 375 and 390 px; focus indicator visible.* Keep the description current. Use comments for the conversation.
- **One owner per item.** Several people can help, but one person moves the item forward and asks for review.
- **For bugs:** steps to reproduce, actual result and expected result. Add a screenshot if it helps, but write enough text that the item makes sense without it.
- *Never paste secrets* (tokens, passwords, customer data) into items, comments or commit messages. Mirrored issues copy text to GitHub.

## Branch names

| Situation | Convention | Why |
|---|---|---|
| The branch finishes one item | Use **Create branch** or **Copy branch name** (`WEB-42-make-the-checkout-…`) | The key in the branch is a closing reference, and everyone's names look the same |
| The branch is part of a bigger item | No key in the name: `checkout-layout-part-one` | Otherwise the branch key makes the PR closing |
| Revert | Keep GitHub's `revert-…` name, but edit the PR text (Chapter 15, Variant D) | `revert-` branches never restart work by themselves |
| Spelling | `WEB-42`, with a hyphen and no underscore after the number | `WEB_42` and `WEB-42_fix` are not recognized |

## PR titles and bodies

Decide *before you open the PR* what it should do to the item, because the first parse creates the link:

| Intent | Write | Avoid |
|---|---|---|
| Finish the item | `WEB-42 …` in the title and `Closes WEB-42` in the body | — |
| Contribute part | `Refs WEB-42` in the title and body, branch without the key | A bare `WEB-42` in the title or branch |
| Mention as context | `Relates to WEB-42` in the body | Any bare key in the title or branch |
| Copied template mentions a key | `skip WEB-42` in the body | Removing it later and expecting the link to vanish |
| No item yet | `WEB-NEW …` in the title | Creating the Plane item by hand at the same time |

A useful PR body has four short parts: **purpose** (with the Plane reference first), *what changed*, *how it was checked*, and *what the reviewer should look at*.

## Commits and Smart Commits

- Write a normal summary line first. Put commands in a separate paragraph or a separate commit.
- **Key first, then commands, on the same line**: `WEB-42 #in-review #time 30m #comment Ready for review.`
- **Put `#comment` last.** It swallows the rest of the line.
- *Use full state names* in hyphenated form (`#in-review`, not `#in` or `#review`).
- **Agree what `#time` means.** It becomes a comment ("Time logged: …"), not a timesheet entry. `1d` = 8 hours and `1w` = 5 days.
- **Avoid `#done` in intermediate commits.** It moves the item the moment the commit is pushed, before review or merge.
- **Do not rebase or amend pushed commits that carry commands.** A new SHA runs the commands again (two time notes, two comments).

## Review and merge

- **Request a reviewer explicitly.** That is the event that moves the item to In Review.
- **Answer review feedback in the PR.** Add a one-line summary to the work item for people who do not read code (a `#comment` in the fix commit is enough).
- **Close obsolete PRs before the final merge.** An open linked PR blocks the merge guard, and git-sync does not re-check after a later close.
- **Agree on what Done means.** By default Done means "merged into `main`". If your team needs "deployed" or "verified in production", ask the admin to change the rules. Do not move items back and forth by hand.

## Mirrored issues

- Decide *which side owns titles and descriptions*. The default is GitHub. Edit there.
- **Do not delete or archive items to close issues.** Move them to a completed or cancelled state.
- *Corrections are new comments*, because edited comments are not mirrored.
- Use the `plane` label for issues the team will actually plan, not for every question.

## A team page template

Copy this into a Plane page and fill it in:

| Topic | Our decision |
|---|---|
| Branch name | `{key}-{title}` from **Create branch** / no key for partial work |
| Review state | In Review = reviewer requested |
| Merge base(s) and meaning | `main` → Done; `staging` → In QA |
| Meaning of Done | |
| Time logging (`#time`)? | yes / no; what it counts |
| Who owns titles and descriptions of mirrored issues | GitHub (default) |
| Where to report sync problems | channel / person (workspace admin) |

## What you learned

- Conventions are team policy, not software rules. Write them down and review them.
- Branch names with a key close items. Use keyless branches and `Refs` for partial work.
- Smart Commits: key first, `#comment` last, full state names, and no rewriting of pushed command commits.
- Close obsolete PRs before the final merge, and agree what Done means.

## Source files

- `src/parse/references.ts`, `src/parse/magicWords.ts`: what the conventions protect against
- `src/github/smart-commits.ts`: command grammar
- `src/github/pr-automation.ts`: default lifecycle rules
