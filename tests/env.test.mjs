// Where a credential or setting comes from (npm test): the installation's own files win —
// `.local/.env`, then the `settings` of `oikos.yaml` — and the shell environment is only a fallback,
// since every installation on the machine shares it. env.mjs caches the installation and its
// `.local/.env` per process, so each case runs in a child process. Fake values only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE_ROOT } from '../tools/common/paths.mjs';

const CORE = realpathSync(CORE_ROOT);
const FIXTURE = join(CORE, 'examples', 'installation');
const ENV_MODULE = pathToFileURL(join(CORE, 'tools', 'common', 'env.mjs')).href;
const KEY = 'OIKOS_TEST_SETTING';
const made = [];

process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A fresh installation from the fixture, with `settings` and `.local/.env` extended as given. */
function installation({ settings = {}, dotenv = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'oikos-test-'));
  made.push(base);
  const dir = join(base, 'acme');
  cpSync(FIXTURE, dir, { recursive: true });
  const extra = Object.entries(settings).map(([k, v]) => `  ${k}: ${v}\n`).join('');
  writeFileSync(join(dir, 'oikos.yaml'), readFileSync(join(dir, 'oikos.yaml'), 'utf8').replace('settings:\n', `settings:\n${extra}`));
  symlinkSync(relative(dir, CORE), join(dir, 'oikos'), 'dir');
  mkdirSync(join(dir, '.local'));
  const lines = Object.entries(dotenv).map(([k, v]) => `${k}=${v}\n`).join('');
  writeFileSync(join(dir, '.local', '.env'), lines, { mode: 0o600 });
  return dir;
}

/** The environment of a session outside any installation, without the caller's own credentials. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['OIKOS_HOME', 'CLAUDE_PROJECT_DIR', 'QWEN_PROJECT_DIR', 'INIT_CWD', 'PWD', KEY,
    'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_BASE_URL', 'GITLAB_TOKEN', 'GITLAB_URL', 'GITHUB_TOKEN', 'GITHUB_ORG', 'GMAIL_APP_PASSWORD']) delete env[k];
  return { ...env, ...extra };
}

/** `lookup(name)` as a tool started in `cwd` with `env` sees it. */
function lookupIn(cwd, name, env = {}) {
  const script = `import { lookup } from ${JSON.stringify(ENV_MODULE)}; console.log(JSON.stringify(lookup(${JSON.stringify(name)})));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8', env: cleanEnv({ PWD: cwd, ...env }) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

test("the installation's .local/.env wins over the shell environment", () => {
  const dir = installation({ dotenv: { [KEY]: 'from-dotenv' } });
  assert.deepEqual(lookupIn(dir, KEY, { [KEY]: 'from-shell' }), { value: 'from-dotenv', source: '.local/.env' });
});

test("the settings of oikos.yaml win over the shell environment", () => {
  const dir = installation({ settings: { [KEY]: 'from-config' } });
  assert.deepEqual(lookupIn(dir, KEY, { [KEY]: 'from-shell' }), { value: 'from-config', source: 'config' });
});

test('the shell environment is the fallback in an installation', () => {
  const dir = installation();
  assert.deepEqual(lookupIn(dir, KEY, { [KEY]: 'from-shell' }), { value: 'from-shell', source: 'env' });
  assert.deepEqual(lookupIn(dir, KEY), { value: null, source: null });
});

test('outside an installation only the environment is read', () => {
  const base = mkdtempSync(join(tmpdir(), 'oikos-test-'));
  made.push(base);
  assert.deepEqual(lookupIn(base, KEY, { [KEY]: 'from-shell' }), { value: 'from-shell', source: 'env' });
  assert.deepEqual(lookupIn(base, KEY), { value: null, source: null });
});

test('setup status flags a credential from the shell environment without failing it', () => {
  const status = (dir, env) => spawnSync(process.execPath, [join(dir, 'oikos', 'tools', 'setup', 'cli.mjs'), 'status', '--offline'],
    { cwd: dir, encoding: 'utf8', env: cleanEnv({ PWD: dir, ...env }) }).stdout;
  const fromShell = status(installation(), { JIRA_EMAIL: 'someone@acme.example' });
  assert.match(fromShell, /ok {2}JIRA_EMAIL — env \(shared by every installation; move it to \.local\/\.env\)/);
  assert.doesNotMatch(fromShell.split('\n').find((l) => l.startsWith('not ready')) || '', /JIRA_EMAIL/, 'a warning, not a missing item');
  const fromFile = status(installation({ dotenv: { JIRA_EMAIL: 'someone@acme.example' } }), { JIRA_EMAIL: 'other@acme.example' });
  assert.match(fromFile, /ok {2}JIRA_EMAIL — \.local\/\.env\n/);
});
