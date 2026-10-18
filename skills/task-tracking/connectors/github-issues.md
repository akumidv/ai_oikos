# Connector: github-issues

GitHub issues, and the organization's projects (Projects v2), for the skill `task-tracking`. One
tool: `node oikos/tools/github-issues/cli.mjs <command>` (run from the installation's root). Every
command takes `--json` for the raw payload and `--help` for its options.

**An issue** (`--task`, `--from`, `--to`, `--parent`) is `owner/repo#12`, `repo#12` (the owner is
`GITHUB_ORG`), `#12` or `12` (in `GITHUB_REPO`), or its URL
`https://github.com/owner/repo/issues/12`. Several: `--task acme-corp/tools#12,acme-corp/tools#15`.

**Never fetch a GitHub issue URL with a web-fetch tool** — a private repository answers a login
page or 404, and "the page was empty" becomes "the task has no description".

## Read

```bash
node oikos/tools/github-issues/cli.mjs whoami                       # which login, which route, the visible token scopes, the settings
node oikos/tools/github-issues/cli.mjs info --task acme-corp/tools#24    # title, state, status, labels, parent / sub-issues / blocked by, description, attachments, comments
node oikos/tools/github-issues/cli.mjs context --task acme-corp/tools#24 # info + project Status and iteration + the parent's other sub-issues + warnings
node oikos/tools/github-issues/cli.mjs search --query 'label:bug is:open' --limit 100
node oikos/tools/github-issues/cli.mjs attachment --task acme-corp/tools#24 --id 1 --dir <scratchpad>
node oikos/tools/github-issues/cli.mjs link --types                   # the link types and their wording
```

- `search` takes GitHub search syntax. `is:issue` is added when the query names no type, and the
  scope — `repo:` from `GITHUB_REPO`, else `org:` from `GITHUB_ORG` — when it names none; the
  output says what was added. GitHub search is rate limited and its syntax is moving to "advanced
  search" (unverified until checked live).
- **Comments are part of the specification.** **Attachments** are the files and images linked in
  the description and comments: `info` lists them, `attachment` fetches one best effort — GitHub
  may serve an uploaded file only to a signed-in browser (unverified until checked live); then the
  user opens it, or it is read through the shared browser.
- `whoami` shows the scopes of a classic token (`X-OAuth-Scopes`); a fine-grained token reports
  none ("not reported"). It warns "writes configured, token read-only" when the scopes it sees
  lack `repo`, and when `GITHUB_PROJECT` is set but `project` is missing.

## Mine — what is assigned to the user

"Me" is the owner of the credential (the token, or the `gh` login) — `whoami` shows it.

```bash
node oikos/tools/github-issues/cli.mjs mine                 # my open issues in the organization, by repository
node oikos/tools/github-issues/cli.mjs mine --user octocat   # a colleague, by login
node oikos/tools/github-issues/cli.mjs search --query 'author:@me is:open'
```

## Status

The status comes from the **Status field of the project** in `GITHUB_PROJECT` (an organization
project number, owner `GITHUB_ORG`) when it is set, else from **labels** named like the statuses.

- `transition` moves an issue only among `GITHUB_AGENT_STATUSES` (default `Todo, In Progress`).
  From `GITHUB_REVIEW_STATUSES` on (default `In Review, Review`) — and from any status not open to
  an agent — only a person moves it: the tool refuses (exit 3) and prints the issue's link.
- **An agent never closes or reopens an issue**: `--to Done`/`Closed`, `edit --state`, a closed
  issue — refused (exit 3) with the link, for the user to do.
- With labels: the current status is the issue's label that matches a known status; the move adds
  the new label first, then removes the old one (the dry run says so). The status labels are the
  repository's — the tool does not create them. `edit` refuses to add or remove a status label:
  the status moves through `transition`.

## Boards and sprints

```bash
node oikos/tools/github-issues/cli.mjs boards                      # the organization's projects; * = GITHUB_PROJECT
node oikos/tools/github-issues/cli.mjs sprints [--state active,future,closed]
node oikos/tools/github-issues/cli.mjs sprint                      # the active iteration: issues by Status, load per assignee
node oikos/tools/github-issues/cli.mjs sprint --id 'Sprint 5'      # an iteration by id or title
```

Sprints are the **Iteration field of the project in `GITHUB_PROJECT`** (required). When that
project has no iteration field, sprints are the **milestones** of `--repo` / `GITHUB_REPO`, and
the output says so. Projects need the `project` scope (classic token, or
`gh auth refresh -s project`) or organization Projects access (fine-grained).

## Write — always dry-run first

```bash
node oikos/tools/github-issues/cli.mjs comment --task acme-corp/tools#24 --file <scratchpad>/comment.md --dry-run
node oikos/tools/github-issues/cli.mjs transition --task acme-corp/tools#24 --to "In Progress" --dry-run
# create — markdown description; --parent makes it a sub-issue; --add-to-project with --status / --sprint
node oikos/tools/github-issues/cli.mjs create --repo tools --summary "..." --file <scratchpad>/desc.md \
  --labels bug --assignee me --milestone 4 --parent acme-corp/tools#1 --add-to-project --status Todo --sprint 'Sprint 5' --dry-run
# edit one or many; --labels sets, --add-labels / --remove-labels change; --assignee none unassigns
node oikos/tools/github-issues/cli.mjs edit --task acme-corp/tools#15,acme-corp/tools#39 --assignee me --dry-run
node oikos/tools/github-issues/cli.mjs edit --query 'label:old is:open' --max 20 --add-labels new --remove-labels old --dry-run
# iterations: --backlog clears the iteration; an issue not in the project needs --add-to-project
node oikos/tools/github-issues/cli.mjs move-to-sprint --sprint 'Sprint 6' --query 'is:open label:carry-over' --max 30 --dry-run
node oikos/tools/github-issues/cli.mjs move-to-sprint --backlog --task acme-corp/tools#15 --dry-run
# links: "A blocks B"; parent / child are sub-issues
node oikos/tools/github-issues/cli.mjs link --from acme-corp/tools#15 --type blocks --to acme-corp/tools#39 --dry-run
```

- Show the user the dry run and write only after they confirm — the same command without
  `--dry-run`. The dry run shows the repository, every selected issue, the field and label
  changes, the status `from → to` and its source, the target iteration or milestone, and the link.
- **Public repositories.** A dry run of a public repository starts with `PUBLIC repository
  owner/repo — everything written is visible to anyone`. A write to a public repository — dry run
  or not — is refused (exit 3) unless it is listed in `GITHUB_PUBLIC_REPOS`.
- **@mentions notify.** The dry run lists them (`will notify @x`); a mention is not undone.
- **Unknown labels** are refused (exit 3): GitHub would create them silently. `--create-labels`
  creates them first, and the dry run says which.
- A bulk edit by `--query` is capped by `--max` (default 50).
- Titles, descriptions and comments are English; non-Latin text is refused unless
  `--allow-non-english`.
- `link --type`: `parent` / `child` are sub-issues, `blocks` / `blocked-by` issue dependencies
  ("blocked by", unverified until checked live). Any other relation: mention it in a comment.
- Not undoable: notifications, a created issue (deleting needs admin; not offered).
- Without credentials every command stops with exit 1 and names the missing key, before any
  request. Only `comment --dry-run` still previews — the write itself needs the credentials.

## Not here, on purpose

| Operation | Route |
|---|---|
| Close or reopen an issue, move it from review on | the user, on the issue's page (the tool prints the link) |
| Upload a file (`attach`) | GitHub has no upload API for issues (F2): the user drags the file into a comment |
| Goals (`goals`, `goal`, `goal-comment`) | GitHub has no goals; the organization's resource notes say where they are kept |
| Delete an issue, transfer it, lock it | the user, in GitHub |
| Link types other than parent / child / blocks / blocked-by | a comment that mentions the other issue |
| Create a status label or a Status option | the user, in the repository's labels or the project's settings |

## Credentials and settings

| Key | Where | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | `.local/.env` | the credential; without it the `gh` login (`gh auth token`) |
| `GITHUB_ORG` | settings | the default owner; the owner of the project |
| `GITHUB_REPO` | settings, optional | the default repository of `create`, `search`, `#12`, milestones |
| `GITHUB_PROJECT` | settings, optional | the organization project number: Status field and iterations |
| `GITHUB_AGENT_STATUSES`, `GITHUB_REVIEW_STATUSES` | settings | the statuses an agent moves among; from which on only a person moves |
| `GITHUB_PUBLIC_REPOS` | settings, optional | the public repositories writes may reach (`owner/repo`, comma separated) |
| `GITHUB_API_URL` | settings, optional | GitHub Enterprise Server (`https://<host>/api/v3`); untested |

Permissions (unverified until checked live): fine-grained — repository Issues read/write,
Metadata read, organization Projects read/write; classic — `repo` + `project`; `gh` —
`gh auth refresh -s project` for Projects. Never ask for a token in the chat.
