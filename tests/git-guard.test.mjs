// The git guard (npm test): the command after a control word (`do`, `then`, …) is the command it
// judges. The hook is driven as a host drives it — `host-hook.mjs git-guard` with the event payload
// on stdin — from a temporary folder outside the core, so no commit check reads a staged tree.
// Nothing here runs git or reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';

const CORE = realpathSync(CORE_ROOT);
const HOOK = join(CORE, 'tools', 'hooks', 'host-hook.mjs');
const CWD = mkdtempSync(join(tmpdir(), 'oikos-git-guard-'));
process.on('exit', () => rmSync(CWD, { recursive: true, force: true }));

/** The guard's decision and reason for one shell command in a permission mode, run from `cwd` with `env` added. */
function guard(command, permission_mode = 'default', { cwd = CWD, env = {} } = {}) {
  const r = spawnSync(process.execPath, [HOOK, 'git-guard'], {
    cwd: CORE,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'git-guard-test', cwd, permission_mode, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  const answer = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return answer?.hookSpecificOutput?.permissionDecision ?? null;
}

// The terms file names a word the core's tracked files hold, so a commit in the core is refused by the
// leak check and a commit anywhere else is not; nothing is committed, the check only reads the index.
const TERMS = join(CWD, 'private-terms');
writeFileSync(TERMS, 'oikos\n');
const LEAKY = { OIKOS_PRIVATE_TERMS: TERMS };

test('the commit leak check follows the repository a call works in: -C, --git-dir, --work-tree, GIT_DIR, GIT_WORK_TREE and a cd (F15)', () => {
  const outside = { cwd: CWD, env: LEAKY };
  for (const command of [
    `git -C ${CORE} commit -m x`,
    `git -C ${CORE}/tools -C .. commit -m x`,
    `git --git-dir=${CORE}/.git commit -m x`,
    `git --git-dir ${CORE}/.git --work-tree ${CORE} commit -m x`,
    `git --work-tree=${CORE} commit -m x`,
    `GIT_DIR=${CORE}/.git git commit -m x`,
    `GIT_WORK_TREE=${CORE} git commit -m x`,
    `export GIT_DIR=${CORE}/.git; git commit -m x`,
    `cd ${CORE} && git commit -m x`,
    `cd ${CORE}; git status; git commit -m x`,
  ]) assert.equal(guard(command, 'default', outside), 'deny', command);
  assert.equal(guard('git commit -m x', 'default', { cwd: CORE, env: LEAKY }), 'deny', 'the session folder is the core');
  for (const command of [
    'git commit -m x',
    `git -C ${CWD} commit -m x`,
    `git --git-dir=${CWD}/.git commit -m x`,
    `GIT_DIR=${CWD}/.git git commit -m x`,
    `git -C ${CORE} status`,
    `git -C ${CORE} log -1`,
  ]) assert.equal(guard(command, 'default', outside), null, command);
  assert.equal(guard(`git -C ${CWD} commit -m x`, 'default', { cwd: CORE, env: LEAKY }), null, 'run from the core, aimed elsewhere');
});

test('git -C does not hide staging everything, and the subcommand is found past git\'s own options', () => {
  assert.equal(guard('git -C somewhere add -A'), 'deny');
  assert.equal(guard('git --git-dir=x -c a=b commit -a -m x'), 'deny');
  assert.equal(guard('git -C somewhere --no-pager push'), 'ask');
  assert.equal(guard('GIT_DIR=x git push'), 'ask');
  assert.equal(guard('git -C somewhere add file.txt'), null);
});

test('a git push inside a loop or an if is judged as a plain git push', () => {
  for (const mode of ['default', 'auto']) {
    const plain = guard('git push', mode);
    assert.equal(plain, mode === 'default' ? 'ask' : 'deny');
    for (const command of ['for b in x; do git push; done', 'if true; then git push; fi']) {
      assert.equal(guard(command, mode), plain, `${command} (${mode})`);
    }
  }
});

test('a wrapper does not hide the landing ask or the staging rule: timeout, nice, command -p, env -S and xargs before git', () => {
  for (const command of [
    'timeout 60 git push', 'timeout -s KILL 60 git push', 'nice git push', 'nice -n 5 git push', 'ionice -c 3 git push', 'command -p git push', 'env -S "git push"',
    'xargs git push', 'setsid git push', 'stdbuf -oL git push', 'flock /tmp/x git push', 'time -p git push', 'timeout 5 nice env X=1 git push',
  ]) assert.equal(guard(command), 'ask', command);
  for (const command of ['timeout 30 git add -A', 'nice git add .', 'env -S "git commit -a -m x"', 'xargs git add --all']) assert.equal(guard(command), 'deny', command);
  for (const command of ['timeout 5 npm test', 'nice rg x', 'timeout 30 git status', 'command -v git', 'xargs echo']) assert.equal(guard(command), null, command);
  assert.equal(guard('timeout 60 git push', 'auto'), 'deny', 'outside the default mode the ask is a deny');
});

test('the commit leak check follows the repository through a wrapper, a variable and a cd', () => {
  const outside = { cwd: CWD, env: LEAKY };
  for (const command of [`timeout 30 git -C ${CORE} commit -m x`, `nice git -C ${CORE} commit -m x`, `env -S "git -C ${CORE} commit -m x"`, `V=${CORE}; git -C $V commit -m x`, `cd $HOME && git -C ${CORE} commit -m x`]) {
    assert.equal(guard(command, 'default', outside), 'deny', command);
  }
  assert.equal(guard(`timeout 30 git -C ${CWD} commit -m x`, 'default', outside), null);
});

/** The whole answer the guard gave to `command`: its decision and reason, and the dispatcher's own message when it failed open (nulls when it said nothing). */
function answer(command, { cwd = CWD, env = {} } = {}) {
  const r = spawnSync(process.execPath, [HOOK, 'git-guard'], {
    cwd: CORE,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'git-guard-test', cwd, permission_mode: 'default', tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()) : {};
  return { decision: out.hookSpecificOutput?.permissionDecision ?? null, reason: out.hookSpecificOutput?.permissionDecisionReason ?? null, message: out.systemMessage ?? null };
}

// A term with a NUL byte cannot be passed to `git grep`, so the leak check throws instead of answering.
const BROKEN_TERMS = join(CWD, 'broken-terms');
writeFileSync(BROKEN_TERMS, 'oikos\0x\n');

test('the git guard fails closed on its commit rule: a check that throws (the leak check cannot run git grep) denies, naming the check and the error, and the privilege rule still decides', () => {
  const broken = { cwd: CWD, env: { OIKOS_PRIVATE_TERMS: BROKEN_TERMS } };
  const commit = answer(`git -C ${CORE} commit -m x`, broken);
  assert.equal(commit.decision, 'deny');
  assert.equal(commit.message, null, 'no failure was left for the dispatcher to fail open on');
  assert.match(commit.reason, /^oikos git guard: the staging and commit rules could not run on `git -C .* commit -m x` \(.+\), so the call is denied instead of let through unchecked/);
  assert.match(answer(`git -C ${CORE} commit -m x`, { cwd: CWD, env: LEAKY }).reason, /the oikos core is public/, 'the same commit with a working git is refused for the leak');
  assert.match(answer(`git -C ${CORE} commit -m x; sudo ls`, broken).reason, /sudo is not run by the agent/);
  assert.match(answer(`sudo ls; git -C ${CORE} commit -m x`, broken).reason, /sudo is not run by the agent/);
  assert.equal(answer('git status', broken).decision, null);
});
