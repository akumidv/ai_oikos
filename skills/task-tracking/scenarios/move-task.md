# Scenario: moving a task by a `confirm` rule

The user asks to move a task to a later status — review, done, closed — and the installation's
rule for that move is `confirm` (the skill, § Moving a task). The move happens only after the
task shows its result and the user confirms; checking the result itself is not this scenario's
(a person, or a review).

The connector's commands and its dry run: Jira — [connectors/jira/transitions.md](../connectors/jira/transitions.md).
The issue trackers keep the plain list of agent statuses for now: a move beyond it is a person's.

## Steps

1. **Collect** — run the move with `--dry-run` (with `--comment "…"` when the move should say
   something, e.g. the result's links). A pass over many tasks is one command, `--task A,B,…`
   (below). When the target is not reachable directly and the tool prints a path, follow it step by
   step — each step its own dry run and its own confirmation.
2. **Judge** the evidence against `requires` and `results`, which are prose the installation
   wrote: where is the result — a pull request, a document, a link, an attachment, the result
   written out — or a comment saying there is none and why. The tool has already looked, in order:
   what the task carries, the pool by the key and its aliases (and, in the project's number
   repositories, by the bare number written as a pattern), then — when nothing was found — the
   commits of the same repositories. Ask the assignee only when all of that shows nothing. Pull
   requests found by search go into the comment posted with the move, so the task records them.
   **Someone else's pull request** (a typo in a prefix: its title or branch is about another task)
   is left out with `--skip-pr <url>` on the dry run and the move; do not cite it as the result.
   **The extended set** (`extended_repos`: repositories where the project's pull requests are
   possible but rare) is searched only with `--extended`. Add the flag only when the user asks for
   it, or when the dry run's hint says the pool found nothing and the set exists and the user agrees
   to search it — then run the hint's command, and the move itself carries the same flag.
3. **Ask the user in the chat**, not through a question tool (its answer is not a prompt, so the
   write guard would not see a confirmation): where the result is, and — when `requires` asks for
   an epic and the task has none — the epic you propose with a one-line reason and the runner-up.
   Pick in this order: a **subject epic** that fits the task's topic (the project's own open epics
   and those of its `epic_projects`) first; a **role epic** (`epic_roles`) by the project's `epics`
   rule only when no subject epic fits. A subject epic marked **link only** is proposed as two
   writes in one question: a parent of the task's own project (a role epic by the rule, else its
   best-fitting open epic; none → the link alone, and say the task stays without a parent) and a
   `Relates` link to the subject epic — both dry runs shown before the question. On the answer set
   the epic first (its own dry run), then run the move unchanged without `--dry-run`.
4. **If the result is not clear, do not move.** Prepare a comment that mentions the assignee and
   asks where the results are (the connector file says how to mention), dry run, and post it on
   the user's yes.

## A pass over many tasks

1. Dry-run every task in one command: `transition --task A,B,… --to S --dry-run` (at most 50 keys).
   It is always brief: a block per task, then the tasks that will not move.
2. Judge each `confirm` block as a single move. A task whose block shows no pull request and no
   link, or flags `pull request search incomplete` (a search that did not run or was partly
   searched — no credential, an HTTP error, a rate limit — or commits whose pull requests were not
   read), is judged from its full dry run (its `Full evidence` line) before the question. Only a first page read or dev-status unavailable is a `Notes:` entry, not that flag.
   When a rate-limit note gives `retry after ~<N>s`, run that full single dry run after that time.
3. Take out every task that will not or should not move, and dry-run the shorter command — the
   guard pairs a move with its identical dry run. Epics are set first with
   `edit --task A,B,… --parent X`, one command per epic, after showing the whole mapping (task →
   epic, reason).
4. Ask one question that names every task; on the answer run the last dry run's command without
   `--dry-run`. Report the tasks that failed (`PROJ-7: <reason>`) — each is handled on its own. A
   task `moved, but the comment was not posted` (the summary ends `, C without its comment`, exit 2)
   is moved, and the run prints the comment's full text, with its pull request lines, under
   `PROJ-7: moved to S; the comment was not posted (…)` — a dry run of the move cannot give it any
   more, the task is in S. Post that text with `comment --task PROJ-7 --file <text> --dry-run`
   (or `--text`) first, then without `--dry-run`, or tell the user. A single move prints the same.

A project the rules do not list, an empty pool, or a pull request in a repository outside the pool
→ [project-setup.md](project-setup.md).
