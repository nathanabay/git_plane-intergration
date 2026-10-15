# 16. Printable cheat sheet

**Plane + GitHub daily loop** · Example project `WEB` · Check your team's rules.

1. Open the work item.
2. Read its acceptance checks and blockers.
3. Confirm ownership.
4. Move it to In Progress.
5. Create a feature branch.
6. Implement the change.
7. Run relevant checks.
8. Commit the intended files.
9. Push the branch.
10. Open the PR with a Plane reference.
11. Request review.
12. Resolve feedback.
13. Merge after required checks and review.
14. Verify Plane's state and Development.

```bash
git switch -c web-42-checkout-button
# Edit, check and stage the intended files.
git commit -m "WEB-42 improve checkout" \
  -m "WEB-42 #time 45m #comment Checked narrow screens."
git push -u origin web-42-checkout-button
```

## Choose the reference

| Intent | PR text |
| --- | --- |
| Finish work | `Closes WEB-42` |
| Contribute part | `Refs WEB-42` |
| Context only | `Relates to WEB-42` |

**Strongest wins.** Bare branch keys and uppercase PR title keys close. For partial work, use a branch without the key and explicit `Refs WEB-42`. A slash-prefixed key still closes. `skip WEB-42` in the body excludes before the first link; it does not remove an existing link.

```text
WEB-42 #in-review #time 30m #comment Ready for review.
```

Keep keys **before commands, on the same line**. Put `#comment` last. Commands run after **push**. `#time` writes a CE comment; `1d = 8h`, `1w = 5d`.

Defaults: branch/PR → In Progress; review request → In Review; qualifying merge into `main` → Done. Approval alone changes no state. Other open linked PRs block completion at that merge event.

Development: **OPEN** = open PR; **MERGED** = merged; **DECLINED** = closed unmerged. Review labels are separate. Merge does not prove deployment.

> Tip: If stuck, report the key, event URL/SHA, time, expected result and actual result. Never share tokens or cookies.
