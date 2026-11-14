#!/usr/bin/env node
// PreToolUse(shell, akmon-browser MCP): who may drive the shared browser (akmon ADR 0032/D07,
// oikos ADR 0009/D07). The browser is the developer's own session's tool: a delegated agent (a
// subagent) and an autonomous run do not drive it, and an attached browser is the user's own Chrome,
// whose window and pages no agent closes. A call drives the browser when it is
//   - a shell command that runs the oikos CLI (`node oikos/tools/browser/cli.mjs …`, `npm run browser`)
//     or akmon's own tool (`akmon tool browser …`), in any spelling akmon's matcher reads, or
//   - a call of a tool of the `akmon-browser` MCP server (`mcp__akmon-browser__*`).
//
// The decision is akmon's: this guard imports `browserGuardResult` and its command-word parser from
// the dev-layer submodule (`<core>/_aitna/akmon/js/hooks/hook_core.mjs`, the module akmon's own hook
// runs) and its access matrix, so the actor rules, the wording and the matrix row stay one owner's.
// What oikos adds is only what akmon cannot know: the oikos CLI's script name next to akmon's own
// (`OIKOS_SCRIPT`), the `browser` script of the core's package.json, and where an installation keeps
// its attach record (`<installation>/.local/.browser/attach.json`).
//
// The actor is read the way akmon reads it: a delegated agent is a call whose payload carries
// `agent_id`; an autonomous run is the one the launcher marks with `AKMON_ACTOR=autonomous`; a call of
// neither kind is the developer's own session, and passes. The submodule missing means no browser
// tool can run either (`tools/browser/akmon.mjs` refuses without it), so the guard is silent then.
//
// In the core repository akmon's own guard is wired as well, on the same calls: it denies the same
// ones, so a double denial is possible and a contradiction is not — neither allows what the other
// denies.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decide, shellSegments } from './common.mjs';
import { isShell, shellCommand, toolName } from './host.mjs';
import { CORE_ROOT, hookInstallation } from '../common/paths.mjs';

/** The script of the oikos CLI, as akmon's matcher reads a script: a path that ends with it. */
export const OIKOS_SCRIPT = 'tools/browser/cli.mjs';

/** The canonical spelling the `browser` npm script stands for. */
const SCRIPT_COMMAND = `node oikos/${OIKOS_SCRIPT}`;

/** The tools of the MCP server; the same prefix as akmon's `browser.mcp_prefix`. */
export const MCP_PREFIX = 'mcp__akmon-browser__';

