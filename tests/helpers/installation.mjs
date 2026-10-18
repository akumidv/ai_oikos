// Shared pieces of the connector tests: a fresh installation copied from examples/installation (ACME
// Corp) into a temporary folder, a tool run there the way an agent runs it, with an environment
// scrubbed of the developer's own settings and a preloaded fetch — one that refuses every call
// (no-fetch.mjs) or one that answers from canned routes (fake-fetch.mjs). The temporary folders are
// removed when the test process exits.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_ROOT } from '../../tools/common/paths.mjs';

export const CORE = realpathSync(CORE_ROOT);
export const FIXTURE = join(CORE, 'examples', 'installation');
/** What both preloads print on stderr for a request they refuse. */
export const NETWORK = 'NETWORK ATTEMPT';
const HERE = dirname(fileURLToPath(import.meta.url));
/** The preload that reports and refuses every fetch. */
export const NO_FETCH = join(HERE, 'no-fetch.mjs');
/** The preload that answers fetch from the routes in OIKOS_FAKE_FETCH. */
export const FAKE_FETCH = join(HERE, 'fake-fetch.mjs');

const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const base = mkdtempSync(join(tmpdir(), 'oikos-connectors-'));
made.push(base);

/** A new empty folder under this run's temporary base. */
export const tempDir = (prefix) => mkdtempSync(join(base, prefix));

/** The fixture's `oikos.yaml` with gitlab listed too (the example installation uses only github). */
export const withGitlab = (t) => t.replace('code-hosting: [github]', 'code-hosting: [github, gitlab]');

/** A fresh installation from the fixture, with `oikos.yaml` edited by `config`. */
export function installation(config) {
  const dir = tempDir('acme-');
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
  'GMAIL_USER', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'OIKOS_FAKE_FETCH', 'OIKOS_FAKE_FETCH_LOG',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS',
];
const SCRUBBED_PREFIX = /^(GITHUB|GITLAB|JIRA|CONFLUENCE)_/;

/** This process's environment without the scrubbed keys, with `env` on top. */
export function cleanEnv(env = {}) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (SCRUBBED.includes(k) || SCRUBBED_PREFIX.test(k)) delete clean[k];
  return { ...clean, ...env };
}

/**
 * Run `oikos/tools/<toolName>/cli.mjs` from the installation `dir` with only the fake credentials in
 * `env`, under `preload` (default: no fetch at all). Returns spawnSync's result plus `output`.
 */
export function tool(dir, toolName, args, env, { preload = NO_FETCH } = {}) {
  const r = spawnSync(process.execPath, ['--import', preload, join(dir, 'oikos', 'tools', toolName, 'cli.mjs'), ...args],
    { cwd: dir, encoding: 'utf8', env: cleanEnv({ OIKOS_HOME: dir, PWD: dir, ...env }) });
  return { ...r, output: `${r.stdout}\n${r.stderr}` };
}

/**
 * Run the ES module source `code` in the installation `dir`, as `tool` runs a tool: for code that
 * imports a shared module directly (e.g. a client) instead of going through a command.
 */
export function script(dir, code, env, { preload = NO_FETCH } = {}) {
  const r = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', code],
    { cwd: dir, encoding: 'utf8', env: cleanEnv({ OIKOS_HOME: dir, PWD: dir, ...env }) });
  return { ...r, output: `${r.stdout}\n${r.stderr}` };
}

/**
 * Canned answers for `tool` / `script` in the installation `dir`: the routes (fake-fetch.mjs) are
 * written into it. Returns { env, preload } to pass on, and `calls()` — every request made so far,
 * as { method, url, body }.
 */
export function withFakeFetch(dir, routes) {
  const file = join(dir, 'fake-fetch.json');
  const log = join(dir, 'fake-fetch.log');
  writeFileSync(file, JSON.stringify({ routes }));
  rmSync(log, { force: true });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { env: { OIKOS_FAKE_FETCH: file, OIKOS_FAKE_FETCH_LOG: log }, preload: FAKE_FETCH, calls };
}

/** Neither a crash nor a request reached for. */
export function assertNoCrashNoRequest(r) {
  assert.doesNotMatch(r.output, /TypeError/);
  assert.doesNotMatch(r.output, new RegExp(NETWORK));
}
