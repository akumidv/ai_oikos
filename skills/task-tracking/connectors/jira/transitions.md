# Connector: jira — transitions by the installation's rules

`node oikos/tools/jira/cli.mjs transition` and `info --extended`, for the skill `task-tracking`; the flow is in [scenarios/move-task.md](../../scenarios/move-task.md).

```bash
node oikos/tools/jira/cli.mjs transition --task PROJ-24 --to "In Progress" --dry-run
node oikos/tools/jira/cli.mjs transition --task PROJ-24 --to Done --comment "Result: [PR 12](https://github.com/acme/web-ui/pull/12)" --dry-run
node oikos/tools/jira/cli.mjs edit --task PROJ-24 --parent PROJ-3 --dry-run      # the epic, before the move
node oikos/tools/jira/cli.mjs link --from PROJ-24 --type Relates --to PLAN-5 --dry-run   # a link-only subject epic, beside the parent
node oikos/tools/jira/cli.mjs transition --task PROJ-24 --to Done --skip-pr https://github.com/acme/web-ui/pull/31 --dry-run
node oikos/tools/jira/cli.mjs transition --task PROJ-24,PROJ-25,PROJ-31 --to Done --dry-run   # many tasks, always brief
node oikos/tools/jira/cli.mjs comment --task PROJ-24 --text "[~accountid:<id>] where are the results of this task?" --dry-run
```

`task-tracking.jira` in `oikos.yaml` says who may move a task between two statuses (the flow:
[scenarios/move-task.md](../../scenarios/move-task.md)). The project is the key's prefix; statuses compare
case-insensitively; the first rule that covers the move wins; a project's own `transitions`
replace `defaults.transitions` wholesale; a move no rule covers takes `defaults.default`
(`person` when unset). The structure is checked when the tool starts: a problem stops
`transition` and names its path (`node oikos/tools/sync/cli.mjs --check` lists them too).

```yaml
task-tracking:
  jira:
    defaults:
      default: person                 # a move no rule describes
      transitions:                    # ordered; the first matching rule wins
        - { from: [To Do, In Progress, Blocked], to: [To Do, In Progress, Blocked], mode: agent }   # only among the working statuses
        - { from: In Progress, to: Review, mode: confirm, requires: The task shows where its result is. }
        - from: Review
          to: [Test, Done]
          mode: confirm
          requires: >
            The task shows where its result is — a pull request, a document, a link, an attachment,
            the result written out — or a comment says there is none and why. The task belongs to
            an epic.
        - { from: Review, to: [To Do, Fix], mode: confirm, requires: A comment saying what to fix. }
        - { from: "*", to: Closed, mode: confirm, requires: A comment giving the reason for closing. }
      number_patterns: ["FIX[{n}]"]   # how a bare task number is written; a project's own list replaces it
      # policy:                       # the organization's policy (below): with it, the rules into or out of Review are person's
      #   person_only: [Review]
      #   source: https://kb.example.com/tracker-rules
    projects:
      PROJ:
        key_aliases: [PJ]             # PJ-123 is PROJ-123 in branch and pull request names
        repos: [github:acme/web-ui, gitlab:acme/backend]   # the pool: <host>:<owner>/<name>, explicit names
        extended_repos: [github:acme/legacy-ui]   # the extended set: PRs possible but rare, searched only with --extended
        number_repos: [github:acme/web-ui]        # here a bare FIX[123] is PROJ-123; each also in repos or extended_repos
        results: Pull requests; UI changes also as screenshots in the attachments.
        epic_roles: { fixes: PROJ-10, features: PROJ-11 }   # general epics by role: a role is lowercase, the epic PROJ's own
        epic_projects: [PLAN]         # projects whose open epics are candidates too (subject epics)
        epics: A subject epic first; else bugs → fixes, the rest → features.
        # transitions: [ … ]          # this project's own rules, instead of the defaults
```

A repository's bare numbers belong to one project: a repository in the `number_repos` of two
projects is a problem, so is one outside the project's `repos` and `extended_repos`, a pattern
without exactly one `{n}` beside other text, and `number_repos` with no pattern in reach. A pattern
matches commit messages too, so `#{n}` also matches GitHub's `Merge pull request #N` — prefer a
bracketed prefix such as `FIX[{n}]`. A project listed twice in `epic_projects` is a problem.

