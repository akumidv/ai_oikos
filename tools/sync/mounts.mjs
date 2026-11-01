// What `sync` writes for the installation's mounts (docs/design/mounts.md § What `sync` writes per
// mount, items 1-3), computed from the resolved mounts (common/mounts.mjs) as a list of file edits
// that cli.mjs applies — or, under `--check`, only compares:
//
// 1. the installation does not load an inside mount's rules: `claudeMdExcludes` in its
//    `.claude/settings.local.json` names the mount's CLAUDE.md, CLAUDE.local.md and `.claude/rules/`;
// 2. an inside mount does not load the installation's rules: `claudeMdExcludes` in the mount's own
//    `.claude/settings.local.json` names the CLAUDE.md and CLAUDE.local.md of the installation root
//    and of every folder between it and the mount — the mount's other keys and entries stay;
// 3. nothing written inside a mount reaches its commits: each file written there goes into the
//    mount's `.git/info/exclude`, unless git already ignores it.
//
// An outside mount is not under the installation's start folder, so items 1 and 2 are moot for it;
// it gets its real path in the installation's `permissions.additionalDirectories` instead.
//
// The skill pointers of a mount (item 4) are written by cli.mjs with the others (pointers.mjs); what
// this module adds is their place in git: a pointer that names this machine's path (an outside
// mount's, a local-layer mount's) goes into the installation's own `.git/info/exclude`, and the
// lines are recorded like the rest.
//
// Sync replaces only what it wrote. Every entry it adds is recorded per mount root in
// `.local/sync.json` (the `mounts` key, the shape of the `Wired` record below), so an entry it finds
// already there stays the person's. A mount that disappears from the configuration (or whose
// repository is not there) keeps its wiring — entries, pointers and record — and sync only says so
// (`pending`); the wiring goes, exactly the entries recorded for it, only when sync is asked to
// `prune` (D-A9-GUARD-FILES d). Absolute paths appear only in git-ignored local files.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { isRepoTop } from '../common/paths.mjs';
import { HOSTS, hostNames } from '../hooks/wiring.mjs';

const SETTINGS = '.claude/settings.local.json';

/**
 * What sync wrote for one mount, by mount root in `.local/sync.json`; a field is absent when empty.
 * @typedef {object} Wired
 * @property {string[]} [installExcludes] entries it added to the installation's `claudeMdExcludes`
 * @property {string[]} [installDirs] entries it added to the installation's `permissions.additionalDirectories`
 * @property {string[]} [excludes] entries it added to `claudeMdExcludes` of the mount's own settings file
 * @property {boolean} [created] it created the mount's settings file (and removes it when emptied)
 * @property {string[]} [ignored] lines it added to the mount's `.git/info/exclude`
 * @property {string[]} [pointers] names of the skill pointers it wrote for the mount's skills
 * @property {string[]} [installIgnored] lines it added to the installation's own `.git/info/exclude`, for the pointers kept out of its commits
 */

/**
 * One file change: the new text, or `content: null` to remove the file.
 * @typedef {object} Edit
 * @property {string} path
 * @property {string|null} content
 * @property {string} label
 */

const json = (data) => `${JSON.stringify(data, null, 2)}\n`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** `have` with the entries of `owned` that are no longer `want`ed dropped and the missing `want`ed ones added; `owned` is then what sync owns among `want`. */
function reconcile(have, want, owned) {
  const kept = have.filter((entry) => !owned.includes(entry) || want.includes(entry));
  const added = want.filter((entry) => !kept.includes(entry));
  return { list: [...kept, ...added], owned: want.filter((entry) => owned.includes(entry) || added.includes(entry)) };
}

/** Why a parsed settings file cannot be edited by sync (a list key that is not a list), or null. */
function shapeProblem(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'not a JSON object';
  if (![data.claudeMdExcludes, data.permissions?.additionalDirectories].every((v) => v === undefined || Array.isArray(v))) {
    return 'claudeMdExcludes and permissions.additionalDirectories must be lists';
  }
  return null;
}

/** The settings file at `path` as an object ({} when absent), or null with a problem when it is not one sync can edit. */
function load(path, label, problems) {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const bad = shapeProblem(data);
    if (bad) throw new Error(bad);
    return data;
  } catch (e) {
    problems.push(`${label}: cannot add the mount wiring (${e.message.split('\n')[0]})`);
    return null;
  }
}

/** `object` with `key` set to `list`, or without it when `list` is empty. */
function withList(object, key, list) {
  const next = { ...object };
  if (list.length) next[key] = list;
  else delete next[key];
  return next;
}

