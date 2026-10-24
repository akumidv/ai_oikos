# Connector: jira — project setup (`project-init`, `repos add`)

Both write only `task-tracking.jira.projects.<KEY>` in the installation's `oikos.yaml` and go
through the write guard (the flow: [scenarios/project-setup.md](../../scenarios/project-setup.md)). Run each dry run and
each write as one standalone command — nothing chained around it.

```bash
node oikos/tools/jira/cli.mjs project-init PROJ --dry-run                            # round 1: the report
node oikos/tools/jira/cli.mjs project-init PROJ --owner github:acme --pattern 'web-*' --months 12 --dry-run
node oikos/tools/jira/cli.mjs project-init PROJ --alias PJ --repo github:acme/web-ui --repo github:acme/auth \
  --results "Pull requests; UI changes also as screenshots." --epics "One epic per product area." --dry-run   # round 2
node oikos/tools/jira/cli.mjs repos add PROJ github:acme/auth --dry-run               # one repository into the pool
node oikos/tools/jira/cli.mjs repos add --extended PROJ github:acme/legacy-ui --dry-run   # into the extended set
node oikos/tools/jira/cli.mjs project-init PROJ --extended-repo github:acme/legacy-ui --dry-run
node oikos/tools/jira/cli.mjs project-init PROJ --number-pattern 'FIX[{n}]' --epic-role fixes=PROJ-10 --epic-project PLAN --dry-run
node oikos/tools/jira/cli.mjs repos add --numbers PROJ github:acme/web-ui --dry-run   # its bare numbers are PROJ's
node oikos/tools/jira/cli.mjs project-init PROJ --person-only Review --policy-source https://kb.example.com/tracker-rules --dry-run
```

- `project-init --dry-run` reports, in order:
  - **Workflow** — the project's statuses (from Jira) against the rules that hold for it (its own
    `transitions`, else the defaults): the moves each rule decides, the statuses a rule names that
    the workflow lacks, and the statuses no rule covers — moves into and out of them stay a person's;
  - **Policy** (ADR 0004) — the person-only statuses that hold for the project (`defaults.policy`
    joined with its own `policy`, with the proposed block's), each with the path naming it, the
    sources, then every rule — `"*"` rules and `defaults.default` included — that lets a move into or
    out of one run as `agent` or `confirm`: its path, the moves among the workflow's statuses (or,
    when the workflow was not read, among the statuses the rules name and `"*"` for any other), and
    the fix (take the status out of the rule's `to`/`from`, or put a `person` rule such as
    `{ from: Review, to: "*", mode: person }` before it; for the default, set it to `person`). The
    rules are fixed by hand; a conflict stops nothing, but such a move is refused when it runs;
  - **Key aliases** — prefixes other than the key that name a task number of the project (from its
    last 500 tasks) in the titles and branches of the candidate repositories' last 100 pull requests
    and first 100 branches, proposed when seen at least twice, with a count and an example;
    configured ones are listed;
  - **Repository pool** — candidates by activity: repositories with pull requests whose title or
    branch carries the key or an alias, updated in the last `--months` (default 6), searched under
    each `--owner` (`github:<owner>`; default the owners of the pool and the extended set); and the
    repositories under those owners whose name matches a `--pattern` glob (`web-*`; with a slash,
    `owner/name`). Those already in the pool are marked `*`, those in the extended set `+`; under
    every other one, the two dry runs that add it to the pool or to the extended set. A pattern is
    never stored. GitHub only: a GitLab owner or
    repository is said as not searched; a branch without a pull request is not found by this search;
  - **Results and epics** — the current prose, or what to ask the user;
  - **Proposed block** — the block as it would be written from `--alias`, `--repo`,
    `--extended-repo`, `--number-pattern`, `--epic-role`, `--epic-project` (merged with what is
    there, de-duplicated), `--results`, `--epics` (replaced); the project's `transitions` stay. A
    project's first own `number_patterns` gets one line saying it replaces `defaults.number_patterns`.
    `repos add --numbers` grows `number_repos` (below). With nothing to change it says so.
  A failed read (no credential, an HTTP error) is said in its section; the others still run.
- Without `--dry-run`, `project-init` writes only that block — no search is repeated, no request is
  made. `repos add` adds explicit `<host>:<owner>/<name>` names (a pattern is refused) to the pool,
  or with `--extended` to the extended set, says which were there already, and writes nothing when
  there is nothing to add.
- A repository is in one list at most: adding one that the other list holds is refused, naming
  that list. Moving a repository between the lists is not a command — edit `oikos.yaml` by hand.
- **Bare numbers** (`FIX[123]` meaning PROJ-123): `--number-pattern` (repeatable, a literal
  template with one `{n}`) grows `number_patterns` — a project's list replaces `defaults.number_patterns`,
  which is edited by hand; `repos add --numbers` grows `number_repos` with repositories already in
  the pool or the extended set, and refuses in the dry run one whose numbers another project holds,
  naming it.
- **Policy**: `--person-only <status>` (repeatable) grows `projects.<KEY>.policy.person_only` and
  `--policy-source <url>` sets its `source` (replaced when there is one); `"*"` is refused. The
  project's policy adds to `defaults.policy`, which is edited by hand. The dry run's `## Policy`
  already shows the conflicts the new statuses bring.
- **Epics**: `--epic-role <role>=<KEY-n>` (repeatable) adds a role epic to `epic_roles` (a role
  already mapped to another epic is refused — edit it by hand); `--epic-project <KEY>` (repeatable)
  adds to `epic_projects`, the other projects whose open epics are candidates too.
- The file is edited in place: the new entry goes into the list as it is written there (`[a, b]` or
  `- a`), a missing block is created, comments and every other line stay. The result must pass the
  structure check of `task-tracking` — with a problem anywhere in it nothing is written and the
  problem is named.
