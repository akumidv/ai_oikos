---
name: footprint
description: Collect the footprint a person leaves in the organization's resources over a period — commits and lines in local git clones, pull or merge requests and reviews on the code host, issues and worklogs in the tracker, wiki pages, notes, messages, mail and calendar — into one markdown report with a timeline, totals per source and a comparison with recorded hours. Triggers on "what did Ada do last quarter", "my footprint for the week", "activity report for", "how many hours did I log vs commits", "collect my contributions for the CV", "performance review material", "what have I done since", "weekly report of my work".
when_to_use: When the question is what a person did over a period across the organization's resources — for a weekly or quarterly report, a performance review, a CV — or how their activity lines up with the hours they recorded.
metadata:
  owner: oikos
  group: hr
surface: read-only — local git clones and, where the installation lists their connectors, the code host, the tracker and the wiki (tools/footprint); messages, mail, documents and the calendar through the claude.ai connectors; notes in the knowledge base
refuses: writing anything to any resource, ranking people (by lines of code or otherwise), a verdict on a person's performance, and sending or sharing the report (that goes through the messaging or workspace skill, with confirmation)
---

# footprint

A **footprint** is the traces a person's work leaves in the organization's resources over a
period: commits, pull or merge requests and reviews, issues moved and hours logged, pages
written, messages, mail, meetings. It is collected into one markdown report — when the person was
active, how much of each kind, and how it lines up with the hours they recorded.

The numbers are **signals, read with the person's role**, never a verdict. A lead who reviews and
unblocks leaves few commits; an analyst leaves pages, not code; thinking, conversations and work
outside the systems leave nothing. The report says what was seen, and the reading says what it
leaves out.

## Scenarios

Typical tasks have their own step-by-step file in `scenarios/`. Pick the one that fits and read
it before starting.

| Scenario | When | Read |
|---|---|---|
| A person over a period | "what did Ada do last quarter", "my footprint for the week", "activity report for", "material for the review", "my contributions for the CV" | [scenarios/period-report.md](scenarios/period-report.md) |
| Activity against recorded hours | "how many hours did I log vs commits", "compare the worklog with the activity", a timesheet next to the timeline | [scenarios/against-hours.md](scenarios/against-hours.md) |

A new typical task gets its own file in `scenarios/` and a row here. The user's own CV kept from
these facts is the `cv` skill's scenario `own-cv`.

## Rules

- **The purpose comes first.** Before collecting, name what the report is for — a weekly report,
  a quarterly review, a CV, a question about hours — and pass it to `collect` as `--purpose`,
  which prints it under the report's title. No purpose, no collection.
- **Someone other than the user.** Ask whether the person knows their footprint is being
  collected, and say that monitoring employees is restricted by law — in Switzerland by ArGV 3
  art. 26 (monitoring of behaviour at the workplace), in the EU by the GDPR (purpose limitation,
  information of the person) — so the purpose and the person's knowledge matter. Go on only when
  the user confirms the purpose; the decision and its responsibility are the user's.
- **The report stays in the installation.** It is saved to `.local/footprint/<person>-<since>-<until>.md`
  (`<person>` a short lowercase id such as `ada`, dates `YYYY-MM-DD`) and is not copied to the
  knowledge base, a wiki, a shared note or a message unless the user asks — and then through the
  skill that does it, with confirmation.
- **No ranking of people.** Two people's footprints are not compared to rank them, and lines of
  code are never a measure of a person. A question of the kind "who works the least" is answered
  with what the numbers cannot tell, not with a list.
- **Places come from the user.** Where the work was done — the organization, a personal project,
  another client — is a place the user names in the settings (§ Places and settings); the tool
  never guesses that a repository, project or space is personal, what no rule names is the default
  place, and the report lists the rules it used. Before a report that splits by place, ask the user
  which repositories, projects and spaces are not the organization's.
- **Sources are counted apart.** The same commit is in git and on GitHub, a merge request is both
  a GitLab event and a link in a Jira issue: each source has its own totals and there is no grand
  total of events.
