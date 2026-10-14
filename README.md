# git-sync: Plane ↔ GitHub sync

Two-way GitHub sync for self-hosted Plane Community Edition: work items and issues, pull requests,
branches and commits, smart commits and checks, configured from Plane's own settings pages.

## Install

On the machine where Plane runs:

```bash
git clone <this repository> git-sync && cd git-sync
sudo ./install.sh
```

It asks for a Plane API key and a Plane webhook secret, sets everything else up and checks that git-sync is
healthy. Then add your GitHub App in **God mode → Git Sync**. Full guide: **[INSTALL.md](INSTALL.md)**.

## Development

```bash
npm ci
npm test            # unit and integration tests
npm run typecheck
```

The design is in [docs/superpowers/specs](docs/superpowers/specs), the operations runbook in
[deploy/APPLY.md](deploy/APPLY.md).
