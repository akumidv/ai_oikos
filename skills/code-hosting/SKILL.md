---
name: code-hosting
description: Read the organization's code hosting without a checkout — repositories and projects, the files in them, open merge or pull requests across a group or the whole instance, pipelines and failed job logs, and which merge requests carry a task key. One skill for every code host; the connector (GitLab, GitHub) comes from the installation's configuration or the user's words. Triggers on "which MRs are open", "my merge requests", "what do I need to review", "what is waiting for review", "where is the code for PROJ-123", "why did the pipeline fail", "which repositories do we have", "show the README of", "list the files of", or a pasted GitLab or GitHub URL.
when_to_use: Whenever a question is about repositories, their files, merge or pull requests, or pipelines on a code host.
metadata:
  owner: oikos
surface: the organization's code hosts — projects and repositories, files, merge requests, pipelines and job logs; read-only
connectors: gitlab, github
refuses: any write (merge, approve, comment, rerun, push), managing repositories, members or settings, and calling a host's CLI or curl directly instead of the connector's tool
---

# code-hosting

Reading code hosts for management questions: what is open, what waits for review, why a
pipeline is red, where the code for a task lives, what a repository contains. Nothing is
changed — merging, approving and rerunning stay with the people who own the code.

## Which connector

`node oikos/tools/landscape/cli.mjs skills code-hosting` shows the connectors this installation uses (`oikos.yaml`
→ `connectors.code-hosting`, the first is the default). Pick by what the user says — a named
host, a pasted URL's host — else the default. When several are configured and the question spans
them ("my open reviews", "where is the code for PROJ-123"), ask each and say which were searched.
Then read the connector's file and drive its tool as it says.

| Connector | Reaches | Read |
|---|---|---|
| gitlab | projects, merge requests, pipelines, job logs, files, task keys in MRs | [connectors/gitlab.md](connectors/gitlab.md) |
| github | an organization's repositories and their files | [connectors/github.md](connectors/github.md) |

A connector the installation does not use is not tried; if the question needs one, say so and
point at `node oikos/tools/setup/cli.mjs status`.

## Reporting

- "Me" is the owner of the connector's token (`whoami`).
- A 404 means "not found or no access" — access is granted per person; say which.
- A red pipeline: report the job, the stage and the quoted error line — not the log.
