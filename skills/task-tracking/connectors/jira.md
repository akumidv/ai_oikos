# Connector: jira

Jira Cloud and the goals of Atlassian Home, for the skill `task-tracking`. One tool:
`node oikos/tools/jira/cli.mjs <command>` (run from the installation's root). Every command takes `--json` for
the raw payload and `--help` for its options.

**Never fetch a Jira URL with a web-fetch tool.** Atlassian is authenticated: the fetch returns an
empty login shell, and "the page was empty" becomes "the task has no description".

## Read

```bash
node oikos/tools/jira/cli.mjs whoami                          # which account, which credentials are set
node oikos/tools/jira/cli.mjs info --task PROJ-24               # summary, status, description, links [link N], attachments, comments [id N]
node oikos/tools/jira/cli.mjs info --task PROJ-24 --extended    # … and its pull requests: attached, pool, extended set
node oikos/tools/jira/cli.mjs info --task PROJ-24 --description [--out <scratchpad>/desc.md]   # only the description, as editable markdown; --adf for raw ADF
node oikos/tools/jira/cli.mjs context --task PROJ-24            # info + sprint, epic children, sub-tasks, links, code, goals, warnings
node oikos/tools/jira/cli.mjs search --jql 'project = PROJ AND statusCategory != Done' --limit 100
node oikos/tools/jira/cli.mjs search --jql 'project = PROJ AND statusCategory != Done' --count   # only the total (≈, Jira's approximate count), no rows read
node oikos/tools/jira/cli.mjs history --task PROJ-24            # status moves: when, from → to, who (me / person / app); time in status, returns from review
node oikos/tools/jira/cli.mjs history --jql 'project = PROJ AND resolved >= -30d' --max 100   # one block across the issues + a line per issue
node oikos/tools/jira/cli.mjs attachment --task PROJ-24 --id 38644 --dir <scratchpad>
node oikos/tools/jira/cli.mjs link --types                       # the link types and their wording
```

- **Comments are part of the specification** — the correction or narrowing often lives there.
- **`context` before working on a task.** Its Code section is Jira's development panel (pull
  requests, open first; branches without one; the commit count) — only code hosts connected to
  Jira; `info --extended` also searches the project's repositories. Goals are the task's and its
  epic's. A section whose read fails prints `_<Section>: unavailable (…)_` and the rest still
  prints. Warnings name what is out of step: an epic, work going on (an "In Progress" status or an
  open pull request) outside an active sprint, a review or closed status, code while the status is
  still To Do, an open pull request no comment names.
- **`history` reads how a task moved**, from its changelog: each status move with its time, the
  actor and the actor's role — `me` (the account of the token), `app` (an app, or a change with no
  author: automation), else `person` —, the time in each status from the creation on (the current
  status counted up to now, marked `(now)`), the **returns from review** and the moves by role.
  **The return rule:** a return is a move whose `from` matches `/review/i` and whose `to` does not
  and is a status the task was in before that move, its initial status included — the work went
  back to where it had been. `In Review → QA` (QA not visited before), `In Review → Approved` and
  `Ready for Review → In Review` are not returns; `In Progress → In Review → In Progress` is one.
  `--jql` (`--max`, default 50; more matching is said) prints one block across the issues — per
  status the median and mean time over the issues that were in it, the returns, the moves by role —
  and one line per issue. A changelog over 5000 entries is read up to that and said `TRUNCATED`:
  later moves are missing, so its time in status is partial (the interval after the last move read
  is credited to no status, no `(now)`) and its returns may be undercounted. `--json` prints
  `{ issues: [{ key, summary, status, created, truncated, moves: [{ at, from, to, actor, role }],
  totals: { time, open, returns, byRole } }], aggregate: { issues, statuses, returns, returned,
  byRole, truncated } }` (`open` is null when truncated, `aggregate.truncated` counts such issues);
  `--raw` adds each issue's raw `changelog`. For cycle time, review churn, how much automation
  moves tasks.
- **Attachments carry what was never written down.** `info` lists them; fetch with `attachment`
  (the id from the Attachments list, not from the description) and read the file. If something
  still cannot be read, ask the user — do not rebuild the spec from the text around it.

## Mine — what is assigned to the user

"Me" is the account of the API token, i.e. the person in `JIRA_EMAIL` (`whoami` shows it). For
"my tasks", "what is on me", "my goals" start here:

```bash
node oikos/tools/jira/cli.mjs mine                         # my open issues by status (* = in an active sprint) + my goals this quarter
node oikos/tools/jira/cli.mjs mine --tag next              # … with next quarter's goals
node oikos/tools/jira/cli.mjs mine --user someone@example.com   # the same for a colleague
node oikos/tools/jira/cli.mjs goals --owner me --tag current   # only my goals
node oikos/tools/jira/cli.mjs search --jql 'assignee = currentUser() AND sprint in openSprints()'
node oikos/tools/jira/cli.mjs search --jql 'reporter = currentUser() AND statusCategory != Done'
```

