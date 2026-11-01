// The hook dispatcher (tools/hooks/host-hook.mjs) when a guard cannot do its job — owner decision
// D-HOOK-LOAD-FAILURE: a guard that does not load, throws, hangs or runs out of time must not turn into
// "allowed". The dispatcher then answers by its fallback rules, once. The broken guards live in a sandbox:
// a copy of tools/hooks and tools/common under a temporary folder, with the one guard replaced, so that the
// dispatcher finds its guards next to itself, as in production — no variable, no argument moves it to a
// guard elsewhere. The sandbox dispatcher's deadline is shortened by editing the copy, never by a setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE, cleanEnv, tempDir } from './helpers/installation.mjs';
import { EDIT_TOOLS, SHELL_TOOLS } from '../tools/hooks/host.mjs';
import { HOOK_TIMEOUT_SECONDS, WIRING, hooksFor, hostNames, oikosPart, settingsFile } from '../tools/hooks/wiring.mjs';

const ENTRY = join(CORE, 'tools', 'hooks', 'host-hook.mjs');
const decision = (answer) => answer?.hookSpecificOutput?.permissionDecision;

/**
 * A sandbox of the hook code: the dispatcher (with `deadlineMs`, when given) and the guards of the core, with
 * `replace` (a file of tools/hooks → its new source) put over them. Returns the path of its dispatcher.
 */
function sandbox(replace = {}, deadlineMs = null) {
  const dir = tempDir('hooks-');
  for (const folder of ['hooks', 'common']) cpSync(join(CORE, 'tools', folder), join(dir, 'tools', folder), { recursive: true });
  cpSync(join(CORE, 'package.json'), join(dir, 'package.json'));
  symlinkSync(join(CORE, 'node_modules'), join(dir, 'node_modules'), 'dir');
  for (const [file, source] of Object.entries(replace)) writeFileSync(join(dir, 'tools', 'hooks', file), source);
  const entry = join(dir, 'tools', 'hooks', 'host-hook.mjs');
  if (deadlineMs !== null) {
    const text = readFileSync(entry, 'utf8');
    const patched = text.replace(/const DEADLINE_MS = [\d_]+;/, `const DEADLINE_MS = ${deadlineMs};`);
    assert.notEqual(patched, text, 'the dispatcher declares its deadline as `const DEADLINE_MS = <number>;`');
    writeFileSync(entry, patched);
  }
  return { dir, entry };
}

/** Runs a dispatcher; the lines it printed, parsed, and how long it took. */
function dispatch(entry, guard, payload, { cwd, env } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [entry, guard], {
    cwd: cwd ?? CORE,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: cleanEnv({ CLAUDE_PROJECT_DIR: cwd ?? CORE, ...env }),
  });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { status: r.status, lines, answer: lines.length ? JSON.parse(lines.at(-1)) : undefined, ms: Date.now() - started, stderr: r.stderr };
}

const pre = (tool, input) => ({ hook_event_name: 'PreToolUse', tool_name: tool, cwd: CORE, tool_input: input });
const shell = (command, tool = 'Bash') => pre(tool, { command });
const file = (tool) => pre(tool, { file_path: join(CORE, 'x.md'), content: 'x', old_string: 'a', new_string: 'b' });

/** The ways a guard can fail to load or run: each source replaces tools/hooks/git-guard.mjs. */
const BROKEN = {
  'a syntax error': 'export function run( {',
  'a throw at the top level': "throw new Error('boom at load');\nexport function run() {}",
  'a dependency that is missing': "import './no-such-module.mjs';\nexport function run() {}",
  'a run() that throws': "export function run() { throw new Error('boom in run'); }",
  'no run() at all': 'export const something = 1;',
};

const DENIED = ['sudo ls', 'doas ls', 'su -', 'pkexec x', '/usr/bin/sudo ls', 'git push origin main', 'git -C x commit -m x',
  'git add a.txt', 'git reset --hard', 'git checkout main', 'echo x > f', 'echo x >> f', 'cat a >f', 'ls &> out', 'echo x 2> err.log'];
const ALLOWED = ['ls', 'git status', 'git log --oneline', 'cat a > /dev/null', 'ls 2>&1', 'ls >/dev/null 2>&1', 'echo sudoku', 'ls surname', 'echo x > /dev/stderr'];