const rulesOf = (root) => [`${root}/**/CLAUDE.md`, `${root}/**/CLAUDE.local.md`, `${root}/**/.claude/rules/**`];

/** Item 2's entries: CLAUDE.md and CLAUDE.local.md of the installation root and of each folder between it and the mount. */
function installationRulesOf(install, root) {
  const folders = [install];
  for (const part of relative(install, root).split(sep).slice(0, -1)) folders.push(join(folders[folders.length - 1], part));
  return folders.flatMap((dir) => [join(dir, 'CLAUDE.md'), join(dir, 'CLAUDE.local.md')]);
}

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

/** The mount's `.git/info/exclude`, wherever its repository keeps it (a submodule's `.git` is a file). */
function excludeFile(root) {
  const r = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  if (r.status !== 0) throw new Error(`git does not know ${root} as a repository (${String(r.stderr).split('\n')[0]})`);
  return r.stdout.trim();
}

/** Whether git already ignores `file` (relative to the repository `root`); anything but yes or no is an error. */
function ignores(root, file) {
  const r = git(root, ['check-ignore', '-q', '--', file]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(`git check-ignore failed in ${root} (${String(r.stderr).split('\n')[0]})`);
}

/**
 * Item 3 for one mount: the `.git/info/exclude` change that keeps `files` (relative paths sync
 * writes in it) out of its commits, and the lines sync then owns. A line sync owns and finds is
 * kept; one it no longer wants goes; a file git already ignores gets no line.
 * @returns {{edit: Edit|null, owned: string[]}}
 */
function ignoreFiles(root, files, label, owned) {
  const path = files.length || owned.length ? excludeFile(root) : null;
  if (!path) return { edit: null, owned: [] };
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = text.split('\n');
  const mine = [];
  const add = [];
  for (const file of files) {
    const line = `/${file}`;
    if (owned.includes(line) && lines.includes(line)) mine.push(line);
    else if (!ignores(root, file)) { mine.push(line); add.push(line); }
  }
  const drop = owned.filter((line) => !mine.includes(line) && lines.includes(line));
  if (!add.length && !drop.length) return { edit: null, owned: mine };
  const kept = lines.filter((line) => !drop.includes(line));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const all = [...kept, ...add];
  return { edit: { path, content: all.length ? `${all.join('\n')}\n` : '', label }, owned: mine };
}

const pick = (record, key) => (record[key] ?? []);
const union = (records, key) => Object.values(records).flatMap((r) => pick(r, key));

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * The roots an earlier sync wired that no longer have a mount to wire: not configured, or not a
 * repository top.
 * @param {object[]} mounts the resolved mounts
 * @param {Record<string, Wired>|undefined} recorded
 * @returns {string[]}
 */
export function goneRoots(mounts, recorded) {
  return isMap(recorded) ? Object.keys(recorded).filter((root) => !mounts.some((m) => m.root === root && isRepoTop(m.root))) : [];
}

/** What a record says sync wired for one mount, in words: `3 claudeMdExcludes entries in … ; the pointers a, b`. */
export function describeWiring(root, record = {}) {
  const count = (list, one, many) => (list?.length ? [`${list.length} ${list.length === 1 ? one : many}`] : []);
  return [
    ...count(record.installExcludes, `claudeMdExcludes entry in ${SETTINGS}`, `claudeMdExcludes entries in ${SETTINGS}`),
    ...count(record.installDirs, `additionalDirectories entry in ${SETTINGS}`, `additionalDirectories entries in ${SETTINGS}`),
    ...count(record.excludes, `claudeMdExcludes entry in ${root}/${SETTINGS}`, `claudeMdExcludes entries in ${root}/${SETTINGS}`),
    ...count(record.ignored, `line in ${root}/.git/info/exclude`, `lines in ${root}/.git/info/exclude`),
    ...count(record.installIgnored, "line in the installation's .git/info/exclude", "lines in the installation's .git/info/exclude"),
    ...(record.pointers?.length ? [`the pointers ${record.pointers.join(', ')}`] : []),
  ].join('; ');
}

/** Items 1 and the outside mounts' directories: the installation's own `.claude/settings.local.json`. */
function wireInstallation(out, install, wired, recorded) {
  const path = join(install, SETTINGS);
  const settings = load(path, SETTINGS, out.problems);
  if (!settings) {
    for (const [root, r] of Object.entries(recorded)) out.keep(root, { installExcludes: r.installExcludes, installDirs: r.installDirs });
    return;
  }
  const inside = wired.filter((m) => m.inside);
  const outside = wired.filter((m) => !m.inside);
  const excludes = reconcile(settings.claudeMdExcludes ?? [], inside.flatMap((m) => rulesOf(m.root)), union(recorded, 'installExcludes'));
  const dirs = reconcile(settings.permissions?.additionalDirectories ?? [], outside.map((m) => m.root), union(recorded, 'installDirs'));
  for (const m of inside) out.keep(m.root, { installExcludes: rulesOf(m.root).filter((e) => excludes.owned.includes(e)) });
  for (const m of outside) out.keep(m.root, { installDirs: dirs.owned.includes(m.root) ? [m.root] : [] });
  const edit = withInstallationLists(settings, excludes.list, dirs.list);
  if (edit) out.edits.push({ path, content: json(edit.settings), label: `${SETTINGS} ${edit.what}` });
}

/** The installation's settings with the two lists set, and which one changed first; null when neither did. */
function withInstallationLists(settings, excludes, dirs) {
  const excludesChanged = !same(excludes, settings.claudeMdExcludes ?? []);
  const dirsChanged = !same(dirs, settings.permissions?.additionalDirectories ?? []);
  if (!excludesChanged && !dirsChanged) return null;
  let next = excludesChanged ? withList(settings, 'claudeMdExcludes', excludes) : settings;
  if (dirsChanged) {
    const permissions = withList(next.permissions ?? {}, 'additionalDirectories', dirs);
    next = { ...next, permissions };
    if (!Object.keys(permissions).length) delete next.permissions;
  }
  return { settings: next, what: excludesChanged ? 'claudeMdExcludes' : 'additionalDirectories' };
}

/** The files a skill pointer is in every host's folder, relative to the installation. */
const pointerFiles = (name) => hostNames.map((host) => `${HOSTS[host].dir}/skills/${name}/SKILL.md`);

/**
 * Item 4's place in git: the pointers that name this machine's path (`ignored`) go into the
 * installation's `.git/info/exclude`, unless git ignores them already, and the lines sync then owns
 * are recorded per mount; those of a pointer or a mount that is gone are dropped. An installation
 * that is not a repository top has no commits of its own to keep them out of.
 */
function wireInstallIgnore(out, install, pointers, recorded) {
  const files = pointers.filter((p) => p.ignored).flatMap((p) => pointerFiles(p.name).map((file) => ({ root: p.mount.root, file })));
  const owned = union(recorded, 'installIgnored');
  if (!files.length && !owned.length) return;
  const keepRecorded = () => { for (const [root, r] of Object.entries(recorded)) out.keep(root, { installIgnored: r.installIgnored }); };
  if (!isRepoTop(install)) { keepRecorded(); return; }
  try {
    const ignored = ignoreFiles(install, files.map((f) => f.file), '.git/info/exclude (skill pointers)', owned);
    if (ignored.edit) out.edits.push(ignored.edit);
    for (const root of new Set(files.map((f) => f.root))) {
      out.keep(root, { installIgnored: files.filter((f) => f.root === root).map((f) => `/${f.file}`).filter((line) => ignored.owned.includes(line)) });
    }
  } catch (e) {
    out.problems.push(`${install}: ${e.message}`);
    keepRecorded();
  }
}

/** Items 2 and 3 for an inside mount whose repository is there. */
function wireMount(out, install, m, prev) {
  const path = join(m.root, SETTINGS);
  const label = `${m.path}/${SETTINGS}`;
  const settings = load(path, label, out.problems);
  if (!settings) {
    out.keep(m.root, { excludes: prev.excludes, created: prev.created, ignored: prev.ignored });
    return;
  }
  const excludes = reconcile(settings.claudeMdExcludes ?? [], installationRulesOf(install, m.root), pick(prev, 'excludes'));
  if (!same(excludes.list, settings.claudeMdExcludes ?? [])) {
    out.edits.push({ path, content: json({ ...settings, claudeMdExcludes: excludes.list }), label: `${label} claudeMdExcludes` });
  }
  const created = excludes.owned.length > 0 && (prev.created === true || !existsSync(path));
  let ignored;
  try {
    ignored = ignoreFiles(m.root, excludes.owned.length ? [SETTINGS] : [], `${m.path}/.git/info/exclude`, pick(prev, 'ignored'));
  } catch (e) {
    out.problems.push(`${m.path}: ${e.message}`);
    out.keep(m.root, { excludes: excludes.owned, created, ignored: prev.ignored });
    return;
  }
  if (ignored.edit) out.edits.push(ignored.edit);
  out.keep(m.root, { excludes: excludes.owned, created, ignored: ignored.owned });
}

/** Take back what sync wrote in a mount that is no longer configured (or no longer a repository top), as far as it is still there. */
function unwireMount(out, root, prev) {
  if (!existsSync(root)) return;
  const path = join(root, SETTINGS);
  const settings = pick(prev, 'excludes').length && existsSync(path) ? load(path, `${root}/${SETTINGS}`, out.problems) : {};
  if (!settings) { out.keep(root, { excludes: prev.excludes, created: prev.created, ignored: prev.ignored }); return; }
  const left = reconcile(settings.claudeMdExcludes ?? [], [], pick(prev, 'excludes')).list;
  if (!same(left, settings.claudeMdExcludes ?? [])) {
    const next = withList(settings, 'claudeMdExcludes', left);
    const label = `${root}/${SETTINGS} (mount removed)`;
    out.edits.push({ path, content: prev.created && !Object.keys(next).length ? null : json(next), label });
  }
  if (pick(prev, 'ignored').length && isRepoTop(root)) {
    try {
      const { edit } = ignoreFiles(root, [], `${root}/.git/info/exclude (mount removed)`, prev.ignored);
      if (edit) out.edits.push(edit);
    } catch (e) {
      out.problems.push(`${root}: ${e.message}`);
      out.keep(root, { ignored: prev.ignored });
    }
  }
}

/** What the wiring steps write into: the file edits, the problems, the record of what was wired (`keep` adds to it, leaving out the empty fields) and `pending`. */
function collector() {
  const record = {};
  return {
    edits: [],
    problems: [],
    pending: [],
    record,
    keep(root, fields) {
      const next = { ...record[root] };
      for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== false && !(Array.isArray(value) && !value.length)) next[key] = value;
      if (Object.keys(next).length) record[root] = next;
    },
  };
}

