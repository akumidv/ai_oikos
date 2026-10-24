# Scenario: setting a project up — `project-init`, `repos add`

A project's part of the transition rules — its key aliases, its repository pool, where its results
are, how its epics are split — is set up from the tracker, not typed by hand. Both commands change
only the installation's `oikos.yaml` (that project's block; every comment and other line stays) and
are writes like any other: dry run, the user's yes, the same command without `--dry-run`.

The commands: Jira — [connectors/jira/project-setup.md](../connectors/jira/project-setup.md). The
issue trackers do not offer them yet.

## When

- A move is asked for a project the rules do not list, or its dry run says the pool is empty →
  offer `project-init <KEY> --dry-run`.
- A `confirm` dry run names a pull request whose repository is outside the pool, with its
  `repos add … --dry-run` line → offer it.
- Or on request.

## Pool or extended set

A repository where the project's pull requests are usual goes into the pool (`--repo`,
`repos add`); one where they are possible but rare into the extended set (`--extended-repo`,
`repos add --extended`). A repository is in one of them at most. **The pool is explicit names**: a
pattern only helps the search; `repos add` refuses one.

## Steps — `project-init` in three rounds

1. **Report.** The dry run reports the workflow against the rules (the statuses no rule covers
   stay a person's), the organization's policy and the rules that contradict it (`## Policy`, each
   with its fix — when there is one, go through [policy-check.md](policy-check.md) with the user
   before the rest), key alias candidates, repository candidates by activity and by the name
   patterns the user gives, the current `results` and `epics`.
2. **Choose.** Ask the user in the chat which aliases and repositories to keep and where the
   results of this project's tasks are; run the dry run again with the chosen flags and show the
   block it would write.
3. **Write.** On the user's yes run that command unchanged without `--dry-run`.
