// The secret guard (npm test): what it closes in an installation's `.local/` (ADR 0002). The hook is
// driven as a host drives it — `host-hook.mjs secret-guard` with the event payload on stdin — and
// the paths are those of a temporary installation, built here and never read: the guard decides
// by name, so no store has to exist. The moves of the old stores (common/local-stores.mjs) run on
// temporary folders. Nothing here reaches the network or starts a Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';
import { globNamesSecret, isLocalStore } from '../tools/hooks/host.mjs';
import { moveLocalStores } from '../tools/common/local-stores.mjs';
import { chromeRunning } from '../tools/browser/cli.mjs';

const CORE = realpathSync(CORE_ROOT);
const HOOK = join(CORE, 'tools', 'hooks', 'host-hook.mjs');
const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'oikos-secret-'));
  made.push(dir);
  return dir;
};

/** The installation the payloads name; nothing is created under its `.local/`. */
const ROOT = join(temp(), 'acme');
mkdirSync(ROOT);
const LOCAL = join(ROOT, '.local');
const at = (...parts) => join(LOCAL, ...parts);

/** The guard's answer to one tool call made from `cwd` (the installation by default). */
function guard(toolName, toolInput, cwd = ROOT) {
  const r = spawnSync(process.execPath, [HOOK, 'secret-guard'], {
    cwd: CORE,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'secret-guard-test', cwd, permission_mode: 'default', tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const denied = (answer) => answer?.hookSpecificOutput?.permissionDecision === 'deny';
const assertDenied = (tool, input, cwd) => assert.ok(denied(guard(tool, input, cwd)), `${tool} ${JSON.stringify(input)} should be denied`);
const assertPassed = (tool, input, cwd) => assert.equal(guard(tool, input, cwd), null, `${tool} ${JSON.stringify(input)} should pass`);

const TOKEN = at('.secrets', 'google', 'token.json');

test('a dot-named store under .local/ is closed to every file tool', () => {
  assertDenied('Read', { file_path: TOKEN });
  assertDenied('Read', { file_path: at('.browser', 'chrome-profile', 'Default', 'Cookies') });
  assertDenied('Grep', { pattern: 'x', path: at('.browser') });
  assertDenied('Glob', { pattern: '**/*.json', path: at('.secrets') });
  assertDenied('Edit', { file_path: TOKEN, old_string: 'a', new_string: 'b' });
  assertDenied('Write', { file_path: at('.browser', 'launch.json'), content: '{}' });
  assertDenied('MultiEdit', { file_path: TOKEN, edits: [{ file_path: TOKEN, old_string: 'a', new_string: 'b' }] });
  assertDenied('read_file', { file_path: TOKEN });
  assertDenied('write_file', { file_path: at('.anything-new', 'x') });
});

test('a relative path is judged as written and from the session folder', () => {
  assertDenied('Read', { file_path: '.local/.secrets/google/token.json' });
  assertDenied('Read', { file_path: '.secrets/google/token.json' }, LOCAL);
  assertDenied('Read', { file_path: '../.browser/launch.json' }, at('cv'));
  assertDenied('Read', { file_path: '.local/cv/../.secrets/google/token.json' });
  assertPassed('Read', { file_path: 'TASK.md' }, at('cv'));
});

test('a dot-named store is closed as a shell argument', () => {
  assertDenied('Bash', { command: `cat ${TOKEN}` });
  assertDenied('Bash', { command: 'cat .local/.secrets/google/token.json' });
  assertDenied('Bash', { command: 'grep -r x .local/.browser' });
  assertDenied('run_shell_command', { command: `cp ${at('.browser', 'launch.json')} /tmp/x` });
  assertDenied('Bash', { command: `grep -r x --include='.local/.secrets/*' .` });
});

test('working material under .local/ is open, a file or a folder', () => {
  const task = at('cv', 'TASK.md');
  assertPassed('Read', { file_path: task });
  assertPassed('Edit', { file_path: task, old_string: 'a', new_string: 'b' });
  assertPassed('Write', { file_path: task, content: 'draft' });
  assertPassed('Bash', { command: `cat ${task}` });
  assertPassed('Bash', { command: 'cat .local/cv/TASK.md' });
  assertPassed('Read', { file_path: at('TASKS.md') });
  assertPassed('Read', { file_path: at('catalog.yaml') });
  assertPassed('Grep', { pattern: 'x', path: at('cv') });
  assertPassed('Glob', { pattern: '.local/cv/**' });
  assertPassed('Grep', { pattern: 'x', path: ROOT, glob: '.local/cv/*.md' });
  assertPassed('Bash', { command: `grep -r x --include='.local/cv/*' .` });
});

test('the legacy stores stay closed by name', () => {
  assertDenied('Read', { file_path: at('browser', 'chrome-profile', 'Default', 'Cookies') });
  assertDenied('Read', { file_path: at('google', 'token.json') });
  assertDenied('Edit', { file_path: at('browser', 'launch.json'), old_string: 'a', new_string: 'b' });
  assertDenied('Bash', { command: 'cat .local/browser/Default/Cookies' });
  assertDenied('Bash', { command: 'cat .local/google/token.json' });
  assertDenied('Glob', { pattern: '.local/google/*' });
});

test('a scope over .local/ as a whole is closed', () => {
  for (const path of [LOCAL, `${LOCAL}/`, '.local', '.local/']) assertDenied('Grep', { pattern: 'x', path });
  assertDenied('Grep', { pattern: 'x', path: '..' }, at('cv'));
  for (const pattern of ['.local/**', '.local/*', '.local', '.local*', '{.local,src}/**', '.local/.b*', '**/.local/{cv,x}/*']) {
    assertDenied('Glob', { pattern });
  }
  assertDenied('Grep', { pattern: 'x', glob: '.local/**' });
  assertDenied('Bash', { command: 'grep -r x .local' });
  assertDenied('Bash', { command: 'grep -r x --include=.local/** .' });
  assertDenied('Bash', { command: 'rg x --glob .local/* .' });
  assertPassed('Bash', { command: 'grep -r x --exclude=.local/** .' });
});

test('a .env file is closed at any depth, a template is open', () => {
  assertDenied('Read', { file_path: at('.env') });
  assertDenied('Read', { file_path: join(ROOT, 'service', '.env.local') });
  assertDenied('Bash', { command: 'cat service/.env' });
  assertDenied('Glob', { pattern: '**/.env*' });
  assertPassed('Read', { file_path: join(ROOT, '.env.example') });
  assertPassed('Bash', { command: 'cat service/.env.example' });
});

test('the command after a control word is the command judged: a loop body like the plain command', () => {
  assertDenied('Bash', { command: 'cat .local/.env' });
  assertDenied('Bash', { command: 'for f in a; do cat .local/.env; done' });
});

test('ls and stat of .local/ stay open', () => {
  assertPassed('Bash', { command: 'ls .local' });
  assertPassed('Bash', { command: `ls -la ${at('.secrets')}` });
  assertPassed('Bash', { command: `stat ${at('.browser')}` });
});

test('the predicates decide by name, whether or not the entry exists', () => {
  assert.equal(isLocalStore(at('.secrets', 'none'), ROOT), true);
  assert.equal(isLocalStore(at('notes', 'none'), ROOT), false);
  assert.equal(isLocalStore(join(ROOT, 'resources', 'x.md'), ROOT), false);
  assert.equal(globNamesSecret('.local/cv/**'), false);
  assert.equal(globNamesSecret('.local\\.secrets\\**'), true);
});

/** An installation folder with the old stores in `.local/`, each holding one file. */
function oldStores() {
  const root = temp();
  mkdirSync(join(root, '.local', 'google'), { recursive: true });
  writeFileSync(join(root, '.local', 'google', 'token.json'), '{"token":"fake"}\n');
  mkdirSync(join(root, '.local', 'browser', 'chrome-profile'), { recursive: true });
  writeFileSync(join(root, '.local', 'browser', 'launch.json'), '{}\n');
  return root;
}

test('sync moves the old stores to their dot-named places', async () => {
  const root = oldStores();
  const moves = await moveLocalStores(root, { browserRunning: async () => false });
  assert.deepEqual(moves.map((m) => [m.store, m.state]), [['google', 'moved'], ['browser', 'moved']]);
  assert.equal(readFileSync(join(root, '.local', '.secrets', 'google', 'token.json'), 'utf8'), '{"token":"fake"}\n');
  assert.ok(existsSync(join(root, '.local', '.browser', 'chrome-profile')));
  assert.ok(existsSync(join(root, '.local', '.browser', 'launch.json')));
  assert.ok(!existsSync(join(root, '.local', 'google')));
  assert.ok(!existsSync(join(root, '.local', 'browser')));
  assert.deepEqual(await moveLocalStores(root, { browserRunning: async () => false }), [], 'nothing left to move');
});

test('the browser profile is not moved while its Chrome runs; the Google sign-in is', async () => {
  const root = oldStores();
  const moves = await moveLocalStores(root, { browserRunning: async () => true });
  assert.deepEqual(moves.map((m) => [m.store, m.state]), [['google', 'moved'], ['browser', 'running']]);
  assert.ok(existsSync(join(root, '.local', 'browser', 'launch.json')));
  assert.ok(!existsSync(join(root, '.local', '.browser')));
});

test('a check moves nothing and never asks about Chrome', async () => {
  const root = oldStores();
  const moves = await moveLocalStores(root, { check: true, browserRunning: async () => assert.fail('asked') });
  assert.deepEqual(moves.map((m) => m.state), ['out of date', 'out of date']);
  assert.ok(existsSync(join(root, '.local', 'google', 'token.json')));
  assert.ok(!existsSync(join(root, '.local', '.secrets')));
});

test('an old store is left when its new place exists too', async () => {
  const root = oldStores();
  mkdirSync(join(root, '.local', '.secrets', 'google'), { recursive: true });
  const moves = await moveLocalStores(root, { browserRunning: async () => false });
  assert.deepEqual(moves.map((m) => [m.store, m.state]), [['google', 'both'], ['browser', 'moved']]);
  assert.ok(existsSync(join(root, '.local', 'google', 'token.json')));
});

test('without a way to tell whether Chrome runs, the browser profile is not moved', async () => {
  const root = oldStores();
  const moves = await moveLocalStores(root);
  assert.equal(moves.find((m) => m.store === 'browser').state, 'running');
});

test('the tools use a store at its new place, and at its old one until it is moved', () => {
  const root = temp();
  writeFileSync(join(root, 'oikos.yaml'), 'organization:\n  name: ACME Corp\n');
  const script = `import { googleDir } from ${JSON.stringify(new URL('../tools/google/auth.mjs', import.meta.url).href)};
import { profileBase } from ${JSON.stringify(new URL('../tools/browser/cli.mjs', import.meta.url).href)};
console.log(JSON.stringify([googleDir(), profileBase()]));`;
  const places = () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, OIKOS_HOME: root } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const local = join(root, '.local');
  assert.deepEqual(places(), [join(local, '.secrets', 'google'), join(local, '.browser', 'chrome-profile')], 'a new installation');
  mkdirSync(join(local, 'google'), { recursive: true });
  mkdirSync(join(local, 'browser'));
  assert.deepEqual(places(), [join(local, 'google'), join(local, 'browser', 'chrome-profile')], 'not moved yet');
  mkdirSync(join(local, '.secrets', 'google'), { recursive: true });
  mkdirSync(join(local, '.browser'));
  assert.deepEqual(places(), [join(local, '.secrets', 'google'), join(local, '.browser', 'chrome-profile')], 'the new place wins');
});

test('a cd earlier in the command moves where a relative argument points', () => {
  assertDenied('Bash', { command: 'cd .local/cv && grep -r x ..' });
  assertDenied('Bash', { command: 'cd .local/cv && cat ../browser/Default/Cookies' });
  assertDenied('Bash', { command: 'pushd .local/cv; cat ../.secrets/google/token.json' });
  assertDenied('Bash', { command: 'cd .local && cd cv && cat ../.browser/launch.json' });
  assertDenied('Bash', { command: `cd ${at('cv')} && grep -r x ../` });
  assertPassed('Bash', { command: 'cd .local/cv && cat TASK.md ../TASKS.md' });
  assertPassed('Bash', { command: 'cd src && grep -r x ..' });
});

test('after a cd that cannot be read, or a subshell, the session folder still decides', () => {
  assertDenied('Bash', { command: '(cd /tmp); cat .secrets/google/token.json' }, LOCAL);
  assertDenied('Bash', { command: 'cd && cat .secrets/google/token.json' }, LOCAL);
  assertDenied('Bash', { command: 'cd - && cat ../.browser/launch.json' }, at('cv'));
  assertDenied('Bash', { command: 'cd "$DIR" && grep -r x ..' }, at('cv'));
  assertPassed('Bash', { command: 'cd ~ && cat notes.md' }, at('cv'));
});

test('the legacy names are closed in any case', () => {
  assertDenied('Read', { file_path: at('Browser', 'Default', 'Cookies') });
  assertDenied('Read', { file_path: at('GOOGLE', 'token.json') });
  assertDenied('Bash', { command: 'cat .local/Google/token.json' });
  assertDenied('Glob', { pattern: '.local/BROWSER/**' });
});

test('. and .. are resolved before the first name under .local/ is judged', () => {
  assertPassed('Read', { file_path: '.local/./TASKS.md' });
  assertPassed('Bash', { command: 'cat .local/../README.md' });
  assertPassed('Read', { file_path: at('.', 'cv', 'TASK.md') });
  assertDenied('Read', { file_path: '.local/./.secrets/google/token.json' });
  assertDenied('Read', { file_path: '.local/../.local/.browser/launch.json' });
  assertDenied('Bash', { command: 'cat .local/cv/../google/token.json' });
  assertDenied('Grep', { pattern: 'x', path: '.local/.' });
  assertDenied('Glob', { pattern: '.local/./**' });
});

test('a store that cannot be moved is reported, and the others still move', async () => {
  const root = oldStores();
  writeFileSync(join(root, '.local', '.secrets'), 'a file where the folder goes\n');
  const moves = await moveLocalStores(root, { browserRunning: async () => false });
  const google = moves.find((m) => m.store === 'google');
  assert.equal(google.state, 'failed');
  assert.match(google.error, /^E[A-Z]+: /);
  assert.ok(existsSync(join(root, '.local', 'google', 'token.json')), 'the store stays where it was');
  assert.equal(moves.find((m) => m.store === 'browser').state, 'moved');
});

test('a Chrome check that throws counts as running', async () => {
  const root = oldStores();
  const moves = await moveLocalStores(root, { browserRunning: async () => { throw new Error('no PowerShell'); } });
  assert.equal(moves.find((m) => m.store === 'browser').state, 'running');
});

test('chromeRunning: the port, the ports launch.json recorded, the profile processes', async () => {
  const root = '/home/user/work/acme';
  const none = () => false;
  const answers = (byPort) => async (port) => byPort[port] ?? null;
  const ask = (options) => chromeRunning({ root, port: 9399, launches: [], profileInUse: none, check: answers({}), ...options });
  assert.equal(await ask({}), false, 'nothing anywhere');
  assert.equal(await ask({ check: answers({ 9399: { owner: { owner: 'ours' } } }) }), true);
  assert.equal(await ask({ check: answers({ 9399: { owner: { owner: 'unknown' } } }) }), true, 'whose it is not known');
  assert.equal(await ask({ check: answers({ 9399: { owner: { owner: 'foreign' } } }) }), false, 'another installation\'s');
  const launches = [{ port: 9222, profile: `${root}/.local/browser/chrome-profile`, exe: '/opt/google/chrome/chrome' }];
  assert.equal(await ask({ launches, check: answers({ 9222: { owner: { owner: 'ours' } } }) }), true, 'the port of the last start');
  let asked = null;
  const seen = (profiles, options) => { asked = { profiles, options }; return true; };
  assert.equal(await ask({ launches, profileInUse: seen }), true, 'a process with the profile');
  assert.ok(asked.profiles.includes(`${root}/.local/browser/chrome-profile`));
  assert.ok(asked.profiles.includes(`${root}/.local/browser/chrome-profile-project`));
  assert.ok(asked.profiles.includes(`${root}/.local/.browser/chrome-profile`));
  assert.equal(asked.options.windows, process.platform === 'win32');
});

