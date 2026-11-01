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
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
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

const MAX_LINKS = 40;
const SEPARATORS = sep === '\\' ? /[\\/]+/ : /\/+/;
/** The components of `text` after its root, the last first: the stack {@link realOf} works through. `.` and empty names are left out. */
const stackOf = (text) => text.slice(parse(text).root.length).split(SEPARATORS).filter((name) => name !== '' && name !== '.').reverse();

/** What the name `path` is: where it points when a symbolic link, null when a file or a folder, undefined when there is nothing (or it cannot be read); remembered in `known`. */
function linkOf(path, known) {
  if (known?.has(path)) return known.get(path);
  let found;
  try {
    found = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    found = undefined;
  }
  known?.set(path, found);
  return found;
}

/**
 * The real path of `path` (relative to `from`, the working folder by default), resolved component by
 * component as ADR 0007 D02 says: each symbolic link followed before the next `..` is applied (`link/..`
 * is the parent of what `link` leads to, never of `link`), the last component included. What does not
 * exist yet — a new file — is appended to the nearest folder that does, `.` and `..` applied to it as
 * written. The shell's own `cd` is logical (`cd link/..` stays above `link`); a file operation is not.
 * @param {string} path
 * @param {string} [from]
 * @param {Map<string, string|null|undefined>} [known] what earlier calls found at a name, to be reused by a caller that resolves many paths at once (valid while the file system does not change under it)
 * @returns {string}
 */
export function realOf(path, from = process.cwd(), known) {
  const text = String(path);
  const absolute = isAbsolute(text) ? text : `${resolve(from)}${sep}${text}`;
  const stack = stackOf(absolute);
  let current = parse(absolute).root;
  let links = 0;
  while (stack.length) {
    const name = stack.pop();
    if (name === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, name);
    const target = linkOf(next, known);
    if (target === undefined || (target !== null && ++links > MAX_LINKS)) return resolve(next, ...stack.reverse());
    if (target === null) {
      current = next;
      continue;
    }
    if (isAbsolute(target)) current = parse(target).root;
    stack.push(...stackOf(target));
  }
  return current;
}

/**
 * The real paths a file tool's `path` may reach — one, or two when they differ: the one {@link realOf}
 * gives (a link followed before the next `..`, as the kernel does), and the one of the path with its `..`
 * collapsed as text first, which is what a host does before it opens the file (`inst/oikos/../vault/x`
 * is then `inst/vault/x`, not a path above the core). A guard judges both and denies when either is denied.
 * @param {string} path
 * @param {string} [from]
 * @param {Map<string, string|null|undefined>} [known] as for {@link realOf}
 * @returns {string[]}
 */
export function realForms(path, from = process.cwd(), known) {
  const kernel = realOf(path, from, known);
  const collapsed = realOf(resolve(from, String(path)), from, known);
  return kernel === collapsed ? [kernel] : [kernel, collapsed];
}

/**
 * The identity of the file or folder `path` — its device and inode, as one string — or null when it does
 * not exist or the file system gives none. Two paths that name one file, however they are spelled
 * (a case variant on a file system that folds case, a bind mount, a link), have one identity.
 * @param {string} path
 * @returns {string|null}
 */
export function idOf(path) {
  try {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stat === undefined || stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * Whether `a` and `b` name one file: the same real path, or — a case variant on a file system that folds
 * case — the same folder and the same name up to case. Judged on the paths as {@link realOf} gives them.
 */
export function sameFile(a, b) {
  if (a === b) return true;
  const folder = idOf(dirname(a));
  return folder !== null && folder === idOf(dirname(b)) && basename(a).toLowerCase() === basename(b).toLowerCase();
}

/** Whether the real path `path` is `dir` itself or inside it (both real, as realOf gives them). */
export function isWithin(path, dir) {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The real root of a mount declared as `path` in the configuration: absolute, or relative to the
 * installation `root`, with every link resolved (a mount may be a link, a submodule, a mount point).
 */
export const mountRoot = (root, path) => realOf(path, root);

/** Whether `dir` is a repository top: it has a `.git` of its own, a folder or a submodule's file. */
export const isRepoTop = (dir) => existsSync(join(dir, '.git'));

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

/** The host variables that name the project folder of a session, in the order they are tried. */
const PROJECT_VARS = ['CLAUDE_PROJECT_DIR', 'QWEN_PROJECT_DIR'];

/**
 * { root, via } — the installation oikos works for and how it was found, or { root: null, problem }.
 * `env` and `cwd` are for tests; the result for the process itself is cached by installRoot().
 *
 * The CLI tools and the MCP servers take `OIKOS_HOME` first. A hook process (`hook`) takes the host's
 * project folder first, and `OIKOS_HOME` only when that is no installation: a hook reads the environment a
 * settings file's `env` key may have set, so the variable cannot be what decides which installation the
 * guards protect. A hook whose `OIKOS_HOME` is no installation, with no installation among the project
 * folders, comes back as `{ root: null, problem, brokenHome: true }` — the guards must not read that as
 * "nothing to check" — unless the host's project folder is the core repository (development), whatever
 * folder the hook process runs in.
 */
export function locateInstallation({ env = process.env, cwd, hook = false } = {}) {
  if (hook) {
    for (const name of PROJECT_VARS) {
      if (env[name] && isInstallation(env[name])) return { root: resolve(env[name]), via: name };
    }
  }
  if (env.OIKOS_HOME) {
    const dir = resolve(env.OIKOS_HOME);
    if (isInstallation(dir)) return { root: dir, via: 'OIKOS_HOME' };
    // Development is the host's project folder being the core: never where the hook process happens to run.
    const development = hook && PROJECT_VARS.some((name) => env[name] && isCore(env[name]));
    return {
      root: null,
      problem: `OIKOS_HOME=${env.OIKOS_HOME} is not an oikos installation (no ${INSTALL_FILE}, no oikos/ link)`,
      ...(hook && !development ? { brokenHome: true } : {}),
    };
  }
  for (const name of PROJECT_VARS) {
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

let hooked;
/**
 * {@link locateInstallation} for a hook process, cached: the installation the guards protect and, when
 * `OIKOS_HOME` is set and leads to none (`brokenHome`), the problem. Every guard entry goes through this,
 * never through {@link installRoot}.
 */
export function hookInstallation() {
  hooked ??= locateInstallation({ hook: true });
  return hooked;
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

/**
 * The stores a tool keeps in `.local/`, each under a dot name the secret guard keeps closed
 * (ADR 0002 D02), with the place it had before (D03). `oikos sync` moves a store from `legacy` to
 * `parts` (tools/common/local-stores.mjs); until then the tools use it where it is.
 */
export const LOCAL_STORES = Object.freeze({
  google: Object.freeze({ parts: Object.freeze(['.secrets', 'google']), legacy: Object.freeze(['google']) }),
  browser: Object.freeze({ parts: Object.freeze(['.browser']), legacy: Object.freeze(['browser']) }),
});

/**
 * The folder of the store `name` (a key of LOCAL_STORES) in `.local/`: its place, or its legacy
 * place while only that exists. Throws when there is no installation.
 */
export function localStorePath(name) {
  const { parts, legacy } = LOCAL_STORES[name];
  const now = localPath(...parts);
  const old = localPath(...legacy);
  return !existsSync(now) && existsSync(old) ? old : now;
}
