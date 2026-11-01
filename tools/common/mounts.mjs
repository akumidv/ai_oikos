// Mounts (docs/design/mounts.md): other repositories the installation uses as sources of skills
// and notes, never of rules. Declared in two layers of one schema — `mounts:` of `oikos.yaml`
// (shared: relative paths inside the installation) and of `.local/mounts.yaml` (personal: a path
// may be absolute and outside it) — and merged here by real path, the local entry winning whole,
// except that it only narrows: it may not add `wiki` to the shared entry's `use` or set
// `mention_assistant: allow` where the shared entry lacks it (the widening is dropped, with a problem).
//
//   mounts:
//     vaults/team:                    # the entry key is the mount's path; null — a read-only mount
//       use: [wiki]                   # wiki | skills
//       wiki: { name: team, rules: NOTES.md, template: templates/note.md, inbox: inbox/, default: true }
//       mention_assistant: allow
//     projects/dev-root:
//       use: [skills]
//       skills: { from: .claude/skills, prefix: dev, only: [deploy-status] }
//
// `skills.prefix` starts the name of each skill pointer (`<prefix>-<skill folder>`); it is a plain
// lowercase name (SLUG) and defaults to the mount folder's name, slugified. A prefix that is not one,
// or that cannot be made from the folder's name, is a problem and the mount gets no pointers; so is a
// pointer name over POINTER_NAME_LIMIT characters (that pointer alone is not made).
//
// `skills.tracked: true` is only for a local-layer entry of a mount inside the installation: its skill
// pointers are then not kept out of the installation's commits (a shared or an outside entry gets a
// problem and the key is ignored).
//
// config.mjs reads the files and calls resolveMounts; the hooks and sync read the result from
// config().mounts. Nothing here reads the environment or writes a file.
import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { CORE_ROOT, isCore, isInstallation, isRepoTop, isWithin, mountRoot, realOf } from './paths.mjs';
import { SLUG, slugify } from './slug.mjs';

/** The personal layer's file, in `.local/`. */
export const LOCAL_MOUNTS_FILE = 'mounts.yaml';

/** What a mount may be used for. */
export const MOUNT_USES = Object.freeze(['wiki', 'skills']);

/** Where a mount's skills are when `skills.from` is not given. */
export const DEFAULT_SKILLS_FROM = '.claude/skills';

const ENTRY_KEYS = ['use', 'skills', 'wiki', 'mention_assistant'];
const SKILLS_KEYS = ['from', 'prefix', 'only', 'tracked'];
const WIKI_KEYS = ['name', 'rules', 'template', 'inbox', 'default'];
const WIKI_TEXT_KEYS = ['name', 'rules', 'template', 'inbox'];

/** The longest name a skill pointer may have, `<prefix>-<skill folder>` as a whole (the limit of a host's skill name). */
export const POINTER_NAME_LIMIT = 64;

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const trimmed = (path) => (path.length > 1 ? path.replace(/\/+$/, '') : path);
const winAbsolute = (path) => /^[A-Za-z]:[\\/]/.test(path);
const hasParentStep = (path) => path.split(/[\\/]/).includes('..');

/** The problem with a mount's path as written in `layer`, or null. A shared path stays inside the installation. */
function pathProblem(path, layer) {
  if (!isText(path)) return 'the path must be a non-empty string';
  if (layer === 'local') return null;
  if (isAbsolute(path) || winAbsolute(path)) return 'a shared mount path is relative to the installation — an absolute path belongs to .local/mounts.yaml';
  if (path.includes('\\')) return 'a path is written with / separators';
  if (hasParentStep(path)) return "a shared mount path has no '..' — a mount outside the installation belongs to .local/mounts.yaml";
  return null;
}

/** The `use` list of an entry, with its problems pushed to `say`. */
function usesOf(entry, say) {
  if (entry.use === undefined || entry.use === null) return [];
  const list = Array.isArray(entry.use) ? entry.use : [entry.use];
  const uses = [];
  for (const use of list) {
    if (!MOUNT_USES.includes(use)) say(`use: unknown value ${JSON.stringify(use)} (${MOUNT_USES.join(', ')})`);
    else if (!uses.includes(use)) uses.push(use);
  }
  return uses;
}