- **Read-only.** Nothing is written to any resource; the tool has no write command.
- **Answer in the user's language**; the report's measures stay as the tool prints them.

## Sources and what each needs

`node oikos/tools/footprint/cli.mjs`, run from the installation's root, collects the sources that
have code; the others are collected by hand (next section).

| Source | What is counted | Identity | Needs |
|---|---|---|---|
| git | commits by author date, each at its time with its repository and subject; repositories, files, lines added and removed as code, tests and docs; generated files (lock files, minified, maps, snapshots, `dist/`, `vendor/`, and the settings' `generated` paths) left out and counted apart; commits whose subject matches the settings' `skip_commits` (everywhere, or in the repositories a rule names) left out and counted apart; the lines of the settings' `pipeline_repos` counted apart (their commits keep their time); a rebased or cherry-picked copy counted once. A repository is named by its remote (`owner/name`, not the folder), so two clones of one remote are one repository and a commit in both counts once; the remote's credentials (`https://user:token@…`, a password with `/` or `@` in it too) are dropped before anything is shown; the submodules of a repository found are repositories of their own | the author's email(s) or name (`--email` exactly, `--name` as a substring whose case may be ignored for ASCII letters only) | local clones under `--repos`, fetched first: their branches, tags and remote-tracking branches are read (not the stash or notes), so only what was fetched is seen; the user's git configuration applies, except the settings that change the counts (renames, mailmap off, …) |
| github | with `GITHUB_ORG`: the organization's repositories listed and each active one's pull requests read newest-updated first — complete for what the token can read; without it: GitHub search (`involves:` the person) across the whole of GitHub, which can return incomplete results — a lower bound. Pull requests opened (and of them those merged since) with their lines, pull requests merged by the person, reviews and reviews by state on others' pull requests (those on the person's own counted apart), others' pull requests reviewed, merged by the person, and reviewed or merged (the lines of the reviewed and of the reviewed-or-merged ones, once per pull request), the person's commits on the pull requests found (all of them, read page by page); each pull request opened, review, review comment, comment, merge and commit an action at its time, with its repository; on others' pull requests the reviewed lines once per pull request and day, on the first review, review comment or merge — a conversation comment alone is no review and carries none; issues opened; per repository. Commits pushed without a pull request are git's | the login (`--github`) | the `github` connector listed; `GITHUB_TOKEN` (the `repo` scope reads private organization work; `read:org` is not needed); `GITHUB_ORG` names the organization to read whole (recommended), else search covers the whole of GitHub |
| gitlab | every event with its kind and project, each an action at its time: pushes and their commits, branches and tags deleted, merge requests opened, merged by the person and approved, comments, issues; others' merge requests the person approved, merged or commented on are read once each for their author, and those approved or merged for their lines in the diff (the reviewed volume — a lower bound where GitLab does not show a diff or cuts it), once per merge request and day — a comment alone is no review and carries no lines; a project that cannot be looked up is shown by id in the default place; per project | the username (`--gitlab`) | the `gitlab` connector listed; `GITLAB_TOKEN`, `GITLAB_URL`; GitLab keeps events for three years |
| jira | the person's actions, each at its time, on the issues they had to do with (created, reported, assigned at some time, watched, moved or logged on, and updated in the period; up to 1000): issues created, status changes and other edits from each issue's changelog, comments, worklogs; worklog hours on the calendar date of their start. A comment on an issue outside these is missed; which issues are read depends on their state now, so a later run can find more actions on older days; an issue that answers 404 or 403 is skipped and named | the account id, email or name (`--atlassian`) | the `jira` connector listed; its credentials |
| confluence | pages and blog posts created (with the words of their current text); edits — the versions the person saved in the period (version 1, the creation, is not an edit) of the pages they ever contributed to that changed since the period began (at most 500 pages looked into); per space | the account id, name or email (`--atlassian`; Confluence finds no one by email, so an email is resolved through Jira where the `jira` connector is listed with its credentials, else refused) | the `confluence` connector listed; its credentials |
| hours | recorded hours per day from a timesheet | — | a CSV file (`--hours`) |

