# Design — the organization's tracker policy beside the installation's rules

Living design concept ([design-flow](../../_aitna/akmon/pipelines/design-flow.md)). Nothing here
is accepted until the owner says so; accepted commitments then move to ADR blocks and the
implementation steps to [`_aitna/TASKS.md`](../../_aitna/TASKS.md).

**State:** accepted by the owner (2026-10-22); commitments in
[ADR 0004](../adr/0004-tracker-policy.md), implementation in `_aitna/TASKS.md` (F17). O1–O3 are
decided (owner, 2026-10-22); O4 (identities) stays open for the future. It extends
[ADR 0001](../adr/0001-tracker-transitions.md) D01 and **amends** its D02: in a move the stricter
of rule and policy wins, so a rule's mode is no longer the last word (ADR 0004 D03). **How to resume:** read § Frame, § Design, then § Open points.

## Frame

- **Problem.** An installation's rules (`task-tracking.<connector>.{defaults,projects}.transitions`,
  ADR 0001) may let an agent move a task into Review, while the organization's knowledge base says
  only a person moves a task into or out of Review. Nothing ties the rules to that page, so the two
  drift apart unseen. The core's own example has the same conflict (below).
- **Goal.** The organization's hard constraints on who moves are recorded beside the rules, in
  structure the tool can check, with a link to the page they come from; a rule that contradicts
  them is reported where the rules are set up and where a move runs.
- **Constraints already decided.** Who may move is structured, what is enough is prose (ADR 0001
  D01); three modes fixed in the core (D02); project setup writes `oikos.yaml` as a guarded write
  (D07); nothing about an organization in the core.
- **Acceptance.** With `policy.person_only: [Review]`, `project-init --dry-run` lists every rule
  that lets a move into or out of Review run in a mode other than `person`, and a move by such a
  rule does not run as `agent`/`confirm`; with no `policy`, nothing changes.

## Survey — the current code and docs

- `tools/common/transitions.mjs` — `DEFAULTS_KEYS` (`default`, `transitions`, `number_patterns`) and
  `PROJECT_KEYS` are closed lists: an unknown key is a load problem, so `policy` needs adding.
  `resolveTransition(part, projectKey, from, to)` — first matching rule, else `defaults.default`.
- `tools/common/project-setup.mjs` — `workflowCoverage(statuses, part, projectKey)` already resolves
  every ordered pair of the workflow's statuses to its rule; `workflowLines` prints it as
  `## Workflow`. A policy check is one more pass over the same moves.
- `examples/installation/oikos.yaml` (the commented `task-tracking` block) and
  `skills/task-tracking/connectors/jira/transitions.md` both show
  `{ from: [To Do, In Progress, Blocked], to: [..., Review], mode: agent }` — an agent moves into
  Review; `from: Review, to: [Test, Done], mode: confirm` — out of Review on confirmation; and
  `from: "*", to: Closed, mode: confirm`, which also covers Review → Closed.
- `skills/task-tracking/scenarios/move-task.md` — the `confirm` flow; `project-setup.md` — setup.

## Design

### The `policy` part

```yaml
task-tracking:
  jira:
    defaults:
      policy:
        person_only: [Review]            # only a person moves a task into or out of these
        source: https://kb.example.com/tracker-rules   # the page the policy comes from
      transitions: [ … ]
    projects:
      PROJ:
        policy: { person_only: [Acceptance] }   # adds to the defaults' policy
```

- `person_only` — a list of status names, compared case-insensitively as statuses are; `source` —
  text (a URL or a page title), printed, never fetched by the tool. Both validated at load.
- **A project's policy adds to the defaults'** (union of `person_only`, both `source`s printed) —
  unlike `transitions`, which a project replaces wholesale. A policy restricts; replacing it would
  let one project drop the organization's rule without a trace (O3).
- No `policy` → behaviour exactly as today; back-compat (`*_AGENT_STATUSES`) is untouched.

### The check — one function, three places

`policyConflicts(part, projectKey, statuses)` — pure: for each move into or out of a person-only
status, the resolved mode (`resolveTransition`); a mode other than `person` is a conflict
`{ from, to, origin, mode }`. `statuses` are the workflow's (in `project-init`) or, without a
workflow read, the statuses the rules and the policy name — so a `"*"` rule is caught either way.

- **`project-init --dry-run`** — a `## Policy` section: the policy, its sources, each conflict with
  the rule's path (`defaults.transitions[0]`) and the fix (a `person` rule placed before it, or the
  status taken out of the rule's `to`). A conflict is not a load problem: it does not stop the tools.
