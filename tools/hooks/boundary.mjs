// The boundary of an installation as the hooks judge it (ADR 0007 D02 and D05): which mounts are
// guarded, which paths belong to another installation, which folders lie above this installation, and
// which file a write would reach through a second name. A path is judged as D02 says: resolved
// component by component (`realOf`, links followed before the next `..`), and its containment in a
// mount, an installation or the core decided by device and inode of its ancestors, so a case variant
// on a file system that folds case or a second route to the same folder does not slip past a string
// comparison. The guards read the configuration once, at their entry point, through
// {@link boundaryOf}, and pass the result down.
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CORE_ROOT, INSTALL_FILE, idOf, isInstallation, isWithin, realOf } from '../common/paths.mjs';
import { config } from '../common/config.mjs';
import { LOCAL_MOUNTS_FILE, declaredMountKeys, guardedRoots, problemsOf } from '../common/mounts.mjs';

/**
 * The mounts a guard keeps closed (D01: a problem never opens a guard): the configured ones; the roots
 * of the entries of `mounts:` that are not mounts — a bad path, a value that is no mapping, a path under
 * `oikos/`, a path declared twice — and of the keys of a file that does not parse (`config().guarded`);
 * and the roots recorded in `.local/sync.json`. When the configuration cannot be resolved at all (D02), the paths both mounts files name stand in for `config().guarded`, and no configured mount opens a read. Each root once; only a configured mount has a `use`, and `flawed` says the resolution reports a problem for it.
 */
export function guardedMounts(install) {
  let mounts = [];
  let dropped;
  try {
    const { mounts: resolved, guarded = [], problems = [] } = config();
    mounts = resolved.map((m) => ({ ...m, flawed: problemsOf(m, problems).length > 0 }));
    dropped = guarded;
  } catch {
    dropped = declaredRoots(install); // the configuration cannot be resolved (D02): what both files name stays guarded, and nothing opens a read
  }
  let recorded = {};
  try {
    recorded = JSON.parse(readFileSync(resolve(install, '.local', 'sync.json'), 'utf8')).mounts ?? {};
  } catch { /* no record, or one that does not read */ }
  const roots = typeof recorded === 'object' && recorded !== null ? Object.keys(recorded) : [];
  const guarded = [...mounts];
  for (const { path, root } of [...dropped, ...roots.map((root) => ({ path: root, root }))]) {
    if (!guarded.some((m) => m.root === root)) guarded.push({ path, root });
  }
  return guarded;
}

/** The roots both mounts files name under `mounts:`, `{ path, layer, root }` each, found without resolving the configuration; a file that cannot be read names none. */
function declaredRoots(install) {
  return [['shared', resolve(install, INSTALL_FILE)], ['local', resolve(install, '.local', LOCAL_MOUNTS_FILE)]].flatMap(([layer, file]) => {
    try {
      return guardedRoots(install, declaredMountKeys(readFileSync(file, 'utf8')), layer);
    } catch {
      return [];
    }
  });
}

/**
 * What the boundary checks need, read once: this installation's real root, the real core, the guarded
 * mounts, each with its identity (`id`), and caches of identities, of nearest installations and of the
 * links met in resolving paths (`links`, for `realOf`). A mount
 * with a `use` list is a configured one; a recorded root has none and is guarded for writes only, never
 * a registration of a linked installation.
 * @param {string} install the installation's root
 */
export function boundaryOf(install) {
  const boundary = { ids: new Map(), nearest: new Map(), links: new Map(), mounts: [] };
  Object.assign(boundary, installOf(install, boundary));
  boundary.mounts = guardedMounts(install).map((m) => ({ ...m, id: idIn(m.root, boundary) }));
  return boundary;
}

/**
 * The part of a boundary a search scope needs: this installation's real root and the identities of it
 * and of every folder above it. `boundary` is the cache the identities go through.
 */
export function installOf(install, boundary = { ids: new Map() }) {
  const root = realOf(install);
  const chain = new Set();
  for (let dir = root; ; dir = dirname(dir)) {
    const id = idIn(dir, boundary);
    if (id !== null) chain.add(id);
    if (dirname(dir) === dir) break;
  }
  const core = realOf(CORE_ROOT);
  return { ids: boundary.ids, install: root, installId: idIn(root, boundary), installChain: chain, core, coreId: idIn(core, boundary) };
}

/** The identity of `path` through the boundary's cache. */
function idIn(path, boundary) {
  if (!boundary.ids.has(path)) boundary.ids.set(path, idOf(path));
  return boundary.ids.get(path);
}

