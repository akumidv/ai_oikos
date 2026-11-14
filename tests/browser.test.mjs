// The shared browser is akmon's (ADR 0009); oikos wraps it (npm test). What is oikos's is tested here:
// the mapping of the installation's settings to `AKMON_BROWSER_*`, the pass-through of the CLI and
// of the MCP launcher to a fake akmon tool (a script in a temporary folder: no Chrome, no npx, no
// network, never the real akmon path), the error for a tool that is not there, the one running-Chrome
// check sync keeps, and sync's migration of the wiring and of the store. akmon's own behaviour —
// ownership refusals, the lifecycle — is akmon's tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';
import { UsageError } from '../tools/common/cli.mjs';
import { ENV_ALIASES, akmonBrowserEnv, akmonTools, browserPort, defaultPort, requireTool, runTool } from '../tools/browser/akmon.mjs';
import { browser } from '../tools/browser/cli.mjs';
import { launch } from '../tools/browser/mcp.mjs';
import { buildRunning, checkPort, chromeOwnership, chromeRunning, profileInstallation } from '../tools/browser/running.mjs';
import { moveBrowserParts } from '../tools/common/local-stores.mjs';
import { migrateSeededRules } from '../tools/hooks/wiring.mjs';
import { CORE, cleanEnv, installation, tempDir, tool } from './helpers/installation.mjs';

const ROOT = '/home/user/work/acme';
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// -- the mapping -----------------------------------------------------------------------------

test('the installation is the akmon project, and the oikos settings go under their akmon names', () => {
  const settings = { OIKOS_CHROME_PATH: '/opt/chrome', OIKOS_CHROME_PROFILE: '/p', OIKOS_CHROME_PORT: '9411', OIKOS_CHROME_PROXY: 'direct' };
  const env = akmonBrowserEnv(ROOT, { read: (name) => settings[name], env: { PATH: '/bin' } });
  assert.deepEqual(env, {
    PATH: '/bin', AKMON_BROWSER_ROOT: ROOT, AKMON_BROWSER_CHROME: '/opt/chrome', AKMON_BROWSER_PROFILE: '/p',
    AKMON_BROWSER_PORT: '9411', AKMON_BROWSER_PROXY: 'direct',
  });
  assert.deepEqual(Object.keys(ENV_ALIASES).sort(), ['OIKOS_CHROME_PATH', 'OIKOS_CHROME_PORT', 'OIKOS_CHROME_PROFILE', 'OIKOS_CHROME_PROXY']);
});

test('a setting that is not set is not passed on; the environment given is not changed', () => {
  const base = { PATH: '/bin' };
  const asked = [];
  const env = akmonBrowserEnv(ROOT, { read: (name) => { asked.push(name); return name === 'OIKOS_CHROME_PORT' ? '9411' : undefined; }, env: base });
  assert.deepEqual(env, { PATH: '/bin', AKMON_BROWSER_ROOT: ROOT, AKMON_BROWSER_PORT: '9411' });
  assert.deepEqual(base, { PATH: '/bin' }, 'a copy, not the process environment');
  assert.deepEqual(asked.sort(), Object.keys(ENV_ALIASES).sort(), 'only the oikos names are read');
  assert.equal(akmonBrowserEnv(ROOT, { read: () => '', env: {} }).AKMON_BROWSER_PORT, undefined, 'an empty value is not a setting');
});

test('the oikos setting wins over an AKMON_BROWSER_* variable; the variable is kept only without it; the root is always the installation', () => {
  const env = akmonBrowserEnv(ROOT, {
    read: (name) => (name === 'OIKOS_CHROME_PORT' || name === 'OIKOS_CHROME_PATH' ? `from-oikos-${name}` : undefined),
    env: {
      AKMON_BROWSER_PORT: '9500', AKMON_BROWSER_PROFILE: '/from/shell', AKMON_BROWSER_ROOT: '/another/project',
    },
  });
  assert.equal(env.AKMON_BROWSER_PORT, 'from-oikos-OIKOS_CHROME_PORT', 'oikos over the shell');
  assert.equal(env.AKMON_BROWSER_CHROME, 'from-oikos-OIKOS_CHROME_PATH');
  assert.equal(env.AKMON_BROWSER_PROFILE, '/from/shell', 'no oikos setting: the variable stays');
  assert.ok(!('AKMON_BROWSER_PROXY' in env), 'neither: nothing is passed, akmon\'s default applies');
  assert.equal(env.AKMON_BROWSER_ROOT, ROOT, 'a stray root never points the tool at another project');
});