A source runs only when its connector is listed under some skill in the installation's
`oikos.yaml`; one that is not listed, has no credential or does not know the person is reported
under **Notes** as not collected, and the others still run. `--me` takes the identity of the
credentials' owner in every source; for git, `git config user.email` as the installation's root
sets it, each repository's own `user.email` in that repository, and the Atlassian email where
jira or confluence is listed — the Notes name the addresses matched. `identify --me` shows who
that is in each source.

```bash
node oikos/tools/footprint/cli.mjs sources                              # per source: listed, credentials present, identity it needs; no request
node oikos/tools/footprint/cli.mjs identify --name "Ada Lovelace" --repos ~/src   # candidate identities per source
node oikos/tools/footprint/cli.mjs identify --me --repos ~/src          # the user's own account in each source, and git emails
node oikos/tools/footprint/cli.mjs collect --since 2026-07-01 --until 2026-09-30 \
  --email ada@example.com --name "Ada Lovelace" --github ada --gitlab ada --atlassian "Ada Lovelace" \
  --repos ~/src --person "Ada Lovelace" --purpose "quarterly review"   # the report as markdown
node oikos/tools/footprint/cli.mjs collect --since 2026-10-13 --me --repos ~/src --source git,jira --by day --purpose "weekly report"
node oikos/tools/footprint/cli.mjs collect --since 2026-07-01 --me --repos ~/src --place personal=ada-tools --day-starts 04:00 --purpose "CV"
```

`collect` flags: `--since YYYY-MM-DD` (required), `--until` (default today), `--tz` (IANA, default
the system's: days and weeks are local dates in it), `--repos` (repeatable; a repository or a
folder with repositories up to two levels down; read only when git is collected), `--source
git,github,…` (default every available), `--hours file.csv` (repeatable), `--by day|week` (the
by-day table is shown for periods of up to 31 days; `--by week` leaves it out whatever the length,
`--by day` adds it whatever the length), `--person "display name"` for the report's header,
`--purpose "what the report is for"` printed under the title (`purpose` in `--json`), `--config
file.yaml` (the settings, default `.local/footprint/config.yaml`), `--place label=pattern[,pattern]`
(repeatable, tried before the file's places), `--default-place label`, `--day-starts HH:MM` (the
next section), `--json` for the report object. It exits 1 only when no source ran.

The report:

- **header** — period, purpose, time zone, sources, the Mon–Fri days, the working day's start, the
  settings file and the place rules used, the caution that the numbers are signals, and — when git
  and a code host ran — that one commit is counted once;
- **Per day, by place** — per place and for all places (one column when there is one place):
  active days (weekend days among them), the median first and last action, the span first–last
  (median · mean over the days with two timed actions or more); per active day (median · mean)
  actions, commits, code + tests lines added, docs lines added, Jira actions and reviews of others'
  pull or merge requests; per Mon–Fri day of the period actions, commits and code + tests lines
  added; and the period's totals (actions, commits, lines +/− by kind, Jira actions by kind — a
  kind the tool does not know as "other" — GitLab pushes, reviews and their lines). Reviewed lines
  are counted once per pull or merge request and day here, once per pull or merge request in the
  sources' totals;
- **Calendar** — per place, weeks × Mon…Sun, each cell `09:12–19:40 · 23` (first–last action ·
  actions that day), `—` outside the period, and the active days of each week; a place with no
  action in the period — a place the settings name with no event at all too — gets a line saying so
  instead (here, in By week and in What changed);
- **By week** — per place: active days, the mean span, actions, commits, code + tests and docs
  lines added, Jira actions, reviews and the reviewed lines (a zero shown as `0` or `+0`); the
  hours per label beside all places;
- **What changed** — per place: the repositories (commits, days, code + tests and docs lines — a
  zero shown as `+0 −0` — the three largest commits' subjects, commits with lines only), Jira
  actions by project, the issues with the most actions, others' pull or merge requests reviewed per
  repository with their lines, the actions by kind;
- **By day** (up to 31 days, or `--by day`) — a row per day and place: first and last action,
  events per source, hours, and the content (repositories with their lines, issue keys with their
  actions);
- **Totals** per source, each source's **breakdown** (with a Place column where its rows have a
  place), and **Notes** — what was skipped, cut at a cap or not counted, and a period that ends
  today (the day is still running).

