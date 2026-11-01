// Editing the declaration of mounts (docs/design/mounts.md): `setup mount add|remove` changes the
// `mounts:` part of `oikos.yaml` (the shared layer) or of `.local/mounts.yaml` (the personal layer) by
// splicing the text (yaml-splice.mjs), so every comment and every other key stays. The result is
// parsed again and must equal the intended configuration, and both layers are resolved
// (mounts.mjs resolveMounts): a change that brings a problem is refused, so a mount the person typed
// wrongly is never written. Nothing here writes a file; `changeMounts` returns the new text.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { UsageError } from './cli.mjs';
import { INSTALL_FILE, isWithin, mountRoot, realOf } from './paths.mjs';
import { LOCAL_MOUNTS_FILE, MOUNT_USES, resolveMounts } from './mounts.mjs';
import { addUnder, applied, contentEnd, keyOf, lineEnd, lineStart, parsed, splice } from './yaml-splice.mjs';

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
const trimmed = (path) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/**
 * The entry of a new mount from what `setup mount add` was given: `use` (a list of MOUNT_USES), and
 * `skills` (`only`, `prefix`, `tracked`) and `wiki` (`name`) blocks when asked for. A read-only mount (no
 * use) is null. An option for a use the mount does not have is a usage error.
 * @param {{use?: string[], only?: string[], prefix?: string, wikiName?: string, tracked?: boolean}} spec
 * @returns {object|null}
 */
export function mountEntry({ use = [], only, prefix, wikiName, tracked }) {
  for (const name of use) if (!MOUNT_USES.includes(name)) throw new UsageError(`--use ${name}: one of ${MOUNT_USES.join(', ')}`);
  const blocks = {
    skills: present({ prefix, only, tracked }),
    wiki: present({ name: wikiName }),
  };
  const options = { skills: '--skills-only, --prefix and --tracked-pointers belong to a mount used for skills', wiki: '--wiki-name belongs to a mount used as a wiki' };
  for (const [name, block] of Object.entries(blocks)) if (block && !use.includes(name)) throw new UsageError(`${options[name]}: add --use ${name}`);
  return use.length ? { use, ...Object.fromEntries(Object.entries(blocks).filter(([, block]) => block)) } : null;
}

/** The mapping of the values of `fields` that were given (not undefined, false or an empty list), or null when none was. */
function present(fields) {
  const given = (value) => value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0);
  const kept = Object.entries(fields).filter(([, value]) => given(value));
  return kept.length ? Object.fromEntries(kept) : null;
}

/** The mount path as the layer file says it: no trailing `/`; for the shared layer an absolute path inside the installation is made relative to it. */
export function mountKey(root, path, layer) {
  const key = trimmed(String(path).trim());
  if (layer !== 'shared' || !isAbsolute(key)) return key;
  const real = realOf(key);
  return isWithin(real, realOf(root)) ? relative(realpathSync(root), real) || key : key;
}

/** The text of a layer's file, '' when it does not exist. */
const textOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** The `mounts:` mapping of a layer's text, `{}` when absent; a text that does not parse is a usage error naming `label`. */
function mountsIn(text, label) {
  const mounts = parsed(text, label).toJS()?.mounts;
  return isMap(mounts) ? mounts : {};
}

/** `text` with the mount `key` added as `entry`; a key that is declared already is refused. */
function withMount(text, key, entry, label) {
  const doc = parsed(text, label);
  const current = doc.toJS() || {};
  if (current.mounts !== undefined && current.mounts !== null && !isMap(current.mounts)) throw new UsageError(`${label}: mounts must be a mapping`);
  if (isMap(current.mounts) && Object.hasOwn(current.mounts, key)) throw new UsageError(`${label}: mounts.${key} is declared already — remove it first`);
  const out = applied(text, addUnder(text, doc, ['mounts'], { [key]: entry }, label));
  return verified(out, { ...current, mounts: { ...current.mounts, [key]: entry } }, label);
}

/** `text` without the mount whose key is `key` or whose path leads to the real root of `key` (`root` the installation's). */
function withoutMount(text, key, root, label) {
  const doc = parsed(text, label);
  const node = doc.get('mounts', true);
  const wanted = mountRoot(root, key);
  const pair = YAML.isMap(node) ? node.items.find((p) => String(keyOf(p)) === key || mountRoot(root, String(keyOf(p))) === wanted) : undefined;
  if (!pair) throw new UsageError(`${label}: mounts.${key} is not declared there`);
  if (node.flow) throw new UsageError(`${label}: mounts is written as a flow mapping — remove the entry by hand`);
  const end = pair.value?.range ? contentEnd(text, pair.value) : pair.key.range[1];
  const out = applied(text, [splice(lineStart(text, pair.key.range[0]), Math.min(text.length, lineEnd(text, end) + 1), '')]);
  const intended = doc.toJS();
  delete intended.mounts[String(keyOf(pair))];
  return verified(out, intended, label);
}

/** `out` when it parses to `intended` (an empty `mounts:` and an absent one are the same), else a usage error: the layout could not be kept. */
function verified(out, intended, label) {
  const result = YAML.parseDocument(out);
  const normal = (data) => ({ ...data, mounts: data?.mounts ?? {} });
  if (result.errors.length || !isDeepStrictEqual(normal(result.toJS() || {}), normal(intended))) {
    throw new UsageError(`the edit of ${label} could not keep its layout — nothing written; make the change by hand`);
  }
  return out;
}

/**
 * The change of `layer` ('shared': `oikos.yaml`, 'local': `.local/mounts.yaml`) in the installation
 * `root`: `{ add: { path, entry } }` or `{ remove: path }`. Returns the file, its text before and
 * after, and the problems the change brings — those of resolving both layers after it that were not
 * there before it. Throws a usage error when the change cannot be made (a key declared already, none
 * to remove, a file that does not parse, a layout the splice cannot keep).
 * @param {string} root the installation's root
 * @param {'shared'|'local'} layer
 * @param {{add?: {path: string, entry: object|null}, remove?: string}} change
 * @returns {{file: string, label: string, before: string, after: string, problems: string[]}}
 */
export function changeMounts(root, layer, change) {
  const files = { shared: join(root, INSTALL_FILE), local: join(root, '.local', LOCAL_MOUNTS_FILE) };
  const labels = { shared: INSTALL_FILE, local: `.local/${LOCAL_MOUNTS_FILE}` };
  const texts = { shared: textOf(files.shared), local: textOf(files.local) };
  const before = texts[layer];
  const label = labels[layer];
  const after = change.add
    ? withMount(before, mountKey(root, change.add.path, layer), change.add.entry, label)
    : withoutMount(before, mountKey(root, change.remove, layer), root, label);
  const problemsOf = (layers) => resolveMounts(root, mountsIn(layers.shared, labels.shared), mountsIn(layers.local, labels.local)).problems;
  const known = new Set(problemsOf(texts));
  const problems = problemsOf({ ...texts, [layer]: after }).filter((problem) => !known.has(problem));
  return { file: files[layer], label, before, after, problems };
}
