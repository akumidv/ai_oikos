// Which installation the hooks protect (security finding H-A): the host hands a settings file's `env`
// to the hook processes, so `OIKOS_HOME` there must not turn the guards off. A hook takes the host's
// project folder first and `OIKOS_HOME` only when that is no installation (paths.mjs `hookInstallation`);
// when `OIKOS_HOME` leads to no installation and nothing else does, the guards deny what they cannot
// judge instead of letting it through. Each test runs a guard through the hook dispatcher in a temporary
// installation (ACME Corp); nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CORE, cleanEnv, tempDir } from './helpers/installation.mjs';
import { hook, mounted } from './helpers/mounts.mjs';

const BROKEN = { OIKOS_HOME: '/nonexistent/oikos-home' };
const decision = (answer) => answer.hookSpecificOutput?.permissionDecision;
const reasonOf = (answer) => answer.hookSpecificOutput?.permissionDecisionReason ?? '';

/** The answer of the package guard to a file tool's call, run in `dir` with `env` on top of the project folder. */
const fileTool = (dir, toolName, input, env) => hook(dir, 'package-guard', { hook_event_name: 'PreToolUse', tool_name: toolName, cwd: dir, tool_input: input }, env);
/** The answer of the git guard to a shell command. */
const shell = (dir, command, env) => hook(dir, 'git-guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command } }, env);

test('OIKOS_HOME that is no installation does not hide the installation the host names: the guards still deny (H-A)', () => {
  const { dir, team } = mounted();
  for (const [what, name, input] of [
    ['a write into the core', 'Write', { file_path: join(dir, 'oikos', 'skills', 'x.md'), content: 'x' }],
    ['a write into a mount', 'Write', { file_path: join(team, 'n.md'), content: 'x' }],
    ['a write to .local/outgoing.yaml', 'Write', { file_path: join(dir, '.local', 'outgoing.yaml'), content: 'terms: []' }],
    ['an edit of settings env', 'Write', { file_path: join(dir, '.claude', 'settings.local.json'), content: '{ "env": { "OIKOS_HOME": "/x" } }' }],
  ]) {
    assert.equal(decision(fileTool(dir, name, input, BROKEN)), 'deny', what);
  }
  const redirect = shell(dir, 'echo x > vaults/team/n.md', BROKEN);
  assert.equal(decision(redirect), 'deny');
  assert.match(reasonOf(redirect), /mount/, 'the mount rule names it, as without OIKOS_HOME');
  assert.equal(decision(fileTool(dir, 'Write', { file_path: join(dir, 'notes.md'), content: 'x' }, BROKEN)), undefined, 'a file of the installation itself is free');
  assert.equal(decision(shell(dir, 'echo x > notes.md', BROKEN)), undefined);
  // the same answers without the variable
  assert.equal(decision(fileTool(dir, 'Write', { file_path: join(team, 'n.md'), content: 'x' }, {})), 'deny');
});

test('OIKOS_HOME that is another valid installation does not move the guards away from the host\'s project folder', () => {
  const { dir, team } = mounted();
  const { dir: other } = mounted();
  assert.equal(decision(fileTool(dir, 'Write', { file_path: join(team, 'n.md'), content: 'x' }, { OIKOS_HOME: other })), 'deny', 'the mount of the project folder is still closed');
});

test('OIKOS_HOME that is no installation, and no host project folder: writes are denied naming OIKOS_HOME, reads stay open (H-A)', () => {
  const { dir, team } = mounted();
  const env = { ...BROKEN, CLAUDE_PROJECT_DIR: '' };
  for (const [what, name, input] of [
    ['Write', 'Write', { file_path: join(dir, 'notes.md'), content: 'x' }],
    ['Edit', 'Edit', { file_path: join(team, 'n.md'), old_string: 'a', new_string: 'b' }],
    ['a write into the core', 'Write', { file_path: join(dir, 'oikos', 'skills', 'x.md'), content: 'x' }],
  ]) {
    const answer = fileTool(dir, name, input, env);
    assert.equal(decision(answer), 'deny', what);
    assert.match(reasonOf(answer), /OIKOS_HOME=\/nonexistent\/oikos-home/, `${what}: names the variable`);
  }
  assert.equal(decision(fileTool(dir, 'Read', { file_path: join(dir, 'AGENTS.md') }, env)), undefined, 'a read');
  assert.equal(decision(fileTool(dir, 'Grep', { pattern: 'x', path: dir }, env)), undefined, 'a search');

  const redirect = shell(dir, 'echo x > vaults/team/n.md', env);
  assert.equal(decision(redirect), 'deny');
  assert.match(reasonOf(redirect), /OIKOS_HOME=\/nonexistent\/oikos-home/);
  assert.equal(decision(shell(dir, 'git -C vaults/team commit -m x', env)), 'deny', 'a git write');
  assert.equal(decision(shell(dir, 'ls vaults/team', env)), undefined, 'a read');
  assert.equal(decision(shell(dir, 'git status', env)), undefined, 'a git read');
  assert.equal(decision(shell(dir, 'echo x > /dev/null', env)), undefined, '/dev/null opens no file');
  // the privilege rule runs first, installation or not
  assert.match(reasonOf(shell(dir, 'sudo ls', env)), /sudo/);
});

test('a hook with an installation of its own and no OIKOS_HOME is unchanged', () => {
  const { dir, team } = mounted();
  assert.equal(decision(fileTool(dir, 'Write', { file_path: join(team, 'n.md'), content: 'x' }, {})), 'deny');
  assert.equal(decision(fileTool(dir, 'Write', { file_path: join(dir, 'notes.md'), content: 'x' }, {})), undefined);
});

test('a session in the core repository is development, whatever OIKOS_HOME says: nothing is denied', () => {
  const dir = tempDir('no-installation-');
  // the dispatcher of the core itself, started from the core with its own folder as the project
  const run = (guard, payload, env) => {
    const r = spawnSync(process.execPath, [join(CORE, 'tools', 'hooks', 'host-hook.mjs'), guard],
      { cwd: CORE, input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: CORE, ...payload }), encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: CORE, ...env }) });
    return r.stdout.trim() ? decision(JSON.parse(r.stdout.trim().split('\n').pop())) : undefined;
  };
  assert.equal(run('package-guard', { tool_name: 'Write', tool_input: { file_path: join(dir, 'x.md'), content: 'x' } }, {}), undefined);
  assert.equal(run('package-guard', { tool_name: 'Write', tool_input: { file_path: join(dir, 'x.md'), content: 'x' } }, BROKEN), undefined);
  assert.equal(run('git-guard', { tool_name: 'Bash', tool_input: { command: `echo x > ${join(dir, 'x.md')}` } }, BROKEN), undefined);
});