/** `skills.from`: a folder inside the mount, or the default (with a problem said). */
function skillsFolder(from, say) {
  if (isText(from) && !isAbsolute(from) && !hasParentStep(from)) return trimmed(from);
  say("skills.from: must be a folder inside the mount (relative, no '..')");
  return DEFAULT_SKILLS_FROM;
}

/** `skills.only`: the distinct names, or null (with a problem said) when it is not a list of names. */
function skillNames(only, say) {
  if (Array.isArray(only) && only.every(isText)) return [...new Set(only)];
  say('skills.only: must be a list of skill names');
  return null;
}

/** `skills.tracked`: true only where it is allowed (a local-layer entry of an inside mount); elsewhere false, with a problem said when it was set. */
function skillsTracked(block, place, say) {
  if (block.tracked === undefined || block.tracked === false) return false;
  if (block.tracked !== true) say('skills.tracked: must be true or false');
  else if (place.layer !== 'local') say('skills.tracked: only in .local/mounts.yaml — a shared entry cannot decide what its readers commit');
  else if (!place.inside) say('skills.tracked: a pointer to a mount outside the installation holds an absolute path, so it is never committed');
  else return true;
  return false;
}

/**
 * The `skills` block of a mount used for skills, normalized, with its problems pushed to `say`;
 * `place` is the entry's `{ layer, inside }`. `prefix` is the one the pointers use — declared, else
 * the folder's name slugified — or null when there is none to use (a problem said).
 */
function skillsOf(entry, path, place, say) {
  const block = entry.skills ?? {};
  if (!isMap(block)) { say('skills: must be a mapping ({ from, prefix, only, tracked })'); return { from: DEFAULT_SKILLS_FROM, prefix: null, only: null, tracked: false }; }
  for (const key of Object.keys(block)) if (!SKILLS_KEYS.includes(key)) say(`skills.${key}: unknown key (${SKILLS_KEYS.join(', ')})`);
  const from = block.from === undefined ? DEFAULT_SKILLS_FROM : skillsFolder(block.from, say);
  const only = block.only === undefined ? null : skillNames(block.only, say);
  return { from, prefix: skillsPrefix(block.prefix, path, say), only, tracked: skillsTracked(block, place, say) };
}

/** `skills.prefix`: it starts the name of a pointer's folder, so it is a plain name (SLUG); absent, the mount folder's name slugified. Null, with a problem said, when there is none. */
function skillsPrefix(prefix, path, say) {
  if (prefix === undefined) {
    const made = slugify(basename(path));
    if (!made) say(`skills.prefix: the folder name '${basename(path)}' holds no letter or digit to make one from — set skills.prefix`);
    return made || null;
  }
  if (typeof prefix === 'string' && SLUG.test(prefix)) return prefix;
  say(`skills.prefix: must be lowercase letters, digits and -, starting with a letter or digit (got ${JSON.stringify(prefix)})`);
  return null;
}

/** The `wiki` block of a mount used as a wiki, normalized (the name defaults to the path), with its problems pushed to `say`. */
function wikiOf(entry, path, say) {
  const block = entry.wiki ?? {};
  if (!isMap(block)) { say('wiki: must be a mapping ({ name, rules, template, inbox, default })'); return { name: path, rules: null, template: null, inbox: null, default: false }; }
  for (const key of Object.keys(block)) if (!WIKI_KEYS.includes(key)) say(`wiki.${key}: unknown key (${WIKI_KEYS.join(', ')})`);
  for (const key of WIKI_TEXT_KEYS) if (block[key] !== undefined && !isText(block[key])) say(`wiki.${key}: must be a non-empty string`);
  if (block.default !== undefined && typeof block.default !== 'boolean') say('wiki.default: must be true or false');
  const text = (key) => (isText(block[key]) ? block[key] : null);
  return { name: text('name') ?? path, rules: text('rules'), template: text('template'), inbox: text('inbox'), default: block.default === true };
}

/** `mention_assistant` of an entry: 'allow' or null. */
function mentionOf(entry, say) {
  if (entry.mention_assistant !== undefined && entry.mention_assistant !== null && entry.mention_assistant !== 'allow') say("mention_assistant: only 'allow' is a value");
  return entry.mention_assistant === 'allow' ? 'allow' : null;
}