test('the port is derived from the installation\'s real folder with akmon\'s formula', () => {
  const dir = realpathSync(tempDir('port-'));
  const expected = 9300 + (createHash('sha1').update(dir).digest().readUInt16BE(0) % 600);
  assert.equal(defaultPort(dir), expected);
  assert.ok(defaultPort(dir) >= 9300 && defaultPort(dir) < 9900);
  assert.notEqual(defaultPort(dir), defaultPort(realpathSync(tempDir('port-'))));
});

test('akmon\'s tool files are under the core\'s submodule', () => {
  assert.deepEqual(akmonTools('/core'), {
    browser: '/core/_aitna/akmon/js/tools/browser.mjs',
    mcp: '/core/_aitna/akmon/js/tools/browser/mcp.mjs',
  });
  assert.equal(akmonTools().browser, join(realpathSync(CORE_ROOT), '_aitna', 'akmon', 'js', 'tools', 'browser.mjs'));
});

// -- the pass-through ---------------------------------------------------------------------------

/**
 * A fake akmon tool in a fresh folder: it writes its arguments and its `AKMON_BROWSER_*` variables
 * to the file named by FAKE_OUT and exits with FAKE_EXIT. Returns where it is and where it reports.
 */
function fakeTool(name = 'browser.mjs') {
  const dir = tempDir('akmon-');
  const file = join(dir, name);
  writeFileSync(file, [
    "import { writeFileSync } from 'node:fs';",
    'const akmon = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("AKMON_BROWSER_")));',
    'writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2), akmon }));',
    'process.exit(Number(process.env.FAKE_EXIT ?? 0));',
  ].join('\n'));
  return { file, out: join(dir, 'out.json') };
}

test('a verb is run by akmon\'s tool with its arguments and the mapped environment; its exit code is the result', async () => {
  const fake = fakeTool();
  const code = await browser(['start', '--url', 'https://example.com', '--headless'], {
    tools: { browser: fake.file }, root: ROOT, read: (name) => (name === 'OIKOS_CHROME_PORT' ? '9411' : undefined),
    env: { FAKE_OUT: fake.out, FAKE_EXIT: '3' },
  });
  assert.equal(code, 3, 'the exit code passes through');
  assert.deepEqual(readJson(fake.out), {
    args: ['start', '--url', 'https://example.com', '--headless'],
    akmon: { AKMON_BROWSER_ROOT: ROOT, AKMON_BROWSER_PORT: '9411' },
  });
});

test('the MCP launcher runs akmon\'s launcher with the same environment and no arguments', async () => {
  const fake = fakeTool('mcp.mjs');
  const code = await launch({
    tools: { mcp: fake.file }, root: ROOT, read: (name) => (name === 'OIKOS_CHROME_PROXY' ? 'system' : undefined),
    env: { FAKE_OUT: fake.out },
  });
  assert.equal(code, 0);
  assert.deepEqual(readJson(fake.out), { args: [], akmon: { AKMON_BROWSER_ROOT: ROOT, AKMON_BROWSER_PROXY: 'system' } });
});

test('help runs without an installation and without the root; any other verb needs the installation', async () => {
  const fake = fakeTool();
  const given = { tools: { browser: fake.file }, root: null, read: () => undefined, env: { FAKE_OUT: fake.out } };
  assert.equal(await browser(['--help'], given), 0);
  assert.deepEqual(readJson(fake.out), { args: ['--help'], akmon: {} });
  await assert.rejects(browser(['status'], { ...given, root: null }), (e) => e instanceof UsageError);
});

test('init is not passed on: .mcp.json is sync\'s', async () => {
  const fake = fakeTool();
  await assert.rejects(browser(['init'], { tools: { browser: fake.file }, root: ROOT, read: () => undefined, env: { FAKE_OUT: fake.out } }),
    (e) => e instanceof UsageError && /init is not passed on.*node oikos\/tools\/sync\/cli\.mjs/.test(e.message));
  assert.ok(!existsSync(fake.out), 'akmon was not run');
});