/** Runs each command through the dispatcher whose git-guard is `source`; asserts the fallback's answer, once. */
function assertFallback(source, denied, allowed) {
  const { entry } = sandbox({ 'git-guard.mjs': source });
  for (const command of denied) {
    const r = dispatch(entry, 'git-guard', shell(command));
    assert.equal(r.status, 0);
    assert.equal(r.lines.length, 1, `one answer for ${command}: ${r.lines.join(' | ')}`);
    assert.equal(decision(r.answer), 'deny', command);
    assert.match(r.answer.hookSpecificOutput.permissionDecisionReason, /git-guard failed .*fallback rules decided/s, command);
  }
  for (const command of allowed) {
    const r = dispatch(entry, 'git-guard', shell(command));
    assert.equal(r.lines.length, 1, command);
    assert.equal(decision(r.answer), undefined, `${command} is allowed`);
    assert.match(r.answer.systemMessage, /git-guard failed/, `${command} still says the hook failed`);
  }
}

for (const [what, source] of Object.entries(BROKEN)) {
  test(`a guard with ${what}: the fallback rules decide, once`, () => {
    assertFallback(source, ['sudo ls', 'git push origin main', 'echo x > f'], ['ls']);
  });
}

test('the fallback rules: privilege, git writes and redirections are denied, reads and look-alikes are not', () => {
  assertFallback(BROKEN['a throw at the top level'], DENIED, ALLOWED);
});

test('the fallback sees through quoting, escapes, variables and every git call that is not a read (D-AUDIT6-FALLBACK)', () => {
  assertFallback(BROKEN['a throw at the top level'], [
    'g\\it commit -m x', "g''it commit", '"g"it commit', 'git co""mmit', 'git c\\ommit', "$'git' commit", "$'g\\x69t' commit",
    'X=git; $X commit', '${X} commit', 'FOO=1 $X push', 'ls && $X x',
    'git pull', 'git cherry-pick abc', 'git am p.patch', 'git stash', 'git revert HEAD', 'git apply p.diff', 'git update-ref -d refs/heads/x',
    'git branch -D x', 'git fetch origin a:b', 'git gc', 'git -c core.x=y push', 'git --no-pager commit', 'cd x && git commit',
    's\\udo ls', 'run0 ls', 'sudoedit /etc/x', '"su"do ls',
  ], ['git status', 'git log -1', 'git -C x diff', 'git --no-pager log', 'ls', 'cat x', 'echo sudoku', 'cat .gitignore', 'git']);
});

test('the fallback denies any variable expansion and any --output option; `echo $HOME` is now denied there on purpose (D-AUDIT6B-FALLBACK, L2)', () => {
  assertFallback(BROKEN['a throw at the top level'], [
    'G=git; { $G commit -m x; }', 'G=git; if $G commit; then ls; fi', 'G=git; ! $G commit', 'G=git; time $G commit', 'G=git; exec $G commit',
    'G=git; command $G commit', 'G=git; env $G commit', 'echo x | xargs $G commit', 'echo $HOME', 'echo ${HOME}',
    'git log --output=out.txt', 'git diff --output out.txt', 'git show --output=x',
  ], ['git log --oneline', 'echo "a $ b"', 'git log --output-indicator-new=+', 'ls']);
});

test('a guard killed by a signal the dispatcher did not send: no shell command and no file write, reads stay (D-AUDIT6-FALLBACK)', () => {
  const { entry } = sandbox({ 'git-guard.mjs': "export function run() { process.kill(process.pid, 'SIGKILL'); }" });
  for (const command of ['ls', 'git status', 'echo hi']) {
    const r = dispatch(entry, 'git-guard', shell(command));
    assert.equal(r.lines.length, 1, command);
    assert.equal(decision(r.answer), 'deny', command);
    assert.match(r.answer.hookSpecificOutput.permissionDecisionReason, /did not finish/, command);
  }
  assert.equal(decision(dispatch(entry, 'git-guard', file('Write')).answer), 'deny');
  assert.equal(decision(dispatch(entry, 'git-guard', file('Read')).answer), undefined);
});