/** One declared entry as a mount, or null (a problem said why) when it cannot be one. */
function entryOf(root, path, value, layer, say) {
  const entry = value ?? {};
  if (!isMap(entry)) { say('must be null (a read-only mount) or a mapping'); return null; }
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) say(`${key}: unknown key (${ENTRY_KEYS.join(', ')})`);
  const use = usesOf(entry, say);
  const real = mountRoot(root, path);
  const place = { layer, inside: isWithin(real, realOf(root)) };
  return {
    path, layer, root: real, inside: place.inside,
    use,
    skills: use.includes('skills') ? skillsOf(entry, path, place, say) : null,
    wiki: use.includes('wiki') ? wikiOf(entry, path, say) : null,
    mention_assistant: mentionOf(entry, say),
  };
}

/**
 * A mount's path as a problem names it: as written, but quoted (JSON) when it holds `: ` or starts with a
 * quote, so that {@link problemsOf} finds where it ends — the text after the path starts at the first `: `.
 */
const keyLabel = (path) => (path.includes(': ') || path.startsWith('"') ? JSON.stringify(path) : path);

/**
 * The roots the guards keep closed for the keys of `mounts:` in `layer`, `{ path, layer, root }` each, one
 * per real root: every key that names a path, whether its entry is a mount or a problem. Left out is
 * what a guard cannot hold without closing the installation — the installation itself or a folder above
 * it (every edit would be denied) — and what other rules guard: the core (read-only in an installation)
 * and `.local/` (working material, with its closed files and stores named one by one).
 * @param {string} root the installation's root
 * @param {string[]} keys
 * @param {'shared'|'local'} layer
 * @returns {{path: string, layer: string, root: string}[]}
 */
export function guardedRoots(root, keys, layer) {
  const barred = [realOf(join(root, 'oikos')), realOf(join(root, '.local'))];
  const installation = realOf(root);
  const found = [];
  for (const key of keys) {
    if (typeof key !== 'string' || key === '') continue;
    const real = mountRoot(root, trimmed(key));
    if (barred.some((dir) => isWithin(real, dir)) || isWithin(installation, real) || found.some((g) => g.root === real)) continue;
    found.push({ path: trimmed(key), layer, root: real });
  }
  return found;
}

/**
 * The mounts of one layer, each `{ path, layer, root, inside, use, skills, wiki, mention_assistant }`
 * (`root` the real absolute root, `inside` whether it lies inside the installation), the problems
 * found, and `guarded` — the root of every key, problem or not ({@link guardedRoots}), which the guards
 * keep closed (D01: a problem never opens a guard). An entry that cannot be a mount — a bad path, a
 * path at or under `oikos/` or `.local/`, a second entry for one real path — is reported and left out of
 * `mounts`, and stays in `guarded`.
 */
function layerMounts(root, declared, layer, file) {
  const problems = [];
  const mounts = [];
  const barred = [realOf(join(root, 'oikos')), realOf(join(root, '.local'))];
  for (const [key, value] of Object.entries(declared)) {
    const say = (text) => problems.push(`${file}: mounts.${keyLabel(key)}: ${text}`);
    const bad = pathProblem(key, layer);
    if (bad) { say(bad); continue; }
    const mount = entryOf(root, trimmed(key), value, layer, say);
    if (!mount) continue;
    if (barred.some((dir) => isWithin(mount.root, dir))) { say('a mount is not at or under oikos/ or .local/'); continue; }
    if (isWithin(realOf(root), mount.root)) { say('a mount is not the installation or a folder above it'); continue; }
    if (mounts.some((m) => m.root === mount.root)) { say(`the same folder is declared twice in ${file}`); continue; }
    mounts.push(mount);
  }
  return { mounts, problems, guarded: guardedRoots(root, Object.keys(declared), layer) };
}

/** The tokens of a flow mapping: a quoted string, a bracket, a comma or colon, or a run of other text. */
const FLOW_TOKEN = /"(?:[^"\\]|\\.)*"|'[^']*'|[{}[\],:]|[^{}[\],:"']+/g;
const FLOW_DEPTH = { '{': 1, '[': 1, '}': -1, ']': -1 };

