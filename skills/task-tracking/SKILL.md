---
name: task-tracking
description: Read and manage the organization's task tracker — a task, a search, boards and sprints, the sprint report (issues by status, load per assignee), quarterly goals with comments; create and edit issues (one or in bulk), move issues between sprints, link issues, comment, and move a task among the early statuses. One skill for every tracker; the connector (Jira, GitHub issues, GitLab issues) comes from the installation's configuration or the user's words. Triggers on a task key like PROJ-123 or an issue reference like owner/repo#123, "my tasks", "what is on me", "my goals", "what is this task", "what is in the sprint", "sprint status", "who is overloaded", "which tasks are open in", "create a task", "assign it to", "add a label to all", "move these to the next sprint", "link as blocking", "which goal is this for", "goals for this quarter", "which goals are at risk", "comment on the goal", "comment on the task", "move it to In Progress", "dry run", or a pasted tracker link.
when_to_use: Whenever the question is about tasks, boards, sprints or goals, or something has to be written into a task.
metadata:
  owner: oikos
surface: the organization's task tracker — tasks, boards, sprints, goals; reads, and writes after a confirmed dry run
connectors: jira, github-issues, gitlab-issues
refuses: moving a task into or out of review and done statuses (a person does that), deleting issues, and fetching the tracker with a web-fetch tool
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
| jira | tasks, JQL search, boards, sprints, goals (Atlassian Home); create, edit, comment, link, transition | [connectors/jira.md](connectors/jira.md) |
| github-issues | GitHub issues, search, Projects v2 (Status, iterations); create, edit, comment, link, transition | [connectors/github-issues.md](connectors/github-issues.md) |
| gitlab-issues | GitLab issues, filters, boards, milestones or iterations; create, edit, comment, link, transition | [connectors/gitlab-issues.md](connectors/gitlab-issues.md) |

How this organization's tracker is laid out — which boards plan which projects, what each status
means, how goals attach — is the organization's, not oikos's: it is in the resource note
(`node oikos/tools/landscape/cli.mjs resources <id>`) and in the knowledge base the installation names.

## Rules for every tracker

- **Comments and attachments are part of the specification**: read them before answering what a
  task is about.
- **Writes**: dry run, show it, write only after the user's yes. A bulk change lists every key and
  has an upper bound.
- Text written into the tracker is English unless the user says otherwise.
- An operation a connector does not offer (its "Not here, on purpose") is said, with the route
  a person takes — never emulated another way.
