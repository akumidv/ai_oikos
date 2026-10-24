---
name: task-tracking
description: Read and manage the organization's task tracker — tasks, search, boards and sprints, the sprint report, quarterly goals; create, edit, link and comment on issues (one or in bulk), move them between sprints, and move a task by the installation's transition rules — a later move only after the task shows its result and the user confirms. One skill for every tracker; the connector (Jira, GitHub issues, GitLab issues) comes from the installation's configuration or the user's words. Triggers on a task key like PROJ-123, an issue reference like owner/repo#123 or a pasted tracker link, "my tasks", "what is this task", "sprint status", "who is overloaded", "create a task", "add a label to all", "move these to the next sprint", "link as blocking", "goals for this quarter", "comment on the task", "move it to In Progress".
when_to_use: Whenever the question is about tasks, boards, sprints or goals (which are at risk, which goal a task serves), something has to be written into a task or a goal, or a project's tracker rules have to be set up.
metadata:
  owner: oikos
  group: engineering
surface: the organization's task tracker — tasks, boards, sprints, goals; reads, and writes after a confirmed dry run
connectors: jira, github-issues, gitlab-issues
refuses: a move the installation's rules leave to a person (without rules, any move beyond the early statuses), moving a task whose result is not clear (the assignee is asked instead), deleting issues, and fetching the tracker with a web-fetch tool
---

# task-tracking

Tasks, sprints and goals: reading them for planning and reviews, and writing into them — always
as a dry run first, written only after the user confirms.

## Which connector

`node oikos/tools/landscape/cli.mjs skills task-tracking` shows the connectors this installation uses (`oikos.yaml`
→ `connectors.task-tracking`, the first is the default). Pick by what the user says — a task key's
project, a pasted URL's host — else the default. Then read the connector's file and drive its
tool as it says.

| Connector | Reaches | Read |
|---|---|---|
| jira | tasks, JQL search, boards, sprints, goals (Atlassian Home), status history (time in status, returns from review); create, edit, comment, link, unlink, transition, attach files | [connectors/jira.md](connectors/jira.md) |
| github-issues | GitHub issues, search, Projects v2 (Status, iterations); create, edit, comment, link, transition | [connectors/github-issues.md](connectors/github-issues.md) |
| gitlab-issues | GitLab issues, filters, boards, milestones or iterations; create, edit, comment, link, transition | [connectors/gitlab-issues.md](connectors/gitlab-issues.md) |

How this organization's tracker is laid out — which boards plan which projects, what each status
means, how goals attach — is the organization's, not oikos's: it is in the resource note
(`node oikos/tools/landscape/cli.mjs resources <id>`) and in the knowledge base the installation names.

## Rules for every tracker

- **Comments and attachments are part of the specification**: read them before answering what a
  task is about.
- **Writes**: dry run, show it, write only after the user's yes. A bulk change lists every key and
  has an upper bound. The dry run and the write are each one standalone command, identical except
  `--dry-run` — nothing chained around them ([OIKOS.md](../../OIKOS.md), *Writes need
  confirmation*).
- Text written into the tracker is English unless the user says otherwise.
- An operation a connector does not offer (its "Not here, on purpose") is said, with the route
  a person takes — never emulated another way.

## Moving a task — the installation's rules

Who may move a task between two statuses is the installation's: `task-tracking.<connector>` in
`oikos.yaml` (the connector file shows the shape). Each rule names `from` and `to` statuses and a
**mode**; the first rule that covers the move wins, a project's own rules replace the defaults, and
a move no rule covers is a person's unless `default` says otherwise. Without that part a connector
keeps its plain list of agent statuses (`*_AGENT_STATUSES`), and every other move is a person's.

| Mode | What happens |
|---|---|
| `agent` | dry run, show it, move on the user's yes — as every write |
| `confirm` | the dry run also prints the evidence — the rule's `requires`, the task's result, its pull requests, its epic; the move runs only after the result is judged and the user confirms: [scenarios/move-task.md](scenarios/move-task.md) |
| `person` | refused (exit 3) with the task's link — the user moves it in the tracker |

**The organization's policy beside the rules.** `policy.person_only` (in `defaults`, and a project's
own, which adds to the defaults') names the statuses only a person moves a task into or out of;
`policy.source` is the knowledge-base page it comes from, printed, never fetched. In a move the
stricter of rule and policy wins: a move into or out of a person-only status is refused as `person`
(exit 3, the task's link) whatever the rule's mode — `confirm` included, since the agent would
start it — and the refusal starts `refused: policy:`, naming the policy, its source and the rule it
overrides. The user moves such a task in the tracker; the rule that contradicts the policy is a
configuration error, reported by `project-init --dry-run` (`## Policy`) and `sync --check`
(a warning). Comparing the page with the rules: [scenarios/policy-check.md](scenarios/policy-check.md).

## Scenarios

Typical tasks have their own step-by-step file in `scenarios/`. Pick the one that fits and read
it before starting; for anything else, work from the connector file and the rules above.

| Scenario | When | Read |
|---|---|---|
| Moving a task by a `confirm` rule | a move to review, done, closed… that the rules leave to `confirm` | [scenarios/move-task.md](scenarios/move-task.md) |
| Setting a project up | a move for a project the rules do not list, an empty repository pool, a pull request outside the pool, or on request | [scenarios/project-setup.md](scenarios/project-setup.md) |
| Checking the rules against the organization's policy | a move refused by the policy, a `## Policy` conflict or a `sync --check` warning, the knowledge-base page on who moves changed, or on request | [scenarios/policy-check.md](scenarios/policy-check.md) |

A new typical task gets its own file in `scenarios/` and a row here.
