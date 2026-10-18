// The commands of oikos tools that change something remotely — exactly the commands that take
// --dry-run. `npm run check` verifies this list against each tool's `--help`.
export const WRITES = {
  jira: ['comment', 'transition', 'create', 'edit', 'move-to-sprint', 'link', 'goal-comment'],
  confluence: ['append', 'create', 'replace-section'],
};