const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SCRIPT_VERBS = new Set(['run', 'run-script', 'rum', 'urn']);
/** The options of a package runner that take their value as the next word. */
const RUNNER_VALUED_OPTIONS = new Set(['--prefix', '-C', '--dir', '--cwd', '--workspace', '-w', '--filter', '-F']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/** Said after akmon's reason: what the hand-back means in an installation, where a fetch is closed too. */
export const INSTALLATION_NOTE = ' In an installation, a host that a resource note reaches through the `browser` skill is read only in the shared Chrome, '
  + 'so a web fetch of it is denied as well: say that the step needs the user\'s own session.';

/** The script a package runner's segment runs (`npm run browser` is `browser`), or undefined. */
function runnerScript(segment) {
  const words = [];
  for (let i = 0; i < segment.args.length; i += 1) {
    const word = segment.args[i];
    if (RUNNER_VALUED_OPTIONS.has(word)) i += 1;
    else if (!word.startsWith('-')) words.push(word);
  }
  if (SCRIPT_VERBS.has(words[0])) return words[1];
  return segment.exe === 'npm' ? undefined : words[0]; // `pnpm browser`, `yarn browser`, `bun browser`
}

/** Whether one segment runs the `browser` package script, or a shell string that does. */
function segmentRunsBrowserScript(segment) {
  if (PACKAGE_RUNNERS.has(segment.exe)) return runnerScript(segment) === 'browser';
  if (!SHELLS.has(segment.exe) || !segment.args.includes('-c')) return false;
  const text = segment.args[segment.args.indexOf('-c') + 1];
  return text !== undefined && runsBrowserScript(text);
}

/**
 * Whether the shell command `command` runs the core's `browser` package script (`npm run browser`,
 * `pnpm browser`, `yarn run browser`, `npm --prefix oikos run browser`), also inside a shell's `-c`
 * string. akmon's matcher reads a script by its path, which a package script hides.
 * @param {string} command
 * @returns {boolean}
 */
export function runsBrowserScript(command) {
  return shellSegments(command).some((segment) => segment.exe && segmentRunsBrowserScript(segment));
}

/**
 * akmon's hook modules and access matrix, from the submodule of the core `core`; null when it is not
 * checked out. A module that is there and fails to load throws: the dispatcher reports a guard that
 * failed, never a silent pass.
 * @param {string} [core] the core's folder, CORE_ROOT unless a test names another
 */
export async function loadAkmon(core = CORE_ROOT) {
  const hooks = join(core, '_aitna', 'akmon', 'js', 'hooks');
  if (!existsSync(join(hooks, 'hook_core.mjs'))) return null;
  const load = (file) => import(pathToFileURL(join(hooks, file)).href);
  const [hookCore, hookData, adapter, matrix] = await Promise.all([
    load('hook_core.mjs'), load('hook_data.mjs'), load('claude_adapter.mjs'), load('../common/access_matrix.mjs'),
  ]);
  return { ...hookCore, ...hookData, ...adapter, ...matrix };
}

/**
 * akmon's hook data with the oikos CLI's script added to the scripts its matcher reads as the browser
 * tool. The data is lazy and stays so: the extended copy answers for `core`, the prototype for the rest.
 * @param {object} data akmon's `lazyHookData()`
 */
export function withOikosScript(data) {
  const browser = data.core.browser;
  const core = { ...data.core, browser: { ...browser, scripts: [...browser.scripts, OIKOS_SCRIPT] } };
  return Object.create(data, { core: { value: core } });
}

/** Whether the installation at `root` has an attach record: the browser is the user's own Chrome. */
export const attached = (root) => Boolean(root) && existsSync(join(root, '.local', '.browser', 'attach.json'));

/** The facts akmon's guard reads about a call: who drives it, in which mode, from where. */
function akmonOptions(payload, akmon, env) {
  return {
    actor: akmon.actorFromEnvironment(env),
    delegated: Boolean(payload.agent_id),
    permissionMode: typeof payload.permission_mode === 'string' ? payload.permission_mode : null,
    attended: akmon.attendedFromEnvironment(env),
    directory: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null,
  };
}

/**
 * The decision for one call, or null when the call does not drive the browser.
 * @param {object} payload the PreToolUse payload
 * @param {object} akmon {@link loadAkmon}
 * @param {{root: string|null, env: Record<string, string|undefined>}} where `root`: the installation
 *   (null outside one); `env`: the hook's environment, where the launcher states the actor
 * @returns {{decision: string, reason: string}|null}
 */
export function driveDecision(payload, akmon, { root, env }) {
  const tool = toolName(payload);
  const shell = isShell(payload);
  const command = shell ? (shellCommand(payload) ?? '') : '';
  const data = withOikosScript(akmon.lazyHookData());
  const options = akmonOptions(payload, akmon, env);
  const prefix = data.core.browser.mcp_prefix;
  const closes = tool.startsWith(prefix) && tool.slice(prefix.length).toLowerCase().includes(data.core.browser.mcp_close_word);
  if (closes && attached(root)) return { decision: 'deny', reason: data.core.browser_attached_close_reason };
  let result = akmon.browserGuardResult(data, shell ? 'Bash' : tool, command, options);
  if (result === null && shell && runsBrowserScript(command)) {
    result = akmon.browserGuardResult(data, 'Bash', SCRIPT_COMMAND, options);
  }
  if (result === null) return null;
  // akmon's own attach rule may answer an MCP close where the installation's record is not the one it reads
  const note = result.permissionReason === data.core.browser_attached_close_reason ? '' : INSTALLATION_NOTE;
  return { decision: result.permissionDecision, reason: `${result.permissionReason}${note}` };
}

/** What the guard looks at: a shell command that may name the browser tool, or a call of the MCP server. */
function candidate(payload) {
  if (isShell(payload)) {
    const command = shellCommand(payload);
    // akmon's matcher reads words with their quotes removed (`tool 'brow'ser`), and so does this filter
    return typeof command === 'string' && command.replace(/\$'/g, '').replace(/['"\\]/g, '').includes('browser');
  }
  return toolName(payload).startsWith(MCP_PREFIX);
}

/** The guard: a delegated agent or an autonomous run that drives the shared browser is denied; so is anyone closing an attached one. */
export async function run(payload) {
  if (!candidate(payload)) return;
  const akmon = await loadAkmon();
  if (!akmon) return; // no submodule, no browser tool to drive
  const answer = driveDecision(payload, akmon, { root: hookInstallation().root, env: process.env });
  if (answer) decide(payload, answer.decision, answer.reason);
}