In JQL, `currentUser()` is the same person. A colleague is named by email (`--user`, `--owner`,
`--assignee`); a name that matches several people is refused with the candidates listed.

## Goals (OKRs)

Goals live in Atlassian Home (keys like `GOAL-42`). **When goals are set per quarter, the quarter
is a tag on the goal**: `q3-26` = Q3 2026 (matching ignores case). Always scope a goal question to a quarter — the current one unless the user says
otherwise. A task reaches a goal through its `Goals` field or through its epic's.

```bash
node oikos/tools/jira/cli.mjs goals --tags                        # the quarter tags in use, and the current quarter
node oikos/tools/jira/cli.mjs goals --tag current                 # this quarter's goals (also: next, previous, q3-26, "q2-26,q3-26")
node oikos/tools/jira/cli.mjs goals --tag current --state at_risk # on_track | at_risk | off_track | pending | done …
node oikos/tools/jira/cli.mjs goals --tag current --search platform  # filter by key, name or owner
node oikos/tools/jira/cli.mjs goals --archived                    # include archived goals
node oikos/tools/jira/cli.mjs goal --key GOAL-54                  # one goal: tags, sub-goals, comments, attached Jira issues
node oikos/tools/jira/cli.mjs goals --task TEAM-68                 # the goals of a task and of its parent
node oikos/tools/jira/cli.mjs goal-comment --key GOAL-54 --file <scratchpad>/comment.md --dry-run
node oikos/tools/jira/cli.mjs edit --task PROJ-15 --add-goals GOAL-55 --dry-run   # attach a task to a goal, through the goals service, confirmed by reading the task back
```

- **Attach a task to a goal** with `edit --add-goals`; `create --goals` links the new issue the
  same way, after the create. The Goals field is never written: Jira answers 204 and drops the
  value, so `edit --goals` is refused.
- **Removing a goal** from a task is done in Atlassian Home.
- **Quarter review**: `goals --tag current --state at_risk` (and `off_track`, `pending`), then
  `goal --key` for each — its issues show whether work behind it is moving, its comments what
  was said. Issues attached only through an epic are not listed by `goal`; check the epics.
- **Comments** on a goal: markdown, English, 2–5 lines; dry-run, show, post after confirmation —
  the same rules as Jira comments.
- The goal itself (name, state, score, target date, tags, progress updates) is edited in
  Atlassian Home by its owner, not by this tool.

## Boards and sprints

```bash
node oikos/tools/jira/cli.mjs boards [--project PROJ] [--name TEAM]
node oikos/tools/jira/cli.mjs sprints --board 20 [--state active,future,closed]
node oikos/tools/jira/cli.mjs sprint --board 20        # the board's active sprint
node oikos/tools/jira/cli.mjs sprint --id 1046         # a specific sprint
```

`sprint` prints the goal and dates, the issues grouped by status, and done/total per assignee.
For a sprint review or planning summary, start from it and add JQL searches for what it does not
cover (e.g. carry-over: `sprint in openSprints() AND sprint in closedSprints()`).
`sprint`, `sprints` and `context` warn when an active sprint's end date has passed and it is still
open: a person closes it and decides on the carry-over, so name it to the user and change nothing.
Future sprints a project keeps for tasks not yet described (a preparation or "description" stage)
hold them on purpose — do not pull tasks from them into the active sprint by status alone; ask.

## Write — always dry-run first

```bash
node oikos/tools/jira/cli.mjs comment --task PROJ-24 --dry-run --file <scratchpad>/comment.md
node oikos/tools/jira/cli.mjs comment --task PROJ-24 --file <scratchpad>/comment.md
node oikos/tools/jira/cli.mjs comment --task PROJ-24 --edit 10001 --file <scratchpad>/comment.md --dry-run   # replace own comment (the [id N] of info)
node oikos/tools/jira/cli.mjs comment --task PROJ-24 --delete 10001 --dry-run                               # delete own comment
node oikos/tools/jira/cli.mjs transition --task PROJ-24 --to "In Progress" --dry-run
node oikos/tools/jira/cli.mjs transition --task PROJ-24,PROJ-25 --to Done --dry-run   # many tasks: one brief dry run
```