test('a tool that is not there is one clear error naming it and the repair, for the CLI and the launcher alike', async () => {
  const missing = join(tempDir('akmon-'), 'browser.mjs');
  const expected = (e) => e instanceof UsageError
    && e.message.includes(`akmon browser tool not found at ${missing}`)
    && e.message.includes('git submodule update --init --recursive')
    && e.message.includes('predates the browser tool');
  assert.throws(() => requireTool(missing), expected);
  await assert.rejects(browser(['status'], { tools: { browser: missing }, root: ROOT, read: () => undefined, env: {} }), expected);
  await assert.rejects(launch({ tools: { mcp: missing }, root: ROOT, read: () => undefined, env: {} }), expected);
  requireTool(fakeTool().file); // one that is there passes
});

/** A stand-in for child_process.spawn: a child that reports `status` (or `error`) and records the signals it is sent. */
function stubSpawn({ status = 0, signal = null, error = null } = {}) {
  const log = { calls: [], signals: [] };
  const spawn = (command, args, options) => {
    log.calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = (name) => { log.signals.push(name); };
    setImmediate(() => (error ? child.emit('error', error) : child.emit('exit', signal ? null : status, signal)));
    return child;
  };
  return { spawn, log };
}

test('runTool hands stdio on, runs the file with node, and says 1 when the tool was killed by a signal', async () => {
  const file = fakeTool().file;
  const ok = stubSpawn({ status: 7 });
  assert.equal(await runTool(file, ['pages'], { A: '1' }, ok.spawn), 7);
  assert.deepEqual(ok.log.calls, [{ command: process.execPath, args: [file, 'pages'], options: { stdio: 'inherit', env: { A: '1' } } }]);
  assert.equal(await runTool(file, [], {}, stubSpawn({ signal: 'SIGKILL' }).spawn), 1);
  const failing = new Error('spawn failed');
  await assert.rejects(runTool(file, [], {}, stubSpawn({ error: failing }).spawn), failing);
});

test('a stop signal reaches the tool while it runs, so an MCP server does not outlive its launcher; the listeners go afterwards', async () => {
  const file = fakeTool().file;
  const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));
  const { spawn, log } = stubSpawn();
  const running = runTool(file, [], {}, spawn);
  process.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(log.signals, ['SIGTERM']);
  await running;
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s)), before);
});

test('the command of the CLI refuses init and, outside an installation, anything but help — without reaching akmon', () => {
  const dir = installation((t) => t);
  const init = tool(dir, 'browser', ['init']);
  assert.equal(init.status, 1, init.output);
  assert.match(init.stderr, /^browser: init is not passed on/);
  const bare = spawnSync(process.execPath, [join(CORE, 'tools', 'browser', 'cli.mjs'), 'status'], { cwd: tempDir('bare-'), encoding: 'utf8', env: cleanEnv() });
  assert.equal(bare.status, 1, bare.stdout + bare.stderr);
  assert.match(bare.stderr, /^browser: /);
});

// -- whose Chrome ------------------------------------------------------------------------------

const OURS = `${ROOT}/.local/browser/chrome-profile`;
const line = (profile, port = 9312) => `/opt/google/chrome/chrome --remote-debugging-port=${port} --user-data-dir=${profile} --no-first-run`;

test('a browser profile path names its installation, on every side, under every name the store has had', () => {
  assert.equal(profileInstallation(OURS), 'acme');
  assert.equal(profileInstallation(`${ROOT}/.local/.browser/chrome-profile`), 'acme', 'the store at its place since ADR 0002');
  assert.equal(profileInstallation(`${ROOT}/.local/.browser/chrome-profile-cft`), 'acme', 'akmon\'s Chrome for Testing profile');
  assert.equal(profileInstallation('/Users/user/globex/.local/browser/chrome-profile-project'), 'globex');
  assert.equal(profileInstallation('\\\\wsl.localhost\\Ubuntu\\home\\user\\globex\\.local\\browser\\chrome-profile'), 'globex');
  assert.equal(profileInstallation('C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\User Data'), null);
  assert.equal(profileInstallation(null), null);
});