test('development is the host\'s project folder being the core, not the folder the hook process runs in (L6)', () => {
  const project = tempDir('no-installation-');
  // the hook process runs in the core, but the host's project folder is no installation: OIKOS_HOME that leads nowhere denies writes
  const run = (guard, payload) => {
    const r = spawnSync(process.execPath, [join(CORE, 'tools', 'hooks', 'host-hook.mjs'), guard],
      { cwd: CORE, input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: CORE, ...payload }), encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: project, ...BROKEN }) });
    return r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()) : {};
  };
  assert.equal(decision(run('package-guard', { tool_name: 'Write', tool_input: { file_path: join(project, 'x.md'), content: 'x' } })), 'deny');
  const redirect = run('git-guard', { tool_name: 'Bash', tool_input: { command: `echo x > ${join(project, 'x.md')}` } });
  assert.equal(decision(redirect), 'deny');
  assert.match(reasonOf(redirect), /OIKOS_HOME=\/nonexistent\/oikos-home/);
  assert.equal(decision(run('git-guard', { tool_name: 'Bash', tool_input: { command: 'ls' } })), undefined, 'a read is still free');
});

test('a git read that also has a write form is judged by its form under a broken OIKOS_HOME (U4)', () => {
  const { dir } = mounted();
  const env = { ...BROKEN, CLAUDE_PROJECT_DIR: '' };
  const reads = [
    'git branch', 'git branch -a', 'git branch -r -v', 'git branch -vv', 'git branch --list', 'git branch --show-current', "git branch --list 'feat/*'",
    'git grep foo', 'git config --get user.name', 'git config --global --get user.name', 'git config --list', 'git config -l', 'git config --get-all x',
    'git remote', 'git remote -v', 'git reflog', 'git reflog show', 'git stash list',
  ];
  const writes = [
    'git branch new-one', 'git branch -D old', 'git branch -m a b', 'git branch --set-upstream-to=origin/main', 'git branch --edit-description',
    'git config user.name x', 'git config --unset user.name', 'git config --get user.name --edit', 'git config --add a b',
    'git remote add x y', 'git remote remove x', 'git remote -v add x y', 'git reflog expire --all', 'git reflog delete HEAD@{1}',
    'git stash', 'git stash drop', 'git stash pop', 'git grep -O vim foo', 'git tag v1', 'git fetch',
  ];
  for (const command of reads) assert.equal(decision(shell(dir, command, env)), undefined, `${command} reads`);
  for (const command of writes) {
    const answer = shell(dir, command, env);
    assert.equal(decision(answer), 'deny', `${command} writes`);
    assert.match(reasonOf(answer), /OIKOS_HOME=\/nonexistent\/oikos-home/, command);
  }
});

test('a program that is a variable the command sets to git is read as git under a broken OIKOS_HOME (L7)', () => {
  const { dir } = mounted();
  const env = { ...BROKEN, CLAUDE_PROJECT_DIR: '' };
  assert.equal(decision(shell(dir, 'G=git; $G commit -m x', env)), 'deny');
  assert.equal(decision(shell(dir, 'G="git -C vaults/team"; $G add a.md', env)), 'deny');
  assert.equal(decision(shell(dir, 'G=git; $G status', env)), undefined);
  assert.equal(decision(shell(dir, 'G=ls; $G -l', env)), undefined);
});
