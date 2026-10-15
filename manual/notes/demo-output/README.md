# Demo run outputs (verbatim)

Produced by `manual/demo/server.ts` + `manual/demo/run-loop.sh` (real git-sync code, demo data). Regenerate any time.

## Work item states after the run

| Key | Title | State | Labels |
|---|---|---|---|
| WEB-33 | Validate postcode before payment | In Progress |  |
| WEB-34 | Show card errors next to the field | In Progress |  |
| WEB-35 | Support Apple Pay on checkout | In Progress |  |
| WEB-36 | Add a guest checkout option | In Progress |  |
| WEB-37 | Fix total rounding on discounted items | In Progress |  |
| WEB-38 | Improve the empty-cart message | Todo |  |
| WEB-39 | Speed up the checkout page | In QA |  |
| WEB-40 | Increase tap target size of quantity buttons | Todo |  |
| WEB-41 | Keep focus visible on checkout controls | In Progress |  |
| WEB-42 | Make the checkout button visible on small screens | Done | frontend, accessibility |
| WEB-44 | Add rate limiting to the login form | Todo | github |
| WEB-45 | Document the release checklist | Todo |  |
| WEB-46 | WEB-NEW Add rate limiting to the sign-up form | In Progress |  |
| WEB-47 | Coupon field accepts expired codes | Backlog | bug |

## Comments git-sync wrote in Plane (HTML)

### WEB-33

```html
<p>Shared validation helper for the checkout form</p><p><small>via <a href="https://github.com/acme/website/commit/a13b45e38deb0264973ff72615c7de8995a274aa">a13b45e</a> by alex-dev</small></p>
```
### WEB-34

```html
<p>Shared validation helper for the checkout form</p><p><small>via <a href="https://github.com/acme/website/commit/a13b45e38deb0264973ff72615c7de8995a274aa">a13b45e</a> by alex-dev</small></p>
```
### WEB-35

```html
<p>Git sync could not complete this action:</p><ul><li><code>WEB-35: #shipped matches no Plane state.</code></li></ul>
```
### WEB-47

```html
<p>Mirrored from GitHub issue <a href="https://github.com/acme/website/issues/131">acme/website#131</a>.</p>
```
```html
<p><strong>sam-reviews</strong> commented on <a href="https://github.com/acme/website/issues/131#issuecomment-77001">GitHub</a>:</p><p>Reproduced on staging. <mention-component entity_identifier="6a57833d-4e43-49be-924c-f093cddfae76" entity_name="user_mention"></mention-component> can you take this?</p>
```
### WEB-44

```html
<p>Mirrored to GitHub issue acme/website#120.</p>
```
### WEB-42

```html
<p>Checked at 320, 375 and 390 px widths; the button stays visible.</p><p><small>via <a href="https://github.com/acme/website/commit/3b2335d710bf1b0ba856a9ca334a2fd2e8a27ac6">3b2335d</a> by alex-dev</small></p>
```
```html
<p>Time logged: 1h 30m (90 minutes)</p><p><small>via <a href="https://github.com/acme/website/commit/7b7ebfdd2c7657165f8c339cbace6cef32e140b6">7b7ebfd</a> by alex-dev</small></p>
```
```html
<p>Addressed review: focus ring restored.</p><p><small>via <a href="https://github.com/acme/website/commit/b8adc27db0e8ecc17b0be2414d2a09b42039b748">b8adc27</a> by alex-dev</small></p>
```

## Links git-sync keeps on Plane work items (title -> URL)

### WEB-33

- `[Branch] WEB-33-validate-postcode -> https://github.com/acme/website/tree/WEB-33-validate-postcode`
### WEB-35

- `[Branch] WEB-35-apple-pay -> https://github.com/acme/website/tree/WEB-35-apple-pay`
### WEB-41

- `[PR] #118 Tidy checkout focus styles · OPEN · REVIEW -> https://github.com/acme/website/pull/118`
### WEB-40

- `[PR] #119 Shared button component · OPEN · REVIEW -> https://github.com/acme/website/pull/119`
### WEB-46

