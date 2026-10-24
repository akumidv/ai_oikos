# Design — status transitions with evidence (tracker workflow rules)

Living design concept ([design-flow](../../_aitna/akmon/pipelines/design-flow.md)). Nothing here
is accepted until the owner says so; accepted commitments then move to ADR blocks and the
implementation steps to [`_aitna/TASKS.md`](../../_aitna/TASKS.md).

**State:** accepted by the owner (2026-10-19); commitments in
[ADR 0001](../adr/0001-tracker-transitions.md), implementation in `_aitna/TASKS.md` (T1–T5).
O4 and O5 are settled during T1 against the live tracker. A second round, from a sprint pass over
some forty tasks (O10–O14: epics by role and across projects, bare task numbers bound to
repositories, leaving a found PR out, many tasks in one move), is accepted by the owner:
ADR 0001 D09–D13, implementation T5. **How to resume:** read § Frame, § Design, then § Open points.

## Frame

- **Problem.** An agent moves a task only among the "agent statuses"; every later move (review
  on, done, closed) is refused outright, so the user who checks tasks must leave the assistant
  for each of them. The refusal is right as a floor and wrong as the only answer: a later move
  is safe when the task shows its result and the user confirms the move.
- **The key logic.** A task that leaves the working statuses needs a **result**, and the task
  must make clear **where to take it** — a pull request, a document, a link, an attachment, the
  result written out — or say that there is none and will be none, and why. Checking the result
  itself is a separate stage (a person, or the review skill); this design works only with what
  the task records as the result of that stage: it is enough to move, or it is not.
- **Goal.** Lower "refused" to "confirmed" for the moves an installation chooses: the tool
  collects what the task records, the agent judges it against the installation's own words, the
  user answers a question, and only then the move runs. A move the installation does not
  describe stays a person's.
- **Constraints already decided.**
  - Every write is shown as `--dry-run` first and runs only as the confirmed command (write guard).
  - Nothing about an organization in the core: statuses, projects, repositories, aliases and the
    requirements live in the installation's `oikos.yaml`.
  - **Who may move is structured** (transition, mode) — the guard enforces it. **What is enough
    is prose**: it differs per project and still more per context (a company, a personal business,
    research), so a condition language would never fit; the agent reads the prose.
  - Reviewing the work is a separate skill; this design only moves statuses and reads the task.
- **Acceptance.** For a configured project, a late move runs after a confirmation question when
  the task shows its result, and does not run otherwise (the agent asks the assignee instead); an
  unconfigured installation behaves exactly as today.

## Survey — the current code

- `tools/jira/cli.mjs:15-21` — `JIRA_AGENT_STATUSES` (default `to do, in progress, blocked`) is an
  allowlist on both ends of `transition`; anything outside it is refused before any request
  (exit 3, the task link printed). `JIRA_REVIEW_STATUSES` feeds only warnings in `context`.
- `tools/jira/cli.mjs:339-368` — `transition --task --to [--dry-run]`: reads the status, finds the
  Jira transition by target name, posts it. No comment is posted with the move.
- `tools/hooks/write-guard.mjs` + `tools/hooks/writes.mjs` — a real write is denied unless the
  identical command was dry-run in the session and the user has prompted since.
- `tools/common/config.mjs` — `oikos.yaml` is parsed with `yaml`; top-level parts are
  `organization`, `connectors`, `settings`, `mcp_servers`, `brand`.
- What the tools can read today: Jira `info` reads comments and issue links; no remote links, no
  dev-status. `gitlab task KEY` searches merge requests instance-wide by key (title/branch); no
  MR-by-URL, no branches. `github` lists repositories and files only — no pull requests.
- `github-issues` / `gitlab-issues` (F7, [tracker-wiki-github-gitlab.md](tracker-wiki-github-gitlab.md)
  § Status model) copy the Jira allowlist model.
- No test covers the Jira transition gate; the GitHub one is tested in `tests/github-issues.test.mjs`.

## Design

### Configuration — per tracker project, in `oikos.yaml`

A new top-level part, `task-tracking`, keyed by connector (`jira`, `github-issues`,
`gitlab-issues`). `defaults` holds the shared rules; `projects` holds what is per project. A
project's own `transitions` replaces the defaults wholesale (no merge — one place says which rule
holds).

