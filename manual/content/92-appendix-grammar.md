# Appendix C · Reference, magic-word and Smart Commit grammar

Every table in this appendix is **generated**. `manual/scripts/grammar-tables.mjs` runs each example through the real parsers in `src/parse/references.ts` and `src/github/smart-commits.ts`, then writes the result here. The tables are rebuilt with every manual build, so they always match the code. The examples come from `tests/parse/references.test.ts`, `tests/github/smart-commits.test.ts`, `tests/a8/grammar.test.ts` and the chapters of this manual.

## Work-item keys

A key is a project prefix, a hyphen and a number: `WEB-42`, `API2-103`. The prefix starts with a letter, followed by 1–11 letters or digits, so it is 2–12 characters long. The key must not be glued to letters or digits on either side, and no `_` may follow the number. Leading zeros are dropped, so `WEB-0042` is `WEB-42`. A recognized key still has to exist in Plane: git-sync looks it up, and an unknown key is ignored and written to the audit log.

<!-- grammar:deny-list -->

Prefixes that are never read as work-item keys (`NOT_PROJECTS` in `src/parse/references.ts`): `UTF`, `SHA`, `ISO`, `AES`, `RSA`, `CVE`, `CWE`, `RFC`, `TLS`, `SSL`, `MD`, `ES`, `PEP`, `USB`, `HTTP`, `IPV`, `SSH`, `GPT`, `RS`, `CRC`, `UTC`, `WIN`.

<!-- /grammar -->

## Where git-sync looks, and what a bare key means

| Place | Case of a bare key | Tier of a bare key | Tier after a magic word |
|---|---|---|---|
| Pull request head branch | any case | closing | the word's tier |
| Pull request title | UPPERCASE only | closing | the word's tier |
| Pull request body | UPPERCASE only | relation | the word's tier |
| Commit message (push rules only) | UPPERCASE only | relation | the word's tier |

A key that follows a magic word may be in any case. The pull request handler reads only the branch, title and body. Commit messages never link a pull request; they are read only by Smart Commits and by `push` / `commit.pushed_to_default` rules.

When the same key appears several times, the **strongest tier wins** (closing > non-closing > relation). If two places give the same tier, the order branch > title > body > commit decides which source is kept.

## Default magic words

<!-- grammar:magic -->

| Tier | Default words and phrases (from `src/parse/magicWords.ts`) |
|---|---|
| closing | `close`, `closes`, `closed`, `closing`, `fix`, `fixes`, `fixed`, `fixing`, `resolve`, `resolves`, `resolved`, `resolving`, `complete`, `completes`, `completed`, `completing`, `implement`, `implements`, `implemented`, `implementing` |
| non-closing | `ref`, `refs`, `references`, `part of`, `contributes to`, `toward`, `towards` |
| relation | `relates to`, `related to` |

<!-- /grammar -->

An instance admin can replace these lists in God mode, under **Magic words**. Each entry may contain only lowercase letters and single spaces, up to 40 characters. Each tier needs 1–100 entries, and a word may belong to one tier only.

A magic word is followed by an optional colon and then **at least one space**. Several keys can follow one word, joined by `,`, `and`, `&` or spaces.

## Reference examples

<!-- grammar:references-full -->

| Text | Where | Result (real parser) | Why |
|---|---|---|---|
| `WEB-42-checkout-button` | branch | WEB-42 (closing) | bare key in a branch |
| `feature/web-42-login` | branch | WEB-42 (closing) | branch keys are case-insensitive |
| `WEB-42 Keep the checkout button visible` | title | WEB-42 (closing) | bare key in a PR title |
| `web-42 keep the button visible` | title | no reference | lowercase bare key in a title |
| `Closes WEB-42` | body | WEB-42 (closing) | closing magic word |
| `fixes web-42` | body | WEB-42 (closing) | key after a magic word is case-insensitive |
| `Refs WEB-41` | body | WEB-41 (non-closing) | non-closing magic word |
| `Part of WEB-41` | body | WEB-41 (non-closing) | two-word non-closing phrase |
| `Relates to WEB-40` | body | WEB-40 (relation) | relation magic word |
| `See WEB-40 for context` | body | WEB-40 (relation) | bare uppercase key in a body |
| `see web-40` | body | no reference | lowercase bare key in a body |
| `Closes WEB-42, WEB-43 and API2-7` | body | WEB-42 (closing); WEB-43 (closing); API2-7 (closing) | several keys after one word |
| `Fixes WEB-1 & WEB-2` | body | WEB-1 (closing); WEB-2 (closing) | & joins keys |
| `Closes: WEB-42` | body | WEB-42 (closing) | optional colon, then a space |
| `Closes:WEB-42` | body | WEB-42 (relation) | no space after the colon: only the bare key counts |
| `Closes WEB-0042` | body | WEB-42 (closing) | leading zeros are normalised |
| `X-42 WEB_42 WEB-42more 42-WEB` | body | no reference | not keys |
| `UTF-8 SHA-256 CVE-2024` | body | no reference | deny-listed prefixes |
| `Closes WEB-42⏎skip WEB-42` | body | skipped: WEB-42 | skip removes the key from this parse |
| `Fixes WEB-42⏎ignore WEB-43⏎Fixes WEB-43` | body | WEB-42 (closing); skipped: WEB-43 | ignore works like skip |
| `WEB-42 Move the button` | commit | WEB-42 (relation) | bare key in a commit message |

