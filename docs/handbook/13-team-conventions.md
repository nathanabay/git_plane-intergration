# 13. Team conventions and good habits

Everything in this chapter is a **suggested team convention**. These practices are useful starting points, not additional parser rules or guarantees enforced by git-sync. Agree on a small set with your team, publish the decision in a team page, and adjust it when real work reveals a problem. Administrator settings and repository protections still govern what the software actually allows.

## 13.1 Give the work item an outcome

A useful title tells a teammate what changes for a user or operator. “Keep the checkout button visible on narrow screens” is easier to finish and review than “Checkout improvements.” Put the evidence needed to prove success in the description. Include the affected audience, the problem, acceptance checks and constraints that cannot be inferred from code.

For a bug, write reproduction steps, actual behavior and expected behavior. For a new feature, explain the decision the user will make or the action they will complete. A small screenshot can clarify a visual problem, but write enough text that the work item still makes sense to someone reading a notification without the picture.

> Example: “At 320 pixels wide, the checkout action remains visible, its label wraps without covering the total, and keyboard focus reaches it after the address fields.” This is a testable outcome. “Responsive checkout” is a topic.

Use comments for conversation and the description for the current agreement. When the team changes the plan, update the description and leave a comment explaining the change. A newcomer should not have to infer the present requirement from ten contradictory comments.

## 13.2 Make responsibility easy to find

Choose one person to move each item forward, even if several developers collaborate. Plane can represent multiple assignees, but your team should agree who arranges review and resolves questions. A reviewer is not automatically a co-owner of implementation. Mention the person whose decision is needed and state the question clearly.

Before starting, check the work item's state, owner and blocking relations. When blocked, record what is needed and who can provide it. Avoid repeatedly changing priority to attract attention; priority should describe the team's relative urgency. A clear comment with a concrete dependency is easier to act on.

At the end of the day, leave one sentence about the next step if somebody else may pick up the work. “Layout fixed; waiting for confirmation of the translated label” is more useful than “Still working.” Keep passwords, access tokens, customer records and private incident details out of ordinary comments and screenshots.

## 13.3 Use identifiers consistently

A simple default branch convention is `web-42-short-description`. Prefer the identifier exactly as Plane displays it when writing prose: `WEB-42`. The branch parser tolerates lower case, but bare prose references are generally uppercase-only. Consistent spelling makes both human scanning and automation more reliable.

Distinguish three intentions before writing a PR: finish the item, contribute part of it, or mention related context. Use `Closes`, `Refs`, or `Relates to` accordingly, after checking the administrator's configured vocabulary. Review the branch and title as well as the body. A weaker body phrase does not override a stronger reference elsewhere.

> Warning: `Refs WEB-42` in the body plus branch `web-42-layout` still yields a closing reference. For a partial contribution, use a branch without the key, such as `checkout-layout-part-one`, and an explicit `Refs WEB-42` PR title. `refs/web-42/layout` still parses as closing because the slash does not satisfy the magic-word whitespace rule.

Do not scatter identifiers into copied templates without understanding why they are there. A PR description saying “Closes WEB-42” is an instruction under the default vocabulary, even when the author meant it only as an example. Use `skip WEB-42` in the PR body before first linking when deliberately excluding a copied reference, and document why the exclusion is needed for reviewers. Adding it later does not remove a stored PR link.

## 13.4 Keep commits useful and deliberate

Write a commit summary that explains the change. Smart Commit commands should add useful history, not replace a readable message. Consider placing the commands on their own message paragraph, with a key before commands on each line. Put `#comment` last. Use full hyphenated state names instead of ambiguous abbreviations.

Log time only when the team wants this information and with a shared understanding of its meaning. In this integration, `#time` produces a comment in Plane CE. It does not feed a native timesheet. The parser treats a day as eight hours and a week as five such days; do not assume elapsed calendar time or your personal work schedule is used.

Avoid `#done` in intermediate commits unless you intend a state transition when the push is processed. Closing words in PR references express completion intent for lifecycle automation, while a state command requests a transition during Smart Commit processing. They have different timing. A branch can still contain unfinished work when a pushed command moves the work item.

## 13.5 Write a PR that a teammate can review

Use a short structure: purpose, changes, validation, and reviewer focus. Include the intended Plane references near the beginning. Describe the checks you actually ran and any meaningful gaps. “Tests passed” is weak evidence when a visual issue was never opened at the affected viewport width.

Keep the change small enough that a reviewer can understand it as one decision. A multi-item PR can be appropriate when the outcomes depend on the same change, but each linked item still needs its acceptance checks reviewed. Ask for review explicitly; publishing an open PR is not the same event as requesting a reviewer.

Treat review feedback as part of the work. Reply with the fix or the reason for a different approach. Update the work item when the outcome or delivery plan changes, so teammates who do not read code discussions can still understand its status.

## 13.6 Separate code completion from delivery

Agree on what Done means in your project. The shipping automation can move an item to Done after a qualifying merge. Some teams need a deployment, a manual verification or release communication before considering a user-facing outcome delivered. If that is your team, ask the administrator to align rules with the agreed workflow.

Do not use a green build or a `MERGED` badge as a substitute for release evidence. Build, deployment and preview links describe different events. Preview environments are useful for review, but a preview URL is not proof of a production deployment. Put the release decision somewhere a teammate can find it.

When one item has several PRs, list the intended parts in its description. Keep outdated PRs clearly closed if they were abandoned. An open linked PR intentionally blocks automatic completion on another merge. Closing an obsolete PR is a workflow decision; deleting the link merely to force Done can hide unfinished scope.

## 13.7 Make troubleshooting collaborative

When something looks wrong, record the identifier, PR URL or commit SHA, approximate time, expected result and actual result. Include the smallest relevant screenshot after removing sensitive details. This gives an administrator enough evidence to find an event without asking you to reproduce a potentially harmful write.

Prefer one deliberate correction over repeated edits intended to “wake up sync.” Retries can be legitimate, but repeated Smart Commit messages with new SHAs can repeat time comments or other side effects. Reconnect your personal account when asked by the UI; repository access problems usually need an administrator or organization owner.

A team page should contain the chosen branch convention, review state, merge base, meaning of Done, time-recording practice, and support contact. Review it during onboarding. The purpose is to reduce decisions a new developer must guess, while keeping project policy visible and changeable.