**The organization's policy** (`policy`, ADR 0004): `person_only` lists the statuses only a person
moves a task into or out of; `source` is the knowledge-base page the policy comes from — printed,
never fetched. `defaults.policy` holds for every project, and a project's own `policy` **adds** to
it (its statuses join the defaults'; both sources are printed) — unlike `transitions`, which a
project replaces. A list that is not of status names, `"*"` in `person_only`, or a `source` that is
not text is a problem. In a move the stricter of rule and policy wins: a move into or out of a
person-only status whose rule (or `defaults.default`) is `agent` or `confirm` is refused as
`person` — exit 3, stderr `refused: policy: <from> → <to> in PROJ is a person's move — Review is
person-only by task-tracking.jira.defaults.policy (source: <url>); it falls under <rule path>
(<mode>), which the policy overrides — move PROJ-24 to '<to>' yourself: <link>`. A `confirm` rule
does not satisfy it: the agent would start the move. Such a rule is a configuration error, not a
load problem — it stops nothing else: `project-init --dry-run` lists it under `## Policy` with the
fix, and `node oikos/tools/sync/cli.mjs --check` prints it as a `warning:`. With the policy above,
the example's rules are written so:

```yaml
      transitions:
        - { from: [To Do, In Progress, Blocked], to: [To Do, In Progress, Blocked], mode: agent }
        - { from: In Progress, to: Review, mode: person }
        - { from: Review, to: "*", mode: person }       # before "*" → Closed, which also covers Review → Closed
        - { from: "*", to: Closed, mode: confirm, requires: A comment giving the reason for closing. }
      policy: { person_only: [Review], source: https://kb.example.com/tracker-rules }
```

- `agent` — the dry run names the move and the rule; the move runs on the user's yes.
- `person` — refused (exit 3) with the task's link and the rule (or the default) that refused; a
  move the policy makes a person's is refused the same way, its line starting `refused: policy:`.
- `confirm` — the dry run prints the rule and its `requires`, the project's `results` and
  `epics`, the assignee with the account id to mention, the description (cut at 3000
  characters), the attachments, the comments since the task **last** entered its current status
  (from the changelog; all of them when it was created there), the remote links and the URLs in
  the description and those comments, the pull requests (below), the epic — or, when the task
  has none, its candidates (below) — and the comment to be posted, then what to do. Judge, ask
  in the chat, and run the same command without `--dry-run` on the user's answer.
- `## Pull requests` of a `confirm` dry run — each with its state (`open`, `draft`, `merged`,
  `closed`, or `unknown` with the reason), where it was found, its repository, title, URL and
  branch; then the branches that carry the key and have no pull request:
  - **attached** — what the task carries: Jira dev-status (read for every integration app its
    summary names, by that app's own type), the remote links, and the GitHub / GitLab PR URLs in
    the description and in **every** comment; each one's state is read from its host by URL;
  - **pool** — the repositories in `projects.<KEY>.repos`: pull requests and branches whose title
    or branch name carries the key or an alias key (`PJ-123` for `PROJ-123`) as a whole token
    (`PROJ-123` is not `PROJ-1234`); in a repository of `number_repos` also the task's number
    written as a pattern (`FIX[123]`, not `FIX[1234]`) — in a repository whose numbers are another
    project's a bare number never matches. Nothing else is searched — an empty pool is said, with how
    to set it up;
  - **commits** — when nothing at all was found, the commits of the searched repositories by the key
    and its aliases (in `number_repos` also by the patterns): a commit's pull request counts as found
    in its repository's set, and its line in the dry run (full and brief) and in the posted comment
    ends `— via commit <sha7> <first line>` — the first such commit, none when the pull request search
    found it too — so a title naming another task is explained, not mistaken for this one's; a commit
    without one is listed under `Commits without a pull request` as evidence and is not posted; a
    commit whose pull requests could not be read is a note (`the pull requests of commit <sha7> were
    not read`; several commits of one repository failing alike share one, `the pull requests of 3
    commits were not read — <reason> (<sha7>, …)`), which makes the search incomplete, and the next
    commits are followed. GitHub's commit search reads the default branch only; a host that answers
    with a rate limit is named and not asked again in that run — when it stops a repository part way
    through its commits, what they found is kept and the note says `commits partly searched`; the
    note ends `; retry after ~<N>s` when the host said when; the host's other repositories share one
    note naming them;
  - **extended** — with `--extended` only: the repositories in `projects.<KEY>.extended_repos`,
    searched as the pool is. Without the flag they are not read; when the pool found nothing and the
    set is not empty, one line names its size and the same dry run with `--extended`. With the flag
    and no set, a note says so;
  - an attached pull request in a repository outside the pool and the extended set is printed with
    the line that adds it (`repos add … --dry-run`, [project-setup.md](project-setup.md));
  - every read is best effort: dev-status unavailable, a host without a credential
    (`GITHUB_TOKEN` / the `gh` login, `GITLAB_TOKEN`) or a repository not found is a note, not a
    failure.
- The pull requests found **only in the pool** (or, with `--extended`, the extended set) are written
  into the task: they are appended to the comment posted with the move — with no `--comment`, the move posts a comment listing them. The dry
  run shows that comment as it will be posted. The move carries the same `--extended` as its dry run.
- `--skip-pr <url>` (repeatable) leaves a pull request found by search out of that comment and out
  of the evidence: the dry run lists it under `Skipped`. URLs compare as the de-duplication compares
  them (case, a trailing `/`, a `/files` tail) — nothing else: give the URL in the form the dry run
  printed it, with no `http`/`https` or `www.` difference. A task whose only found pull request is
  skipped still gets the commit search. In the dry run a URL no search found is a usage
  error, and so is an attached pull request (it is never posted); in the move a URL no longer found
  is a note. Whether a pull request belongs to the task is judged from its printed title and branch.
- `## Epic` of a task without one: the role epics (`epic_roles`: role, key, summary, status —
  flagged when closed, missing or not an epic), the project's other open epics, then the open epics
  of each `epic_projects` project (the first 50 each), each marked **parent** or **link only** — link
  only when either project is team-managed, since such a project takes only a parent of its own.
  `## What to do` then names the ranking (a subject epic that fits first, a role epic by the `epics`
  rule only when none fits) and, for a link-only pick, the two dry runs: `edit --task K --parent
  <epic of the project> --dry-run` and `link --from K --type Relates --to <subject epic> --dry-run`.
- `--brief` (with `--dry-run`) prints a `confirm` dry run as one short block: the move with its
  mode and rule, `Requires` and `results` on one line each, one line per pull request (and the
  extended set's hint); for a result that is not code, the other links in the description and the
  comments since the task entered its status, the attachment names (five of each, then how many
  more) and the count of those comments; the epic or the open epics' keys and summaries, the first
  line of the comment to be posted with the number of pull request lines it adds, a `Notes:` line
  with what the pull request search could not read, ranked: a rate limit, a stopped search, unread
  commits, then what only informs (a first page only, dev-status unavailable); and `Flags` — what
  the full dry run shows missing (no pull request, the pull request search incomplete, no link, no epic while `requires` names one, an empty pool). The
  search is incomplete only when a search did not run or was partly searched (no credential, an HTTP
  error, a rate limit) or the pull requests of some commits were not read; only a first page read or
  dev-status unavailable stays in `Notes:` without the flag. `agent` and
  `person` moves print as without it; the move itself accepts and ignores `--brief`, so it stays
  the dry run's command without `--dry-run`. Its epic line names the role epics with their flags and each other project's epics
  with the **parent** / **link only** mark; skipped pull requests and commits without one get a line.
- **Many tasks**: `--task A,B,…` (explicit keys, at most 50, a key given twice counts once; rules
  only) resolves each task on its own. The dry run is always brief: the project's `results` once,
  one block per task (a `confirm` block ends with its own full dry run's command), then the tasks
  that will not move — a person's move (by a rule, or by the policy: `PROJ-7: policy: …`), no transition (with the path when there is one), evidence
  that could not be read. A task whose block flags no pull request and no link, or an incomplete pull
  request search, is judged from its own full dry run. The real run collects the evidence again per
  task, moves it and prints `moved PROJ-7`, or `PROJ-7: <reason>` on stderr (a task no longer
  movable counts as failed), then `N/M moved` — with `, C without its comment` when a move went
  through and its comment did not; it exits 2 if any move or comment failed. Such a task's comment
  text (markdown, with its pull request lines) is printed under `PROJ-7: moved to S; the comment
  was not posted (…)`, between dashed lines — a single move does the same, and exits 2: post it
  with `comment --task PROJ-7 --file <text>` (or `--text`) and `--dry-run` first, or tell the user,
  since a dry run of the move finds the task in S already.
  `--comment` goes to every task; `--skip-pr` applies to each task that found the pull request and
  is an error only when no task did — a note when a task's evidence was not read, since that task
  might have. Commits are searched only for the tasks with no pull request.
  One key is the single move, full or `--brief`, as above.
- **No direct transition to `--to`**: the error names the statuses reachable from here, as before;
  when the rules allow a status S reachable now and S → `--to` (neither a `person` move) and this
  project's history shows a task moved S → `--to` (one search per S, at most ten), it also prints
  that path with its modes and one dry-run command per step. Each step is a move of its own, with
  its own dry run and confirmation. Without a `task-tracking.jira` part no path is looked for.
- `info --extended` adds the same `## Pull requests` section to `info`; `info` without it reads
  no code host.
- `--comment` is posted after the move, as `comment` posts it (markdown, English).
- Without credentials every command stops with exit 1 and names the missing keys, before any
  request; it never falls back to a dry run. Only `comment --dry-run` and `link --dry-run`, whose
  preview reads nothing from Jira, still show it — the write itself needs the credentials.