/** The keys at the top level of the flow mapping that starts `text` (`{ a: {…}, "b c": ~ }`), quotes kept; best effort, one line. */
function flowKeys(text) {
  const keys = [];
  let depth = 0;
  let key = '';
  let value = false; // after a key's colon, up to the comma
  for (const [token] of text.matchAll(FLOW_TOKEN)) {
    const step = FLOW_DEPTH[token];
    if (step !== undefined) depth += step;
    else if (depth !== 1) continue;
    else if (token === ',') [key, value] = ['', false];
    else if (token === ':' && !value) {
      if (key) keys.push(key);
      [key, value] = ['', true];
    }
    else if (!value && token.trim()) key = token.trim();
  }
  return keys;
}

/**
 * The keys under `mounts:` of the YAML `text`, found by scanning its lines — for a file that does not
 * parse, whose entries are then not read but must stay guarded. Best effort: the block style (the keys at
 * the first indentation under `mounts:`), and a flow mapping on the `mounts:` line itself.
 * @param {string} text
 * @returns {string[]}
 */
export function scanMountKeys(text) {
  const keys = [];
  const unquote = (key) => key.replace(/^(["'])(.*)\1$/, '$2');
  let inside = false;
  let indent = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^mounts\s*:/.test(line)) {
      inside = true;
      indent = null;
      const flow = line.replace(/^mounts\s*:/, '');
      keys.push(...flowKeys(flow).map(unquote));
      continue;
    }
    if (!inside || /^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) { inside = false; continue; }
    const lead = line.length - line.trimStart().length;
    indent ??= lead;
    if (lead !== indent) continue;
    const key = /^\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"?:-][^#]*?|-[^\s#][^#]*?)\s*:(?=\s|$)/.exec(line);
    if (key) keys.push(unquote(key[1]));
  }
  return keys;
}

/**
 * The skill folders of a mount used for skills — those under `skills.from` that hold a SKILL.md,
 * only the ones `skills.only` names when it is set — sorted; empty when `skills.from` is missing.
 * @param {object} m a resolved mount
 * @returns {string[]}
 */
export function skillFolders(m) {
  if (!m.skills || !existsSync(join(m.root, m.skills.from))) return [];
  return readdirSync(join(m.root, m.skills.from)).sort()
    .filter((dir) => (m.skills.only ? m.skills.only.includes(dir) : true))
    .filter((dir) => existsSync(join(m.root, m.skills.from, dir, 'SKILL.md')));
}

/** The name of the pointer of the skill folder `dir` of the mount `m`, `<prefix>-<dir>`. */
export const pointerName = (m, dir) => `${m.skills.prefix}-${dir}`;

/** Whether the mount's skill `dir` can have a pointer: the mount has a prefix and the name stays within POINTER_NAME_LIMIT. */
export const hasPointer = (m, dir) => m.skills.prefix !== null && pointerName(m, dir).length <= POINTER_NAME_LIMIT;

/** What is wrong with the skills of a mount: `skills.from` is not a folder in it, `skills.only` names a skill it lacks, or a pointer's name is too long. */
function skillsProblems(m) {
  if (!m.skills) return [];
  if (!existsSync(join(m.root, m.skills.from))) return [`skills.from: ${m.skills.from} does not exist in the mount`];
  const missing = (m.skills.only ?? [])
    .filter((name) => !existsSync(join(m.root, m.skills.from, name, 'SKILL.md')))
    .map((name) => `skills.only: '${name}' is not a skill folder under ${m.skills.from}`);
  const long = m.skills.prefix === null ? [] : skillFolders(m)
    .filter((dir) => !hasPointer(m, dir))
    .map((dir) => `skills: the pointer name '${pointerName(m, dir)}' is ${pointerName(m, dir).length} characters, over the limit of ${POINTER_NAME_LIMIT} — set a shorter skills.prefix or leave the skill out with skills.only; no pointer is made for it`);
  return [...missing, ...long];
}

/** What is wrong with the repository of a mount: it is missing, it is not a top, or its skills are not where `skills` says. */
function repositoryProblems(m) {
  if (!existsSync(m.root)) return [`${m.root} does not exist — clone or link the repository there`];
  if (!isRepoTop(m.root)) return [`${m.root} is not the top of a repository (no .git of its own)`];
  return skillsProblems(m);
}

/** How deep, and over how many folders at most, a mount is searched for an installation it holds ({@link nestedInstallation}): every hook call resolves the mounts, so the search is bounded. */
const NESTED_DEPTH = 2;
const NESTED_FOLDERS = 100;

/** The folders directly in `dir`, `.git`, `node_modules` and links left out; none when `dir` cannot be read. */
function subfolders(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules')
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/** The first installation found below the folder `root` — within NESTED_DEPTH levels and NESTED_FOLDERS folders, links, `.git` and `node_modules` left alone — or null. */
function nestedInstallation(root) {
  let level = [root];
  let seen = 0;
  for (let depth = 0; depth < NESTED_DEPTH && level.length; depth++) {
    const next = level.flatMap(subfolders).slice(0, NESTED_FOLDERS - seen);
    seen += next.length;
    const found = next.find((dir) => isInstallation(dir));
    if (found) return found;
    level = next;
  }
  return null;
}

/** What is wrong with a mount's root as to the core and the installations (D01), or '' when nothing: it holds the core, it is an installation used for something, or it holds one. */
function boundaryProblem(m) {
  if (isWithin(realOf(CORE_ROOT), m.root)) return 'a mount is not the core or a folder that holds it';
  if (isInstallation(m.root)) return m.use.length ? 'a linked installation is registered without `use` — `use` would make its files a source of skills or notes here (ADR 0007 D05)' : '';
  const nested = nestedInstallation(m.root);
  return nested ? `it holds the installation ${nested} — a mount does not contain another installation; register that one by itself, without \`use\` (ADR 0007 D01)` : '';
}

/** The problems that need every mount at once: overlap, a missing or not-a-repository root, the core and the installations, names, defaults, `skills.only`. */
function jointProblems(mounts) {
  const problems = [];
  const file = (m) => (m.layer === 'local' ? '.local/mounts.yaml' : 'oikos.yaml');
  const say = (m, text) => problems.push(`${file(m)}: mounts.${keyLabel(m.path)}: ${text}`);
  for (const [i, m] of mounts.entries()) {
    for (const other of mounts.slice(i + 1)) {
      if (isWithin(m.root, other.root) || isWithin(other.root, m.root)) say(m, `overlaps the mount ${keyLabel(other.path)} (${other.layer})`);
    }
    for (const text of repositoryProblems(m)) say(m, text);
    const bad = boundaryProblem(m);
    if (bad) say(m, bad);
  }
  const wikis = mounts.filter((m) => m.wiki);
  for (const [i, m] of wikis.entries()) {
    const first = wikis.findIndex((w) => w.wiki.name === m.wiki.name);
    if (first !== i) say(m, `the wiki name '${m.wiki.name}' is also the mount ${wikis[first].path}'s — give one a wiki.name`);
  }
  const defaults = wikis.filter((m) => m.wiki.default);
  for (const m of defaults.slice(1)) say(m, `wiki.default: ${defaults[0].path} is the default wiki already`);
  return problems;
}

/**
 * The local entry `local` as it stands in place of the shared `shared` of the same real path: whole,
 * but narrowing only. `wiki` in its `use` that the shared `use` lacks, and `mention_assistant: allow`
 * that the shared entry lacks, are dropped — what the shared entry says stays — each with a problem
 * pushed to `problems`.
 */
function narrowed(local, shared, problems) {
  const widening = [];
  const next = { ...local };
  if (local.use.includes('wiki') && !shared.use.includes('wiki')) {
    widening.push("use: 'wiki' is not in the shared entry's use");
    next.use = local.use.filter((use) => use !== 'wiki');
    next.wiki = null;
  }
  if (local.mention_assistant === 'allow' && shared.mention_assistant !== 'allow') {
    widening.push('mention_assistant: allow is not set on the shared entry');
    next.mention_assistant = shared.mention_assistant;
  }
  for (const what of widening) problems.push(`.local/mounts.yaml: mounts.${keyLabel(local.path)}: may not widen the shared mount ${shared.path} — ${what}; dropped`);
  return next;
}

/**
 * The installation's mounts and the problems of both layers. `shared` and `local` are the `mounts:`
 * mappings of `oikos.yaml` and `.local/mounts.yaml` (empty when absent). A local entry for a real
 * path the shared file declares replaces that entry as a whole, but may only narrow it (`narrowed`);
 * the order is the shared file's, then the local additions. `guarded` is the roots the guards keep
 * closed ({@link guardedRoots}): those of every key of both layers, mount or problem, and of the keys
 * of a file that did not parse (`unread`, `{ shared, local }` lists of keys, see {@link scanMountKeys}).
 * @param {string} root the installation's root
 * @param {object} shared
 * @param {object} local
 * @param {{shared?: string[], local?: string[]}} [unread]
 * @returns {{mounts: object[], problems: string[], guarded: {path: string, layer: string, root: string}[]}}
 */
export function resolveMounts(root, shared, local, unread = {}) {
  const sharedLayer = layerMounts(root, shared, 'shared', 'oikos.yaml');
  const localLayer = layerMounts(root, local, 'local', '.local/mounts.yaml');
  const widening = [];
  const mounts = sharedLayer.mounts.map((m) => {
    const local = localLayer.mounts.find((l) => l.root === m.root);
    return local ? narrowed(local, m, widening) : m;
  });
  for (const m of localLayer.mounts) if (!sharedLayer.mounts.some((s) => s.root === m.root)) mounts.push(m);
  const guarded = [...sharedLayer.guarded, ...localLayer.guarded, ...guardedRoots(root, unread.shared ?? [], 'shared'), ...guardedRoots(root, unread.local ?? [], 'local')]
    .filter((g, i, all) => all.findIndex((other) => other.root === g.root) === i);
  return { mounts, problems: [...sharedLayer.problems, ...localLayer.problems, ...widening, ...jointProblems(mounts)], guarded };
}

/** The mount that holds the real path `path`, or null. */
export const mountOf = (mounts, path) => mounts.find((m) => isWithin(path, m.root)) ?? null;

const PROBLEM_OF_ENTRY = /^(?:oikos\.yaml|\.local\/mounts\.yaml): mounts\.("(?:[^"\\]|\\.)*"|.+?): /;
const PROBLEM_OVERLAP = /overlaps the mount ("(?:[^"\\]|\\.)*"|.+?) \((?:shared|local)\)$/;