test('a fallback names the failure of the guard in the reason', () => {
  const { entry } = sandbox({ 'git-guard.mjs': BROKEN['a throw at the top level'] });
  const r = dispatch(entry, 'git-guard', shell('sudo ls'));
  assert.match(r.answer.hookSpecificOutput.permissionDecisionReason, /boom at load/);
});

test('every spelling of the shell and file tools of the hosts is judged by the fallback', () => {
  const { entry } = sandbox({ 'git-guard.mjs': BROKEN['a throw at the top level'] });
  for (const tool of SHELL_TOOLS) {
    assert.equal(decision(dispatch(entry, 'git-guard', shell('sudo ls', tool)).answer), 'deny', tool);
    assert.equal(decision(dispatch(entry, 'git-guard', shell('echo x > f', tool)).answer), 'deny', tool);
    assert.equal(decision(dispatch(entry, 'git-guard', shell('ls', tool)).answer), undefined, tool);
  }
  for (const tool of [...EDIT_TOOLS, 'replace']) {
    assert.equal(decision(dispatch(entry, 'git-guard', file(tool)).answer), 'deny', `${tool} writes`);
  }
  for (const tool of ['Read', 'Grep', 'Glob', 'read_file', 'grep_search', 'glob', 'list_directory']) {
    const r = dispatch(entry, 'git-guard', file(tool));
    assert.equal(decision(r.answer), undefined, `${tool} reads`);
    assert.equal(r.lines.length, 1);
  }
});

test('a guard name the table does not wire, or a table that cannot load, is a failure of the guard too', () => {
  const { entry } = sandbox({ 'wiring.mjs': 'export const WIRING = (' });
  const r = dispatch(entry, 'git-guard', shell('sudo ls'));
  assert.equal(decision(r.answer), 'deny', 'wiring.mjs does not load');
  assert.equal(decision(dispatch(entry, 'git-guard', shell('ls')).answer), undefined);
  const real = sandbox();
  for (const name of ['no-such-guard', 'leaks', '../common/paths', '']) {
    const answer = dispatch(real.entry, name, shell('sudo ls'));
    assert.equal(answer.lines.length, 1, name);
    assert.equal(decision(answer.answer), 'deny', `"${name}" is no guard: the fallback decides`);
  }
});

test('a failure on an event other than PreToolUse is a message, never a decision', () => {
  const { entry } = sandbox({ 'session-start.mjs': BROKEN['a run() that throws'], 'context-pressure.mjs': BROKEN['a run() that throws'] });
  for (const [guard, event] of [['session-start', 'SessionStart'], ['context-pressure', 'UserPromptSubmit'], ['context-pressure', 'PostToolUse']]) {
    const r = dispatch(entry, guard, { hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'sudo ls' } });
    assert.equal(r.lines.length, 1, event);
    assert.equal(r.answer.hookSpecificOutput, undefined, event);
    assert.match(r.answer.systemMessage, new RegExp(`${guard} failed`), event);
  }
});

test('a guard that loops forever is stopped at the deadline and the fallback denies, well before the host would', () => {
  const { entry } = sandbox({ 'git-guard.mjs': 'export function run() { for (;;); }' }, 1500);
  for (const command of ['ls', 'sudo ls']) {
    const r = dispatch(entry, 'git-guard', shell(command));
    assert.equal(r.lines.length, 1);
    assert.equal(decision(r.answer), 'deny', `${command}: a shell command whose check did not finish is not run`);
    assert.match(r.answer.hookSpecificOutput.permissionDecisionReason, /did not answer within/);
    assert.ok(r.ms < 6000, `answered in ${r.ms} ms`);
  }
  assert.equal(decision(dispatch(entry, 'git-guard', file('Write')).answer), 'deny', 'a write');
  const read = dispatch(entry, 'git-guard', file('Read'));
  assert.equal(decision(read.answer), undefined, 'a read');
  assert.match(read.answer.systemMessage, /did not answer within/);
});

test('a guard blocked in a synchronous call is killed with what it started, and the dispatcher still answers in time', () => {
  const source = "import { spawnSync } from 'node:child_process';\nexport function run() { spawnSync('sleep', ['30']); }";
  const { entry } = sandbox({ 'git-guard.mjs': source }, 1500);
  const r = dispatch(entry, 'git-guard', shell('ls'));
  assert.equal(decision(r.answer), 'deny');
  assert.ok(r.ms < 6000, `answered in ${r.ms} ms`);
});