| Inputs | Result (real parser) | Why |
|---|---|---|
| branch: `web-42-checkout`<br>body: `Refs WEB-42` | WEB-42 (closing, from branch) | branch (closing) beats body Refs (non-closing) |
| title: `Checkout tweaks`<br>body: `Refs WEB-42⏎Relates to WEB-42` | WEB-42 (non-closing, from body) | non-closing beats relation |
| title: `WEB-NEW Add rate limiting` | create in: WEB | WEB-NEW asks for a new item |
| title: `Tidy styles`<br>body: `web-NEW and WEB-new` | create in: WEB | only uppercase NEW counts |

<!-- /grammar -->

`skip KEY` and `ignore KEY` count only in a pull request body, are case-insensitive and cover one key each. The key is dropped from this parse wherever it appears (branch, title or body), but a link that git-sync already stored is **not** removed.

`WEB-NEW` in a title or body asks git-sync to create a new work item in the project whose identifier is `WEB`. `NEW` must be uppercase. This happens on the `opened`, `edited` and `reopened` events.

## Smart Commit grammar

`<anything> KEY [KEY…] <anything> #command [args] #command [args] …`

- Each line of a commit message is read on its own. A line needs at least one key **before** its first `#command`.
- `#comment <text>` takes the rest of the line as the comment. A `#tag` or key inside the comment stays text.
- `#time <duration>` accepts `w`, `d`, `h` and `m` units, with decimals; 1w = 5d and 1d = 8h. It is posted as a Plane comment, `Time logged: <duration> (<n> minutes)`.
- Any other `#word` is a workflow-state command.

<!-- grammar:smart-commits-full -->

| Commit message | Result (real parser) |
|---|---|
| `WEB-42 #comment Checked at 320, 375 and 390 px` | keys WEB-42 · comment “Checked at 320, 375 and 390 px” |
| `Fix layout WEB-42 #time 1h 30m` | keys WEB-42 · time 1h 30m = 90 min |
| `WEB-42 #time 1w 2d 4h 30m` | keys WEB-42 · time 1w 2d 4h 30m = 3630 min |
| `WEB-42 #time 1.5h` | keys WEB-42 · time 1.5h = 90 min |
| `WEB-42 #in-review #time 45m #comment Ready for Sam` | keys WEB-42 · state #in-review · time 45m = 45 min · comment “Ready for Sam” |
| `WEB-33 WEB-34 #in-progress #comment Shared validation helper` | keys WEB-33, WEB-34 · state #in-progress · comment “Shared validation helper” |
| `WEB-42 #comment see #12 and WEB-7 — this stays text` | keys WEB-42 · comment “see #12 and WEB-7 — this stays text” |
| `WEB-42 #time 3x` | keys WEB-42 · error: #time needs a duration such as 1w 2d 4h 30m, got "3x" |
| `WEB-42 #comment` | keys WEB-42 · error: #comment has no text |
| `#comment no key before the command` | nothing runs |
| `Done. #comment WEB-42 after the command` | nothing runs |
| `WEB-42 updated the docs` | nothing runs |
| `WEB-42 #done⏎WEB-43 #comment Second line, own key` | keys WEB-42 · state #done ‖ keys WEB-43 · comment “Second line, own key” |
| `WEB-42⏎#comment key on the line above` | nothing runs |

<!-- /grammar -->

## State commands

A state command is matched against the states of the work item's own project, in three steps:

1. The full state name with spaces as hyphens (`#in-review`).
2. The same name ignoring hyphens and apostrophes (`#inreview`).
3. The leading whole words of exactly one state's name.

If two states match at the same step, the command is refused as ambiguous. A command never moves an item into a triage state.

<!-- grammar:states -->

States of the example project: Backlog, Todo, In Progress, In Review, In QA, Done, Cancelled.

| Command | Result (real resolver) |
|---|---|
| `#in-review` | → In Review |
| `#In-Review` | → In Review |
| `#inreview` | → In Review |
| `#done` | → Done |
| `#todo` | → Todo |
| `#in-qa` | → In QA |
| `#in` | refused: ambiguous |
| `#progress` | refused: no such state |
| `#cancel` | refused: no such state |
| `#shipped` | refused: no such state |

<!-- /grammar -->

## Source files

- `src/parse/references.ts`, `src/parse/magicWords.ts`
- `src/github/smart-commits.ts`
- `src/ui/validate.ts` (magic-word validation)
- `manual/scripts/grammar-tables.mjs` (this appendix's generator)