/**
 * What stays of the wiring of the gone mounts `gone`: unless pruning, each is `pending` with its
 * wiring in words, and the record the active mounts' wiring reconciles against (`owned`) lacks them —
 * their entries are left alone and their record stays whole.
 */
function keptWiring(recorded, gone, prune) {
  if (prune) return { pending: [], owned: recorded };
  const pending = gone.map((root) => ({ root, wiring: describeWiring(root, recorded[root]) }));
  return { pending, owned: Object.fromEntries(Object.entries(recorded).filter(([root]) => !gone.includes(root))) };
}

/** A mount that has gone: its wiring is taken away when pruning, else kept as recorded. */
function settleGone(out, root, prev, prune) {
  if (prune) unwireMount(out, root, prev);
  else out.keep(root, prev);
}

/** The wiring of the mounts that are there: the installation's lists and ignore lines, each mount's pointers and, for an inside one, its own settings. */
function wireActive(out, install, wired, pointers, { recorded, owned }) {
  wireInstallation(out, install, wired, owned);
  wireInstallIgnore(out, install, pointers, owned);
  for (const m of wired) out.keep(m.root, { pointers: pointers.filter((p) => p.mount.root === m.root).map((p) => p.name) });
  for (const m of wired) if (m.inside) wireMount(out, install, m, recorded[m.root] ?? {});
}

