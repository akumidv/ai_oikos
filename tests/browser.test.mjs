// The shared browser is told by the installation's code (npm test). Whose a Chrome is is decided
// from the command lines of the processes on the DevTools port; the MCP server refuses another
// installation's Chrome and one oikos did not start. No real Chrome, no npx, no network: a stand-in
// process carries Chrome's flags and answers DevTools' version request on the loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';
import { chromeOwnership, checkPort, notOursMessage, profileInstallation } from '../tools/browser/cli.mjs';
import { serve } from '../tools/browser/mcp.mjs';

const CORE = realpathSync(CORE_ROOT);
const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const ROOT = '/home/user/work/acme';
const OURS = `${ROOT}/.local/browser/chrome-profile`;
const line = (profile, port = 9312) => `/opt/google/chrome/chrome --remote-debugging-port=${port} --user-data-dir=${profile} --no-first-run`;

test('an oikos profile path names its installation, on every side', () => {
  assert.equal(profileInstallation(OURS), 'acme');
  assert.equal(profileInstallation(`${ROOT}/.local/.browser/chrome-profile`), 'acme', 'the store at its place since ADR 0002');
  assert.equal(profileInstallation('/Users/user/globex/.local/browser/chrome-profile-project'), 'globex');
  assert.equal(profileInstallation('\\\\wsl.localhost\\Ubuntu\\home\\user\\globex\\.local\\browser\\chrome-profile'), 'globex');
  assert.equal(profileInstallation('C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\User Data'), null);
  assert.equal(profileInstallation(null), null);
});