/** The path a problem names, as {@link keyLabel} wrote it: quoted (JSON) or plain; undefined when the quoted text is not one. */
function labelled(label) {
  if (!label.startsWith('"')) return label;
  try {
    return JSON.parse(label);
  } catch {
    return undefined;
  }
}

/**
 * The problems of `problems` (as config() reports them) that name the mount `m` — its own entry's, and the
 * overlaps it is part of. A mount with any is a problem entry (ADR 0007 D01): the `vault` tool does not use it.
 * A path is read back exactly: a path with `: ` in it is quoted in the problem ({@link keyLabel}).
 * @param {object} m a resolved mount
 * @param {string[]} problems
 * @returns {string[]}
 */
export function problemsOf(m, problems) {
  return problems.filter((problem) => {
    const named = labelled(problem.match(PROBLEM_OF_ENTRY)?.[1] ?? '');
    if (named === undefined || named === '') return false;
    const overlapped = labelled(problem.match(PROBLEM_OVERLAP)?.[1] ?? '');
    return named.replace(/\/+$/, '') === m.path || (overlapped !== undefined && overlapped === m.path);
  });
}

/**
 * The mounts the `vault` connector uses: used as a wiki, with no problem (`problemsOf`), and not the core,
 * an installation or a folder that holds the core (D01).
 * @param {object[]} mounts the resolved mounts
 * @param {string[]} problems the configuration's problems
 * @returns {object[]}
 */
export function usableWikis(mounts, problems) {
  return mounts.filter((m) => m.wiki && !problemsOf(m, problems).length && !isInstallation(m.root) && !isCore(m.root) && !isWithin(realOf(CORE_ROOT), m.root));
}

/** What a mount is besides its path: the layer, where it lies, what it is used for and the wiki's name — for `landscape` and `setup status`. */
export function mountFacts(m) {
  const uses = m.use.length ? m.use.join(', ') : 'read only';
  return `${m.layer} layer, ${m.inside ? 'inside' : 'outside'} the installation · use: ${uses}${m.wiki ? ` · wiki '${m.wiki.name}'` : ''}`;
}