```yaml
task-tracking:
  jira:
    defaults:
      default: person                   # a move not described below: a person only
      transitions:
        - from: [Backlog, To Do, In Progress, Blocked]
          to:   [Backlog, To Do, In Progress, Blocked, Review]
          mode: agent
        - from: Review
          to:   [Test, Done]
          mode: confirm
          requires: >
            The task shows where its result is: a pull request, a document, a link, an attachment,
            or the result written out in the description or a comment — or a comment saying the
            result cannot be obtained or is no longer relevant, and why. Straight to Done when the
            result was checked at review (a task without code). If it is not clear, do not move:
            ask the assignee in a comment where to find the results. The task belongs to an epic;
            if its epic is not set, set the best-fitting epic with the move, as `epics` says (a
            subject epic of another project goes in as a `Relates` link).
        - from: Review
          to:   [To Do, Fix]
          mode: confirm
          requires: A comment saying what is missing or what to fix.
        - from: [Test, Checked]
          to:   [Checked, Done]
          mode: confirm
          requires: The pull requests are merged, or a comment says the result was tested / checked.
        - from: "*"
          to:   Closed
          mode: confirm
          requires: A comment giving the reason for closing.
    projects:
      PROJ:
        key_aliases: [PJ]               # PJ-123 is PROJ-123 in branch and PR names
        repos:                          # explicit names only; where its PRs and branches live
          - github:acme/web-ui
          - github:acme/auth
          - gitlab:acme/backend
        number_repos: [github:acme/web-ui]      # here a bare FIX[123] means PROJ-123 (D11)
        number_patterns: ["FIX[{n}]", "FEAT[{n}]"]
        results: PRs in repos; UI changes also as screenshots in the attachments.
        epic_roles: { fixes: PROJ-10, features: PROJ-11, support: PROJ-12 }   # general epics (D09)
        epic_projects: [PLAN]                   # subject epics may also be PLAN's (D10)
        epics: >                                # how to pick: prose, judged by the agent
          A subject epic first; else bugs → fixes, tooling and docs → support, the rest → features.
      DOCS:
        results: A report on the wiki, linked in a comment.
        transitions:                    # own workflow: replaces defaults.transitions
          - { from: [To Do, In Progress], to: [To Do, In Progress, Review], mode: agent }
          - from: Review
            to: Done
            mode: confirm
            requires: The report is linked in a comment and the reviewer's comment accepts it.
```

- `config.mjs` exposes the part as it does the others; the structure (`from`, `to`, `mode`,
  `default`, `projects`) is validated at load and every problem is named. `requires`, `results`
  and `epics` are free text; the tool never interprets them, it prints them.
- A status the project's workflow lacks is named at `project-init` and in `transition`, where the
  workflow is read.
- Back-compat: no `task-tracking.<connector>` part → the old `*_AGENT_STATUSES` allowlist, unchanged.
- Statuses are matched case-insensitively by name, as today.

### Modes (fixed set in the core)

| Mode | What it takes |
|---|---|
| `agent` | dry-run, then the user's next prompt (today's write guard) |
| `confirm` | dry-run that prints the rule's `requires`, the project's `results` and what the task records; the agent judges and asks the user; the move runs only on the user's answer |
| `person` | refused, exit 3, the task link printed (today's refusal) |

### What the tool collects, and who judges

- **The tool collects**, and prints in the dry-run of a `confirm` move:
  - the matched rule and its `requires`, the project's `results`;
  - the description, the attachments, and the comments since the task entered its current status
    (from the changelog);
  - the links in them, and the pull requests found (§ Finding pull requests) with their state;
  - the comment that will be posted with the move (`--comment "…"`, plus the PR links found in the
    pool and not yet in the task);
  - the task's epic; when it has none, the project's open epics (key, summary, a short
    description) — the candidates for § Epic — and the role epics and the open epics of
    `epic_projects` (§ Epics by role and across projects).
- **The agent judges** the collected material against `requires` and `results`, and states its
  judgment — where the result is, or why there is none — in the confirmation question.
- **The user decides.** If the result is not clear, the agent does not move the task; it prepares
  a comment that mentions the assignee and asks where the results are (an ordinary `comment`,
  dry-run first).

### Epic

Every project has a set of epics, and a task leaving Review belongs to one. When the task's
epic (its `parent` of type Epic) is not set:

- the dry-run of the move says so and lists the project's open epics
  (`project = KEY AND issuetype = Epic AND statusCategory != Done`; round 2 adds the role epics
  and `epic_projects`, below);
- the agent picks the best-fitting one by the task's summary, description and result, and puts it
  in the confirmation question with a one-line reason and the runner-up;
- on the user's answer the epic is set first (`jira edit --task KEY --parent EPIC`, its own
  dry-run shown with the move's), then the move runs. The user may name another epic instead.

That the epic is required is stated in the rule's `requires` (prose, so a project or a context
without epics simply does not say it); listing the candidates is the tool's, choosing is the
agent's, deciding is the user's. A project may add a prose hint on how its epics are split
(`projects.<KEY>.epics`). For `github-issues` / `gitlab-issues` the counterpart (a milestone, a
parent issue, a GitLab epic) is decided with O7.