- **`sync --check`** — lists conflicts with the other `oikos.yaml` problems, as a warning.
- **The move** — `transition` resolves the rule, then the policy: a move into or out of a
  person-only status whose rule is not `person` is refused as `person` is (exit 3, the task's link),
  naming the policy, its source and the conflicting rule (O2); stderr starts `refused: policy:`, to
  tell it from a rule's own refusal and from the content check's `refused: content check:`
  (ADR 0003 D03), while the exit code — and the next step, the user moves it — stays `person`'s. A
  batch lists such tasks among those that will not move. This amends ADR 0001 D02.

### The scenario — the agent compares the page with the rules

`skills/task-tracking/scenarios/policy-check.md`: read `source` (the knowledge base or the wiki
skill), read the rules and the `## Policy` section of `project-init --dry-run`, and report in chat
what the page says that the rules contradict or the policy does not record — a prose judgment, as
ADR 0001 D01 leaves prose to the agent. A proposed change is written by `project-init` (new options
`--person-only <status>`, `--policy-source <url>`), a guarded write (D07).

### The core example

Fix both copies: the agent rule moves only among the working statuses; `In Progress → Review` is
`confirm`; the Review rules stay `confirm`; a commented `policy` line shows the person-only form,
with a note that an installation setting it turns its Review rules to `person` (and puts
`{ from: Review, to: "*", mode: person }` before `"*" → Closed`).

### Later — rules keyed by identity (sketch, not decided)

Separate agent identities — intake, implement, review, merge, accept, release — each a tracker
account with its own allowed moves. A possible shape, so the policy part does not block it:

```yaml
task-tracking:
  jira:
    identities:                           # credential key per identity, in .local/.env
      implement: { email: JIRA_EMAIL_IMPLEMENT }
      review:    { email: JIRA_EMAIL_REVIEW }
    defaults:
      policy:
        person_only: [Accepted]
        identity_only: { Review: [review] }   # only this identity (or a person) moves in or out
      transitions:
        - { from: In Progress, to: Review, mode: agent, by: [implement] }
```

`by` would narrow a rule to identities; `whoami` would name the identity of the credentials in use;
`person_only` would keep meaning "no agent identity at all". Open: whether `confirm` by an agent
identity counts as a person's act, how an identity is proved (the account, not a claim), and
whether identities belong in `oikos.yaml` or in the tracker's own permissions (O4).

## Options considered

- **A — a structured `policy` with `source`, checked; prose judged by the agent.** Chosen direction.
- **B — the policy only as prose in `requires`.** Rejected: a conflict between a rule's mode and
  the organization's rule is structural; the guard can enforce it, so it should.
- **C — the tool reads the knowledge-base page and derives `person_only`.** Rejected: it interprets
  prose (ADR 0001 D01) and depends on a page's wording.
- **D — a fourth mode per rule (`policy`).** Rejected: the policy is about statuses, not about one
  rule; duplicating it per rule is what drifts today.

## Open points

| # | Point | State |
|---|---|---|
| O1 | Does a `confirm` move satisfy `person_only`? | decided (owner, 2026-10-22) — no (strict): the move runs under the user's account, but the agent starts it; a person-only move is made by the person in the tracker |
| O2 | In the move, report only or refuse | decided (owner, 2026-10-22) — refuse as `person` (the stricter of rule and policy wins); report-only lets the conflict run on every move. Refusing amends ADR 0001 D02 (a rule's mode decides a move), with a dated amendment note there |
| O3 | A project's policy: adds to the defaults' or replaces them | decided (owner, 2026-10-22) — adds (union); an exception would need an explicit key later |
| O4 | Identities (intake, implement, review, merge, accept, release) | open, future: sketch above; not decided now |
| O5 | The issue trackers (`github-issues`, `gitlab-issues`) | follow ADR 0001 D07 / T4: the same part when they take the rules |

## Rejected (candidates)

- **Putting the policy in `oikos.yaml`'s top level** (`policy:` beside `task-tracking`) — it is per
  tracker and per project, as the statuses are. Revisit-if: a policy spans trackers.
- **A conflict as a load problem** — it would stop every tool on one rule's mode. Revisit-if: never.

## Points for the implementation

- `transitions.mjs`: `policy` in `DEFAULTS_KEYS` and `PROJECT_KEYS`; validation; `effectivePolicy`
  (union); `policyConflicts`; `resolveTransition` callers apply the policy after the rule.
- `project-setup.mjs`: `policyLines`; `project-init` options `--person-only`, `--policy-source`.
- `tools/jira/cli.mjs`: the refusal and the batch listing; the issue trackers later (O5).
- `sync --check`: conflicts as warnings.
- Docs: `connectors/jira/transitions.md` (the part and the example), `examples/installation/oikos.yaml`,
  `scenarios/policy-check.md`, `scenarios/project-setup.md`, the skill's § Moving a task.
- Tests: union of policies, a `"*"` rule caught, refusal in a single and a batch move, no policy →
  unchanged, the fixed example free of conflicts.