```bash
# create — markdown description, assignee `me` or an email
node oikos/tools/jira/cli.mjs create --project PROJ --type Task --summary "..." --file <scratchpad>/desc.md \
  --parent PROJ-1 --assignee me --labels oikos --priority Medium --due 2026-10-15 --sprint 1046 --dry-run
# edit one or many; --labels sets, --add-labels/--remove-labels change; --assignee none unassigns
node oikos/tools/jira/cli.mjs edit --task PROJ-15,PROJ-39 --priority Low --dry-run
node oikos/tools/jira/cli.mjs edit --jql 'project = PROJ AND labels = old' --max 20 --add-labels new --remove-labels old --dry-run
# description: change one part and keep the rest (read it first with info --description)
node oikos/tools/jira/cli.mjs description --task PROJ-15 --section "Acceptance criteria" --file <scratchpad>/ac.md --dry-run
node oikos/tools/jira/cli.mjs description --task PROJ-15 --append --file <scratchpad>/update.md --dry-run
node oikos/tools/jira/cli.mjs description --task PROJ-15 --adf --file <scratchpad>/desc.json --dry-run   # whole replace from raw ADF
# sprints
node oikos/tools/jira/cli.mjs move-to-sprint --sprint 1047 --jql 'sprint = 1046 AND statusCategory != Done' --max 60 --dry-run
node oikos/tools/jira/cli.mjs move-to-sprint --backlog --task PROJ-15 --dry-run
# links: "A blocks B"
node oikos/tools/jira/cli.mjs link --from PROJ-15 --type Blocks --to PROJ-39 --dry-run   # reads PROJ-15 back, prints the link id
node oikos/tools/jira/cli.mjs unlink --id 10234 --dry-run         # names the link it would remove
# files: attach local files (attachment downloads one)
node oikos/tools/jira/cli.mjs attach --task PROJ-15 --file report.pdf --file .local/notes/plan.md --dry-run
```

- Show the user the dry run and write only after they confirm. For a bulk change the dry run
  lists every key; `--max` (default 50) refuses a JQL that selects more than was meant.
- **A long text's dry run is compact.** Over 2000 characters, the dry run of `edit` and `create`
  (the description), `description` (`--text`/`--file`) and `comment` prints the text's size, its
  outline and a unified diff from the current description (`edit` per issue, `description` of the
  whole description) — or its first 15 lines where there is nothing to compare (`create`,
  `comment`). Show the user that; `--full` prints the whole text when they want to read it. `--full`
  only changes what a dry run prints, so the confirmed write may keep it (the write is the dry run
  without `--dry-run`).
- `--parent` is read before the dry run and the write: a parent in another project is refused
  when either project is team-managed (Jira allows only a same-project parent there), with the
  `link` to make instead; between company-managed projects it passes with a note.
- Summaries, descriptions and comments are English; the tool refuses non-Latin text unless
  `--allow-non-english` is passed.
- **To change part of a description, use `description`.** `--section "Heading"` replaces the body
  under that top-level heading (case-insensitive; `"## Heading"` fixes the level) up to the next
  heading of its level; several matches are refused with the list, a missing one is appended as a
  new section. `--append` adds after the end. Both keep every other node as it is, so nothing
  outside the edited part needs a guard; a section body holding what markdown cannot carry is
  refused unless `--force`, and so is a new body that leaves out an image or task card the old one
  carried (keep each as its `![alt](media:<id>?…)` line or its key). The dry run prints the old body
  and the resulting outline. `info --description` prints the editable markdown (an image as
  `![alt](media:<id>?…)`, a task card as its key) that `--section`/`--append`/`edit --file` read
  back — a read, so it lives in `info`: `description` has no read mode. `--adf --file` replaces the
  whole description from JSON, refused when the new document lacks any media id, mention account
  id, card URL, macro (extension type and key), status text or emoji the old one had anywhere in it,
  panels and expands included (`--force`).
- **Replacing a whole description from markdown is refused when it would lose content.** Before `edit
  --description`/`--file` (each issue of a `--jql` selection too, and in the dry run) the tool reads
  the current description and refuses, naming the issue and what it holds (`mention x2`), when it
  has anything markdown cannot carry: files and images an image line cannot hold, cards other than
  a task card of the site, macros, mentions, status lozenges, emoji, tables beyond plain ones,
  marks beyond one of bold/code/link, deeper lists. It refuses too when the new text leaves out an
  image or task card the old description carried: keep each image as the `![alt](media:<id>?…)`
  line `info --description` prints, and each task card as its key.
  Jira Cloud also deletes an image pasted into the description once the new description no longer
  references it, so it is gone from Attachments too. Show the user the refusal; `--force`
  overwrites anyway — only after the user confirms, and after downloading each such attachment
  with `attachment` — an image comes back as an image line naming the downloaded file. Prefer
  `description --section`/`--append`, which keep it in place.