#### Epics by role and across projects (O10, O11)

A sprint pass showed two gaps: the best epic by topic was often another project's (a goal epic, an
epic of a board that plans the same product), and the project's own general epics (fixes,
features, support…) were only named in prose, so the dry run could list them but not tell them
apart.

- **Roles are structure, the rule is prose.** `projects.<KEY>.epic_roles` maps a role name to an
  epic of the project (`{ fixes: PROJ-10, … }`), validated at load (a role is a lowercase name, an
  epic key carries the project's key). How to choose among them stays prose in `epics`
  ("bugs → fixes; …"), read by the agent (D01 holds).
- **Subject epics of named projects.** `projects.<KEY>.epic_projects` lists other projects whose
  open epics are candidates too — explicit, as the pool is (D05). No site-wide epic search.
- **The dry run's `## Epic`** (task without an epic): the role epics (role, key, summary, status;
  one that is closed, missing or not an epic is flagged), the project's other open epics, then the
  open epics of each `epic_projects` project, each marked **parent** or **link only**. A
  cross-project epic is *link only* when either project is team-managed (such a project takes only
  a same-project parent).
- **The agent ranks, the tool does not.** A subject epic that fits the task's topic comes first;
  a general epic by the `epics` rule only when no subject epic fits. The question names the pick
  and the runner-up with a one-line reason.
- **A link-only pick** is proposed as two writes in one question: a same-project parent — a role
  epic by the `epics` rule, else the project's best-fitting open epic — and a `Relates` link to
  the subject epic: `edit --task K --parent PROJ-10 --dry-run` and
  `link --from K --type Relates --to PLAN-5 --dry-run`. When the project has no open epic, the
  question offers the link alone and says the task stays without a parent. Both dry runs are shown
  before the question; the user's answer unlocks both (the guard stamps each dry run with the
  prompt count; a dry run re-run after the question needs another answer).
- **A parent the site would refuse is refused in the dry run**: `edit` / `create --parent` read
  the parent and, for a cross-project parent, both projects; a team-managed side refuses the whole
  command (bulk included) with the `Relates` alternative. A routine correction under D06, not a
  new decision.
- **A batch** keeps `edit --task A,B,… --parent X`, one command per epic; the agent shows the whole
  mapping (task → epic, reason) in chat before the dry runs.
- Written by `project-init --epic-role <role>=<KEY-n>` and `--epic-project <KEY>` (guarded, D07),
  or by hand.

### Finding pull requests

In order; results are merged and de-duplicated by URL:

1. **Attached to the task**: Jira dev-status (the Jira app may cover only one repository), remote
   links, PR/MR URLs in the description and comments. Each one's state is read by its URL.
2. **The project's repository pool** (`projects.<KEY>.repos`): pull requests and branches whose
   title or branch name carries the key or one of its `key_aliases`, as a whole token. A branch
   without a PR is reported as such.
3. **Nothing else.** No instance-wide search: an empty pool says so in the dry-run, and
   `project-init` is offered.

A PR found in step 2 and not attached to the task is written into the task when the move runs: the
move's comment lists the PR links (shown in the dry-run with the rest of the comment).

A PR attached to the task whose repository is not in the pool: the dry-run offers
`<tracker> repos add <KEY> <host:owner/name> --dry-run`, so the pool grows with use.

#### Bare task numbers, bound to repositories (O12)

Developers write the number without the key (`FIX[123]: …`, `FEAT[124]`), in PR titles and
commits. A bare number means nothing until the repository is known: in one repository
`FIX[123]` is PROJ-123, in another the same text is PLAN-123. So the binding is the
repository's: **a repository's bare numbers belong to at most one project**, while search by the
full key stays many-to-many as before.

- `projects.<KEY>.number_repos` — the repositories where a bare number N means `<KEY>-N`. Each
  must also be in the project's `repos` or `extended_repos`: those lists say **when** a repository
  is searched (every move, or with `--extended`), `number_repos` says **how** it is matched.
