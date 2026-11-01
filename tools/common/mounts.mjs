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
// `skills.commit: true` is only for a local-layer entry of a mount inside the installation: its skill
// pointers are then not kept out of the installation's commits (a shared or an outside entry gets a
// problem and the key is ignored).
//
// config.mjs reads the files and calls resolveMounts; the hooks and sync read the result from
// config().mounts. Nothing here reads the environment or writes a file.
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isRepoTop, isWithin, mountRoot, realOf } from './paths.mjs';

/** The personal layer's file, in `.local/`. */
export const LOCAL_MOUNTS_FILE = 'mounts.yaml';

/** What a mount may be used for. */
export const MOUNT_USES = Object.freeze(['wiki', 'skills']);

/** Where a mount's skills are when `skills.from` is not given. */
export const DEFAULT_SKILLS_FROM = '.claude/skills';

const ENTRY_KEYS = ['use', 'skills', 'wiki', 'mention_assistant'];
const SKILLS_KEYS = ['from', 'prefix', 'only', 'commit'];
const WIKI_KEYS = ['name', 'rules', 'template', 'inbox', 'default'];
const WIKI_TEXT_KEYS = ['name', 'rules', 'template', 'inbox'];

const PREFIX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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

/** `skills.commit`: true only where it is allowed (a local-layer entry of an inside mount); elsewhere false, with a problem said when it was set. */
function skillsCommit(block, place, say) {
  if (block.commit === undefined || block.commit === false) return false;
  if (block.commit !== true) say('skills.commit: must be true or false');
  else if (place.layer !== 'local') say('skills.commit: only in .local/mounts.yaml — a shared entry cannot decide what its readers commit');
  else if (!place.inside) say('skills.commit: a pointer to a mount outside the installation holds an absolute path, so it is never committed');
  else return true;
  return false;
}

/** The `skills` block of a mount used for skills, normalized, with its problems pushed to `say`; `place` is the entry's `{ layer, inside }`. */
function skillsOf(entry, place, say) {
  const block = entry.skills ?? {};
  if (!isMap(block)) { say('skills: must be a mapping ({ from, prefix, only, commit })'); return { from: DEFAULT_SKILLS_FROM, prefix: null, only: null, commit: false }; }
  for (const key of Object.keys(block)) if (!SKILLS_KEYS.includes(key)) say(`skills.${key}: unknown key (${SKILLS_KEYS.join(', ')})`);
  const from = block.from === undefined ? DEFAULT_SKILLS_FROM : skillsFolder(block.from, say);
  const only = block.only === undefined ? null : skillNames(block.only, say);
  return { from, prefix: skillsPrefix(block.prefix, say), only, commit: skillsCommit(block, place, say) };
}

/** `skills.prefix`: it starts the name of a pointer's folder, so it is a plain name; null (the path's last folder is used) when absent or bad. */
function skillsPrefix(prefix, say) {
  if (prefix === undefined) return null;
  if (typeof prefix === 'string' && PREFIX.test(prefix)) return prefix;
  say('skills.prefix: must be letters, digits, - and _, starting with a letter or digit');
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
    skills: use.includes('skills') ? skillsOf(entry, place, say) : null,
    wiki: use.includes('wiki') ? wikiOf(entry, path, say) : null,
    mention_assistant: mentionOf(entry, say),
  };
}

/**
 * The mounts of one layer, each `{ path, layer, root, inside, use, skills, wiki, mention_assistant }`
 * (`root` the real absolute root, `inside` whether it lies inside the installation), and the problems
 * found. An entry that cannot be a mount — a bad path, a path at or under `oikos/` or `.local/`, a
 * second entry for one real path — is reported and left out.
 */
