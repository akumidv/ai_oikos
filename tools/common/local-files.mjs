// The path rule for a local file a tool carries somewhere else — uploaded by `jira attach` and the
// image lines of a Jira text, copied into a work package by `handoff park` (ADR 0005 D02). What the
// agent may not read (the secret guard, tools/hooks/), a tool may not carry: a file lies inside the
// allowed roots (the installation, and what the caller adds), never in a closed store of `.local/`
// (a dot name there or a legacy store — ADR 0002 D01), never an `.env*` file, and with no dot-named
// component outside a working folder of `.local/` (`.claude/`, `.mcp.json`, `.git/` are the
// installation's configuration and tooling). Each file is judged by its real path, a symlink followed.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { UsageError } from './cli.mjs';
import { installRoot } from './paths.mjs';
import { isEnvFile, isLocalStore } from '../hooks/host.mjs';

/** The installation's private folder, whose first names decide what is closed (ADR 0002 D01). */
export const PRIVATE_FOLDER = '.local';

/** A target written as a home (`~`) or network (`\\host`, `//host`) path: never read, whatever it resolves to. */
export const HOME_OR_NETWORK = /^(?:~|\\\\|\/\/)/;

/** Whether `path` is `root` or lies below it (both real, absolute). */
export const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
// A file system that does not tell `.Local` from `.local` (Windows, macOS by default) is judged by
// folded names, as tools/hooks/host.mjs judges `.local/` store names.
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin';
const folded = (path) => (FOLDS_CASE ? path.toLowerCase() : path);
/** {@link inside}, by folded names where the file system folds case. */
export const insideFolded = (path, root) => inside(folded(path), folded(root));

/**
 * Where a relative path starts and the folders a local file may come from: the installation, and
 * the markdown file `file`'s folder when an image line's text came from --file (`--text` has no
 * folder of its own). `locals` is the installation's `.local/` by its path and its real path, so a
 * symlinked `.local` is judged where it points; `where` names the allowed folders in a refusal.
 */
export function fileRoots(file, where) {
  const install = installRoot() ? realpathSync(installRoot()) : null;
  const allowed = install ? [install] : [];
  const local = install ? join(install, PRIVATE_FOLDER) : null;
  const locals = local ? [...new Set([local, ...(existsSync(local) ? [realpathSync(local)] : [])])] : [];
  if (!file) return { base: process.cwd(), allowed, locals, install, where };
  const base = dirname(realpathSync(file));
  return { base, allowed: [...allowed, base], locals, install, where };
}

/**
 * The closed store of the installation's `.local/` that the real `path` lies in, as `.local/<name>`,
 * or null. A store is closed by its first name there (ADR 0002 D01) — a dot name (`.env`,
 * `.secrets/`) or a legacy store, by the secret guard's own rule (isLocalStore); any other name
 * (`cv/`, `notes/`, a file) is the user's working material and open.
 */
export function closedStore(path, roots) {
  for (const local of roots.locals) {
    if (!insideFolded(path, local)) continue;
    const first = path.slice(local.length).split(/[\\/]/).find(Boolean);
    if (!first) return PRIVATE_FOLDER;
    const named = `${PRIVATE_FOLDER}/${first}`;
    if (isLocalStore(named, roots.install)) return named;
  }
  return null;
}

/**
 * The first dot-named component (`.claude`, `.mcp.json`, `.git`) of the real `path` below each
 * allowed root it lies in, or null. Outside the working folders of `.local/` a dot name is the
 * installation's configuration or tooling (its settings, MCP servers, git) and never sent out;
 * inside an open working folder (`.local/<name>/…`, closedStore judges the stores) none is judged.
 */
export function dotComponent(path, roots) {
  if (roots.locals.some((local) => insideFolded(path, local))) return null;
  for (const root of roots.allowed) {
    if (!inside(path, root)) continue;
    const dotted = path.slice(root.length).split(/[\\/]/).find((part) => part.startsWith('.'));
    if (dotted) return dotted;
  }
  return null;
}

/**
 * Why `path` may not be carried by its names, or null: it lies in a closed store of `.local/`
 * (closedStore), is a `.env` file, or has a dot-named component outside a working folder of
 * `.local/` (dotComponent). Judges the path as given, so it serves a real path and the path a
 * symlink is reached by alike.
 */
export function nameProblem(path, roots) {
  const store = closedStore(path, roots);
  if (store) return `it is in ${store}, a closed store of the installation's private ${PRIVATE_FOLDER}/ folder (a dot name there is never read)`;
  if (isEnvFile(path)) return `${basename(path)} is a .env file, never read`;
  const dotted = dotComponent(path, roots);
  if (dotted) return `it is under ${dotted}, a dot-named file or folder (configuration or tooling such as .claude/, .mcp.json, .git/ — never sent out); outside a working folder of ${PRIVATE_FOLDER}/ a dot name is never read`;
  return null;
}

/** Why the real `path` may not be carried, or null: outside `roots.allowed`, or what nameProblem finds. */
export function pathProblem(path, roots) {
  if (!roots.allowed.some((root) => inside(path, root))) return `it resolves outside ${roots.where}`;
  return nameProblem(path, roots);
}

/**
 * The local file `target` as { target, name, path, size, mime }: a file of one of `types` (suffix →
 * MIME type) whose real path (a symlink followed, a loop refused) passes pathProblem — inside one of
 * `roots.allowed`, outside a closed store of `.local/`, not a `.env` file, with no dot-named
 * component outside a working folder of `.local/` — at most `maxBytes` long.
 * What the text alone shows is judged before the filesystem is touched; `what` names the file in a
 * refusal (image, file) and `verb` what is done with files of `types` (uploaded, attached).
 */
export function localFile(target, roots, { what, types, verb, maxBytes = Infinity }) {
  const refused = (why) => new UsageError(`Refusing ${what} '${target}': ${why}.`);
  const only = `only ${Object.keys(types).join(', ')} files are ${verb}`;
  const typeOf = (path) => types[extname(path).toLowerCase()];
  if (HOME_OR_NETWORK.test(target)) throw refused(`a home or network path is not read — name a file in ${roots.where}`);
  if (!typeOf(target)) throw refused(`${extname(target) ? `the type ${extname(target)} is not ${verb}` : 'it has no suffix'}; ${only}`);
  let path;
  try {
    path = realpathSync(resolve(roots.base, target));
  } catch (e) {
    throw refused(`the path cannot be resolved (${e.code || e.message})`);
  }
  if (!typeOf(path)) throw refused(`it resolves to ${basename(path)}; ${only}`);
  const problem = pathProblem(path, roots);
  if (problem) throw refused(problem);
  const stat = statSync(path);
  if (!stat.isFile()) throw new UsageError(`${what[0].toUpperCase()}${what.slice(1)} '${target}' is not a file (${path}).`);
  if (stat.size > maxBytes) throw refused(`it is ${stat.size} bytes, over the ${maxBytes}-byte limit of one file`);
  return { target, name: basename(path), path, size: stat.size, mime: typeOf(path) };
}
