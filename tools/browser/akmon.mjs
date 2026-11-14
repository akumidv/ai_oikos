// How oikos reaches the browser tool of akmon (ADR 0009). oikos keeps no Chrome mechanics of its own:
// `node oikos/tools/browser/cli.mjs <verb>` runs akmon's `browser.mjs` and `tools/browser/mcp.mjs`
// runs akmon's MCP launcher. akmon is the dev-layer submodule inside the core
// (`<core>/_aitna/akmon`); this module is the one place that names its tool files, checks that they are
// there, and turns the installation's own settings into the `AKMON_BROWSER_*` variables the tool reads.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../common/cli.mjs';
import { CORE_ROOT, envValue } from '../common/env.mjs';
import { installPath, realOf } from '../common/paths.mjs';

/**
 * The files of akmon's browser tool under the core `core`: the verbs (`browser`) and the MCP launcher
 * (`mcp`).
 * @param {string} [core] the core's folder, CORE_ROOT unless a test names another
 * @returns {{browser: string, mcp: string}}
 */
export const akmonTools = (core = CORE_ROOT) => ({
  browser: join(core, '_aitna', 'akmon', 'js', 'tools', 'browser.mjs'),
  mcp: join(core, '_aitna', 'akmon', 'js', 'tools', 'browser', 'mcp.mjs'),
});

/**
 * Throws a UsageError naming `file` unless it exists: the submodule is not checked out, or its pin
 * predates the browser tool.
 * @param {string} file one of akmon's tool files
 */
export function requireTool(file) {
  if (existsSync(file)) return;
  throw new UsageError(`akmon browser tool not found at ${file}: run \`git submodule update --init --recursive\` in oikos, `
    + 'or the akmon pin predates the browser tool (update oikos, then the submodule)');
}

/** The oikos settings that stand for an akmon one; an `AKMON_*` variable that is already set wins. */
export const ENV_ALIASES = Object.freeze({
  OIKOS_CHROME_PATH: 'AKMON_BROWSER_CHROME',
  OIKOS_CHROME_PROFILE: 'AKMON_BROWSER_PROFILE',
  OIKOS_CHROME_PORT: 'AKMON_BROWSER_PORT',
  OIKOS_CHROME_PROXY: 'AKMON_BROWSER_PROXY',
});

/**
 * The environment akmon's browser tool runs in for the installation at `root`: `env` with
 * `AKMON_BROWSER_ROOT` set to the installation — always, so a stray value in the shell never points the
 * tool at another project's browser — and each `OIKOS_CHROME_*` setting that `read` gives, under its
 * akmon name, unless that name is set in `env` already. Pure: the caller passes what it read.
 * @param {string} root the installation's folder
 * @param {{read?: (name: string) => string|undefined, env?: Record<string, string|undefined>}} [from]
 *   `read` looks a setting up (envValue: `.local/.env`, `oikos.yaml` settings, the environment)
 * @returns {Record<string, string|undefined>}
 */
export function akmonBrowserEnv(root, { read = envValue, env = process.env } = {}) {
  const mapped = { ...env, AKMON_BROWSER_ROOT: root };
  for (const [from, to] of Object.entries(ENV_ALIASES)) {
    if (env[to]) continue;
    const value = read(from);
    if (value) mapped[to] = String(value);
  }
  return mapped;
}

/**
 * Run the akmon tool file `script` with `args` in `env`, stdio inherited; resolves to its exit code (1
 * when it was killed by a signal). The file is checked first. A SIGINT, SIGTERM or SIGHUP to this process
 * is passed on, so an MCP server the host stops does not outlive its launcher. `spawn` is for tests.
 * @param {string} script one of akmonTools()
 * @param {string[]} args
 * @param {Record<string, string|undefined>} env akmonBrowserEnv()
 * @param {typeof nodeSpawn} [spawn]
 * @returns {Promise<number>}
 */
export function runTool(script, args, env, spawn = nodeSpawn) {
  requireTool(script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', env });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const forward = (signal) => child.kill(signal);
    for (const signal of signals) process.on(signal, forward);
    const done = () => { for (const signal of signals) process.off(signal, forward); };
    child.on('error', (e) => { done(); reject(e); });
    child.on('exit', (code) => { done(); resolve(code ?? 1); });
  });
}

/**
 * The DevTools port akmon's tool uses for the installation at `dir` when `OIKOS_CHROME_PORT` is not
 * set — the formula is akmon's (9300 + sha1 of the real path), so the two agree.
 */
export function defaultPort(dir) {
  return 9300 + (createHash('sha1').update(realOf(dir)).digest().readUInt16BE(0) % 600);
}

/** This installation's DevTools port: OIKOS_CHROME_PORT (oikos.yaml settings), else defaultPort(). */
export const browserPort = () => Number(envValue('OIKOS_CHROME_PORT') || defaultPort(installPath()));
