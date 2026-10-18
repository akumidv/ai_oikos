// The commands of oikos tools that change something remotely — exactly the commands that take
// --dry-run. `npm run check` verifies this list against each tool's `--help`.
export const WRITES = {
  jira: ['comment', 'transition', 'create', 'edit', 'move-to-sprint', 'link', 'goal-comment'],
  confluence: ['append', 'create', 'replace-section'],
  'github-issues': ['create', 'edit', 'comment', 'transition', 'move-to-sprint', 'link'],
  'gitlab-issues': ['create', 'edit', 'comment', 'transition', 'move-to-sprint', 'link'],
  'github-wiki': ['create', 'append', 'replace-section'],
  'gitlab-wiki': ['create', 'append', 'replace-section'],
};