/**
 * The wiring of items 1-3 for `mounts` (config().mounts) in the installation `install`, against
 * what an earlier sync `recorded` (the `mounts` key of `.local/sync.json`, `{}` when none): the file
 * edits to make, the record to keep, and the problems found (a settings file sync cannot edit).
 * A mount whose root is not a repository top is not wired — config() reports it — and counts as
 * removed. `pointers` are the skill pointers sync writes for the mounts (pointers.mjs): their
 * names are recorded and the ones kept out of the installation's commits get their ignore lines.
 * What was wired for a mount that has gone is kept, and each such mount is listed in `pending` with
 * its wiring in words, unless `prune` is set: then it is taken away. Nothing is written here.
 * @param {string} install the installation's root
 * @param {object[]} mounts the resolved mounts (tools/common/mounts.mjs)
 * @param {Record<string, Wired>} recorded
 * @param {import('./pointers.mjs').MountPointer[]} pointers
 * @param {{prune?: boolean}} [options]
 * @returns {{edits: Edit[], record: Record<string, Wired>, problems: string[], pending: {root: string, wiring: string}[]}}
 */
export function wireMounts(install, mounts, recorded = {}, pointers = [], { prune = false } = {}) {
  const gone = goneRoots(mounts, recorded);
  const { pending, owned } = keptWiring(recorded, gone, prune);
  const wired = mounts.filter((m) => isRepoTop(m.root));
  const out = collector();
  if (wired.length || gone.length) {
    wireActive(out, realpathSync(install), wired, pointers, { recorded, owned });
    for (const root of gone) settleGone(out, root, recorded[root], prune);
  }
  return { edits: out.edits, record: out.record, problems: out.problems, pending };
}
