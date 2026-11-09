# T5 · Epics across projects, bare numbers, batch moves

Detail for the [backlog](../TASKS.md) row `T5` (Round 2 of the tracker transitions,
[ADR 0001](../../docs/adr/0001-tracker-transitions.md) D09–D13).

[design](../../docs/design/tracker-transitions.md) § Epics by role and across projects, § Bare task
numbers, § Leaving a found PR out, § Moving many tasks. Done in code, tests green: parent check in
`create`/`edit --parent`, overdue sprint warning, path hint, `transition --brief`; D09–D13
(`epic_roles`, `epic_projects`, `number_repos`, `number_patterns`, commit search, `--skip-pr`,
`transition --task A,B,…`, the `project-init`/`repos add` flags). Code audited (three rounds,
pass), audit fixes and the owner's D11–D13 rulings in; the parent rule checked live (team-managed
only refuses; company-managed projects hold cross-project parents). Last round in (partly searched
on a rate limit, collapsed per-commit notes, unread commits flag the search incomplete, D13
widened to "stopped part way" and unread commits), control audit pass with fixes. Follow-ups in,
audited (pass): the real run notes an incomplete re-collection on stderr, retry-after in
rate-limit notes (kept per host across a batch), reason before shas, 404s collapsed, one
"limited earlier" note per host. A rate limit is kept per quota across a batch for the pool and
extended search as for the commit search (GitHub GraphQL, REST search and REST core apart). Left: GitLab live; the installation's config moved to the new keys (by the owner, in the
installation); commit.
