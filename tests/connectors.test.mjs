// Connector tools without their site setting (npm test). Each test copies examples/installation
// (ACME Corp) into a temporary folder with the site's URL taken out of `oikos.yaml`, gives the tool a
// fake token, and runs it as an agent does. A missing site is a usage error that names the key — never
// a TypeError — and it comes before any request: a preloaded `fetch` that reports and refuses every
// call proves nothing reached the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';

const CORE = realpathSync(CORE_ROOT);
const FIXTURE = join(CORE, 'examples', 'installation');
const NETWORK = 'NETWORK ATTEMPT';
const made = [];

process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const base = mkdtempSync(join(tmpdir(), 'oikos-connectors-'));
made.push(base);
const NO_FETCH = join(base, 'no-fetch.mjs');
writeFileSync(NO_FETCH, `globalThis.fetch = async (url) => {
  process.stderr.write('${NETWORK} ' + url + '\\n');
  throw new Error('the network is off in tests');
};\n`);

/** A fresh installation from the fixture, with `oikos.yaml` edited by `config`. */
function installation(config) {
  const dir = mkdtempSync(join(base, 'acme-'));
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, 'oikos.yaml'), config(readFileSync(join(dir, 'oikos.yaml'), 'utf8')));
  symlinkSync(relative(dir, CORE), join(dir, 'oikos'), 'dir');
  mkdirSync(join(dir, '.local'));
  return dir;
}

// Every key a connector reads, so the developer's own shell profile cannot leak into a test; the
// proxy variables too, so the CLI does not re-run itself without the preloaded fetch.
const SCRUBBED = [
  'OIKOS_HOME', 'CLAUDE_PROJECT_DIR', 'QWEN_PROJECT_DIR', 'INIT_CWD', 'PWD',
  'GITLAB_URL', 'GITLAB_TOKEN', 'GITHUB_ORG', 'GITHUB_TOKEN',
  'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'CONFLUENCE_BASE_URL', 'CONFLUENCE_EMAIL', 'CONFLUENCE_API_TOKEN',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS',
];

/** Run `oikos/tools/<tool>/cli.mjs` from `dir` with only the fake credentials in `env`. */
function tool(dir, toolName, args, env) {
  const clean = { ...process.env };
  for (const k of SCRUBBED) delete clean[k];
  const r = spawnSync(process.execPath, ['--import', NO_FETCH, join(dir, 'oikos', 'tools', toolName, 'cli.mjs'), ...args],
    { cwd: dir, encoding: 'utf8', env: { ...clean, OIKOS_HOME: dir, PWD: dir, ...env } });
  return { ...r, output: `${r.stdout}\n${r.stderr}` };
}

function assertNoCrashNoRequest(r) {
  assert.doesNotMatch(r.output, /TypeError/);
  assert.doesNotMatch(r.output, new RegExp(NETWORK));
}

test('gitlab without GITLAB_URL is a usage error that names the key, before any request', () => {
  const dir = installation((t) => t);
  for (const args of [['whoami'], ['projects'], ['mrs']]) {
    const r = tool(dir, 'gitlab', args, { GITLAB_TOKEN: 'glpat-fake-token' });
    assertNoCrashNoRequest(r);
    assert.equal(r.status, 1, `gitlab ${args[0]}: ${r.output}`);
    assert.match(r.stderr, /^gitlab: no GITLAB_URL$/m);
    assert.match(r.stderr, /GITLAB_URL\s+missing/);
    assert.match(r.stderr, /GITLAB_TOKEN\s+set/);
    assert.doesNotMatch(r.stderr, /null|personal_access_tokens/, 'no token page without a site');
  }
});

test('gitlab with GITLAB_URL set still reaches for the site', () => {
  const dir = installation((t) => t.replace('settings:', 'settings:\n  GITLAB_URL: https://gitlab.example.com/'));
  const r = tool(dir, 'gitlab', ['whoami'], { GITLAB_TOKEN: 'glpat-fake-token' });
  assert.doesNotMatch(r.output, /TypeError|no GITLAB_URL/);
  assert.match(r.stderr, new RegExp(`${NETWORK} https://gitlab\\.example\\.com/api/v4/user`), 'the trailing slash is trimmed');
});

test('github without GITHUB_ORG is a usage error that names the key, before any request', () => {
  const dir = installation((t) => t.replace(/^\s*GITHUB_ORG:.*\n/m, ''));
  const r = tool(dir, 'github', ['repos'], { GITHUB_TOKEN: 'ghp_fake_token' });
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /GITHUB_ORG/);
});

test('jira without JIRA_BASE_URL reports the missing key instead of calling', () => {
  const dir = installation((t) => t.replace(/^\s*JIRA_BASE_URL:.*\n/m, ''));
  const r = tool(dir, 'jira', ['whoami'], { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' });
  assertNoCrashNoRequest(r);
  assert.match(r.stdout, /no Jira credentials/);
  assert.match(r.stdout, /JIRA_BASE_URL\s+missing/);
});

test('confluence without a base URL reports the missing key instead of calling', () => {
  const dir = installation((t) => t.replace(/^\s*JIRA_BASE_URL:.*\n/m, ''));
  const r = tool(dir, 'confluence', ['info', '--page', '123'], { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' });
  assertNoCrashNoRequest(r);
  assert.match(r.stdout, /no Atlassian credentials/);
  assert.match(r.stdout, /JIRA_BASE_URL\s+missing/);
});
