// The two roots, on their own so that env.mjs and config.mjs can both use them without a cycle.
//
// CORE_ROOT is where oikos's code is: skills, tools, programs a tool installed. Node gives
// `import.meta.url` with symlinks resolved, so through an installation's `oikos/` link it is still
// the core checkout — which is why it never tells which installation oikos works for.
//
// The installation is found from where oikos runs, in this order:
//   1. OIKOS_HOME — set explicitly (the MCP servers `sync` writes carry it);
//   2. CLAUDE_PROJECT_DIR / QWEN_PROJECT_DIR — the agent host's project folder (set for hooks);
//   3. the working folder and its parents (npm's INIT_CWD and the shell's logical PWD first, so a
//      path through the `oikos/` link still leads back to the installation).
// A folder is an installation when it holds `oikos.yaml` or an `oikos` entry leading to this core;
// the core itself never is one. None found is an error for a tool that needs it, never a fallback
// to the core — the core keeps nothing of any installation.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The installation's configuration file, at its root. */
export const INSTALL_FILE = 'oikos.yaml';

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The real path of `path`, through the nearest folder that exists (a new file is not there yet). */
export function realOf(path) {
  const rest = [];
  let at = resolve(path);
  while (!existsSync(at) && dirname(at) !== at) {
    rest.unshift(basename(at));
    at = dirname(at);
  }
  return join(real(at) || at, ...rest);
}

/** Whether `dir` is the core checkout this code runs from (through any link). */
export const isCore = (dir) => real(dir) === real(CORE_ROOT);

/** Whether `dir` is an oikos installation: `oikos.yaml`, or an `oikos` entry leading to this core. */
export function isInstallation(dir) {
  if (!dir || !isDir(dir) || isCore(dir)) return false;
  return existsSync(join(dir, INSTALL_FILE)) || real(join(dir, 'oikos')) === real(CORE_ROOT);
}

/** The installation `start` or one of its parents is, or null. */
export function findUp(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (isInstallation(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** The working folder as the user typed it: the shell's PWD when it is the same folder as cwd. */
function logicalCwd() {
  const cwd = process.cwd();
  const pwd = process.env.PWD;
  return pwd && real(pwd) === real(cwd) ? pwd : cwd;
}

/**
 * { root, via } — the installation oikos works for and how it was found, or { root: null, problem }.
 * `env` and `cwd` are for tests; the result for the process itself is cached by installRoot().
 */
export function locateInstallation({ env = process.env, cwd } = {}) {
  if (env.OIKOS_HOME) {
    const dir = resolve(env.OIKOS_HOME);
    return isInstallation(dir)
      ? { root: dir, via: 'OIKOS_HOME' }
      : { root: null, problem: `OIKOS_HOME=${env.OIKOS_HOME} is not an oikos installation (no ${INSTALL_FILE}, no oikos/ link)` };
  }
  for (const name of ['CLAUDE_PROJECT_DIR', 'QWEN_PROJECT_DIR']) {
    if (env[name] && isInstallation(env[name])) return { root: resolve(env[name]), via: name };
  }
  const starts = cwd ? [cwd] : [env.INIT_CWD, logicalCwd()].filter(Boolean);
  for (const start of starts) {
    const found = findUp(start);
    if (found) return { root: found, via: 'cwd' };
  }
  return {
    root: null,
    problem: `no oikos installation here (${starts[starts.length - 1]}): run oikos from an installation folder — one with ${INSTALL_FILE} `
      + `and oikos/ — or set OIKOS_HOME to it${isCore(starts[starts.length - 1]) ? '; this is the oikos core repository, which is not an installation' : ''}`,
  };
}

let located;
/** The installation's root, or null when oikos runs outside any (the core repository). */
export function installRoot() {
  located ??= locateInstallation();
  return located.root;
}

/** Why there is no installation, or null when there is one. */
export const installProblem = () => (installRoot() ? null : located.problem);

/** A path inside the installation; throws (a usage error) when there is none. */
export function installPath(...parts) {
  const root = installRoot();
  if (!root) {
    const e = new Error(located.problem);
    e.name = 'NoInstallation';
    throw e;
  }
  return join(root, ...parts);
}

/** How a path in the core is written for the agent: `oikos/skills/…` from an installation, `skills/…` in the core. */
export const coreLabel = (rel) => `${installRoot() ? 'oikos/' : ''}${rel}`;

/** A path in the installation's private `.local/` folder; throws when there is no installation. */
export const localPath = (...parts) => installPath('.local', ...parts);