/** Whether the real path `path` is the folder `root` or inside it, whose identity is `id`: by the string, or by the identity of `path` or any of its ancestors. */
export function inside(path, root, id, boundary) {
  if (isWithin(path, root)) return true;
  if (id === null) return false;
  for (let dir = path; ; dir = dirname(dir)) {
    if (idIn(dir, boundary) === id) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** The guarded mount that holds the real path `path`, or null. */
export const mountHolding = (path, boundary) => boundary.mounts.find((m) => inside(path, m.root, m.id, boundary)) ?? null;

/** Whether the mount `m` is one a read may pass through: configured, with no problem of its own (D01: a problem never opens a guard), and not an installation used for something; a registered linked installation has no `use`. */
function opensReads(m) {
  if (!Array.isArray(m.use) || m.flawed) return false;
  return m.use.length === 0 || !isInstallation(m.root);
}

/** The nearest ancestor of the real path `path` (itself included) that `isInstallation` accepts, or null; memoized in `boundary.nearest`. */
export function nearestInstallation(path, boundary) {
  const walked = [];
  let found = null;
  for (let dir = path; ; dir = dirname(dir)) {
    if (boundary.nearest.has(dir)) { found = boundary.nearest.get(dir); break; }
    walked.push(dir);
    if (isInstallation(dir)) { found = dir; break; }
    if (dirname(dir) === dir) break;
  }
  for (const dir of walked) boundary.nearest.set(dir, found);
  return found;
}

/**
 * The root of the other installation the real path `path` belongs to, registered or not, or null: the
 * nearest installation above it that is not this one. The core is never one (D05, whatever sits under
 * it); a folder inside no installation belongs to none. A write is judged by this: registering an
 * installation opens its reads ({@link foreignInstallation}), never its writes.
 * @param {string} path a real path
 * @param {ReturnType<typeof boundaryOf>} boundary
 * @returns {string|null}
 */
export function otherInstallation(path, boundary) {
  if (inside(path, boundary.core, boundary.coreId, boundary)) return null;
  const near = nearestInstallation(path, boundary);
  if (near === null || near === boundary.install) return null;
  const id = idIn(near, boundary);
  return id !== null && id === boundary.installId ? null : near;
}

/**
 * The root of the other installation the real path `path` belongs to that a read may not reach, or
 * null: it is inside this installation, the core, a registered mount (a repository, or a linked
 * installation registered without `use`), or no installation at all.
 * @param {string} path a real path
 * @param {ReturnType<typeof boundaryOf>} boundary
 * @returns {string|null}
 */
export function foreignInstallation(path, boundary) {
  if (boundary.mounts.some((m) => opensReads(m) && inside(path, m.root, m.id, boundary))) return null;
  return otherInstallation(path, boundary);
}

/** Whether the real path `path` is a folder above this installation's root — a scope that reaches every installation beside it. */
export function aboveInstallation(path, boundary) {
  if (path === boundary.install) return false;
  if (isWithin(boundary.install, path)) return true;
  const id = idIn(path, boundary);
  return id !== null && id !== boundary.installId && boundary.installChain.has(id);
}

/** The reason for a scope above the installation, `what` searching `scope` (`real`). */
export const scopeReason = (what, scope, real) => `oikos boundary guard: ${what} would search ${scope} (${real}), a folder above this installation, which reaches every `
  + 'installation beside it (ADR 0007 D05). Search inside this installation or a registered mount, or name the folder to search.';

/** Whether the real path `path` is a file with more than one hard link: a write through it changes every other name of the file too, which may lie in a mount or another installation (D02). */
export function hardLinked(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.nlink > 1;
  } catch {
    return false;
  }
}

/** The reason for a write to a file with more than one hard link, as `what` writes to `path`. */
export const hardLinkReason = (what, path) => `oikos boundary guard: ${what} writes to ${path}, a file with more than one hard link — a write through it changes every other name of the file `
  + 'too, which may lie in a mount or in another installation (ADR 0007 D02). Write a new file instead, or remove the extra link first.';

/** The reason for a read that reaches another installation not registered as a mount, `what` reading `named` (real path `real`, in the installation `other`). */
export const foreignReadReason = (what, named, real, other) => `oikos boundary guard: ${what} reads ${named} (${real}), which is in another installation (${other}) that is not `
  + 'registered as a mount (ADR 0007 D05). To read it, register it as a mount without `use`: '
  + `\`node oikos/tools/setup/cli.mjs mount add ${other} --personal --dry-run\`. Material moves between installations only through \`setup transfer\`, run in the receiving installation.`;

/** The reason for a write into another installation, registered or not, `what` writing to `named` (real path `real`, in the installation `other`). */
export const foreignWriteReason = (what, named, real, other) => `oikos boundary guard: ${what} writes to ${named} (${real}), which is in another installation (${other}) — an installation `
  + 'writes only into itself, registered as a mount or not (ADR 0007 D02, D05). Open a session in that installation to change it; to bring material here, run '
  + '`setup transfer <file> --dry-run` in the receiving installation.';

/**
 * The reason for a guard check that threw: the call is denied instead of let through unchecked, since a
 * hook that fails open skips every rule behind the failure. `guard` is the guard's name as its messages
 * spell it, `check` the check that failed, `what` the call it was judging.
 */
export const failedCheckReason = (guard, check, what, error) => `oikos ${guard}: the ${check} could not run on ${what} (${error instanceof Error ? error.message : String(error)}), `
  + 'so the call is denied instead of let through unchecked. The user can do it themselves.';