test('whose a Chrome is: this installation, another one by its code, or one oikos did not start', () => {
  assert.deepEqual(chromeOwnership([line(OURS)], { root: ROOT }), { owner: 'ours', installation: 'acme' });
  assert.deepEqual(chromeOwnership([line(`${ROOT}/.local/.browser/chrome-profile`)], { root: ROOT }), { owner: 'ours', installation: 'acme' });
  // A Windows Chrome under WSL: the profile as Windows sees it, recorded at `start` in launch.json.
  const windows = '\\\\wsl.localhost\\Ubuntu\\home\\user\\work\\acme\\.local\\browser\\chrome-profile';
  const quoted = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9312 --user-data-dir="${windows.toUpperCase()}"`;
  assert.equal(chromeOwnership([quoted], { root: ROOT, launch: { profile: windows } }).owner, 'ours');
  assert.equal(chromeOwnership([quoted], { root: ROOT, profile: windows }).owner, 'ours');
  assert.equal(chromeOwnership([line('/tmp/custom')], { root: ROOT, profile: '/tmp/custom' }).owner, 'ours', 'OIKOS_CHROME_PROFILE');

  const other = '/home/user/work/globex/.local/browser/chrome-profile';
  assert.deepEqual(chromeOwnership([line(other)], { root: ROOT, profile: OURS }), { owner: 'foreign', installation: 'globex', profile: other });
  const twin = '/home/user/old/acme/.local/browser/chrome-profile';
  assert.deepEqual(chromeOwnership([line(twin)], { root: ROOT, profile: OURS }), { owner: 'foreign', installation: 'acme', profile: twin },
    'the same folder name elsewhere is still another installation');
  assert.deepEqual(chromeOwnership([line('/home/user/.config/chrome-debug')], { root: ROOT }),
    { owner: 'foreign', installation: null, profile: '/home/user/.config/chrome-debug' });
  assert.deepEqual(chromeOwnership(['/usr/bin/chromium --remote-debugging-port=9312'], { root: ROOT }),
    { owner: 'foreign', installation: null, profile: null });
  assert.deepEqual(chromeOwnership([], { root: ROOT, profile: OURS }), { owner: 'unknown' });
});

test('the refusal names this installation, the port, whose Chrome answered and the fix', () => {
  const other = notOursMessage({ owner: 'foreign', installation: 'globex', profile: '/x/globex/.local/browser/chrome-profile' }, { port: 9312, code: 'acme' });
  assert.equal(other, 'the Chrome on 127.0.0.1:9312 is the Chrome of installation globex (profile /x/globex/.local/browser/chrome-profile), '
    + "not installation acme's. oikos does not drive it: close that Chrome, or set OIKOS_CHROME_PORT in the settings of oikos.yaml "
    + "to a free port; then start this installation's: node oikos/tools/browser/cli.mjs start");
  assert.match(notOursMessage({ owner: 'foreign', installation: null, profile: null }, { port: 9312, code: 'acme' }),
    /is a Chrome not started by oikos \(its default profile\), not installation acme's/);
  assert.match(notOursMessage({ owner: 'unknown' }, { port: 9312, code: 'acme' }), /whose it is cannot be told, not installation acme's/);
});

test('the port check: nothing answering, this installation\'s Chrome, another one\'s', async () => {
  const version = { Browser: 'Chrome/140' };
  assert.equal(await checkPort(9312, { probe: async () => null, owner: () => assert.fail('no process is read when nothing answers'), code: 'acme' }), null);
  const ours = await checkPort(9312, { probe: async () => version, owner: () => ({ owner: 'ours', installation: 'acme' }), code: 'acme' });
  assert.equal(ours.refusal, null);
  const other = await checkPort(9312, { probe: async () => version, owner: () => ({ owner: 'foreign', installation: 'globex', profile: 'p' }), code: 'acme' });
  assert.match(other.refusal, /installation globex .* not installation acme's/);
});

test('the MCP server starts only for this installation\'s Chrome or none', async () => {
  const run = async (found) => {
    const calls = [];
    await serve(9312, { check: async () => found, start: (p) => calls.push(['start', p]), refuse: (m) => calls.push(['refuse', m]) });
    return calls;
  };
  assert.deepEqual(await run(null), [['start', 9312]], 'no Chrome: the server starts and reports it on use');
  assert.deepEqual(await run({ refusal: null }), [['start', 9312]]);
  const refused = await run({ refusal: 'the Chrome on 127.0.0.1:9312 is …' });
  assert.equal(refused.length, 1);
  assert.equal(refused[0][0], 'refuse');
  assert.match(refused[0][1], /^chrome-devtools MCP server not started: the Chrome on 127\.0\.0\.1:9312/);
});

/** A free loopback port. */
function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** A stand-in Chrome: Chrome's flags on its command line, DevTools' version answer on `port`. */
async function fakeChrome(port, profile) {
  const answer = "require('http').createServer((q, r) => r.end(JSON.stringify({ Browser: 'FakeChrome/1' })))"
    + `.listen(${port}, '127.0.0.1')`;
  const child = spawn(process.execPath, ['-e', answer, '--', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return child;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`the stand-in Chrome did not answer on ${port}`);
}

/** Run tools/browser/mcp.mjs for the installation `dir` as the host does, sending `initialize`. */
function mcp(dir, port) {
  const env = { ...process.env, OIKOS_HOME: dir, OIKOS_CHROME_PORT: String(port), OIKOS_CHROME_PATH: process.execPath };
  for (const k of ['CLAUDE_PROJECT_DIR', 'QWEN_PROJECT_DIR', 'OIKOS_CHROME_PROFILE', 'NODE_USE_ENV_PROXY',
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
  return spawnSync(process.execPath, [join(CORE, 'tools', 'browser', 'mcp.mjs')],
    { cwd: dir, env, encoding: 'utf8', input: `${JSON.stringify(initialize)}\n`, timeout: 90000 });
}

test('the MCP server refuses another installation\'s Chrome and one oikos did not start', { skip: process.platform !== 'linux' && 'the process table is read from /proc' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'oikos-test-'));
  made.push(base);
  const dir = join(base, 'acme');
  cpSync(join(CORE, 'examples', 'installation'), dir, { recursive: true });
  mkdirSync(join(dir, '.local'));

  for (const [profile, whose] of [
    [join(base, 'globex', '.local', 'browser', 'chrome-profile'), 'the Chrome of installation globex'],
    [join(base, 'chrome-debug'), 'a Chrome not started by oikos'],
  ]) {
    const port = await freePort();
    const chrome = await fakeChrome(port, profile);
    try {
      const r = mcp(dir, port);
      assert.equal(r.status, 1, r.stderr);
      const expected = `the Chrome on 127.0.0.1:${port} is ${whose} (profile ${profile}), not installation acme's.`;
      assert.ok(r.stderr.includes(expected), r.stderr);
      assert.ok(r.stderr.includes('node oikos/tools/browser/cli.mjs start'), r.stderr);
      const answer = JSON.parse(r.stdout.trim());
      assert.equal(answer.id, 0);
      assert.ok(answer.error.message.includes(expected), 'the host gets the refusal as the answer to initialize');
    } finally {
      chrome.kill();
    }
  }
});
