# Connector: github

An organization's repositories on GitHub, for the skill `code-hosting`. One tool:
`node oikos/tools/github/cli.mjs <command>`. Read-only by design; `--json` gives GitHub's payload.

```bash
node oikos/tools/github/cli.mjs whoami
node oikos/tools/github/cli.mjs repos [--search billing] [--org <org>]
node oikos/tools/github/cli.mjs ls --repo billing-api [--path src] [--ref main]
node oikos/tools/github/cli.mjs ls --repo billing-api --recursive [--path src]
node oikos/tools/github/cli.mjs file --repo billing-api --path README.md [--ref main]
```

- `--repo` takes `name` (the organization in `GITHUB_ORG`, `oikos.yaml` settings) or `org/name`.
- `whoami` names the user the token belongs to.
- A 404 means "not found or no access" — access is granted per person.

## Not here, on purpose

- **Issues, projects, wikis** — not covered yet; whether the organization uses them is in its
  resource note.
- **Pull requests, CI** — not covered yet.
- **Managing repositories, teams, permissions, settings** — devops work, outside oikos.

## Credentials

`GITHUB_TOKEN` in `.local/.env` (the shell environment is only a fallback) — a fine-grained token with read-only
**Contents** and **Metadata** on the organization (https://github.com/settings/tokens). If it is not
set, the tool uses the `gh` CLI's login (`gh auth login`). `whoami` names the route taken. With
neither, every command stops with exit 1 and names `GITHUB_TOKEN`, before any request. Never
ask for a token in the chat.
