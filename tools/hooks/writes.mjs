// The oikos tool commands that take --dry-run because they write: to an external service, or, for
// jira `project-init` and `repos`, to the installation's oikos.yaml (ADR 0001 D07), setup `mount` to
// its oikos.yaml or `.local/mounts.yaml` (a file tool may not change the mounts), and `vault` to a note in a
// wiki mount (ADR 0007 D04: the one route that writes into a mount). A command that
// changes only a local store (`catalog add`, `people add`) is not listed. `npm run check` verifies this list
// against each tool's `--help`. The write guard reads the first word after `cli.mjs` as the
// command, so a command with sub-verbs is listed by its first word and every sub-verb of it is a
// write: jira `repos` (`repos add`) and setup `mount` (`mount add|remove`) have only writes. A write command has no read mode: a read lives
// in a read command (`jira info --description`), so the command word alone decides. An entry that
// starts with `--` is an option instead: `sync` has no commands, and `sync --prune` (which takes away
// the wiring of a mount that has gone) is a write wherever the option stands in the call; it is not
// a runCli tool, so `npm run check` does not read its --help; tests/write-guard.test.mjs holds the
// entry to the guard and tests/mounts.test.mjs to sync's own `--prune` and `--dry-run`.
export const WRITES = {
  jira: ['comment', 'transition', 'create', 'edit', 'description', 'move-to-sprint', 'link', 'unlink', 'goal-comment', 'project-init', 'repos', 'attach'],
  confluence: ['append', 'create', 'replace-section'],
  'github-issues': ['create', 'edit', 'comment', 'transition', 'move-to-sprint', 'link'],
  'gitlab-issues': ['create', 'edit', 'comment', 'transition', 'move-to-sprint', 'link'],
  'github-wiki': ['create', 'append', 'replace-section'],
  'gitlab-wiki': ['create', 'append', 'replace-section'],
  vault: ['create', 'append', 'replace-section'],
  setup: ['mount'],
  sync: ['--prune'],
};
