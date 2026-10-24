# ADR 0001 — Tracker status transitions with evidence

Accepted commitments only. Design, alternatives and open points:
[docs/design/tracker-transitions.md](../design/tracker-transitions.md). Implementation state:
[`_aitna/TASKS.md`](../../_aitna/TASKS.md) (T1–T5).

## D01 — Who may move is structured, what is enough is prose
<a id="dec-0001-d01"></a>`Decision-ID: DEC-0001/D01`

- **Choice.** An installation describes moves in `oikos.yaml` under `task-tracking.<connector>`:
  `defaults` (`default` mode, `transitions`) and `projects.<KEY>` (`key_aliases`, `repos`,
  `results`, `epics`, optional own `transitions` that replace the defaults wholesale). A rule is
  `from`, `to` (a status, a list, or `"*"`), `mode` and optional `requires`. The structure is
  validated at load; `requires`, `results` and `epics` are free text the tool prints and never
  interprets.
- **Rationale.** The guard can enforce only structure; what counts as a result differs per
  project and still more per context (a company, a personal business, research), so a condition
  language would miss cases or grow into a language. The agent reads the prose, the user confirms.
- **Consequences.** No `task-tracking.<connector>` part → the old `*_AGENT_STATUSES` allowlist,
  unchanged.
- **Reconsider if** a move must run with no person in the loop.

## D02 — Three modes, fixed in the core
<a id="dec-0001-d02"></a>`Decision-ID: DEC-0001/D02`

- **Choice.** `agent` — dry-run, then the user's next prompt. `confirm` — the dry-run also prints
  the rule's `requires`, the project's `results` and what the task records; the agent judges and
  asks; the move runs on the user's answer. `person` — refused, exit 3, the task link printed.
  A move no rule describes takes `default` (`person` unless set).
