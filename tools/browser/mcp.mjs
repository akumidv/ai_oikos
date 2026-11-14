#!/usr/bin/env node
// Launcher of the `akmon-browser` MCP server (.mcp.json, written by `oikos sync`). It runs akmon's
// launcher (`<core>/_aitna/akmon/js/tools/browser/mcp.mjs`, ADR 0009) for this installation: the same
// environment as the CLI (akmon.mjs: AKMON_BROWSER_ROOT = the installation, the OIKOS_CHROME_*
// settings under their akmon names), stdio passed straight through, so the server speaks to the host
// as before. akmon's launcher refuses a Chrome that does not run with this project's profile, and
// answers the host's `initialize` with the reason. The installation comes from OIKOS_HOME, which sync
// writes into .mcp.json next to this command.
import { isMain, UsageError } from '../common/cli.mjs';
import { envValue } from '../common/env.mjs';
import { installProblem, installRoot } from '../common/paths.mjs';
import { akmonBrowserEnv, akmonTools, runTool } from './akmon.mjs';

/**
 * Run akmon's MCP launcher for the installation, returning its exit code. `tools`, `root`, `read`,
 * `env` and `spawn` are for tests.
 * @param {{tools?: {mcp: string}, root?: string|null, read?: (name: string) => string|undefined, env?: Record<string, string|undefined>, spawn?: Function}} [given]
 * @returns {Promise<number>}
 */
export async function launch({ tools = akmonTools(), root = installRoot(), read = envValue, env = process.env, spawn } = {}) {
  if (!root) throw new UsageError(installProblem());
  return runTool(tools.mcp, [], akmonBrowserEnv(root, { read, env }), spawn);
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = await launch();
  } catch (e) {
    console.error(`akmon-browser MCP server not started: ${e.message}`);
    process.exitCode = 1;
  }
}
