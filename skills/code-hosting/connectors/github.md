# Connector: github

An organization's repositories on GitHub, for the skill `code-hosting`. One tool:
`node oikos/tools/github/cli.mjs <command>`. Read-only by design; `--json` gives GitHub's payload.

```bash
node oikos/tools/github/cli.mjs whoami
node oikos/tools/github/cli.mjs repos [--search billing] [--org <org>]
node oikos/tools/github/cli.mjs ls --repo billing-api [--path src] [--ref main]
node oikos/tools/github/cli.mjs ls --repo billing-api --recursive [--path src]
node oikos/tools/github/cli.mjs file --repo billing-api --path README.md [--ref main]
node oikos/tools/github/cli.mjs pr --url https://github.com/acme/web-ui/pull/12
node oikos/tools/github/cli.mjs prs --key PROJ-123 --repo web-ui --repo acme/auth [--alias PJ]
node oikos/tools/github/cli.mjs governance --repo acme/app [--branch release]
node oikos/tools/github/cli.mjs merged --repo acme/app --since 2026-07-01 [--limit 200]
```

- `--repo` takes `name` (the organization in `GITHUB_ORG`, `oikos.yaml` settings) or `org/name`.
- `whoami` names the user the token belongs to.
- A 404 means "not found or no access" — access is granted per person.
- `pr` reads one pull request by its URL: state (`open`, `draft`, `merged`, `closed`), branch, title.
- `prs` lists the pull requests and branches of a task key in the named repositories only — those
  whose title or branch name carries the key (or `--alias` with the same number) as a whole token;
  there is no organization-wide search. The tracker's `transition` uses the same search on the
  project's repository pool.
- `governance` reads what guards a branch (default: the default branch): the rules in force on it
  and the repository's rulesets; the classic branch protection (enforce admins, required status
  checks, required reviews and their count, code owner reviews, dismiss stale reviews, linear
  history, force pushes, deletions); the deployment environments (required reviewers, wait timer,
  which branches may deploy); and CODEOWNERS — the first of `.github/CODEOWNERS`, `CODEOWNERS`,
  `docs/CODEOWNERS`, as GitHub looks, with its rules. A part the token cannot read is named, not
  fatal: protection answers 404 both when the branch is not protected and when the token is not an
  admin's — report it as "not protected, or needs admin", never as "not protected".
- `merged` lists the pull requests merged since a date — author, who merged, approving reviewers,
  review count, hours from open to merge — and totals them: count, median and mean hours open→merge,
  the share merged with at least one approval and the share merged by their own author. One
  GitHub search query, read page by page; it says when `--limit` cut the list.
- Both are reads; neither has `--dry-run`, and nothing about a repository's settings is changed.

## Not here, on purpose

- **Issues, projects, wikis** — not covered yet; whether the organization uses them is in its
  resource note.
- **CI, pull request diffs, review comments** — not covered yet; pull requests are read only as
  above (reviews only as the approvals and counts of `merged`).
- **Managing repositories, teams, permissions, settings** — devops work, outside oikos;
  `governance` only reads them.

## Credentials

`GITHUB_TOKEN` in `.local/.env` (the shell environment is only a fallback) — a fine-grained token with read-only
**Contents**, **Metadata** and **Pull requests** on the organization (https://github.com/settings/tokens). If it is not
set, the tool uses the `gh` CLI's login (`gh auth login`). `whoami` names the route taken. With
neither, every command stops with exit 1 and names `GITHUB_TOKEN`, before any request. Never
ask for a token in the chat.

`governance` reads more than the token above may reach, and says which part it could not read:

| Part | Fine-grained permission (read) | Note |
|---|---|---|
| rules on a branch, rulesets | Metadata | verify on the instance; rulesets need a plan that has them for a private repository |
| classic branch protection | **Administration** | and the token's user must be an admin of the repository; otherwise GitHub answers 404 |
| environments | Actions (verify) | environments of a private repository need a paid plan |
| CODEOWNERS | Contents | |

`merged` needs **Pull requests** and **Metadata** only. A classic token or the `gh` login reads
them all with `repo`, protection still only for a repository admin.
