// The notes of a vault — a wiki mount (ADR 0007 D04, docs/design/mounts.md § Vault): which vault a command
// means, the notes in it, where a note may be written and how it is written, how a new note is put
// together from the vault's template, the vault's note rules (`wiki.rules`) and the rules of the content
// check of one vault. The `vault` tool (tools/vault/cli.mjs) is the one route that writes into a mount;
// everything that decides whether it may lives here.
//
// A target is judged as ADR 0007 D02 says: resolved component by component (`realOf`), its containment in the
// vault decided by device and inode (`inside`), a file with more than one hard link refused, and a note is
// written through a temporary file in the target's own folder, renamed into place.
import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import YAML from 'yaml';
import { hardLinked, inside } from '../hooks/boundary.mjs';
import { GuardRefusal, UsageError } from './cli.mjs';
import { config } from './config.mjs';
import { problemsOf } from './mounts.mjs';
import { EXECUTABLE_KINDS, outgoingRules } from './outgoing.mjs';
import { derivedTerms, organizationMarkers } from './outgoing-terms.mjs';
import { idOf, installRoot, isWithin, realOf, sameFile } from './paths.mjs';

/**
 * The files that carry an agent's rules: a note is never written to one (lower case; compared ignoring case).
 * The hosts oikos wires are Claude Code (`CLAUDE.md`, `CLAUDE.local.md`) and Qwen Code (`QWEN.md`); Codex also
 * reads `AGENTS.override.md` over `AGENTS.md`, and Gemini CLI `GEMINI.md`. (`.claude/rules/` is a dot folder.)
 */
