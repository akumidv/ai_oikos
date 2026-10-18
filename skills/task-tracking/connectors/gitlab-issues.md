# Connector: gitlab-issues

GitLab issues (GitLab.com or a self-hosted instance), for the skill `task-tracking`. One tool:
`node oikos/tools/gitlab-issues/cli.mjs <command>` (run from the installation's root). Every
command takes `--json` for the raw payload and `--help` for its options.

**Never fetch a GitLab URL with a web-fetch tool.** A private project answers an anonymous
request with a login page or a 404, and "the page was empty" becomes "the task has no
description". Paste the URL to the tool instead.

A task is named `group/project#12`, `#12` (or `12`) in the default project `GITLAB_PROJECT`, or
by its URL (`https://gitlab.example.com/group/sub/project/-/issues/12`, also `…/-/work_items/12`).

## Read

```bash
node oikos/tools/gitlab-issues/cli.mjs whoami                       # which user, the token scopes, the settings
node oikos/tools/gitlab-issues/cli.mjs info --task acme-corp/tools#24   # title, status label, labels, milestone, links, description, attachments, comments
node oikos/tools/gitlab-issues/cli.mjs context --task '#24'          # info + milestone or iteration + warnings
node oikos/tools/gitlab-issues/cli.mjs search --labels bug --state opened --limit 100
node oikos/tools/gitlab-issues/cli.mjs search --group acme-corp --milestone 'Sprint 3' --assignee me
node oikos/tools/gitlab-issues/cli.mjs search --search 'login timeout' --query 'order_by=created_at'
node oikos/tools/gitlab-issues/cli.mjs attachment --task '#24' --id 1 --dir <scratchpad>
```

- **Search is filters, not a query language**: `--labels a,b` (all of them), `--milestone TITLE`,
  `--state opened|closed|all` (default opened), `--search text`, `--assignee me|<username>|none`,
  `--iteration ID` (Premium; unverified until checked live). `--query` passes GitLab's own
  list-issue parameters as they are (`'labels=bug&not[labels]=wontfix'`); the flags win over it.
  The scope is `--project`, else `--group`, else `GITLAB_PROJECT`, else `GITLAB_GROUP`, else every
  project the token sees.
- **Comments are part of the specification** — the correction or narrowing often lives there.
  System notes (label and milestone changes) are counted, not shown.
- **Attachments carry what was never written down.** `info` lists the files linked in the
  description and the comments (`/uploads/…`); fetch one with `attachment --id <n>`. The download
  goes through GitLab's uploads API, which is unverified until checked live and may need a
  higher role; when it fails the tool prints the link to open in the browser.

## Mine — what is assigned to the user

"Me" is the owner of `GITLAB_TOKEN` (`whoami` shows it).

```bash
node oikos/tools/gitlab-issues/cli.mjs mine                      # my open issues by status label
node oikos/tools/gitlab-issues/cli.mjs mine --user some.one      # the same for a colleague (GitLab username)
node oikos/tools/gitlab-issues/cli.mjs search --assignee me --milestone 'Sprint 3'
```

## Status — labels

GitLab issues carry their status as a label. `GITLAB_AGENT_STATUSES` (settings, comma separated,
case-insensitive) lists the labels an agent may move a task among, e.g. `To Do, In Progress`
(scoped labels such as `status::doing` work too); `GITLAB_REVIEW_STATUSES` those from which on only
a person moves a task. **There is no default**: without `GITLAB_AGENT_STATUSES`, `transition` is
refused (exit 3) and names the key. The status a line shows is the first such label, `open` when
there is none, `closed` for a closed issue.

## Boards and sprints

A "sprint" is a milestone (default) or an iteration (Premium), by `GITLAB_SPRINTS` =
`milestones` | `iterations`.

```bash
node oikos/tools/gitlab-issues/cli.mjs boards --project acme-corp/tools    # boards and their lists (read-only)
node oikos/tools/gitlab-issues/cli.mjs boards --group acme-corp
node oikos/tools/gitlab-issues/cli.mjs sprints [--state active|closed|all]  # milestones of the project and of GITLAB_GROUP
node oikos/tools/gitlab-issues/cli.mjs sprint --id 1046                     # issues by status label, closed/total per assignee
```

`sprints` prints each milestone's **id** — that, not the title, is what `sprint --id` and
`move-to-sprint --sprint` take. With `GITLAB_SPRINTS: iterations`, `sprints` lists the group's
iterations (`--state opened|upcoming|current|closed|all`, default opened) and the group is
`--group`, `GITLAB_GROUP` or the project's own group.

## Write — always dry-run first

```bash
node oikos/tools/gitlab-issues/cli.mjs comment --task '#24' --file <scratchpad>/comment.md --dry-run
node oikos/tools/gitlab-issues/cli.mjs transition --task '#24' --to "In Progress" --dry-run
# create — markdown description, assignee `me` or a username, --sprint a milestone id
node oikos/tools/gitlab-issues/cli.mjs create --project acme-corp/tools --summary "..." --file <scratchpad>/desc.md \
  --labels backend --assignee me --due 2026-10-15 --sprint 1046 --dry-run
# edit one or many; --labels sets, --add-labels/--remove-labels change (one PUT per issue); --assignee none unassigns
node oikos/tools/gitlab-issues/cli.mjs edit --task '#15,#39' --add-labels backend --dry-run
node oikos/tools/gitlab-issues/cli.mjs edit --query 'labels=old' --max 20 --add-labels new --remove-labels old --dry-run
# sprints
node oikos/tools/gitlab-issues/cli.mjs move-to-sprint --sprint 1047 --query 'milestone=Sprint 3' --max 60 --dry-run
node oikos/tools/gitlab-issues/cli.mjs move-to-sprint --backlog --task '#15' --dry-run
# links: "A blocks B"
node oikos/tools/gitlab-issues/cli.mjs link --from '#15' --type blocks --to acme-corp/web#39 --dry-run
```

- Show the user the dry run and write only after they confirm, as the exact same command without
  `--dry-run`. The dry run shows the project, every selected issue, the field and label changes,
  `from → to` of a transition, the target milestone or iteration, `A —blocks→ B`, and whom an
  @mention will notify.
- **Bulk** selection by `--query` (GitLab list parameters, in the scope of `--project` /
  `--group` / the defaults; open issues unless it names a `state`) or `--task A,B` is capped by
  `--max` (default 50): a selection of more is refused, never cut.
- **Unknown labels are refused**: GitLab creates a label silently when a write names one it does
  not know, so a typo would become a new label. The tool checks the project's labels (its own and
  its groups') first and refuses (exit 3) with the near match; `--create-labels` when new labels
  are meant.
- `transition` moves a task only among `GITLAB_AGENT_STATUSES`, as **one** `PUT` with
  `add_labels` (the target) and `remove_labels` (the other agent status labels on the issue) —
  GitLab applies both at once. A target outside the list, an issue in a review status, a closed
  issue, a missing `GITLAB_AGENT_STATUSES`: refused (exit 3) with the issue's link for the user.
- **An agent never closes or reopens an issue**: `transition --to closed`, `edit --state` are
  refused (exit 3); a person does it in GitLab.
- `move-to-sprint` sets `milestone_id` (`--backlog`: 0, no milestone). With
  `GITLAB_SPRINTS: iterations` it sets `iteration_id` (`--backlog`: null) through the same `PUT` —
  **unverified until checked live**; the dry run says so, and the issue is checked after the
  write. A closed milestone or iteration is refused. `create --sprint` takes a milestone only.
- `link --type relates_to | blocks | is_blocked_by`. Blocking links depend on the GitLab tier
  (unverified until checked live): a 403 or 400 from GitLab is reported as "this GitLab tier may
  not offer blocking links"; link as `relates_to` then, or a person links them.
- Titles, descriptions and comments are English; the tool refuses non-Latin text unless
  `--allow-non-english` is passed. Comments are concise (2–5 lines), markdown (native in GitLab).
- Not undoable: the notifications a write sends, a created issue (deleting needs the Owner role
  and is not offered).
- Without credentials every command stops with exit 1 and names the missing keys, before any
  request. Only `comment --dry-run`, whose preview reads nothing, still shows it — the write itself
  needs the credentials.

## Not here, on purpose

| Operation | Why | The route a person takes |
|---|---|---|
| close / reopen an issue | a person's move, never an agent's | the issue's page in GitLab |
| attach a file (`attach`) | an upload needs multipart requests, planned with F2 | drag the file into the issue in GitLab |
| goals, epics, OKRs (`goals`, `goal`, `goal-comment`) | tiered and out of F7 | the group's epics page, `<GITLAB_URL>/groups/<group>/-/epics` |
| delete an issue | needs the Owner role; not undoable | the issue's page in GitLab |
| edit a board | boards are read-only here | the board in GitLab |

The tool still has `attach`, `goals`, `goal` and `goal-comment`: each stops with one line saying it
is not offered and where a person does it.

## Credentials and settings

| Key | Where | Purpose |
|---|---|---|
| `GITLAB_TOKEN` | `.local/.env` | a personal access token; writes need scope `api`, `read_api` is enough for reads (`whoami` warns when the token lacks `api`) |
| `GITLAB_URL` | settings | the site, e.g. `https://gitlab.example.com` |
| `GITLAB_PROJECT`, `GITLAB_GROUP` | settings, optional | the default project (`#12`, `create`, `search`) and group (boards, milestones, iterations, `search`) |
| `GITLAB_SPRINTS` | settings | `milestones` (default) or `iterations` |
| `GITLAB_AGENT_STATUSES`, `GITLAB_REVIEW_STATUSES` | settings | the status labels — § Status |

Token page: `<GITLAB_URL>/-/user_settings/personal_access_tokens`. `whoami` reads the scopes
from `GET /personal_access_tokens/self` (unverified until checked live; "scopes not reported" when
GitLab does not answer it). Never ask for a token in the chat.