- `number_patterns` — literal templates with one `{n}` (`"FIX[{n}]"`), in `defaults` for the whole
  installation or per project (a project's list replaces the defaults'). No regular expressions.
  Matched in titles, branch names and commit messages as a whole token, as a key is
  (`FIX[12]` is not `FIX[123]`). A branch name cannot hold `[`; a project whose branches carry the
  number (`fix/123-…`) adds a pattern for that form (`fix/{n}`). A bare number is a short
  substring, so a repository's branch lookup by it returns more and its result cap is reached
  sooner; the dry run says so when it is.
- At load: a repository in the `number_repos` of two projects of one connector is a problem; so is
  a `number_repos` entry outside the project's two lists, a pattern without exactly one `{n}`, and
  `number_repos` with no pattern in reach. Uniqueness is per connector: Jira and `github-issues`
  may bind the same repository (O7).
- In a repository bound to another project a bare number is never matched for this one: a task's
  pool search does not pick up `FIX[123]` from a repository whose numbers are PLAN's.
- **Commits** are searched when the PR search finds nothing for the task: in the repositories
  searched, by the key and its aliases, and in `number_repos` also by the patterns. A commit with
  a PR brings that PR in as found by search, printed and posted with the commit that led to it
  (`— via commit <sha7> <first line>`), since its title may name another task; a commit without one
  is listed in the dry run as evidence and not posted; a commit whose PRs could not be read (a read
  error other than a rate limit) is a note that makes the search incomplete, and the search goes on
  to the next commit. The commits of one repository that fail for the same reason share one note,
  the reason before the shas so a cut note keeps it (`the pull requests of 3 commits were not read
  — <reason> (<sha7>, <sha7>, <sha7>)`, at most three shas, then `+N more`); a reason that names the
  commit (a 404 names it in its path) is compared with the sha as `<sha>`; a single one keeps its
  own (`the pull requests of commit <sha7> were not read`). On GitHub this is REST commit search (GraphQL has none): it reads the
  default branch only and shares the search rate limit (about 30 requests a minute), so a batch
  searches commits only for its tasks with no PR found, and stops asking a quota of a host once it
  answers a rate limit (HTTP 429, a 403 mentioning "rate limit", a GraphQL `RATE_LIMITED`); a repository it stops part way through
  its commits keeps the PRs and commits already found and is noted as partly searched (`commits
  partly searched — … after K of M commits`); a rate limit that names `retry-after` or
  `x-ratelimit-reset` (GitLab: `RateLimit-Reset`) ends its note with `; retry after ~<N>s`
  (retry-after first; a GitHub secondary limit — `x-ratelimit-remaining` above 0 — waits a minute). The other
  repositories of that host share one note (`<host>: commits of N repositories not searched — …
  limited the rate of requests earlier in this run (<repo>, … +N more)`), and each later task's
  block says the same of its own, with no look-ahead on the remaining quota and no batch-level
  list; the run keeps the first limit's deadline per quota, so these notes end with the time left
  (none when the host named none). The pool and extended search record and honour the same
  limit, kept per quota — on GitHub GraphQL (PR search), REST search and REST core (a commit's
  PRs) apart, unless the error names its `x-ratelimit-resource`; on GitLab one for all: a
  repository whose PR search answers a rate limit is noted `not searched — …; retry after ~<N>s`
  and marks that quota, so no later search on it asks the host (a search needing two limited
  quotas gives the later deadline) — their repositories of that host
  get the same one note per host, without `commits` (`<host>: N repositories not searched — …
  earlier in this run …`), and count as not searched; one stopped only by its PR quota is still
  searched for commits. A real move whose evidence, collected again, is incomplete
  still moves and comments, and once both went through notes it on stderr with its first gap. GitLab: the project search with `scope=commits`.
- Written as the pool is: `repos add --numbers <KEY> <repo>…` (the repository already in one of the
  two lists; its dry run refuses a repository whose numbers another project already holds, and
  names that project), `project-init --number-pattern`; both guarded (D07). `defaults.number_patterns`
  is edited by hand.

#### Leaving a found PR out (O13)