- **Rationale.** Lowers "refused" to "confirmed" only for the moves an installation chooses.
- **Amended 2026-10-22** by [ADR 0004 D03](0004-tracker-policy.md#dec-0004-d03): where a policy
  names the status, the stricter of rule and policy decides; a move into or out of a person-only
  status is refused as `person`.

## D03 — Confirmation is the user's next prompt
<a id="dec-0001-d03"></a>`Decision-ID: DEC-0001/D03`

- **Choice.** A `confirm` move is confirmed as every write is: the dry-run, the agent's question
  in chat (where the result is, the epic it proposes and why), the user's next prompt. The write
  guard is unchanged; the question is not asked through a question tool, whose answer is not a
  prompt.
- **Rationale.** One confirmation mechanism; no hook change.
- **Reconsider if** a harness delivers a question tool's answer to hooks as a prompt.

## D04 — A result must be locatable; otherwise ask the assignee
<a id="dec-0001-d04"></a>`Decision-ID: DEC-0001/D04`

- **Choice.** A task leaving the working statuses must show where its result is, or carry a
  comment that there is none and why. If it is not clear, the agent does not move the task: it
  prepares a comment that mentions the assignee and asks where the results are. Checking the
  result itself is a separate stage (a person or the review skill), outside this decision.
- **Consequences.** A task without code goes from Review straight to Done, or back to To Do / Fix
  with a comment saying what to fix.

## D05 — Pull requests: attached first, then the project's pool, nothing else
<a id="dec-0001-d05"></a>`Decision-ID: DEC-0001/D05`

- **Choice.** Pull requests are collected from what the task carries (dev-status, remote links,
  PR/MR URLs in the description and comments), then from the project's explicit repository pool
  by the key and its aliases as a whole token. No instance-wide search. A PR found in the pool and
  not in the task is written into the move's comment. The pool stores explicit names; a name
  pattern is only a one-time search aid in `project-init`.
- **Rationale.** The Jira app may cover one repository while a task's work spans several;
  instance-wide search finds unrelated work by key collision.

## D06 — Epic set on leaving Review
<a id="dec-0001-d06"></a>`Decision-ID: DEC-0001/D06`

- **Choice.** When a rule's `requires` says so and the task has no epic, the dry-run lists the
  project's open epics; the agent proposes the best-fitting one with a reason and the runner-up;
  on the user's answer the epic is set (`edit --parent`, its own dry-run) and then the move runs.

## D07 — Project setup is a guarded write; trackers in order
<a id="dec-0001-d07"></a>`Decision-ID: DEC-0001/D07`

- **Choice.** `<tracker> project-init <KEY>` (workflow, aliases, pool, results) and
  `<tracker> repos add` write only the installation's `oikos.yaml` and still go through the write
  guard. Jira first; `github-issues` and `gitlab-issues` take the same rules afterwards.

## D08 — An extended repository set, searched only on request
<a id="dec-0001-d08"></a>`Decision-ID: DEC-0001/D08`

- **Choice.** A project may name a second, explicit set, `projects.<KEY>.extended_repos`: repositories
  (any code host) where the project's pull requests are possible but rare. No search reads it by
  default. `transition` and `info` read it with `--extended`, on the user's request; a pull request
  found there and not attached to the task goes into the move's comment as one from the pool does.
  When the pool finds nothing and the set is not empty, the dry-run says the set exists and how to
  search it. `repos add --extended` and `project-init --extended-repo` fill it.
- **Rationale.** Searching rarely-relevant repositories on every move costs requests and finds key
  collisions; never searching them loses the odd real pull request.
- **Consequences.** D05 holds without the flag. A dry-run and its real command carry the same flag.

## D09 — General epics named by role
<a id="dec-0001-d09"></a>`Decision-ID: DEC-0001/D09`

- **Choice.** `projects.<KEY>.epic_roles` maps a role name (lowercase) to an epic of the project
  (`{ fixes: PROJ-10, features: PROJ-11 }`), validated at load. How to choose among them stays prose
  in `epics`, read by the agent. The dry run lists the role epics with their status and flags one
  that is closed, missing or not an epic.
- **Rationale.** The roles are facts the tool can check and print; the choice depends on the task
  and stays the agent's (D01).
- **Consequences.** Extends D01's structure: `projects.<KEY>` gains `epic_roles`. `project-init
  --epic-role <role>=<KEY-n>` writes it (D07).

## D10 — Subject epics of named projects; a link where a parent cannot be
<a id="dec-0001-d10"></a>`Decision-ID: DEC-0001/D10`

- **Choice.** `projects.<KEY>.epic_projects` names other projects whose open epics are also
  candidates; no site-wide epic search. The dry run marks each cross-project candidate **parent**
  or **link only** (link only when either project is team-managed). The agent ranks: a subject epic
  that fits the task's topic first, a general epic by the `epics` rule only when none fits; the
  question names the pick and the runner-up with a reason. A link-only pick is proposed as a
  same-project parent (a role epic by the rule, else the best-fitting open epic; none → the link
  alone) and a `Relates` link to the subject epic, both dry runs shown before one question.
- **Rationale.** The work is often planned in another project's epic, and a team-managed project
  refuses that epic as a parent; the link keeps the tie, the parent keeps the project's own order.
  An explicit list keeps the candidates few and reviewable, as the pool does (D05).
- **Consequences.** Extends D06: the candidates also include the role epics and the open epics of
  `epic_projects`; a cross-project pick may be a link. `create` / `edit --parent` refuse in the dry
  run a parent the site would refuse. `project-init --epic-project <KEY>` writes the list (D07).

## D11 — Bare task numbers belong to repositories
<a id="dec-0001-d11"></a>`Decision-ID: DEC-0001/D11`

- **Choice.** `projects.<KEY>.number_repos` lists the repositories where a bare number N (no key)
  means `<KEY>-N`; each is also in the project's `repos` or `extended_repos`, which still say when
  it is searched. A repository's bare numbers belong to at most one project per connector.
  `number_patterns` are literal templates with one `{n}` (`"FIX[{n}]"`), in `defaults` or per
  project (a project's list replaces the defaults'), matched as a whole token. When the PR search
  finds nothing for a task, commits are searched in the same repositories (by key and aliases, in
  `number_repos` also by the patterns); a commit's PR counts as found by search. Found PRs all
  named by `--skip-pr` (D12) count as none found, so the commit search still runs.
- **Rationale.** A bare number collides across projects; bound to the repository where it is
  written, it finds the PRs that carry no key and drops the collisions an organization-wide search
  brings.
- **Consequences.** D05's match set becomes the key, its aliases and, in `number_repos`, the
  patterns; D05's "nothing else" holds, and an organization-wide search stays rejected. Extends
  D01's structure: `projects.<KEY>` gains `number_repos`, `number_patterns`; `defaults` gains
  `number_patterns`. `repos add --numbers` and `project-init --number-pattern` write them (D07).
- **Reconsider if** a repository's numbers turn out to belong to several projects.

## D12 — A PR found by search can be left out
<a id="dec-0001-d12"></a>`Decision-ID: DEC-0001/D12`

- **Choice.** `transition --skip-pr <url>` (repeatable) leaves a PR found by search out of the
  move's comment and out of the agent's evidence; the dry run lists it as skipped. A URL that no
  task found is a usage error in the dry run, except in a batch where some task's evidence could
  not be read — then it is a note naming those tasks. Whether a PR belongs to the task is the
  agent's judgment from the printed title and summary; the tool has no similarity heuristic.
- **Rationale.** A typo in a prefix attaches someone else's PR, and a posted comment is hard to
  take back.
- **Consequences.** Narrows D05: a found PR named by `--skip-pr` is not written into the comment.

## D13 — Many tasks in one move
<a id="dec-0001-d13"></a>`Decision-ID: DEC-0001/D13`

- **Choice.** `transition --task A,B,… --to S` takes explicit keys (at most 50) and one target;
  each task is resolved on its own. One dry run, always in the short form, lists every task with
  enough to judge a result that is not code (rule, `requires`, `results`, PRs, other links,
  attachments, comment count, epic candidates, the comment to be posted) and the tasks that will
  not move. The agent judges each task as for a single move and takes out the ones that will not
  or should not move; a task with no PR and no link, or whose PR search was incomplete (a search
  that did not run or stopped part way: no credential, an HTTP error, a rate limit, or commits
  whose PRs could not be read), is judged from its full single dry run first. One confirmation
  answers the batch. The real run collects the evidence again per task, moves and reports each,
  and exits 2 if any failed. `edit --task A,B,… --parent X` per epic stays
  the batch form for epics.
- **Rationale.** A pass over tens of tasks took one command and one round per task; the guard
  already confirms a listed batch for `edit`.
- **Consequences.** D03 holds: the confirmation is the next prompt after the question in chat. A
  batch is never selected by JQL, so the user sees every key the confirmation covers.