An action is any event with its time; an event that has only a date counts for its day, not for
its first and last action, and one with neither is left out and counted in the Notes. **One commit
is counted once:** when git ran, its commits are the actions, and a GitHub commit or a GitLab push
in a repository git read — its remote, host and path, is one of the clones' `origin` — is not an
action nor a first or last action (it stays in its source's totals; the pushes keep a row of their
own, and the Notes say how many were left out); one in a repository git did not read (no local
clone, or not under `--repos`) is an action, as is every one without git. A review of someone else's pull or merge request
— a review, a review comment, an approval or a merge — counts once per request and day, with its
lines once; a conversation comment, a commit, a push, a close or a reopen is not a review. Hours
stay on their calendar date. `--json` gives the same report as plain objects and arrays (a
breakdown's rows carry their places, not the paths or remotes they were matched on).

### Places and settings

A **place** is where the work was done: the organization, a personal project, another client. The
user names them; what no rule names is the default place (`default_place`, else the installation's
`organization.name`). The settings live in `.local/footprint/config.yaml` — an open working file
beside the reports, with no secret in it — and the flags of `collect` override them:

```yaml
default_place: ACME Corp               # else organization.name of oikos.yaml; --default-place
places:                                # label → case-insensitive substrings; --place label=a,b is tried first
  personal: [ada-tools, side-project]
skip_commits:                          # subjects of a tool's snapshot commits: left out, counted apart
  - "^Agent host session"              #   a pattern alone: in every repository
  - { pattern: "^reindex:", repos: [acme/knowledge] }  # or only in the repositories named (substrings)
generated: ["(^|/)\\.claude/skills/"]  # paths whose lines are a tool's output, added to the built-in ones
pipeline_repos: [acme/knowledge]       # repositories whose lines are a pipeline's output: counted apart
day_starts: "04:00"                    # --day-starts; an action before it belongs to the day before
```

A pattern is matched against git — the repository's absolute path and its `remote.origin.url`;
github — `owner/repo`; gitlab — the project's path; jira — the project key; confluence — the space
key. The first rule that matches decides. A pattern is a case-insensitive **substring**, so a short
one matches more than meant: `app` matches `/home/ada/apps/…` and `acme/webapp` too, and `ada` every
repository under `/home/ada/`. Prefer a whole `owner/name` or a distinctive folder name, and check
the place rules the report's header lists. The `repos` of a `skip_commits` rule and
`pipeline_repos` match the same way. `day_starts` (default `00:00`) makes a working day run past
midnight: with `04:00` an action at 01:30 belongs to the day before and shows as `01:30+1`.

## Sources without code

**Slack, mail, documents and the calendar** go through their claude.ai connectors (connected in
claude.ai → Settings → Connectors; the `messaging` and `workspace` skills say how each is reached).
For each one available:

1. Search by the person and the period: messages they wrote (`from:` the person, `after:`/`before:`
   the dates), mail they sent, documents they own or edited, calendar events they attended.
2. Count by day, as local dates in the report's time zone; for the calendar, the hours of
   accepted events.
3. Add a section of its own to the report — `## Slack`, `## Mail`, `## Documents`, `## Meetings`
   (the calendar's events; the report's own `## Calendar` is the tool's) —
   with the counts by week and a line on what the search could not see (private channels and
   direct messages not opened, mail not in the connected account). Do not add these counts to the
   tool's totals.

The connector's account is the user's: it sees what the user can see, and "me" there is the
account that connected it.

**Notes.** Notes in the knowledge base the installation names in its `AGENTS.md` (usually its MCP
server) are searched by owner and date over the period and counted the same way, as their own
section. An Obsidian vault is a git repository: pass it to `collect` as one of the `--repos`, and
its notes are counted as docs.