- **`attach` uploads local files** to one task, `--file` once per file: md, txt, log, csv, json,
  yaml/yml, pdf, docx, xlsx, pptx, png, jpg/jpeg, gif, webp, svg, at most 10 MB each; any other
  type (an archive too: it could carry a closed store) or size is refused naming the file. The path
  rule is the image lines' below — inside the installation, a working folder of `.local/` included,
  never a dot-named store there nor anything under a dot-named file or folder elsewhere (`.mcp.json`,
  `.claude/settings.local.json`, `.git/…`: configuration, never sent out); a file the
  agent made in its scratchpad is copied into the installation (a working folder of `.local/`)
  first. The dry run (offline too) lists name, size and type and names a file the task already has
  by name and size — that one is not uploaded again. The write reads the attachments back and
  prints `[id] name (size)` of each file; one Jira took but the task does not show, or a failed
  upload, exits 2. Removing an attachment is done in Jira.
- Deleting issues is not offered — a person does it in Jira.
- `link --type` takes a type name or either of its verbs (`link --types` lists them); an inward
  verb (`--type "is blocked by"`) swaps the ends. Before the write it reads the from-issue's links:
  the same link already there is reported (exit 0, nothing written), a link of the type stated the
  other way is refused with the `unlink --id` to run first. After the write it confirms the
  direction by reading the from-issue back; a link stated the other way exits 2 with its id. Links made by an earlier oikos version may read back reversed: check them in the
  task's links (`info`) and remove a wrong one with `unlink --id`.
- **Comments** are concise (2–5 lines), markdown (rendered to Atlassian format: headings,
  lists, code, `**bold**`, `[links](url)`). `[~accountid:<account id>]` mentions a person (the
  account id is in a `confirm` dry run's Assignee line, or `--json` of `info`).
- **Markdown writes** (comment, description, create/edit, a transition's or a goal's comment): a
  task key of a project the site has (`PROJ-39`, outside code and links) becomes a task card; the
  project list is read only when the text names a key. An image alone on its line becomes an image
  (comment, description, a single-issue `edit`): `![alt](attachment:<name>)` is an attachment the
  task has; `![alt](path.png)` is a local png/jpg/jpeg/gif/webp/svg/bmp **inside the installation
  (a working folder of `.local/` such as `.local/cv/` included, never a dot-named store there such
  as `.local/.secrets/`) or the `--file` markdown's folder**, never under a dot-named file or folder
  outside a working folder of `.local/` (`.claude/`, `.git/`) — real path, so a symlink out or a
  loop is refused — uploaded to the task unless an attachment of the same name and size is there (reused).
  `media:<id>` and `https://` lines stay as they are. The dry run uploads nothing and lists each
  image. `create` refuses image lines (no issue yet): create, then `description --append`.
- **Edit or delete only your own comment.** `comment --edit ID` / `--delete ID` read the comment
  first and refuse one written by another account than the token's (`--others` overrides — only
  on the user's explicit word). The dry run names the comment by its first line and, for an edit,
  shows the new text. An edit is refused over content markdown cannot carry, as a description is
  (`--force` overrides). Anything but HTTP 200 (edit) or 204 (delete) exits 2.
- `transition` follows the installation's rules ([jira/transitions.md](jira/transitions.md)); without them it moves a task only among the statuses
  open to an agent — `JIRA_AGENT_STATUSES` in `oikos.yaml` settings (default
  `To Do, In Progress, Blocked`) — and any other move is a person's: the tool refuses (exit 3) and
  prints the link for the user.

## Transitions and project setup

Read only for the step that needs it:

| Topic | Read |
|---|---|
| `transition` by the installation's rules — the `task-tracking.jira` block, the modes, a `confirm` dry run with its evidence, `## Pull requests` (bare numbers, commits, `--skip-pr`) and `## Epic` (role epics, other projects' epics), `--brief`, many tasks with `--task A,B,…`, `info --extended` | [jira/transitions.md](jira/transitions.md) |
| `project-init`, `repos add` — a project's key aliases, repository pool and extended set, its bare-number repositories (`repos add --numbers`) and patterns (`--number-pattern`), its role epics (`--epic-role`) and epic projects (`--epic-project`), results and epics in `oikos.yaml` | [jira/project-setup.md](jira/project-setup.md) |

## The organization's Jira

Which boards plan which projects, what each status means, how goals and epics tie tasks together
is the organization's: read its resource note (`node oikos/tools/landscape/cli.mjs resources` lists the one reached via
`jira`) before a sprint or goal question. Related tasks usually come by issue links, the epic
(`parent = <epic>`) and the goal.

## Credentials

`JIRA_API_TOKEN` (https://id.atlassian.com/manage-profile/security/api-tokens) and `JIRA_EMAIL`
(an address of `organization.email_domain`; falls back to `git config user.email` only when that
domain is configured and the git email is in it) — in
`.local/.env` (the shell environment is only a fallback). `JIRA_BASE_URL` is in the `settings` of `oikos.yaml`. `whoami` shows what is
set and where from. Never ask for a token in the chat.