- `[PR] #122 WEB-NEW Add rate limiting to the sign-up form · OPEN · REVIEW -> https://github.com/acme/website/pull/122`
### WEB-37

- `[PR] #123 WEB-37 Fix total rounding on discounted items · OPEN · REVIEW -> https://github.com/acme/website/pull/123`
- `[CI] Build · fail -> https://github.com/acme/website/pull/123/checks`
### WEB-36

- `[PR] #124 WEB-36 Guest checkout: backend · MERGED -> https://github.com/acme/website/pull/124`
- `[PR] #125 WEB-36 Guest checkout: form · OPEN · REVIEW -> https://github.com/acme/website/pull/125`
### WEB-39

- `[PR] #126 WEB-39 Speed up the checkout page · MERGED -> https://github.com/acme/website/pull/126`
### WEB-47

- `GitHub issue acme/website#131 -> https://github.com/acme/website/issues/131`
### WEB-44

- `GitHub issue acme/website#120 -> https://github.com/acme/website/issues/120`
### WEB-42

- `[Branch] WEB-42-make-the-checkout-button-visible-on-small-screens -> https://github.com/acme/website/tree/WEB-42-make-the-checkout-button-visible-on-small-screens`
- `[PR] #121 WEB-42 Keep the checkout button visible on small screens · MERGED -> https://github.com/acme/website/pull/121`
- `[CI] Build · pass -> https://github.com/acme/website/pull/121/checks`
- `[Deploy] Preview · success -> https://website-git-web-42-acme.vercel.app`
- `[Preview] Vercel -> https://website-git-web-42-acme.vercel.app`

## Text git-sync posted to GitHub

`POST /repos/{owner}/{repo}/commits/{commit_sha}/comments`

```text
Git sync could not complete this action:

- ` WEB-35: #shipped matches no Plane state. `
- ` WEB-35: #time needs a duration such as 1h 30m. `

<!-- git-sync-problem:335cb1f0e2d4a0553b75594c2f37db84080b71fdd0384aae13861f03c2702eef -->
```
`POST /repos/{owner}/{repo}/commits/{commit_sha}/comments`

```text
Git sync could not complete this action:

- ` Unknown work item WEB-999. `

<!-- git-sync-problem:45ad5a57b0cc6187557b7ce2831b81d68e1fd832391e292f1156a66bccc89631 -->
```
`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

```text
Linked Plane work item:
- WEB-41: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/5b05e0da-1bc0-40e2-b95a-99a102630480
```
`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

```text
Linked Plane work item:
- WEB-40: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/64211cb5-7519-42d4-bb20-5ef872bac225
```
`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

```text
Linked Plane work item:
- WEB: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/50b5ef6b-6077-4578-a943-8bb8db2d6cc9
```
`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

```text
Linked Plane work item:
- WEB-37: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/c19152ed-3a41-40c1-9c25-8fadf51d7fae
```
`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

```text
Linked Plane work item:
- WEB-36: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/8d070f86-8bff-46cb-937f-e505c246c74a
```
`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

```text
Linked Plane work item:
- WEB-36: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/8d070f86-8bff-46cb-937f-e505c246c74a
```
`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

```text
Linked Plane work item:
- WEB-39: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/a91a7b7b-cff8-4f4f-8c6c-4a27f444faa0
```
`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

```text
Linked to Plane work item: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/7a2b5e69-aca5-49cb-8b4b-b71966c58b01
```
`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

```text
Linked to Plane work item: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/f19a4a55-c98c-4829-af86-1505b5001d16
```
`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`

```text
Linked Plane work item:
- WEB-42: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/53486230-16eb-4c87-afc4-ffeb2339a1a9
```

## GitHub issues created by mirroring

```text
#131 Coupon field accepts expired codes
Steps:
1. Add any item
2. Enter `SUMMER24`

Expected: *Code expired*.

cc @sam-reviews
labels: ['plane', 'bug'] assignees: ['alex-dev']
```
```text
#120 Add rate limiting to the login form
Limit failed sign-ins to **5 per minute**.

---
Mirrored from Plane: http://plane.example.com/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/issues/f19a4a55-c98c-4829-af86-1505b5001d16
labels: ['plane'] assignees: []
```