export const RULE_FILES = Object.freeze(['claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'qwen.md', 'gemini.md']);

/** The keys a vault's note rules (the YAML front matter of `wiki.rules`) may have. */
export const NOTE_RULE_KEYS = Object.freeze(['required', 'language', 'allow']);

/** The longest note name (without `.md`) that `create` makes from a title. */
const NAME_LIMIT = 120;
/** The largest note the search reads. */
const SEARCH_LIMIT_BYTES = 1_000_000;
const SKIP_FOLDERS = new Set(['node_modules']);

const unique = (list) => [...new Set(list)];
const posix = (path) => path.split(sep).join('/');

// -- which vault ------------------------------------------------------------------------------------

/**
 * The wiki the command means among `wikis` (the usable ones): the one named by `name`, else the default
 * (`wiki.default`), else the only one; with several and none chosen, a usage error that lists them. A name
 * that belongs to a wiki that is not usable says why, from `all` (every wiki mount) and `problems`.
 * @param {object[]} wikis the usable wiki mounts
 * @param {string|undefined} name `--wiki`
 * @param {{all?: object[], problems?: string[]}} [context] every wiki mount and the configuration's problems, for the message
 * @returns {object} a resolved mount
 */
export function pickWiki(wikis, name, context = {}) {
  const listed = wikis.map((m) => `  ${m.wiki.name} (${m.path})`).join('\n') || '  (none)';
  if (name) return namedWiki(wikis, name, { ...context, listed });
  const chosen = wikis.find((m) => m.wiki.default) ?? (wikis.length === 1 ? wikis[0] : null);
  if (!chosen) throw new UsageError(`which vault? Name one with --wiki (several wikis, none the default). Wikis:\n${listed}`);
  return chosen;
}

/** The usable wiki called `name`; a usage error when there is none, saying why when the name is that of a wiki that is not used. */
function namedWiki(wikis, name, { all = wikis, problems = [], listed }) {
  const found = wikis.find((m) => m.wiki.name === name);
  if (found) return found;
  const unusable = all.find((m) => m.wiki?.name === name);
  if (unusable) throw new UsageError(`the wiki '${name}' is not used — ${problemsOf(unusable, problems).join('; ') || 'its mount is the core or an installation'}`);
  throw new UsageError(`no wiki named '${name}'. Wikis:\n${listed}`);
}

// -- the note rules and the content check -----------------------------------------------------------------

/**
 * @typedef {object} NoteRules What a vault's `wiki.rules` file says, as data.
 * @property {string[]} required frontmatter keys a new note must have
 * @property {boolean} english the note is English: the `language` category of the check is on
 * @property {string[]} allow kinds of executable content the vault allows (keys of EXECUTABLE_KINDS)
 */

/** The text of the vault's own file `rel` (`wiki.rules` or `wiki.template`), judged as a target is: inside the vault, a file. */
function vaultFile(mount, rel, what) {
  const real = realOf(rel, mount.root);
  if (isAbsolute(rel) || !inside(real, mount.root, idOf(mount.root), { ids: new Map() }) || !isWithin(real, mount.root)) {
    throw new UsageError(`${what}: ${rel} must be a file inside the vault ${mount.path}`);
  }
  if (!existsSync(real) || !statSync(real).isFile()) throw new UsageError(`${what}: ${rel} is not a file in the vault ${mount.path}`);
  return readFileSync(real, 'utf8');
}

/**
 * The note rules of a wiki mount: the YAML front matter of its `wiki.rules` file — `required` (frontmatter
 * keys of a new note), `language` (`en` turns the language check on, any other value leaves it off) and
 * `allow` (the kinds of executable content the vault allows). A vault without `wiki.rules`, or a file
 * without front matter, has no rules. A configured file that is missing, or rules that do not read, are a
 * usage error: a vault whose rules cannot be read gets no note.
 * @param {object} mount a wiki mount
 * @returns {NoteRules}
 */
export function noteRules(mount) {
  const none = { required: [], english: false, allow: [] };
  if (!mount.wiki.rules) return none;
  const { front } = splitNote(vaultFile(mount, mount.wiki.rules, 'wiki.rules'));
  if (front === null) return none;
  const label = `wiki.rules ${mount.wiki.rules}`;
  const data = parsedFront(front, label);
  for (const key of Object.keys(data)) if (!NOTE_RULE_KEYS.includes(key)) throw new UsageError(`${label}: unknown key '${key}' (${NOTE_RULE_KEYS.join(', ')})`);
  const allow = ruleList(data, 'allow', label);
  for (const kind of allow) if (!Object.hasOwn(EXECUTABLE_KINDS, kind)) throw new UsageError(`${label}: allow: unknown kind '${kind}' (${Object.keys(EXECUTABLE_KINDS).join(', ')})`);
  return { required: ruleList(data, 'required', label), english: typeof data.language === 'string' && ENGLISH.test(data.language.trim()), allow };
}

const ENGLISH = /^(?:en(?:[-_].*)?|english)$/i;

/** The list of names under `key` of the note rules `data`; a usage error naming `label` when it is not one. */
function ruleList(data, key, label) {
  const value = data[key] ?? [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) throw new UsageError(`${label}: ${key}: is a list of names`);
  return value.map((item) => item.trim());
}

/**
 * The rules of the content check of one vault (ADR 0007 D04): the installation's `.local/outgoing.yaml`
 * terms and allow list and the linked installations' terms (`outgoingRules`), its derived terms, and for a
 * personal vault (the local layer) the organization's markers; `language` off unless the note rules say
 * English, `assistant` off where the mount sets `mention_assistant: allow`, and every kind of executable
 * content refused that the note rules do not allow.
 * @param {object} mount a wiki mount
 * @param {NoteRules} rules from {@link noteRules}
 * @returns {import('./outgoing.mjs').OutgoingRules}
 */
export function vaultRules(mount, rules) {
  const base = outgoingRules();
  const markers = mount.layer === 'local' ? organizationMarkers(config()) : { terms: [], patterns: [] };
  return Object.freeze({
    ...base,
    terms: Object.freeze(unique([...base.terms, ...(installRoot() ? derivedTerms(installRoot()) : []), ...markers.terms])),
    patterns: Object.freeze([...(base.patterns ?? []), ...markers.patterns]),
    off: Object.freeze([...(rules.english ? [] : ['language']), ...(mount.mention_assistant === 'allow' ? ['assistant'] : [])]),
    refuse: Object.freeze(Object.keys(EXECUTABLE_KINDS).filter((kind) => !rules.allow.includes(kind))),
  });
}

// -- targets ---------------------------------------------------------------------------------------

/** What is wrong with the names of a path inside a vault (`names`: its components), or null: a dot name, not a `.md` note, a `SKILL.md`, a rule file. */
function nameProblem(names) {
  const dot = names.find((name) => name.startsWith('.'));
  if (dot !== undefined) return `a name that starts with a dot (${dot}) — notes are never written in or as a dot folder or file`;
  const file = names[names.length - 1].toLowerCase();
  if (!file.endsWith('.md')) return 'not a .md note';
  if (file === 'skill.md') return 'a SKILL.md is never written';
  if (RULE_FILES.includes(file)) return `${names[names.length - 1]} is a rule file and is never written`;
  return null;
}

/**
 * @typedef {object} Target
 * @property {string} real the real path of the note (links resolved, the last component included)
 * @property {string} rel its path from the vault's root, with `/`
 * @property {boolean} exists whether a file is there now
 * @property {string} root the vault's real root, which the folders of the note must stay inside
 * @property {string|null} folderId the identity (device and inode) of the note's folder when judged, null when it did not exist yet
 */

/**
 * Judge `relPath` — a path of a note from the vault's root, with `/` — as a place to read or write (ADR 0007
 * D04 and D02). Always: the path is relative with no `..`, no dot name and no rule file, the file a `.md`,
 * and its real path (every link followed, the last component included) lies inside the vault, by device and
 * inode. For a write also: no folder of it is a nested repository, it is under no mount's `skills.from`,
 * it is not the vault's own note rules or template, it is a regular file when it exists and has no other
 * hard link. A refusal is a GuardRefusal (exit 3, `refused: vault target`).
 * @param {object} mount the wiki mount
 * @param {object[]} mounts every mount of the installation
 * @param {string} relPath
 * @param {{write?: boolean}} [options]
 * @returns {Target}
 */
export function judgeTarget(mount, mounts, relPath, { write = true } = {}) {
  const refuse = (why) => new GuardRefusal(`refused: vault target ${relPath}: ${why} — nothing ${write ? 'written' : 'read'} (ADR 0007 D04).`);
  const names = relPath.split('/');
  const shape = shapeProblem(relPath, names);
  if (shape) throw refuse(shape);
  const boundary = { ids: new Map() };
  const real = realOf(join(mount.root, ...names));
  const place = placeProblem(mount, real, boundary);
  if (place) throw refuse(place);
  const target = { real, rel: posix(relative(mount.root, real)), exists: existsSync(real), root: mount.root, folderId: idOf(dirname(real)) };
  if (!write) return target;
  const why = writeProblem(mount, mounts, real, boundary);
  if (why) throw refuse(why);
  return target;
}

/** What is wrong with a note path as written: not relative inside the vault, or a name no note may have; else null. */
function shapeProblem(relPath, names) {
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || /[\\\p{Cc}]/u.test(relPath) || names.some((name) => name === '' || name === '.' || name === '..')) {
    return 'a note is named by a path inside the vault: relative, with / separators, no .. and no empty part';
  }
  return nameProblem(names);
}

/** What is wrong with where the real path `real` lies: outside the vault (a link, `..`), not told from the vault's by name, or a name no note may have once links are followed; else null. */
function placeProblem(mount, real, boundary) {
  if (!inside(real, mount.root, idOf(mount.root), boundary)) return `it resolves to ${real}, outside the vault (a link, or ..)`;
  if (!isWithin(real, mount.root)) return `its real path ${real} cannot be told from the vault's by name (a case variant)`;
  const bad = nameProblem(relative(mount.root, real).split(sep));
  return bad ? `it resolves to ${posix(relative(mount.root, real))}: ${bad}` : null;
}

/** The nested repository the folders of `real` lie in, said, or null. */
function nestedRepository(mount, real) {
  for (let dir = dirname(real); dir !== mount.root && isWithin(dir, mount.root); dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return `${posix(relative(mount.root, dir))} is a nested repository`;
  }
  return null;
}

/** The skills folder of a mount `real` is under, said, or null. */
function underSkills(mounts, real, boundary) {
  for (const other of mounts.filter((m) => m.skills)) {
    const from = realOf(other.skills.from, other.root);
    if (inside(real, from, idOf(from), boundary)) return `it is under ${other.skills.from} of the mount ${other.path}, where skills live`;
  }
  return null;
}

/** The wiki whose note rules or template `real` is, said, or null: those files are the vault's schema, not notes. */
function isSchemaFile(mounts, real) {
  for (const other of mounts.filter((m) => m.wiki)) {
    const file = [other.wiki.rules, other.wiki.template].filter(Boolean).find((name) => sameFile(real, realOf(name, other.root)));
    if (file) return `it is ${file}, the note rules or the template of the wiki '${other.wiki.name}'`;
  }
  return null;
}

/** What is wrong with the file `real` as a thing to write over: not a regular file, or one with more than one hard link; else null. */
function fileProblem(real) {
  let stat = null;
  try {
    stat = lstatSync(real);
  } catch { /* a new note */ }
  if (stat && !stat.isFile()) return 'it is not a regular file';
  return stat && hardLinked(real) ? 'it is a file with more than one hard link — a write through it would change every other name too' : null;
}

/** What makes the real path `real` no place to write a note — beyond what a read also refuses — or null. */
const writeProblem = (mount, mounts, real, boundary) => nestedRepository(mount, real) ?? underSkills(mounts, real, boundary) ?? isSchemaFile(mounts, real) ?? fileProblem(real);

/**
 * The note name `create` makes of a title: the title with the characters a file name cannot hold made `-`,
 * blanks collapsed, plus `.md`. A title that leaves no name, starts with a dot or is too long is a usage error.
 * @param {string} title
 * @returns {string}
 */
export function noteName(title) {
  const name = String(title ?? '').trim().replace(/\.md$/i, '').replace(/[<>:"/\\|?*]|\p{Cc}/gu, '-').replace(/\s+/g, ' ').trim();
  if (!name || name.startsWith('.')) throw new UsageError(`--title ${JSON.stringify(title)} makes no note name (not empty, no leading dot)`);
  if (name.length > NAME_LIMIT) throw new UsageError(`--title is longer than ${NAME_LIMIT} characters`);
  return `${name}.md`;
}

/**
 * The folder a new note goes into, as a path from the vault's root: `folder` (`--folder`), else the wiki's
 * `wiki.inbox`. A note goes into the inbox or a folder below the notes root, never the root itself, so with
 * neither it is a usage error.
 * @param {object} mount
 * @param {string|undefined} folder
 * @returns {string}
 */
export function noteFolder(mount, folder) {
  const given = (folder ?? mount.wiki.inbox ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!given || given === '.') throw new UsageError(`no folder: a note goes into the wiki's inbox (wiki.inbox of ${mount.path}) or a folder below the notes root — pass --folder`);
  return given;
}

/**
 * Write `text` as the note `target` — through a temporary file in the target's own folder, renamed into place
 * (ADR 0007 D02). A new note is put in place without replacing a file that appeared in the meantime. Folders
 * of the path that do not exist are made one at a time, each refused when it is a link. The note's folder is
 * judged again — still its own real path, still inside the vault, still the same folder by device and inode —
 * just before the temporary file is written and again before it is put in place; a change refuses the write
 * (GuardRefusal) and removes the temporary file. Between a check and the call that follows it a link can
 * still be swapped in: this narrows that window, it cannot close it without openat.
 * @param {Target} target from {@link judgeTarget}
 * @param {string} text
 */
export function writeNote(target, text) {
  const folder = dirname(target.real);
  makeFolders(target);
  const id = target.folderId ?? idOf(folder);
  assertFolderUnchanged(target, id);
  const temporary = join(folder, `.${basename(target.real)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: target.exists ? statSync(target.real).mode & 0o777 : 0o644 });
    assertFolderUnchanged(target, id);
    if (target.exists) renameSync(temporary, target.real);
    else putNew(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Make the folders of the note's path that do not exist, one component at a time, from the vault's root; a component that is a link, or not a folder, refuses the write. */
function makeFolders(target) {
  let dir = target.root;
  for (const name of relative(target.root, dirname(target.real)).split(sep).filter(Boolean)) {
    dir = join(dir, name);
    let stat = lstatOrNull(dir);
    if (stat === null) {
      try {
        mkdirSync(dir);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      stat = lstatSync(dir);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw changedTarget(target, `${posix(relative(target.root, dir))} is ${stat.isSymbolicLink() ? 'a link' : 'not a folder'}`);
  }
}

/** What `path` is, or null when there is nothing there. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** The refusal of a write whose folder is not what it was when judged. */
const changedTarget = (target, why) => new GuardRefusal(`refused: vault target ${target.rel}: ${why} — it changed after it was judged; nothing written (ADR 0007 D02).`);

/** Refuse unless the folder of the note is still its own real path, inside the vault, and the folder with identity `id`. */
function assertFolderUnchanged(target, id) {
  const folder = dirname(target.real);
  if (realOf(folder) !== folder) throw changedTarget(target, `its folder now resolves to ${realOf(folder)} (a link)`);
  if (!isWithin(folder, target.root) || !inside(folder, target.root, idOf(target.root), { ids: new Map() })) throw changedTarget(target, 'its folder is outside the vault');
  if (id !== null && idOf(folder) !== id) throw changedTarget(target, 'its folder is not the one that was judged');
}

/** Put the finished file `temporary` at `target.real`, a name nothing holds: by a hard link that fails on an existing file, else — a file system without links — by a checked rename. */
function putNew(temporary, target) {
  const taken = () => new UsageError(`the note ${target.rel} exists now — edit it with append or replace-section instead`);
  try {
    linkSync(temporary, target.real);
  } catch (e) {
    if (e.code === 'EEXIST') throw taken();
    if (existsSync(target.real)) throw taken();
    renameSync(temporary, target.real);
  }
}

// -- the notes of a vault --------------------------------------------------------------------------

/**
 * The notes of a vault: the paths from its root of every `.md` file, links not followed, dot folders and
 * `node_modules` left out, rule files and SKILL.md left out. Sorted.
 * @param {object} mount a wiki mount
 * @returns {string[]}
 */
export function noteFiles(mount) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP_FOLDERS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile() && nameProblem([entry.name]) === null) found.push(rel);
    }
  };
  walk(mount.root, '');
  return found.sort();
}

/**
 * The note `ref` means in the vault: a path from its root (`inbox/idea.md`, `.md` optional) or a name
 * (`idea`), matched exactly, then ignoring case. A name that several notes have is a usage error that lists them.
 * @param {object} mount
 * @param {string} ref
 * @returns {string|null} the path from the vault's root, or null when the vault has no such note
 */
export function findNote(mount, ref) {
  const wanted = String(ref ?? '').trim().replace(/^\.\//, '');
  if (!wanted) throw new UsageError('--note is required (a path from the vault\'s root, or a note name)');
  const files = noteFiles(mount);
  const withExtension = /\.md$/i.test(wanted) ? wanted : `${wanted}.md`;
  const key = wanted.includes('/') ? (file) => file : (file) => file.split('/').pop();
  const hits = (compare) => files.filter((file) => compare(key(file)) === compare(withExtension));
  const found = hits((s) => s).length ? hits((s) => s) : hits((s) => s.toLowerCase());
  if (found.length === 1) return found[0];
  if (found.length > 1) throw new UsageError(`${found.length} notes in ${mount.wiki.name} are named ${JSON.stringify(ref)} — give a path:\n${found.map((f) => `  ${f}`).join('\n')}`);
  return null;
}

/** The frontmatter `title` of a note's text, or ''. */
function titleOf(text) {
  const { front } = splitNote(text);
  if (front === null) return '';
  try {
    const title = YAML.parse(front)?.title;
    return typeof title === 'string' ? title : '';
  } catch {
    return '';
  }
}

/**
 * @typedef {object} NoteHit
 * @property {string} file the note's path from the vault's root
 * @property {number} line from 1
 * @property {string} text the line
 * @property {string|null} before the line before, or null
 * @property {string|null} after the line after, or null
 */

/**
 * Search the notes of a vault: `title` against each note's file name and frontmatter `title`, `query`
 * against every line (frontmatter included), both ignoring case; at most `limit` of each. A note over
 * SEARCH_LIMIT_BYTES is not read.
 * @param {object} mount
 * @param {{title?: string, query?: string, limit?: number}} options
 * @returns {{titles: string[], hits: NoteHit[], more: number}}
 */
export function searchNotes(mount, { title, query, limit = 25 }) {
  const titles = [];
  const hits = [];
  let more = 0;
  for (const file of noteFiles(mount)) {
    const real = join(mount.root, ...file.split('/'));
    if (statSync(real).size > SEARCH_LIMIT_BYTES) continue;
    const text = readFileSync(real, 'utf8');
    if (title) {
      const wanted = title.toLowerCase();
      const name = file.split('/').pop().replace(/\.md$/i, '');
      if ([name, titleOf(text)].some((candidate) => candidate.toLowerCase().includes(wanted))) {
        if (titles.length < limit) titles.push(file); else more += 1;
      }
    }
    if (!query) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.toLowerCase().includes(query.toLowerCase())) return;
      if (hits.length >= limit) { more += 1; return; }
      hits.push({ file, line: i + 1, text: line, before: i > 0 ? lines[i - 1] : null, after: i + 1 < lines.length ? lines[i + 1] : null });
    });
  }
  return { titles, hits, more };
}

/** The text of the note `target` (judged for a read). */
export const readNote = (target) => readFileSync(target.real, 'utf8');

// -- a new note ------------------------------------------------------------------------------------

/**
 * A note's text split into its YAML front matter (the text between the `---` lines, or null when the note
 * has none) and the body after it.
 * @param {string} text
 * @returns {{front: string|null, body: string}}
 */
export function splitNote(text) {
  const m = String(text).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  return m ? { front: m[1], body: String(text).slice(m[0].length) } : { front: null, body: String(text) };
}

/** `text` with the placeholders of a template filled: `{{title}}` and `{{date}}` (YYYY-MM-DD). */
const filled = (text, title, date) => text.replace(/\{\{\s*title\s*\}\}/g, title).replace(/\{\{\s*date\s*\}\}/g, date);

/** The parsed front matter `front` (an object), a usage error naming `what` when it does not parse or is not a mapping. */
function parsedFront(front, what) {
  let data;
  try {
    data = YAML.parse(front);
  } catch (e) {
    throw new UsageError(`${what}: the front matter does not parse (${e.message.split('\n')[0]})`, { cause: e });
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new UsageError(`${what}: the front matter must be a mapping`);
  return data;
}

/**
 * Put a new note together: the vault's template (`wiki.template`, read from the vault, `{{title}}` and
 * `{{date}}` filled; no template is an empty one) and the text given. The given text may start with its
 * own front matter, whose keys are set in the template's (the template's comments stay); its body goes
 * where the template's `{{body}}` stands, else after the template's body.
 * @param {object} mount the wiki mount
 * @param {{title: string, text: string, date?: string}} input `title` is the note's title, `text` what the user gave
 * @returns {{front: string|null, body: string, text: string}} the front matter (without its fences), the body and the whole note
 */
export function composeNote(mount, { title, text, date = new Date().toISOString().slice(0, 10) }) {
  const template = splitNote(mount.wiki.template ? filled(vaultFile(mount, mount.wiki.template, 'wiki.template'), title, date) : '');
  const given = splitNote(text);
  const front = mergedFront(mount, template.front, given.front);
  if (front !== null) parsedFront(front, 'the note');
  const slot = /\{\{\s*body\s*\}\}/;
  const added = given.body.trim();
  const body = slot.test(template.body) ? template.body.replace(slot, added) : [template.body.trim(), added].filter(Boolean).join('\n\n');
  const finished = `${body.replace(/\n+$/, '')}\n`;
  return { front, body: finished, text: front === null ? finished : `---\n${front}\n---\n${finished}` };
}

/** The front matter of a new note: the template's with the given text's keys set in it (the template's comments stay), or whichever there is, or null. */
function mergedFront(mount, fromTemplate, fromGiven) {
  if (fromTemplate === null || fromGiven === null) return fromTemplate ?? fromGiven;
  const merged = YAML.parseDocument(fromTemplate);
  if (merged.errors.length) throw new UsageError(`wiki.template ${mount.wiki.template}: the front matter does not parse (${merged.errors[0].message.split('\n')[0]})`);
  for (const [key, value] of Object.entries(parsedFront(fromGiven, 'the note'))) merged.set(key, value);
  return String(merged).trimEnd();
}

/**
 * Refuse a new note whose front matter lacks a key the vault's note rules require (a refusal, exit 3).
 * @param {string|null} front the note's front matter text
 * @param {NoteRules} rules
 * @param {string} wiki the wiki's name, for the message
 */
export function checkRequired(front, rules, wiki) {
  if (!rules.required.length) return;
  const data = front === null ? {} : parsedFront(front, 'the note');
  const missing = rules.required.filter((key) => data[key] === undefined || data[key] === null || data[key] === '');
  if (missing.length) throw new GuardRefusal(`refused: note rules: the wiki '${wiki}' requires the front matter key(s) ${missing.join(', ')} — nothing written.`);
}
