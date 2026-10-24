// The oikos tool commands that take --dry-run because they write: to an external service, or, for
// jira `project-init` and `repos`, to the installation's oikos.yaml (ADR 0001 D07). A command that
// changes only a local store (`catalog add`) is not listed. `npm run check` verifies this list
// against each tool's `--help`. The write guard reads the first word after `cli.mjs` as the
// command, so a command with sub-verbs is listed by its first word and every sub-verb of it is a
// write: jira `repos` (`repos add`) has only writes. A write command has no read mode: a read lives
// in a read command (`jira info --description`), so the command word alone decides.
export const WRITES = {
  jira: ['comment', 'transition', 'create', 'edit', 'description', 'move-to-sprint', 'link', 'unlink', 'goal-comment', 'project-init', 'repos', 'attach'],
  confluence: ['append', 'create', 'replace-section'],
  'github-issues': ['create', 'edit', 'comment', 'transition', 'move-to-sprint', 'link'],
  'gitlab-issues': ['create', 'edit', 'comment', 'transition', 'move-to-sprint', 'link'],
  'github-wiki': ['create', 'append', 'replace-section'],
  'gitlab-wiki': ['create', 'append', 'replace-section'],
};
