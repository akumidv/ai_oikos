# ADR 0004 — The organization's tracker policy beside the installation's rules

Accepted commitments only. Design, alternatives and open points:
[docs/design/tracker-policy.md](../design/tracker-policy.md). Implementation state:
[`_aitna/TASKS.md`](../../_aitna/TASKS.md) (F17); in code in `jira` (D01–D05) and, by the owner's
decision D-POLICY-HOSTS, in `github-issues` and `gitlab-issues` (D06; no `project-init` there).
Accepted by the owner, with the
design's open points O1–O3 decided as D01 and D03 record; identities (O4) stay out of scope.
Extends [ADR 0001](0001-tracker-transitions.md) D01 (D01, D02 below).

Amends [ADR 0001 D02](0001-tracker-transitions.md#dec-0001-d02) (D03 below): where a policy names
the status, the stricter of rule and policy decides, so an `agent` or `confirm` rule into or out of
a person-only status is refused as `person`.

## D01 — A `policy` part: person-only statuses and their source
<a id="dec-0004-d01"></a>`Decision-ID: DEC-0004/D01`

- **Choice.** `task-tracking.<connector>.defaults.policy` and `projects.<KEY>.policy` hold
  `person_only` (status names: only a person moves a task into or out of them) and `source` (the
  knowledge-base page the policy comes from, printed, never fetched). Validated at load. A
  project's policy adds to the defaults' (union), unlike `transitions`.
- **Rationale.** The organization's rule is structural — who may move — so the tool can hold it
  (ADR 0001 D01); a link to the page lets the agent and the user check it against its origin. A
  policy restricts, so adding is safe and replacing could drop it unseen.
- **Consequences.** Extends ADR 0001 D01's structure. No `policy` → unchanged behaviour.

## D02 — Conflicts reported where the rules are set up
<a id="dec-0004-d02"></a>`Decision-ID: DEC-0004/D02`

- **Choice.** `project-init --dry-run` prints a `## Policy` section: each move into or out of a
  person-only status whose rule (or `defaults.default`) is not `person`, with the rule's path and
  the fix; `sync --check` lists them as warnings. A conflict is not a load problem.
  `project-init --person-only <status> --policy-source <url>` writes the part (ADR 0001 D07).
- **Rationale.** The conflict is found when the rules are written, not on the first refused move.

## D03 — In a move the stricter of rule and policy wins
<a id="dec-0004-d03"></a>`Decision-ID: DEC-0004/D03`

- **Choice.** A move into or out of a person-only status is refused as `person` (exit 3, the
  task's link), naming the policy, its source and the conflicting rule, whatever the rule's mode.
  A `confirm` move does **not** satisfy `person_only` (owner): the agent starts it, so
  it is not the person's own move in the tracker. The stderr line starts `refused: policy:`, so it reads apart from a rule's
  own `person` refusal (`refused:`) and from the content check's (`refused: content check:`,
  ADR 0003 D03); the exit code stays 3 because the next step is the same as for `person`: the user
  moves the task in the tracker. A batch lists such tasks among those that will not move.
- **Rationale.** A rule that contradicts the organization's policy is a configuration error; the
  guard enforces structure, and the safe side of an error is the person.
- **Consequences.** Amends ADR 0001 D02 (dated note there): the rule's mode is no longer the last
  word on a move.
- **Reconsider if** an organization's policy explicitly counts a confirmed move under the person's
  own account as the person's act — then `confirm` would satisfy `person_only` and only `agent`
  would conflict.

## D04 — The agent compares the source page with the rules
<a id="dec-0004-d04"></a>`Decision-ID: DEC-0004/D04`

- **Choice.** A task-tracking scenario (`policy-check`): read the `source` page through the
  knowledge base or the wiki skill, read the rules and the `## Policy` report, and say in chat what
  the page requires that the rules contradict or the policy does not record; a change is proposed
  as a `project-init` dry run.
- **Rationale.** The page is prose; judging it is the agent's, as ADR 0001 D01 leaves prose.

## D05 — The core example follows its own policy
<a id="dec-0004-d05"></a>`Decision-ID: DEC-0004/D05`

- **Choice.** `examples/installation/oikos.yaml` and `connectors/jira/transitions.md`: the `agent`
  rule moves only among the working statuses; into and out of Review is `confirm`; a commented
  `policy` shows the person-only form and what it turns to `person`, including the `"*" → Closed`
  rule that also covers Review.
- **Rationale.** The example is copied; it must not teach the conflict this ADR reports.

## D06 — `github-issues` and `gitlab-issues` enforce the policy too
<a id="dec-0004-d06"></a>`Decision-ID: DEC-0004/D06`

- **Owner's decision D-POLICY-HOSTS.** The organization's policy — `task-tracking.<connector>.defaults.policy` and
  `projects.<KEY>.policy` — is enforced by `github-issues` and `gitlab-issues` as by `jira`: a status
  move into or out of a person-only status is refused (exit 3, `refused: policy:`, before anything
  is sent, dry run and real run), naming the status, the policy path, its `source` and — when the
  tool's own agent list (`GITHUB_AGENT_STATUSES`, `GITLAB_AGENT_STATUSES`) lists the status — that
  list as the rule overridden. `confirm` does not satisfy `person_only` there either (these tools
  have no `confirm` mode). The two tools keep their own agent and review lists; they read the
  policy only, not the transition rules (ADR 0001 D07 / T4 stay open). Where status is a label
  (GitLab; GitHub without `GITHUB_PROJECT`), adding or removing a person-only label through `create`
  or `edit` is refused the same way.
- **Project key (implementation reading, for the owner to confirm).** These trackers have no project
  key like Jira's; `projects.<KEY>` is matched against the issue's repository path
  (`owner/repo`, `group/project`), case-insensitively; no matching project means `defaults.policy`
  alone.
- **Not here.** These tools have no `project-init`, so D02's `## Policy` report applies to them
  only through `sync --check`, which already lists conflicts for every connector's part.
