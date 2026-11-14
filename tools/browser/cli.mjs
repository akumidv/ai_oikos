#!/usr/bin/env node
// A shared Chrome window for the user and the agent. The user signs in (SSO, MFA) by hand; the agent
// drives the same window — through the `akmon-browser` MCP server in .mcp.json, or through the verbs
// here. The mechanics are akmon's (`akmon tool browser`, ADR 0009): this command is the user-facing
// way to run them, `node oikos/tools/browser/cli.mjs <verb> [args]`, from the installation's root. It
// runs `<core>/_aitna/akmon/js/tools/browser.mjs <verb> [args]` with the installation as the project
// (AKMON_BROWSER_ROOT: state in `.local/.browser/`, a DevTools port derived from its folder) and the
// OIKOS_CHROME_PATH / _PROFILE / _PORT / _PROXY settings under their AKMON_BROWSER_* names — the
// oikos setting first, an AKMON_BROWSER_* variable only without it (akmon.mjs) — stdio and exit
// code passed through.
//
// Verbs are akmon's: status, start, stop, restart, attach, detach, install, pages, snapshot,
// screenshot, eval, logs, net, selectors, ext, record. One verb is not passed on: `init`, which would
// write `.mcp.json` — that file is `oikos sync`'s.
import { isMain, UsageError } from '../common/cli.mjs';
import { envValue } from '../common/env.mjs';
import { moveBrowserParts, moveLocalStores } from '../common/local-stores.mjs';
import { installProblem, installRoot } from '../common/paths.mjs';
import { akmonBrowserEnv, akmonTools, runTool } from './akmon.mjs';

const HELP = new Set(['--help', '-h', 'help']);

// Verbs that start nothing in `.local/.browser/`: they run before the state is migrated too.
const READ_ONLY = new Set(['status', 'stop']);

/** Whether the browser state of the installation at `root` waits for `oikos sync` to be moved to where akmon looks (a check, nothing moves). */
async function migrationPending(root) {
  const moves = [...await moveLocalStores(root, { check: true }), ...await moveBrowserParts(root, { check: true })];
  return moves.some((m) => m.state === 'out of date');
}

/**
 * Run the akmon browser verb in `args` for the installation, returning its exit code. A verb that may
 * start a Chrome or write the state is refused while the state of an earlier oikos is not yet moved
 * (`oikos sync` moves it): akmon would make an empty profile beside it and strand the sign-ins.
 * `tools`, `root`, `read`, `env`, `spawn` and `pending` (the migration check, given the root) are for
 * tests; the defaults are what the entry point reads.
 * @param {string[]} args the verb and its arguments
 * @param {{tools?: {browser: string}, root?: string|null, read?: (name: string) => string|undefined, env?: Record<string, string|undefined>, spawn?: Function, pending?: (root: string) => Promise<boolean>}} [given]
 * @returns {Promise<number>}
 */
export async function browser(args, { tools = akmonTools(), root = installRoot(), read = envValue, env = process.env, spawn, pending = migrationPending } = {}) {
  if (args[0] === 'init') {
    throw new UsageError('init is not passed on: `.mcp.json` is written by `node oikos/tools/sync/cli.mjs`, which wires the akmon-browser server for this installation');
  }
  const help = args.length === 0 || HELP.has(args[0]);
  if (!root && !help) throw new UsageError(installProblem());
  if (root && !help && !READ_ONLY.has(args[0]) && await pending(root)) {
    throw new UsageError('the browser state is not migrated yet: run `node oikos/tools/sync/cli.mjs` first');
  }
  return runTool(tools.browser, args, root ? akmonBrowserEnv(root, { read, env }) : env, spawn);
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = await browser(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`browser: ${e.message}`);
    process.exitCode = 1;
  }
}
