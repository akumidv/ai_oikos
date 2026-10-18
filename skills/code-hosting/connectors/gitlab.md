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
```

- `task` matches the key as a whole token (`PROJ-123` never matches `PROJ-1234`). GitLab's search
  covers title and description, so an MR whose key is only in the branch name is missed; other
  code hosts are not searched by it — say so when reporting.
- A red pipeline: `pipelines` → `jobs` → `job-log --errors` → `job-log` (tail + earlier errors) →
  `--full` only if asked. Report job, stage and the quoted error line; do not paste the log.
- A 404 means "not found or no access" — access is granted per person.

## Channel

A self-hosted GitLab is often internal. If the tool reports a Cloudflare Access login page or
"no channel", the proxy/VPN/WARP did not carry the request — not that GitLab is down. The tool re-runs itself
with `NODE_USE_ENV_PROXY=1` when a proxy is set, because Node's fetch ignores `HTTPS_PROXY`
otherwise.

## Credentials

`GITLAB_TOKEN` (scope `read_api`; create at `<GITLAB_URL>/-/user_settings/personal_access_tokens`)
in `.local/.env` (the shell environment is only a fallback). `GITLAB_URL` is in the `settings` of `oikos.yaml`. Never ask for a token in the chat.