test('a denial the guard printed before it failed stands, and nothing else is printed', () => {
  const printed = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'the guard said no' } });
  const { entry } = sandbox({ 'git-guard.mjs': `export function run() { process.stdout.write(${JSON.stringify(`${printed}\n`)}); for (;;); }` }, 1500);
  const r = dispatch(entry, 'git-guard', shell('ls'));
  assert.equal(r.lines.length, 1);
  assert.equal(r.answer.hookSpecificOutput.permissionDecisionReason, 'the guard said no');
  // an answer that is not a denial does not survive the failure: the fallback decides
  const soft = JSON.stringify({ systemMessage: 'half an answer' });
  const { entry: entry2 } = sandbox({ 'git-guard.mjs': `export function run() { process.stdout.write(${JSON.stringify(`${soft}\n`)}); throw new Error('late'); }` });
  const r2 = dispatch(entry2, 'git-guard', shell('sudo ls'));
  assert.equal(r2.lines.length, 1);
  assert.equal(decision(r2.answer), 'deny');
});

test('the normal path is unchanged: the guard\'s own answer, printed once, and silence when it has none', () => {
  const ask = dispatch(ENTRY, 'git-guard', shell('git push origin main'));
  assert.equal(ask.status, 0);
  assert.equal(ask.lines.length, 1, ask.lines.join(' | '));
  assert.equal(decision(ask.answer), 'ask');
  assert.match(ask.answer.hookSpecificOutput.permissionDecisionReason, /oikos git guard/);
  const deny = dispatch(ENTRY, 'git-guard', shell('sudo ls'));
  assert.equal(deny.lines.length, 1);
  assert.match(deny.answer.hookSpecificOutput.permissionDecisionReason, /^oikos git guard: sudo/);
  const quiet = dispatch(ENTRY, 'git-guard', shell('ls'));
  assert.deepEqual(quiet.lines, []);
  assert.equal(quiet.status, 0);
  // an unreadable payload is an empty one
  const r = spawnSync(process.execPath, [ENTRY, 'git-guard'], { cwd: CORE, input: 'not json', encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: CORE }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('the unmodified sandbox answers as the core does (the copies are faithful)', () => {
  const { entry } = sandbox();
  assert.equal(decision(dispatch(entry, 'git-guard', shell('git push origin main')).answer), 'ask');
});

test('every wired hook carries a timeout, and the dispatcher\'s deadline is well under it', () => {
  const source = readFileSync(ENTRY, 'utf8');
  const deadline = Number(/const DEADLINE_MS = ([\d_]+);/.exec(source)?.[1].replace(/_/g, ''));
  assert.ok(deadline > 0, 'the dispatcher declares DEADLINE_MS');
  assert.ok(deadline <= HOOK_TIMEOUT_SECONDS * 1000 * 0.75, `deadline ${deadline} ms against timeout ${HOOK_TIMEOUT_SECONDS} s`);
  for (const host of hostNames) {
    const commands = Object.values(hooksFor(host)).flatMap((groups) => groups.flatMap((g) => g.hooks));
    assert.equal(commands.length, WIRING.length);
    for (const command of commands) assert.equal(command.timeout, HOOK_TIMEOUT_SECONDS, `${host}: ${command.command}`);
  }
});

test('the core\'s own generated settings carry the timeout on every oikos hook (sync --check compares guards, not this)', () => {
  for (const host of hostNames) {
    const settings = JSON.parse(readFileSync(join(CORE, settingsFile(host)), 'utf8'));
    const commands = Object.values(oikosPart(settings.hooks)).flatMap((groups) => groups.flatMap((g) => g.hooks));
    assert.equal(commands.length, WIRING.length, host);
    for (const command of commands) assert.equal(command.timeout, HOOK_TIMEOUT_SECONDS, `${host}: ${command.command} — run \`npm run sync\``);
  }
});

test('the dispatcher imports nothing of oikos at its top level', () => {
  const imports = readFileSync(ENTRY, 'utf8').split('\n').filter((line) => /^import /.test(line));
  assert.ok(imports.length > 0);
  for (const line of imports) assert.match(line, /from 'node:/, line);
});
