# Connector: gitlab

A GitLab instance (`GITLAB_URL`), for the skill `code-hosting`. One tool:
`node oikos/tools/gitlab/cli.mjs <command>`; the project is always named (`--project group/name`)
because this work does not sit in a checkout. Every command is a read; `--json` returns GitLab's own payload.

## Commands

```bash
node oikos/tools/gitlab/cli.mjs whoami
node oikos/tools/gitlab/cli.mjs projects [--search billing] [--group platform]
node oikos/tools/gitlab/cli.mjs mrs [--group platform | --project platform/api] [--state opened|merged|all] [--author user]
node oikos/tools/gitlab/cli.mjs mrs --author me                 # my open MRs ("me" = the owner of GITLAB_TOKEN)
node oikos/tools/gitlab/cli.mjs mrs --reviewer me               # MRs waiting for my review
node oikos/tools/gitlab/cli.mjs task PROJ-123 [--mentions]        # MRs carrying the key in title or text
node oikos/tools/gitlab/cli.mjs pipelines --project platform/api [--ref main]
node oikos/tools/gitlab/cli.mjs jobs --project platform/api --pipeline 886
node oikos/tools/gitlab/cli.mjs job-log --project platform/api --id 2187 --errors
node oikos/tools/gitlab/cli.mjs file --project platform/docs --path README.md [--ref main]
node oikos/tools/gitlab/cli.mjs mrs --project platform/api --state all --since 2026-07-01   # updated since
node oikos/tools/gitlab/cli.mjs governance --project platform/api
node oikos/tools/gitlab/cli.mjs merged --project platform/api --since 2026-07-01 [--limit 200] [--notes]
```

- `task` matches the key as a whole token (`PROJ-123` never matches `PROJ-1234`). GitLab's search
  covers title and description, so an MR whose key is only in the branch name is missed; other
  code hosts are not searched by it — say so when reporting.
- A red pipeline: `pipelines` → `jobs` → `job-log --errors` → `job-log` (tail + earlier errors) →
  `--full` only if asked. Report job, stage and the quoted error line; do not paste the log.
- A 404 means "not found or no access" — access is granted per person.
- `mrs --since` keeps the merge requests updated on or after the date (`updated_after`).
- `governance` reads what guards a project: its merge checks (merge method, squash, pipeline must
  succeed, discussions must be resolved, delete the source branch, approvals before merge where
  returned), its protected branches (who may push and merge, force push, code owner approval), its
  approval settings and rules, and CODEOWNERS — the first of `CODEOWNERS`, `docs/CODEOWNERS`,
  `.gitlab/CODEOWNERS` on the default branch, as GitLab looks, with its rules. A part the token's role
  or the instance's tier does not reach is named ("needs Premium or Maintainer"), not fatal.
  Protected branches answered 404 or 403 are "not readable with this token (needs Maintainer)", and
  the other parts are still read. The count is what the token sees ("0 visible to this token"): a
  role below Maintainer may get a filtered or empty list, so never report it as "none" or as "no
  protection" — a part the token cannot read says nothing about the protection. `--json` keeps
  GitLab's raw list; each part has a `state`: `ok` (with `data`), `unreadable` (with `why`: a 403,
  or a 404 for a part of a project that was itself read — the role or the tier, never "nothing
  there"), or, for CODEOWNERS only, `absent` (no file at any of its paths).
- `merged` lists the merge requests merged since a date — author, who merged, who approved, hours
  from open to merge; `--notes` adds the count of non-system notes (one more request per merge
  request) — and totals them: count, median and mean hours open→merge, the share merged with at
  least one approval (of those whose approvals could be read) and the share merged by their own
  author. It reads the merge requests updated since the date and keeps those merged since; it says
  when `--limit` was reached.
- Both are reads; neither has `--dry-run`, and nothing about a project's settings is changed.

## Channel

A self-hosted GitLab is often internal. If the tool reports a Cloudflare Access login page or
"no channel", the proxy/VPN/WARP did not carry the request — not that GitLab is down. The tool re-runs itself
with `NODE_USE_ENV_PROXY=1` when a proxy is set, because Node's fetch ignores `HTTPS_PROXY`
otherwise.

## Credentials

`GITLAB_TOKEN` (scope `read_api`; create at `<GITLAB_URL>/-/user_settings/personal_access_tokens`)
in `.local/.env` (the shell environment is only a fallback). `GITLAB_URL` is in the `settings` of `oikos.yaml`.
Without either, every command stops with exit 1 and names the missing key, before any request. Never ask for a token in the chat.

`governance` and `merged` need no other scope, but the role and the tier decide what they see:
protected branches and some merge settings may need **Maintainer** on the project (a field the role
does not see is left out); the project's approval settings and approval rules need **Premium** (or
Ultimate) and answer 403 or 404 without it; the approvals of a merge request (`approved_by`) are
read on every tier.
