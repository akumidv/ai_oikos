# Connector: jira

Jira Cloud and the goals of Atlassian Home, for the skill `task-tracking`. One tool:
`node oikos/tools/jira/cli.mjs <command>` (run from the installation's root). Every command takes `--json` for
the raw payload and `--help` for its options.

**Never fetch a Jira URL with a web-fetch tool.** Atlassian is authenticated: the fetch returns an
empty login shell, and "the page was empty" becomes "the task has no description".

## Read

```bash
node oikos/tools/jira/cli.mjs whoami                          # which account, which credentials are set
node oikos/tools/jira/cli.mjs info --task PROJ-24               # summary, status, description, links, attachments, comments
node oikos/tools/jira/cli.mjs context --task PROJ-24            # info + sprint + epic children + warnings
node oikos/tools/jira/cli.mjs search --jql 'project = PROJ AND statusCategory != Done' --limit 100
node oikos/tools/jira/cli.mjs attachment --task PROJ-24 --id 38644 --dir <scratchpad>
node oikos/tools/jira/cli.mjs link --types                       # the link types and their wording
```

- **Comments are part of the specification** — the correction or narrowing often lives there.
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
node oikos/tools/jira/cli.mjs goals --tag current --search copilot   # filter by key, name or owner
node oikos/tools/jira/cli.mjs goals --archived                    # include archived goals
node oikos/tools/jira/cli.mjs goal --key GOAL-54                  # one goal: tags, sub-goals, comments, attached Jira issues
node oikos/tools/jira/cli.mjs goals --task TEAM-68                 # the goals of a task and of its parent
node oikos/tools/jira/cli.mjs goal-comment --key GOAL-54 --file <scratchpad>/comment.md --dry-run
node oikos/tools/jira/cli.mjs edit --task PROJ-15 --goals GOAL-55 --dry-run   # attach a task (sets the list; --goals "" clears)
```

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

## Write — always dry-run first

```bash
node oikos/tools/jira/cli.mjs comment --task PROJ-24 --dry-run --file <scratchpad>/comment.md
node oikos/tools/jira/cli.mjs comment --task PROJ-24 --file <scratchpad>/comment.md
node oikos/tools/jira/cli.mjs transition --task PROJ-24 --to "In Progress" --dry-run
```

```bash
# create — markdown description, assignee `me` or an email
node oikos/tools/jira/cli.mjs create --project PROJ --type Task --summary "..." --file <scratchpad>/desc.md \
  --parent PROJ-1 --assignee me --labels oikos --priority Medium --due 2026-10-15 --sprint 1046 --dry-run
# edit one or many; --labels sets, --add-labels/--remove-labels change; --assignee none unassigns
node oikos/tools/jira/cli.mjs edit --task PROJ-15,PROJ-39 --priority Low --dry-run
node oikos/tools/jira/cli.mjs edit --jql 'project = PROJ AND labels = old' --max 20 --add-labels new --remove-labels old --dry-run
# sprints
node oikos/tools/jira/cli.mjs move-to-sprint --sprint 1047 --jql 'sprint = 1046 AND statusCategory != Done' --max 60 --dry-run
node oikos/tools/jira/cli.mjs move-to-sprint --backlog --task PROJ-15 --dry-run
# links: "A blocks B"
node oikos/tools/jira/cli.mjs link --from PROJ-15 --type Blocks --to PROJ-39 --dry-run
```

- Show the user the dry run and write only after they confirm. For a bulk change the dry run
  lists every key; `--max` (default 50) refuses a JQL that selects more than was meant.
- Summaries, descriptions and comments are English; the tool refuses non-Latin text unless
  `--allow-non-english` is passed.
- **Replacing a description deletes its embedded images.** Jira Cloud removes an attachment
  that was pasted into the description once the new description no longer references it, so
  it is gone from Attachments too. Before `edit --description`/`--file` on a task whose `info`
  shows `[file: …]` in the description, download each such attachment with `attachment` and
  tell the user in the dry run that it will be deleted; the tool cannot upload it back (the
  user re-attaches it in Jira, or it is attached through the shared browser after confirmation).
- Deleting issues is not offered — a person does it in Jira.
- **Comments** are concise (2–5 lines), markdown (rendered to Atlassian format: headings,
  lists, code, `**bold**`, `[links](url)`).
- `transition` moves a task only among the statuses open to an agent — `JIRA_AGENT_STATUSES` in
  `oikos.yaml` settings (default `To Do, In Progress, Blocked`). Any other move is a
  person's — the tool refuses (exit 3) and prints the link for the user.
- Without credentials every command stops with exit 1 and names the missing keys, before any
  request; it never falls back to a dry run. Only `comment --dry-run` and `link --dry-run`, whose
  preview reads nothing from Jira, still show it — the write itself needs the credentials.

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