function layerMounts(root, declared, layer, file) {
  const problems = [];
  const mounts = [];
  const barred = [realOf(join(root, 'oikos')), realOf(join(root, '.local'))];
  for (const [key, value] of Object.entries(declared)) {
    const say = (text) => problems.push(`${file}: mounts.${key}: ${text}`);
    const bad = pathProblem(key, layer);
    if (bad) { say(bad); continue; }
    const mount = entryOf(root, trimmed(key), value, layer, say);
    if (!mount) continue;
    if (barred.some((dir) => isWithin(mount.root, dir))) { say('a mount is not at or under oikos/ or .local/'); continue; }
    if (isWithin(realOf(root), mount.root)) { say('a mount is not the installation or a folder above it'); continue; }
    if (mounts.some((m) => m.root === mount.root)) { say(`the same folder is declared twice in ${file}`); continue; }
    mounts.push(mount);
  }
  return { mounts, problems };
}

/** What is wrong with the skills of a mount: `skills.from` is not a folder in it, or `skills.only` names a skill it lacks. */
function skillsProblems(m) {
  if (!m.skills) return [];
  if (!existsSync(join(m.root, m.skills.from))) return [`skills.from: ${m.skills.from} does not exist in the mount`];
  return (m.skills.only ?? [])
    .filter((name) => !existsSync(join(m.root, m.skills.from, name, 'SKILL.md')))
    .map((name) => `skills.only: '${name}' is not a skill folder under ${m.skills.from}`);
}

/** What is wrong with the repository of a mount: it is missing, it is not a top, or its skills are not where `skills` says. */
function repositoryProblems(m) {
  if (!existsSync(m.root)) return [`${m.root} does not exist — clone or link the repository there`];
  if (!isRepoTop(m.root)) return [`${m.root} is not the top of a repository (no .git of its own)`];
  return skillsProblems(m);
}

/** The problems that need every mount at once: overlap, a missing or not-a-repository root, names, defaults, `skills.only`. */
function jointProblems(mounts) {
  const problems = [];
  const file = (m) => (m.layer === 'local' ? '.local/mounts.yaml' : 'oikos.yaml');
  const say = (m, text) => problems.push(`${file(m)}: mounts.${m.path}: ${text}`);
  for (const [i, m] of mounts.entries()) {
    for (const other of mounts.slice(i + 1)) {
      if (isWithin(m.root, other.root) || isWithin(other.root, m.root)) say(m, `overlaps the mount ${other.path} (${other.layer})`);
    }
    for (const text of repositoryProblems(m)) say(m, text);
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
  for (const what of widening) problems.push(`.local/mounts.yaml: mounts.${local.path}: may not widen the shared mount ${shared.path} — ${what}; dropped`);
  return next;
}

/**
 * The installation's mounts and the problems of both layers. `shared` and `local` are the `mounts:`
 * mappings of `oikos.yaml` and `.local/mounts.yaml` (empty when absent). A local entry for a real
 * path the shared file declares replaces that entry as a whole, but may only narrow it (`narrowed`);
 * the order is the shared file's, then the local additions.
 * @param {string} root the installation's root
 * @param {object} shared
 * @param {object} local
 * @returns {{mounts: object[], problems: string[]}}
 */
export function resolveMounts(root, shared, local) {
  const sharedLayer = layerMounts(root, shared, 'shared', 'oikos.yaml');
  const localLayer = layerMounts(root, local, 'local', '.local/mounts.yaml');
  const widening = [];
  const mounts = sharedLayer.mounts.map((m) => {
    const local = localLayer.mounts.find((l) => l.root === m.root);
    return local ? narrowed(local, m, widening) : m;
  });
  for (const m of localLayer.mounts) if (!sharedLayer.mounts.some((s) => s.root === m.root)) mounts.push(m);
  return { mounts, problems: [...sharedLayer.problems, ...localLayer.problems, ...widening, ...jointProblems(mounts)] };
}

/** The mount that holds the real path `path`, or null. */
export const mountOf = (mounts, path) => mounts.find((m) => isWithin(path, m.root)) ?? null;

/** What a mount is besides its path: the layer, where it lies, what it is used for and the wiki's name — for `landscape` and `setup status`. */
export function mountFacts(m) {
  const uses = m.use.length ? m.use.join(', ') : 'read only';
  return `${m.layer} layer, ${m.inside ? 'inside' : 'outside'} the installation · use: ${uses}${m.wiki ? ` · wiki '${m.wiki.name}'` : ''}`;
}
