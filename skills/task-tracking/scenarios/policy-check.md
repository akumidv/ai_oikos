# Scenario: checking the rules against the organization's policy

The installation's transition rules say who may move a task (`task-tracking.<connector>` in
`oikos.yaml`); the organization's own page on who moves — a knowledge-base or wiki page — may say
more. The structured part of that page is the `policy` beside the rules: `person_only`, the statuses
only a person moves a task into or out of, and `source`, the page it comes from (ADR 0004). The tool
enforces the structure; whether the page and the rules agree is the agent's judgment, said in chat.

The commands: Jira — [connectors/jira/project-setup.md](../connectors/jira/project-setup.md) and
[connectors/jira/transitions.md](../connectors/jira/transitions.md). The issue trackers do not take
the rules yet.

## When

- A move was refused with `refused: policy:` — the rule that let it is a configuration error.
- `project-init <KEY> --dry-run` lists a conflict under `## Policy`, or
  `node oikos/tools/sync/cli.mjs --check` prints a `warning:` about the policy.
- The user says the page on who moves changed, a project is being set up, or on request.

## Steps

1. **Read the page.** The `source` printed under `## Policy` (or in the refusal): read it through
   the knowledge base the installation names, or the `wiki` skill for a wiki page. The tool never
   fetches it. No `source` recorded → ask the user where the organization says who moves a task.
2. **Read the rules.** The `task-tracking.<connector>` part of `oikos.yaml` and the `## Policy`
   section of `project-init <KEY> --dry-run` for each project concerned — the person-only statuses
   with the paths that name them, and each conflicting rule with its moves and fix.
3. **Compare, in chat.** Say what the page requires that the rules contradict (a rule that lets an
   agent, or a confirmed move, into or out of a status the page leaves to a person), and what the
   page requires that the policy does not record (a person-only status missing from `person_only`,
   a page newer than the `source` recorded). Quote the page's words; a prose requirement that is not
   about who moves — what a move needs — belongs in a rule's `requires`, not in the policy.
4. **Propose the change.** A status the page leaves to a person → the dry run
   `project-init <KEY> --person-only <status> --policy-source <url> --dry-run` (for one project;
   `defaults.policy` for every project is edited by hand), and its `## Policy` then shows the
   conflicts it brings. A conflicting rule → the fix `## Policy` names (`mode: person`, or a
   `person` rule placed before it), written in `oikos.yaml` by hand after the user's yes.
5. **Write** only on the user's yes: the same `project-init` command without `--dry-run`, as every
   write. Then `project-init <KEY> --dry-run` again: `## Policy` says no conflict.

The safe side of a doubt is the person: until the rules are fixed, a conflicting move is refused
as `person` and the user moves the task in the tracker.