test('whose a Chrome is: this installation, another one by its code, or one nobody started for an installation', () => {
  assert.deepEqual(chromeOwnership([line(OURS)], { root: ROOT }), { owner: 'ours', installation: 'acme' });
  assert.deepEqual(chromeOwnership([line(`${ROOT}/.local/.browser/chrome-profile-cft`)], { root: ROOT }), { owner: 'ours', installation: 'acme' });
  assert.equal(chromeOwnership([line('/tmp/custom')], { root: ROOT, profile: '/tmp/custom' }).owner, 'ours', 'OIKOS_CHROME_PROFILE');
  const windows = '\\\\wsl.localhost\\Ubuntu\\home\\user\\work\\acme\\.local\\browser\\chrome-profile';
  const quoted = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9312 --user-data-dir="${windows.toUpperCase()}"`;
  assert.equal(chromeOwnership([quoted], { root: ROOT, launch: { profile: windows } }).owner, 'ours', 'a Windows Chrome under WSL, as launch.json recorded it');

  const other = '/home/user/work/globex/.local/browser/chrome-profile';
  assert.deepEqual(chromeOwnership([line(other)], { root: ROOT, profile: OURS }), { owner: 'foreign', installation: 'globex', profile: other });
  assert.deepEqual(chromeOwnership([line('/home/user/.config/chrome-debug')], { root: ROOT }),
    { owner: 'foreign', installation: null, profile: '/home/user/.config/chrome-debug' });
  assert.deepEqual(chromeOwnership([], { root: ROOT, profile: OURS }), { owner: 'unknown' });
});

test('the port check: nothing answering, then the ownership of what answers', async () => {
  const version = { Browser: 'Chrome/140' };
  assert.equal(await checkPort(9312, { probe: async () => null, owner: () => assert.fail('no process is read when nothing answers') }), null);
  const owner = { owner: 'ours', installation: 'acme' };
  assert.deepEqual(await checkPort(9312, { probe: async () => version, owner: () => owner }), { version, owner });
});

test('the running check probes the port akmon\'s tool gets: oikos setting, else AKMON_BROWSER_PORT, else the formula', async () => {
  const none = () => undefined;
  const mapped = (read, env) => akmonBrowserEnv(ROOT, { read, env });
  assert.equal(browserPort(ROOT, mapped(none, { AKMON_BROWSER_PORT: '9477' })), 9477);
  assert.equal(browserPort(ROOT, mapped((name) => (name === 'OIKOS_CHROME_PORT' ? '9411' : undefined), { AKMON_BROWSER_PORT: '9477' })), 9411);
  assert.equal(browserPort(ROOT, mapped(none, {})), defaultPort(ROOT));

  const probed = [];
  const check = async (p) => { probed.push(p); return null; };
  const running = await chromeRunning({
    root: ROOT, browserEnv: mapped(none, { AKMON_BROWSER_PORT: '9477' }), launches: [], check, profileInUse: () => false,
  });
  assert.equal(running, false);
  assert.deepEqual(probed, [9477], 'the shell port, with no oikos setting, is the one probed');
});

// -- the migration of the wiring ----------------------------------------------------------------

const LEGACY_READS = ['list_pages', 'take_snapshot', 'take_screenshot', 'list_console_messages', 'list_network_requests'].map((t) => `mcp__chrome-devtools__${t}`);
const READS = LEGACY_READS.map((rule) => rule.replace('chrome-devtools', 'akmon-browser'));

test('the read-only rules an earlier sync seeded are renamed, and nothing else is touched', () => {
  const settings = { model: 'kept', permissions: { allow: ['Bash(ls)', ...LEGACY_READS], deny: ['x'] } };
  const migrated = migrateSeededRules(settings);
  assert.deepEqual(migrated.permissions.allow, ['Bash(ls)', ...READS]);
  assert.deepEqual(migrated.permissions.deny, ['x']);
  assert.equal(migrated.model, 'kept');
  assert.deepEqual(settings.permissions.allow, ['Bash(ls)', ...LEGACY_READS], 'the input is not changed');
  assert.deepEqual(migrateSeededRules(migrated), migrated, 'idempotent');
  const half = migrateSeededRules({ permissions: { allow: [LEGACY_READS[0], READS[0]] } });
  assert.deepEqual(half.permissions.allow, READS, 'a current rule already there is not added twice');
});

test('settings without an old rule are left as they are: a person who removed the rules keeps it so', () => {
  for (const settings of [{}, { permissions: {} }, { permissions: { allow: [] } }, { permissions: { allow: ['Bash(ls)'] } }, { permissions: { allow: READS } }]) {
    assert.equal(migrateSeededRules(settings), settings);
  }
});

/** An installation synced under the old names: oikos's `chrome-devtools` server recorded in sync.json, the old rules seeded. */
function oldInstallation({ foreign = {} } = {}) {
  const dir = realpathSync(installation((t) => t));
  const core = join(CORE, 'tools', 'browser', 'mcp.mjs');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {
    'chrome-devtools': { type: 'stdio', command: 'node', args: [core], env: { OIKOS_HOME: dir } },
    theirs: { type: 'http', url: 'https://other.example.com/mcp' },
    ...foreign,
  } }, null, 2));
  mkdirSync(join(dir, '.local'), { recursive: true });
  writeFileSync(join(dir, '.local', 'sync.json'), JSON.stringify({ mcp: ['chrome-devtools'] }, null, 2));
  for (const host of ['.claude', '.qwen']) {
    mkdirSync(join(dir, host), { recursive: true });
    writeFileSync(join(dir, host, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)', ...LEGACY_READS] } }, null, 2));
  }
  return dir;
}

test('sync replaces the chrome-devtools server it wrote by akmon-browser, keeps the others, and renames the rules it seeded', () => {
  const dir = oldInstallation();
  const red = tool(dir, 'sync', ['--check']);
  assert.equal(red.status, 1, 'the check is red until sync runs');
  assert.match(red.stdout, /out of date: \.mcp\.json/);
  assert.equal(tool(dir, 'sync', []).status, 0);

  const servers = readJson(join(dir, '.mcp.json')).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ['akmon-browser', 'knowledge', 'theirs'], 'knowledge is the fixture\'s own mcp_servers entry');
  assert.deepEqual(servers['akmon-browser'], { type: 'stdio', command: 'node', args: [join(CORE, 'tools', 'browser', 'mcp.mjs')], env: { OIKOS_HOME: dir } });
  assert.deepEqual(readJson(join(dir, '.local', 'sync.json')).mcp, ['akmon-browser', 'knowledge']);
  for (const host of ['.claude', '.qwen']) {
    assert.deepEqual(readJson(join(dir, host, 'settings.json')).permissions.allow, ['Bash(ls)', ...READS], `${host}: the rules follow the server`);
  }
  const green = tool(dir, 'sync', ['--check']);
  assert.equal(green.status, 0, green.stdout + green.stderr);
});

test('a chrome-devtools server the person added themselves stays, beside akmon-browser', () => {
  const dir = oldInstallation();
  writeFileSync(join(dir, '.local', 'sync.json'), JSON.stringify({}, null, 2));
  assert.equal(tool(dir, 'sync', []).status, 0);
  const servers = readJson(join(dir, '.mcp.json')).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ['akmon-browser', 'chrome-devtools', 'knowledge', 'theirs']);
  assert.equal(servers['chrome-devtools'].env.OIKOS_HOME, dir, 'as the person had it');
});

test('a moved installation is still told by the entry an earlier sync wrote under the old name', () => {
  const dir = oldInstallation();
  const file = join(dir, '.mcp.json');
  const data = readJson(file);
  data.mcpServers['chrome-devtools'].env.OIKOS_HOME = '/old/place/acme';
  writeFileSync(file, JSON.stringify(data, null, 2));
  const r = tool(dir, 'sync', []);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /note: this installation was moved — an earlier sync recorded \/old\/place\/acme/);
  assert.equal(readJson(file).mcpServers['akmon-browser'].env.OIKOS_HOME, dir);
});

// -- the migration of the store ------------------------------------------------------------------

/** An installation folder with the browser store, and a cache of oikos-installed Chrome for Testing builds. */
function storeWith({ profile = 'chrome-profile-project', builds = ['linux-140.0.1', 'linux-141.0.2'] } = {}) {
  const root = tempDir('store-');
  const store = join(root, '.local', '.browser');
  mkdirSync(join(store, 'chrome-profile'), { recursive: true });
  if (profile) {
    mkdirSync(join(store, profile, 'Default'), { recursive: true });
    writeFileSync(join(store, profile, 'Default', 'Cookies'), 'signed in');
  }
  const cache = join(tempDir('cache-'), 'chrome');
  for (const build of builds) {
    mkdirSync(join(cache, build, 'chrome-linux64'), { recursive: true });
    writeFileSync(join(cache, build, 'chrome-linux64', 'chrome'), 'binary');
  }
  return { root, store, cache };
}

const states = (moves) => moves.map((m) => [m.from.split('/').pop(), m.state]);

test('the Chrome for Testing profile is renamed and the downloaded Chrome moved to where akmon looks; sign-ins survive', async () => {
  const { root, store, cache } = storeWith();
  const moves = await moveBrowserParts(root, { browserRunning: async () => false, cache });
  assert.deepEqual(states(moves), [['chrome-profile-project', 'moved'], ['linux-140.0.1', 'moved'], ['linux-141.0.2', 'moved']]);
  assert.equal(readFileSync(join(store, 'chrome-profile-cft', 'Default', 'Cookies'), 'utf8'), 'signed in');
  assert.ok(!existsSync(join(store, 'chrome-profile-project')));
  assert.ok(existsSync(join(store, 'chrome-profile')), 'the system Chrome\'s profile is not touched');
  assert.ok(existsSync(join(store, 'chrome', 'chrome', 'linux-141.0.2', 'chrome-linux64', 'chrome')));
  assert.deepEqual(readdirSync(cache), [], 'moved out of the cache, not copied');
  assert.deepEqual(await moveBrowserParts(root, { browserRunning: async () => false, cache }), [], 'idempotent: nothing left to move');
});

test('an installation on the system\'s Chrome leaves the shared cache alone', async () => {
  const { root, store, cache } = storeWith({ profile: null });
  assert.deepEqual(await moveBrowserParts(root, { browserRunning: async () => false, cache }), []);
  assert.deepEqual(readdirSync(cache).sort(), ['linux-140.0.1', 'linux-141.0.2']);
  assert.ok(!existsSync(join(store, 'chrome')));
});

test('a cache left behind by a move that did not finish is moved on the next run', async () => {
  const { root, store, cache } = storeWith({ profile: 'chrome-profile-cft', builds: ['linux-140.0.1'] });
  assert.deepEqual(states(await moveBrowserParts(root, { browserRunning: async () => false, cache })), [['linux-140.0.1', 'moved']]);
  assert.ok(existsSync(join(store, 'chrome', 'chrome', 'linux-140.0.1')));
});

test('nothing moves while Chrome runs, under a check nothing moves and Chrome is not asked, and a target is never overwritten', async () => {
  const running = storeWith();
  assert.deepEqual(states(await moveBrowserParts(running.root, { browserRunning: async () => true, cache: running.cache })),
    [['chrome-profile-project', 'running'], ['linux-140.0.1', 'running'], ['linux-141.0.2', 'running']]);
  assert.ok(existsSync(join(running.store, 'chrome-profile-project')));
  assert.equal(readdirSync(running.cache).length, 2);
  const unknown = await moveBrowserParts(running.root, { browserRunning: async () => { throw new Error('no PowerShell'); }, cache: running.cache });
  assert.equal(unknown[0].state, 'running', 'a check that cannot be made counts as running');

  const checked = storeWith();
  const asked = [];
  const out = await moveBrowserParts(checked.root, { check: true, browserRunning: async () => asked.push('asked'), cache: checked.cache });
  assert.deepEqual(out.map((m) => m.state), ['out of date', 'out of date', 'out of date']);
  assert.deepEqual(asked, []);
  assert.ok(existsSync(join(checked.store, 'chrome-profile-project')));

  const taken = storeWith();
  mkdirSync(join(taken.store, 'chrome-profile-cft'));
  writeFileSync(join(taken.store, 'chrome-profile-cft', 'mine'), 'kept');
  const both = await moveBrowserParts(taken.root, { browserRunning: async () => false, cache: taken.cache });
  assert.deepEqual(states(both), [['chrome-profile-project', 'both'], ['linux-140.0.1', 'moved'], ['linux-141.0.2', 'moved']]);
  assert.equal(readFileSync(join(taken.store, 'chrome-profile-cft', 'mine'), 'utf8'), 'kept');
  assert.ok(existsSync(join(taken.store, 'chrome-profile-project', 'Default', 'Cookies')), 'the old profile is left for the user to look at');
});

// -- a move that does not finish, runs twice, or runs from under a Chrome ------------------------------

const noMove = async () => false;
const exdev = () => Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });

/** The file system calls of a move across volumes: a rename of `across` (a path) fails with EXDEV, the rest is real. */
function acrossVolumes(across, { copy = cpSync } = {}) {
  return { renameSync: (from, to) => { if (from === across) throw exdev(); return renameSync(from, to); }, cpSync: copy, rmSync };
}

test('a move across volumes copies into a temporary sibling and renames it, so a failed copy leaves no target and the source whole', async () => {
  const { root, store, cache } = storeWith({ profile: 'chrome-profile-cft', builds: ['linux-140.0.1'] });
  const source = join(cache, 'linux-140.0.1');
  writeFileSync(join(source, 'chrome-linux64', 'second'), 'more');
  let copied = 0;
  const failing = acrossVolumes(source, { copy: (from, to, options) => cpSync(from, to, { ...options, filter: () => { if (++copied > 2) throw new Error('disk full'); return true; } }) });
  const out = await moveBrowserParts(root, { browserRunning: noMove, cache, fs: failing });
  assert.deepEqual(states(out), [['linux-140.0.1', 'failed']]);
  assert.match(out[0].error, /disk full/);
  assert.ok(!existsSync(join(store, 'chrome', 'chrome', 'linux-140.0.1')), 'no half-copied target');
  assert.deepEqual(readdirSync(join(store, 'chrome', 'chrome')), [], 'the temporary copy is gone');
  assert.equal(readFileSync(join(source, 'chrome-linux64', 'chrome'), 'utf8'), 'binary', 'the source is whole');
  assert.deepEqual(states(await moveBrowserParts(root, { check: true, browserRunning: noMove, cache })), [['linux-140.0.1', 'out of date']], 'the next run moves it, not reports both');
});

test('a move across volumes keeps a relative symbolic link relative, and removes the source after the rename', async () => {
  const { root, store, cache } = storeWith({ profile: 'chrome-profile-cft', builds: ['mac-140.0.1'] });
  const source = join(cache, 'mac-140.0.1');
  symlinkSync('chrome-linux64/chrome', join(source, 'Current'));
  const out = await moveBrowserParts(root, { browserRunning: noMove, cache, fs: acrossVolumes(source) });
  assert.deepEqual(states(out), [['mac-140.0.1', 'moved']]);
  const target = join(store, 'chrome', 'chrome', 'mac-140.0.1');
  assert.equal(readlinkSync(join(target, 'Current')), 'chrome-linux64/chrome');
  assert.equal(readFileSync(join(target, 'Current'), 'utf8'), 'binary', 'it resolves inside the target, not into the removed source');
  assert.ok(!existsSync(source));
  assert.deepEqual(readdirSync(join(store, 'chrome', 'chrome')), ['mac-140.0.1']);
});

test('a source another sync moved first is nothing to move, not a failure', async () => {
  const { root, cache } = storeWith({ profile: 'chrome-profile-cft', builds: ['linux-140.0.1', 'linux-141.0.2'] });
  const vanishing = { renameSync: (from, to) => { rmSync(from, { recursive: true }); return renameSync(from, to); }, cpSync, rmSync };
  assert.deepEqual(await moveBrowserParts(root, { browserRunning: noMove, cache, fs: vanishing }), [], 'both builds vanished before they moved: nothing reported');
  const taken = storeWith({ profile: 'chrome-profile-cft', builds: ['linux-140.0.1'] });
  const denied = { renameSync: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); }, cpSync, rmSync };
  assert.deepEqual(states(await moveBrowserParts(taken.root, { browserRunning: noMove, cache: taken.cache, fs: denied })), [['linux-140.0.1', 'failed']]);
});

test('a build a process runs from is left in the shared cache, with its own state; the profile and other builds move', async () => {
  const { root, store, cache } = storeWith();
  const asked = [];
  const buildInUse = (build) => { asked.push(basename(build)); return build.endsWith('linux-140.0.1'); };
  const out = await moveBrowserParts(root, { browserRunning: noMove, cache, buildInUse });
  assert.deepEqual(states(out), [['chrome-profile-project', 'moved'], ['linux-140.0.1', 'in use'], ['linux-141.0.2', 'moved']]);
  assert.deepEqual(asked, ['linux-140.0.1', 'linux-141.0.2'], 'asked for builds only, not for the profile');
  assert.ok(existsSync(join(cache, 'linux-140.0.1')));
  assert.ok(!existsSync(join(store, 'chrome', 'chrome', 'linux-140.0.1')));
  const unknown = await moveBrowserParts(storeWith({ profile: 'chrome-profile-cft', builds: ['linux-140.0.1'] }).root,
    { browserRunning: noMove, cache, buildInUse: () => { throw new Error('no process table'); } });
  assert.equal(unknown[0].state, 'in use', 'a check that cannot be made counts as in use');
});

test('a build in the shared cache is marked shared, a profile is not', async () => {
  const { root, cache } = storeWith();
  const out = await moveBrowserParts(root, { check: true, cache });
  assert.deepEqual(out.map((m) => m.shared ?? false), [false, true, true]);
});

test('buildRunning: a process whose executable is under the build folder, or a process table that could not be read', () => {
  const found = (lines, complete = true) => (keep) => ({ lines: lines.filter((l) => keep(l, l.split(' '))), complete });
  const build = '/core/cache/chrome/linux-140.0.1';
  assert.equal(buildRunning(build, { processes: found([`${build}/chrome-linux64/chrome --no-first-run`]) }), true);
  assert.equal(buildRunning(`${build}/`, { processes: found([`${build}/chrome-linux64/chrome`]) }), true, 'a trailing slash does not matter');
  assert.equal(buildRunning(build, { processes: found([`${build}-other/chrome`, '/usr/bin/chrome']) }), false, 'a sibling folder with the same prefix is another build');
  assert.equal(buildRunning(build, { processes: found([], false) }), true);
  if (process.platform !== 'linux') return;
  const dir = tempDir('build-');
  symlinkSync(process.execPath, join(dir, 'chrome'));
  const child = spawn(join(dir, 'chrome'), ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    assert.equal(buildRunning(dir), true, 'the real process table shows it');
  } finally {
    child.kill();
  }
  assert.equal(buildRunning(tempDir('build-')), false);
});

test('the command refuses a verb that may start Chrome while the browser state is not migrated; status, stop and help pass', async () => {
  const fake = fakeTool();
  const given = (pending) => ({ tools: { browser: fake.file }, root: ROOT, read: () => undefined, env: { FAKE_OUT: fake.out }, pending });
  const asked = [];
  const outOfDate = async (root) => { asked.push(root); return true; };
  for (const verb of ['start', 'restart', 'attach']) {
    await assert.rejects(browser([verb], given(outOfDate)),
      (e) => e instanceof UsageError && /the browser state is not migrated yet: run `node oikos\/tools\/sync\/cli\.mjs` first/.test(e.message));
    assert.ok(!existsSync(fake.out), 'akmon was not run');
  }
  assert.deepEqual(asked, [ROOT, ROOT, ROOT]);
  for (const verb of ['status', 'stop', '--help', 'help']) assert.equal(await browser([verb], given(outOfDate)), 0, verb);
  assert.equal(asked.length, 3, 'the check is not even made for them');
  assert.equal(await browser(['start'], given(async () => false)), 0, 'migrated: passed on');
  assert.deepEqual(readJson(fake.out).args, ['start']);
});

test('the migration check sees an old place of the store, and a profile not yet renamed', async () => {
  const fake = fakeTool();
  const old = tempDir('install-');
  mkdirSync(join(old, '.local', 'browser', 'chrome-profile'), { recursive: true });
  const base = { tools: { browser: fake.file }, read: () => undefined, env: { FAKE_OUT: fake.out } };
  await assert.rejects(browser(['start'], { ...base, root: old }), (e) => e instanceof UsageError && /not migrated yet/.test(e.message));
  const renamed = storeWith();
  await assert.rejects(browser(['start'], { ...base, root: renamed.root }), (e) => e instanceof UsageError && /not migrated yet/.test(e.message));
  assert.equal(await browser(['start'], { ...base, root: tempDir('fresh-') }), 0, 'nothing to migrate: passed on');
});