A typo in a prefix (`FIX[132]` on a PR of task 123) attaches someone else's PR. `transition
--skip-pr <url>` (repeatable) leaves a PR found by search out of the move's comment; the dry run
lists it under *Skipped*, and the agent does not cite it as the task's result. URLs are compared
as the de-duplication compares them (case, a trailing `/`, a `/files` tail). A URL that is not
among the found PRs is a usage error in the dry run, so a typo in the flag does not pass silently;
at the real run a skipped URL no longer found is noted, not an error. A task whose found PRs are
all skipped counts as having none found, so the commit search (O12) still runs for it. An attached
PR is not posted anyway, so skipping one stays refused. Whether a PR's title fits the task is the
agent's judgment (the dry run prints both); the tool has no similarity heuristic.

### Moving many tasks, a short dry run, a path (O14)

A pass over forty tasks took about eighty single commands and some 75k tokens of dry runs.

- **`transition --task A,B,… --to S`** — explicit keys, at most 50 (a cap of its own; bulk `edit`
  caps only a `--jql` selection), one target. Each task is resolved on its own (rule, mode,
  transition). One dry run lists every task in the short form and ends with the tasks that will
  not move (a `person` move, no transition, with the path when there is one; `its evidence was not
  read — <reason>`, the rest of the batch still resolved). The agent judges each `confirm` task as
  for a single move and takes out of the list every task that will not or should not move, so the
  confirmed list holds only movable ones; the shorter command gets its own dry run, since the guard
  pairs identical commands. One confirmation answers the batch (D03 unchanged: the next prompt
  after the question). The real run collects the evidence again per task, moves each, reports
  each; a task no longer movable then (its status changed) is reported and counts as failed, and a
  task that moved but whose comment failed is reported as `N/M moved, C without its comment`, with
  the comment's full text printed for a `comment --dry-run` post (as in a single move); exit
  2 on any failure, comment failures included. `--comment` in a batch is posted to every task — a
  task-specific comment (Review → To Do / Fix) is a single move. `--skip-pr <url>` applies to every
  task whose found PRs include it, and is a usage error only when no task found it; when some
  task's evidence was not read, a URL that left out no PR found by search (unmatched, or naming an
  attached PR only) is a note naming those tasks instead.
- **`--brief`** — about fifteen to twenty lines per task, enough to judge a result that is not
  code (D02, D04): the rule, `requires` and the project's `results` (once per project in a batch),
  the PRs with state and source, the other links in the description and in the comments since the
  task entered its status, the attachment names, the count of those comments, the epic or its
  candidates (role, key, summary, **parent** / **link only**), the first line of the comment to be
  posted and the count of PR lines appended, structural flags. The block ends with one `Notes:` line
  for what the PR search could not do (no credential, an HTTP error, a rate limit, only the first
  page read, dev-status unavailable; at most 3 shown, failures that stop a search first, then
  `(+N more)`). Only a search that did not run or was partly searched (no credential, an HTTP
  error, a rate limit), or commits whose PRs were not read, sets the flag `pull request search
  incomplete`; a first page only or dev-status unavailable is a note alone. A skipped PR found
  through a commit ends its brief `Skipped` entry with `— via commit <sha7> <first line>`, as its
  other lines do. A task whose brief block shows no PR and no link, or carries that flag, is judged from its
  full single dry run before the question. The full dry run is the same command without `--brief`; a batch is always brief.
  Accepted on the real move too, so the confirmed command can stay identical to its dry run.
- **A path when the target is not directly reachable**: candidates are the direct transitions
  whose move the rules allow (a resolved mode other than `person`); a candidate S is offered when
  the rules allow S → target and the project's history shows it (`status CHANGED FROM S TO
  target`). At most two steps; each step is its own move with its own dry run and confirmation,
  the commands printed in order. Not a decision: it only prints moves D02 already allows.
- **An overdue active sprint**: `sprint`, `sprints` and `context` warn when an active sprint's end
  date has passed; closing it and the carry-over stay a person's. Future sprints a project keeps
  for not-yet-described tasks hold them on purpose: none is pulled into the active sprint by status
  alone. Not a decision.

### Project initialization — `<tracker> project-init <KEY>`

One command for each tracker connector (a Jira project key, a GitLab project, a GitHub
repository). It runs when a move is asked for a project absent from `projects`, or on request.
Steps, read-only until the last:

1. **Workflow** — read the project's statuses and transitions (Jira:
   `/rest/api/3/project/{key}/statuses` and the transitions; GitLab/GitHub: labels, board columns,
   Projects status field). Lay `defaults` over it and show which moves each rule covers and which
   statuses no rule covers (they stay a person's).
2. **Key aliases** — find branches and PRs whose number matches a task of the project under a
   different prefix (`PJ-123` for `PROJ-123`); propose them.
3. **Repository pool** — candidates by activity (repositories with PRs or branches carrying the key
   or an alias in the last N months) and by name patterns the user gives (`web-*`). A pattern is
   used for this search only; the pool stores the explicit names the user picks.
4. **Results** — ask where results of this project's tasks usually are; store as `results`.
5. **Write** the `projects.<KEY>` block into `oikos.yaml` — dry-run, then confirmation.

As built for Jira in T3 (no decision changed; where the code differs from the steps above):

- Step 1 reads the statuses only (`/project/{key}/statuses`), not the transitions: coverage is the
  pairs of workflow statuses each rule decides by first match.
- Step 2 looks in the candidate repositories' last 100 pull requests (titles, branches) and first
  100 branches, against the numbers of the project's last 500 tasks; a prefix is proposed when seen
  at least twice. GitHub only.
- Step 3 searches pull requests under the given owners (default: the owners of the pool) with
  GitHub's search (`is:pr user:<owner> updated:>=<date> "<KEY>"`), keeping those whose title or
  branch carries the key or an alias as `<PREFIX>-<n>`; a branch with no pull request across an owner
  is not found this way. Patterns match the names of the owner's unarchived repositories. GitLab
  owners and repositories are reported as not searched.
- Steps 4 and 5 are flags of the same command (`--results`, `--epics`, `--alias`, `--repo`): the
  dry run proposes, the user chooses in chat, the dry run with the chosen flags shows the block, and
  the same command without `--dry-run` writes it with no search.
- The guard reads one command word, so `repos add` is guarded as `repos` in `writes.mjs`: every
  sub-verb of `repos` is a write; a read-only sub-verb would need its own command name.
- The YAML edit is spliced into the source (`tools/common/tracking-config.mjs`), so a re-serialized
  file never reformats the installation's other lines.

### Writes and the guard

- `transition` (both modes), `comment`, `project-init` and `repos add` are writes: each in
  `tools/hooks/writes.mjs`, each takes `--dry-run`, each runs only as the confirmed command.
  `project-init` and `repos add` change only the installation's `oikos.yaml`, and still go through
  the guard (decided, O6).
- A `confirm` move is confirmed like any write: the dry-run, then the agent asks its question
  **in chat** (where the result is, the epic it proposes and why), and the user's next prompt is
  the answer the guard already accepts. The guard is unchanged; the question is not asked through
  a question tool, whose answer is not a prompt (O3).

### Changes by tool

| Tool | Change |
|---|---|
| `tools/common/config.mjs` | the `task-tracking` part, structure validation |
| `tools/common/` (new module) | rule resolution (project → defaults → back-compat), PR collection — shared by the three tracker connectors |
| `tools/jira/cli.mjs` | `transition --comment` and the `confirm` dry-run; workflow read; changelog (entry into the current status); remote links; dev-status; the project's open epics when the task has none; `project-init`; `repos add` |
| `tools/github/` | PR search by key in named repositories; PR state by URL; branches by key |
| `tools/gitlab/cli.mjs` | MR state by URL; branches by key; search limited to named projects |
| `tools/github-issues`, `tools/gitlab-issues` | the same rules, after Jira (O7) |
| `tools/hooks/` | `project-init`, `repos add` in `writes.mjs`; the guard itself unchanged (O3) |
| `skills/task-tracking/SKILL.md`, `connectors/*.md` | the new flow: collect, judge against `requires`, ask, move — or ask the assignee; "refuses review and done" replaced by the rules |
| `tests/` | gate per mode, rule resolution, back-compat, PR collection with fakes |
| `tools/common/transitions.mjs` (round 2) | `epic_roles`, `epic_projects`, `number_repos`, `number_patterns` (also in `defaults`) validated; number ownership unique per connector |
| `tools/common/pullrequests.mjs`, `tools/github/`, `tools/gitlab/cli.mjs` (round 2) | bare-number match in `number_repos`; commits by key / pattern in named repositories and the PRs of a commit; `--skip-pr` filter |
| `tools/jira/cli.mjs` (round 2) | parent check in `create` / `edit --parent`; role and cross-project epics in `## Epic`; `transition --task A,B,…`, `--brief`, `--skip-pr`, the path hint; overdue sprint warning; `project-init --epic-role`, `--epic-project`, `--number-pattern`; `repos add --numbers` |

## Open points

| # | Point | State |
|---|---|---|
| O1 | Who may move: structured (`from`, `to`, `mode`); what is enough: prose (`requires`, `results`) judged by the agent | decided (owner, 2026-10-19) |
| O2 | A non-code task goes Review → Done directly (the result is checked at review), or back to To Do / Fix with a comment | decided (owner, 2026-10-19) |
| O3 | A `confirm` move is confirmed by the user's next prompt after the agent's question in chat — the guard as it is; no question tool | decided (owner, 2026-10-19) |
| O4 | Dev-status endpoint and coverage on the organization's Jira (Cloud vs Server, which apps) | checked live in T1 (2026-10-19, Jira Cloud): `/rest/dev-status/latest/issue/summary?issueId=` answers and counts pull requests per integration app; `/issue/detail` with `applicationType=GitHub` returned none for tasks the summary counts PRs on — the PRs come through a third-party git integration app whose `applicationType` differs. Settled in T2 (2026-10-19, live): the summary's `pullrequest.byInstanceType` / `branch.byInstanceType` keys are the `applicationType` values (a third-party app's is its own id, e.g. `oAuth-<app id>`); `/issue/detail?applicationType=<that key>&dataType=pullrequest` answers `detail[]` of `{ pullRequests[], branches[], repositories[] }`, a PR as `{ id, name, status (OPEN / MERGED / DECLINED), url, source.branch, destination.branch, repositoryName, repositoryUrl }`, a branch as `{ name, url (…/tree/<branch>), repository }`. `applicationType=GitHub` answers an empty `detail` for the same tasks; a bad issue id answers 400. The tool reads the detail once per type the summary names |
| O5 | "Since entering the current status" — from the changelog; the status entered several times | decided in T1: the **last** entry (checked live on a task that entered In Progress twice); no entry in the changelog (created in the status) → every comment |
| O6 | `project-init` and `repos add` go through the write guard | decided (owner, 2026-10-19) |
| O7 | The same rules for `github-issues` / `gitlab-issues` after Jira, not with it | decided (owner, 2026-10-19) |
| O8 | A task leaving Review without an epic gets the best-fitting open epic of the project, chosen by the agent, confirmed with the move | decided (owner, 2026-10-19) |
| O9 | A second, explicit repository set where PRs are possible but rare, searched only on the user's request | decided (owner, 2026-10-19): `extended_repos`, `--extended` — ADR 0001 D08 |
| O10 | General epics named by role, so the dry run can tell them apart | decided (owner): flat `epic_roles`; the rule stays prose in `epics` — ADR 0001 D09 |
| O11 | The best epic by topic is another project's | decided (owner): explicit `epic_projects`; the agent ranks; a link-only pick is a same-project parent plus `Relates` — ADR 0001 D10 |
| O12 | PRs and commits that carry a bare number, not the key | decided (owner): `number_repos` (a repository's numbers belong to one project) and literal `number_patterns`; no organization-wide search — ADR 0001 D11 |
| O13 | A PR found by search that is someone else's | decided (owner): `--skip-pr <url>`; no title heuristic — ADR 0001 D12 |
| O14 | Many tasks in one move | decided (owner): `transition --task A,B,…`, one brief dry run, one confirmation — ADR 0001 D13 |

## Rejected (candidates)

- **A condition language** (`conditions: {all: [result_located, comment]}` with a fixed set
  `result_located`, `pr_linked`, `pr_merged`, `comment`) — what counts as a result differs per
  project and per context; the conditions would either miss cases or grow into a language.
  Prose read by the agent fits, and the user confirms. Revisit-if: a check that must hold with no
  person in the loop (an automatic move).
- **A string rule language in `settings`** (`"Review>Test: pr; …"`) — metadata disguised as a
  string; no validation. Revisit-if: never.
- **Name patterns in the pool** (`github:acme/web-*`) — a pool must be explicit and reviewable;
  patterns are a one-time search aid in `project-init`. Revisit-if: a project with many short-lived
  repositories under one prefix.
- **Instance-wide PR search when the pool is empty** — finds unrelated work by key collision and
  hides a missing pool. Revisit-if: a tracker whose keys are globally unique and the pool proves a
  burden.
- **Organization-wide search by a bare number** (`gh search prs 123 --owner <org>`) — it found
  real PRs in a sprint pass, but a bare number collides across every project of the organization;
  binding numbers to repositories (D11) keeps the hits and drops the collisions, and the
  repositories it found go into the pool. Revisit-if: never for bare numbers.
- **One `epics` key that is text or a mapping** (`{ rule, roles, projects }`) — a union type is
  harder to validate and to edit in place than flat keys beside `repos`. Revisit-if: epics grow
  more properties than roles and projects.
- **Site-wide epic search by topic words** — noisy, and the same reason as instance-wide PR search;
  the projects that plan the same product are few and known. Revisit-if: an installation whose
  subject epics are spread over many projects.
- **The tool ranks epics by topic** — interpreting prose; D01. Revisit-if: never.
- **A repository-keyed map for number ownership** (`task-tracking.jira.repos: { "<repo>": { numbers:
  PLAN } }`) — one project per repository by construction, but a second place that describes
  repositories. Revisit-if: repositories gain more properties of their own.
- **A batch move selected by `--jql`** (as bulk `edit` allows) — a confirmed move must list every
  key it moves, so the user sees what the one confirmation covers. Revisit-if: batches routinely
  exceed the cap of 50.
- **A title-similarity warning for pool PRs** — a heuristic the agent does better from the printed
  title and summary. Revisit-if: misattached PRs keep slipping past the agent.
- **`--no-pool-comment`** (leave every PR found by search out of the comment) — a typo brings in one
  wrong PR among right ones, and dropping them all loses the right ones; `--skip-pr` per PR, D12.
  Revisit-if: most PRs found by search turn out wrong.

## To verify

- Jira, checked live in T1 (2026-10-19, Jira Cloud, read-only):
  - `/rest/api/3/issue/{key}/changelog` pages with `startAt`/`maxResults`/`total`/`isLast` and
    `values[]` of `{ created, items[] }`, a status item carrying `field`/`fieldId` `status` and
    `fromString`/`toString` — used (`expand=changelog` on the issue also answered; it does not page,
    and its documented cap of 100 histories was not reached on the tasks tried).
  - `/rest/api/3/issue/{key}/comment?orderBy=created` pages with `startAt`/`total` — used for the
    comments, since the issue's `comment` field is capped.
  - `/rest/api/3/issue/{key}/remotelink` answers a plain array of `{ object: { url, title } }`
    (empty on the tasks tried).
  - The epic JQL `project = KEY AND issuetype = Epic AND statusCategory != Done` answers through
    `/search/jql`; a task's epic is its `parent` whose issue type is Epic.
  - Dev-status: see O4 (settled in T2).
  - Still open: posting a comment within `POST /transitions` (`update.comment`) — T1 posts the
    comment as a separate call after the move instead.
- GitHub, checked live in T2 (2026-10-19, github.com, read-only):
  - A PR by URL: REST `/repos/{owner}/{name}/pulls/{n}` — `state` open/closed, `merged_at`,
    `draft`, `head.ref`, `title`. Used.
  - The pool: one GraphQL request per repository. `repository.refs(refPrefix: "refs/heads/",
    query: KEY)` matches the branch name by substring, case-insensitively (`feature/PJ-123-x` is
    found by `PJ-123`, also by `pj-123`), and each ref's `associatedPullRequests` gives the PRs
    whose head it is — so a PR whose title does not carry the key (titles like `FEAT[123]: …` were
    common on the tasks tried) is found by its branch. `search(type: ISSUE, query: "is:pr repo:o/n
    in:title \"KEY\"")` finds the PRs by title. An unquoted key also matched PR bodies (a release
    PR listing task numbers); the whole-token filter on title and branch drops those. Used, one
    request per repository so that one missing repository does not fail the rest.
  - Not used: REST `search/issues` (several repositories per query, but the 30-a-minute search
    limit and no branch name in its answer); `git/matching-refs/heads/<prefix>` matches a name
    prefix only (`feature/PJ-123` is missed).
  - A task whose dev-status counted no PR had its merged PR found in the pool by the alias key in
    the branch and title (the case D05 is for).
- Round 2, to verify live:
  - Jira: a cross-project parent is refused exactly when either project is team-managed
    (`simplified` / `style: next-gen`) — known only from one field report's HTTP 400; and how
    `status CHANGED FROM S TO T` performs over a large project's history.
  - GitHub REST commit search: the default-branch-only scope, the current rate limit, how
    `FIX[123]` is tokenized (search by the number, filter locally by the pattern).
  - GitLab `projects/:id/search?scope=commits` without advanced search, on a self-managed instance.
- GitLab (not in the pool tried live; built on the documented API, covered by tests with fakes):
  MR by `projects/:id/merge_requests/:iid`; the pool by `projects/:id/merge_requests?state=all&in=title&search=KEY`,
  `projects/:id/repository/branches?search=KEY` and, for each branch that carries the key,
  `projects/:id/merge_requests?state=all&source_branch=<branch>`. To verify against a live instance.
