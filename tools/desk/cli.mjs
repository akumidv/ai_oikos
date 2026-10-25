#!/usr/bin/env node
// The mechanics of the desk agent's working folder (ADR 0006 D03): `.local/desk/` holds topics of
// incoming notes that become tracker tasks. The agent writes notes, plan, drafts, card and summary
// with its file tools; this tool makes the new topic folders, rebuilds the derived INDEX.md, says
// each topic's status and age, searches, compacts old topics into `_archive/` and reopens them.
//
// A local write of open, git-ignored files only: it writes under `.local/desk/` and nowhere else,
// takes no --dry-run and is not a guarded write. It never deletes a file — a file is moved, and
// only a folder left empty by a move is removed (the ancestors of the files moved, nothing else).
// It refuses, before writing anything, to write through a symlink under `.local/desk/`. Every fact of a topic (status, age, tier, keys)
// is computed from the folders on each run, never stored.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import YAML from 'yaml';
import { runCli, isMain, printJson, UsageError } from '../common/cli.mjs';
import { config } from '../common/config.mjs';
import { DESK_FOLDER, FINAL_STATUSES, UNIT_STATUSES, deskSettings } from '../common/desk.mjs';
import { frontmatter } from '../common/landscape.mjs';
import { installRoot, localPath } from '../common/paths.mjs';

const TOOL = 'node oikos/tools/desk/cli.mjs';
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const ARCHIVE = '_archive';
const INDEX = 'INDEX.md';
const KEPT_LIVE = ['card.md', 'summary.md'];
const PLAN_HEADER = '| # | unit | kind | where | source | status | key |';
const PLAN_SEPARATOR = '|---|------|------|-------|--------|--------|-----|';
const DAY_MS = 24 * 60 * 60 * 1000;
const LINE_WIDTH = 160;
const MAX_FILE_HITS = 50;
const SHOWN_CONFLICTS = 3;
const NO_VALUE = '—';

const counted = (n, word) => `${n} ${word}(s)`;
const deskDir = () => localPath(DESK_FOLDER);
/** A path as the agent reads it: relative to the installation. */
const shown = (path) => relative(installRoot(), path);

// == thresholds ==

/** A `--warm-days`-style flag `value` as a whole number of days, 1 or more; `name` is for the message. */
function daysOf(value, name) {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new UsageError(`--${name} '${value}': a whole number of days, 1 or more`);
  return Number(value);
}

/**
 * { warmDays, coldDays }: the flags of `values` over the `desk:` part of the installation's
 * `oikos.yaml` over the defaults. Cold must come after warm, wherever each value came from.
 */
export function thresholds(values) {
  const settings = deskSettings(config().desk);
  const warmDays = values['warm-days'] == null ? settings.warmDays : daysOf(values['warm-days'], 'warm-days');
  const coldDays = values['cold-days'] == null ? settings.coldDays : daysOf(values['cold-days'], 'cold-days');
  if (coldDays <= warmDays) {
    throw new UsageError(`cold days (${coldDays}) must be greater than warm days (${warmDays}) — set --warm-days / --cold-days or desk: in oikos.yaml`);
  }
  return { warmDays, coldDays };
}

// == reading a topic's files ==

/** Every file under `dir` (symlinks not followed) as { rel, abs, mtimeMs }, by name; [] when there is no `dir`. */
function filesOf(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  const walk = (at, rel) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(at, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, name);
      else found.push({ rel: name, abs, mtimeMs: lstatSync(abs).mtimeMs });
    }
  };
  walk(dir, '');
  return found;
}

const listed = (value) => (Array.isArray(value) ? value : String(value ?? '').split(',')).map((v) => String(v).trim()).filter(Boolean);
const keysOf = (text) => text.split(/[,\s]+/).filter((k) => k && !['—', '–', '-'].includes(k));
const unique = (values) => [...new Set(values)];

/** The frontmatter of `text` (null: no file) as { fm, body }; a file with none, or with broken YAML, is { fm: {}, body: text }. */
function split(text) {
  const body = text ?? '';
  try {
    return frontmatter(body) || { fm: {}, body };
  } catch {
    return { fm: {}, body };
  }
}

/**
 * The cells of a markdown table row: split on unescaped pipes only, `\|` read as a literal pipe,
 * the optional leading and trailing pipe dropped, each cell trimmed.
 */
export function cellsOf(row) {
  const text = row.trim();
  const cells = [];
  let cell = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (text[i] === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += text[i];
    }
  }
  cells.push(cell);
  if (text.startsWith('|')) cells.shift();
  if (text.endsWith('|') && !text.endsWith('\\|')) cells.pop();
  return cells.map((c) => c.trim());
}

const DASHES = /^:?-+:?$/;
const isRow = (line) => line.includes('|');

/**
 * The units of a plan.md `body`: [{ status, key }] — the rows of the first markdown table (edge
 * pipes optional) whose header has a `status` column and is followed by a separator row; `key` is
 * the key cells' task keys ('' without a key column). A status outside UNIT_STATUSES is '?', and so
 * is the status of a row with fewer cells than the header: a damaged row is never taken as final.
 */
export function unitsOf(body) {
  const lines = body.split('\n');
  const at = lines.findIndex((l, i) => isRow(l) && isRow(lines[i + 1] ?? '')
    && cellsOf(lines[i + 1]).every((c) => DASHES.test(c)) && cellsOf(l).some((c) => c.toLowerCase() === 'status'));
  if (at < 0) return [];
  const names = cellsOf(lines[at]).map((c) => c.toLowerCase());
  const statusAt = names.indexOf('status');
  const keyAt = names.indexOf('key');
  const units = [];
  for (const line of lines.slice(at + 2)) {
    if (!isRow(line)) break;
    const cells = cellsOf(line);
    if (cells.every((c) => !c)) continue;
    const status = cells.length < names.length ? '' : cells[statusAt].toLowerCase();
    units.push({ status: UNIT_STATUSES.includes(status) ? status : '?', key: keyAt < 0 ? '' : keysOf(cells[keyAt] || '').join(', ') });
  }
  return units;
}

/** Whether `file` is a regular file itself — not a folder, not a symlink (a link could lead out of the desk). */
const isPlainFile = (file) => lstatSync(file, { throwIfNoEntry: false })?.isFile() === true;

/** The text of the regular file `file`, or null when it is absent or is not a regular file. */
const readText = (file) => (isPlainFile(file) ? readFileSync(file, 'utf8') : null);

// == topics: folders to facts ==

/**
 * Every topic of the desk as { date, slug, liveDir, archiveDir } (a folder is null when absent),
 * by date then slug. A topic in both places is one topic.
 */
function topicFolders(desk) {
  const topics = new Map();
  const add = (date, slug, where, dir) => {
    const id = `${date}/${slug}`;
    if (!topics.has(id)) topics.set(id, { date, slug, liveDir: null, archiveDir: null });
    topics.get(id)[where] = dir;
  };
  const folders = (dir, pattern) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && pattern.test(e.name)).map((e) => e.name).sort() : []);
  for (const date of folders(desk, DATE)) {
    for (const slug of folders(join(desk, date), /^[^.]/)) add(date, slug, 'liveDir', join(desk, date, slug));
  }
  const archive = join(desk, ARCHIVE);
  for (const month of folders(archive, MONTH)) {
    for (const date of folders(join(archive, month), DATE)) {
      for (const slug of folders(join(archive, month, date), /^[^.]/)) add(date, slug, 'archiveDir', join(archive, month, date, slug));
    }
  }
  return [...topics.values()].sort((a, b) => a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug));
}

/** A topic's status (open, done, closed, archived) from what its live folder holds; see the design's § Topic facts. */
function statusOf({ live, hasCard, hasPlan, allFinal }) {
  if (!live) return 'archived';
  if (hasCard && (!hasPlan || allFinal)) return 'closed';
  return allFinal && !hasCard ? 'done' : 'open';
}

/** hot while the topic's age is within `warmDays`, then warm; cold when only the archive holds it. */
function tierOf(liveDir, ageDays, warmDays) {
  if (!liveDir) return 'cold';
  return ageDays <= warmDays ? 'hot' : 'warm';
}

/** Whole days since the newest file of the topic's live and archive folders (the folder itself when both are empty). */
function ageOf({ liveDir, archiveDir }, now) {
  const files = [...filesOf(liveDir || ''), ...filesOf(archiveDir || '')];
  const newest = files.length ? Math.max(...files.map((f) => f.mtimeMs)) : statSync(liveDir || archiveDir).mtimeMs;
  return Math.max(0, Math.floor((now - newest) / DAY_MS));
}

/** The text of the plan.md in the archive folder `archiveDir` (null: none, or no archive folder). */
const archivedPlanOf = (archiveDir) => (archiveDir ? readText(join(archiveDir, 'plan.md')) : null);

/**
 * The facts of one topic folder-pair `folders`, computed at `now` (ms) with `warmDays`:
 * { date, slug, status, ageDays, tier, keys, tags, title, path, units, archived, stale, hasPlan,
 * hasCard, hasSummary, liveDir, archiveDir }. `archived` is whether any raw material or the whole
 * topic sits in `_archive/`. The age counts the newest file of both places, so moving raw material
 * to the archive does not make a topic look older than its last activity.
 */
function topicOf(folders, desk, now, warmDays) {
  const { date, slug, liveDir, archiveDir } = folders;
  const home = liveDir || archiveDir;
  const text = (name) => readText(join(home, name));
  const [card, plan, summary] = ['card.md', 'plan.md', 'summary.md'].map(text);
  // After the warm step the plan sits in the archive: it still names the topic's keys, tags and
  // title, but the status is judged from the live folder only.
  const cardPart = split(card);
  const planPart = split(plan ?? archivedPlanOf(archiveDir));
  const units = plan == null ? [] : unitsOf(planPart.body);
  const allFinal = units.length > 0 && units.every((u) => FINAL_STATUSES.includes(u.status));
  const hasCard = card != null;
  const hasPlan = plan != null;
  const status = statusOf({ live: Boolean(liveDir), hasCard, hasPlan, allFinal });
  const ageDays = ageOf(folders, now);
  return {
    date,
    slug,
    status,
    ageDays,
    tier: tierOf(liveDir, ageDays, warmDays),
    keys: unique([...listed(cardPart.fm.keys), ...unitsOf(planPart.body).flatMap((u) => keysOf(u.key))]),
    tags: unique([...listed(cardPart.fm.tags), ...listed(planPart.fm.tags)]),
    title: String(cardPart.fm.title || planPart.fm.title || slug),
    path: relative(desk, home),
    units,
    archived: Boolean(archiveDir),
    stale: status === 'open' && hasCard && hasPlan,
    hasPlan,
    hasCard,
    hasSummary: summary != null,
    liveDir,
    archiveDir,
  };
}

/** All topics of the desk, with their facts, at the current time. */
function topicsOf(desk, { warmDays }) {
  const now = Date.now();
  return topicFolders(desk).map((f) => topicOf(f, desk, now, warmDays));
}

/** The `--json` shape of the topic `t`. */
const topicJson = (t) => ({
  date: t.date, slug: t.slug, status: t.status, ageDays: t.ageDays, tier: t.tier, keys: t.keys, tags: t.tags,
  title: t.title, path: t.path, units: t.units, archived: t.archived,
});

// == INDEX.md ==

/** The index line of the topic `t`. */
const indexLine = (t) => `- ${[t.date, t.slug, t.status, t.keys.join(', ') || NO_VALUE, t.tags.join(', ') || NO_VALUE, t.title.replace(/\s+/g, ' ') || NO_VALUE, t.path].join(' · ')}`;

/** The text of INDEX.md for the topics `topics`. */
export function indexText(topics) {
  return [
    '# Desk index',
    '',
    `Generated by \`${TOOL} index\` from the topic folders — do not edit by hand; it is rebuilt.`,
    '',
    ...topics.map(indexLine),
    '',
  ].join('\n');
}

/** Rebuild INDEX.md; { lines, written } — nothing is rewritten when the text is unchanged. */
function writeIndex(desk, settings) {
  const topics = topicsOf(desk, settings);
  const text = indexText(topics);
  const file = join(desk, INDEX);
  const written = readText(file) !== text;
  if (written) {
    assertNoSymlink(desk, file);
    mkdirSync(desk, { recursive: true });
    writeFileSync(file, text);
  }
  return { lines: topics.length, written };
}

// == moving files: nothing is deleted ==

/**
 * Why `path` cannot be written, or null: `desk` itself, or a folder or file between it and `path`,
 * is a symlink — a write through it would land outside `.local/desk/`. Parts that do not exist
 * yet will be made as real folders, so the walk stops at the first one that is missing.
 */
function symlinkProblem(desk, path) {
  let at = desk;
  for (const part of ['', ...relative(desk, path).split('/')]) {
    at = part ? join(at, part) : at;
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink()) return `${shown(at)} is a symlink — the desk is written only through real folders`;
    if (at === desk && !stat.isDirectory()) return `${shown(at)} is not a folder`;
  }
  return null;
}

/** Throws a UsageError, before anything is written, when `path` in `desk` would be written through a symlink. */
function assertNoSymlink(desk, path) {
  const problem = symlinkProblem(desk, path);
  if (problem) throw new UsageError(`Refusing to write ${shown(path)}: ${problem}. Nothing was written.`);
}

/**
 * What moving `from` to `to` does: 'new', 'same' (identical content there already — the move
 * leaves one copy), or { conflict } when the name is taken by other content or by a non-file.
 */
function fateOf(from, to) {
  const there = lstatSync(to, { throwIfNoEntry: false });
  if (!there) return 'new';
  if (!there.isFile()) return { conflict: `${shown(to)} exists and is not a plain file` };
  return readFileSync(to).equals(readFileSync(from)) ? 'same' : { conflict: `${shown(to)} exists with other content` };
}

/**
 * The moves of the files `files` (of `from`) into the folder `to`, as { moves: [{ from, to, fate }],
 * conflicts: [text] }, each judged before anything moves.
 */
function judgeMoves(files, from, to) {
  const moves = [];
  const conflicts = [];
  for (const f of files) {
    const dest = join(to, f.rel);
    const problem = symlinkProblem(deskDir(), dest);
    const fate = problem ? { conflict: problem } : fateOf(f.abs, dest);
    if (typeof fate === 'object') conflicts.push(fate.conflict);
    else moves.push({ from: f.abs, to: dest, fate });
  }
  return { moves, conflicts, from, to };
}

/** Remove `start` and its ancestors while they are empty — the folders a move emptied, walked upward only — never `stop` or above. */
function pruneUp(start, stop) {
  for (let at = start; at !== stop && at.startsWith(`${stop}/`) && readdirSync(at).length === 0; at = dirname(at)) rmdirSync(at);
}

/** Move each of `moves` (renameSync keeps the content and the mtime), then prune the folders left empty up to `stop`. */
function applyMoves(moves, stop) {
  for (const m of moves) {
    mkdirSync(dirname(m.to), { recursive: true });
    renameSync(m.from, m.to);
  }
  for (const dir of unique(moves.map((m) => dirname(m.from)))) pruneUp(dir, stop);
}

/** The archive folder of the topic `t`: `_archive/<YYYY-MM>/<date>/<slug>`. */
const archiveOf = (desk, t) => join(desk, ARCHIVE, t.date.slice(0, 7), t.date, t.slug);

// == new ==

/** Today as YYYY-MM-DD, local time. */
function today() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** `date` as given to --date: a real calendar day, YYYY-MM-DD. */
function dateOf(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  // An impossible day is an Invalid Date (month 13, day 32) or rolls over (February 30).
  const real = DATE.test(date) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  if (!real) throw new UsageError(`--date '${date}': a calendar day as YYYY-MM-DD`);
  return date;
}

/** The slug `slug` argument checked: latin letters, digits and '-'; never the archive's own name. */
function slugOf(slug) {
  if (!slug) throw new UsageError('a topic slug is required: new <slug> (e.g. api-review)');
  if (slug === ARCHIVE || !SLUG.test(slug)) throw new UsageError(`slug '${slug}': lowercase latin letters, digits and '-', starting with a letter or digit, not '${ARCHIVE}' (e.g. api-review)`);
  return slug;
}

/** The text of a new plan.md: frontmatter and the empty unit table. */
const planText = (title, tags) => `---\n${YAML.stringify({ title, tags })}---\n\n${PLAN_HEADER}\n${PLAN_SEPARATOR}\n`;

/** Create a topic: `slug` on `date`, `-2`, `-3`… when taken. Returns { slug, date, dir, notes }. */
function newTopic(slug, { date, title, tags }, desk, settings) {
  const others = topicsOf(desk, settings);
  const taken = (s) => others.some((t) => t.date === date && t.slug === s);
  let chosen = slug;
  for (let n = 2; taken(chosen); n += 1) chosen = `${slug}-${n}`;
  const notes = [];
  if (chosen !== slug) notes.push(`'${slug}' is taken on ${date} — created '${chosen}'`);
  for (const t of others) {
    if (t.slug === slug && t.date !== date && t.status === 'open') notes.push(`open topic ${t.date}/${t.slug} has the same slug — continue it, or this is a new topic`);
  }
  const dir = join(desk, date, chosen);
  assertNoSymlink(desk, join(dir, 'plan.md'));
  assertNoSymlink(desk, join(desk, INDEX));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.md'), `# ${title}\n`, { flag: 'wx' });
  writeFileSync(join(dir, 'plan.md'), planText(title, tags), { flag: 'wx' });
  return { slug: chosen, date, dir, notes };
}

// == list ==

/** The count line of `list`: `3 topic(s): 1 open, 1 done, 1 closed` (archived only when shown). */
function countLine(topics) {
  const count = (status) => topics.filter((t) => t.status === status).length;
  const parts = ['open', 'done', 'closed', 'archived'].filter((s) => s !== 'archived' || count(s)).map((s) => `${count(s)} ${s}`);
  return `${topics.length} topic(s): ${parts.join(', ')}`;
}

/** The line of `list` for the topic `t`. */
const listLine = (t) => `${t.date}  ${t.slug}  ${t.status}  ${t.ageDays}d  ${t.tier}  ${t.keys.join(', ') || '-'}`;

// == find ==

/** The topics of `topics` whose index fields (slug, title, keys, tags) contain `needle` (lowercase). */
const fieldHits = (topics, needle) => topics.filter((t) => [t.slug, t.title, ...t.keys, ...t.tags].some((f) => f.toLowerCase().includes(needle)));

/** The lines of the file `abs` containing `needle` (lowercase), as { path, line, text }. */
function lineHits(abs, needle) {
  const hits = [];
  readFileSync(abs, 'utf8').split('\n').forEach((text, i) => {
    if (text.toLowerCase().includes(needle)) hits.push({ path: shown(abs), line: i + 1, text: text.trim().slice(0, LINE_WIDTH) });
  });
  return hits;
}

/** The files `find` reads: card.md and summary.md of live topics, plus everything under `_archive/` with --archive. */
function searchedFiles(topics, desk, archive) {
  const files = [];
  for (const t of topics) {
    for (const name of KEPT_LIVE) if (t.liveDir && isPlainFile(join(t.liveDir, name))) files.push(join(t.liveDir, name));
  }
  if (archive) files.push(...filesOf(join(desk, ARCHIVE)).map((f) => f.abs).filter(isPlainFile));
  return files;
}

// == compact ==

/** The compaction of the live topic `t`: { topic, skip } | { topic, step, moves, conflicts } | null when nothing is due. */
function compactionOf(t, desk, { warmDays, coldDays }) {
  if (!t.liveDir || t.ageDays <= warmDays) return null;
  const topic = { date: t.date, slug: t.slug };
  if (t.status === 'open') return { topic, skip: t.hasPlan && t.units.length ? 'has open units — stays hot' : 'has no plan with units, or none final — stays hot' };
  const missing = KEPT_LIVE.filter((name) => !isPlainFile(join(t.liveDir, name)));
  if (missing.length) return { topic, skip: `needs ${missing.join(' and ')} — the agent writes them` };
  const cold = t.ageDays > coldDays;
  const files = filesOf(t.liveDir).filter((f) => cold || !KEPT_LIVE.includes(f.rel));
  if (!files.length) return null;
  return { topic, step: cold ? 'cold' : 'warm', ...judgeMoves(files, t.liveDir, archiveOf(desk, t)) };
}

/** The line of `compact` for the plan `p`. */
function compactLine(p) {
  const id = `${p.topic.date}/${p.topic.slug}`;
  if (p.skip) return `${id}: skipped — ${p.skip}`;
  if (p.conflicts.length) {
    const more = p.conflicts.length > SHOWN_CONFLICTS ? `; and ${p.conflicts.length - SHOWN_CONFLICTS} more` : '';
    return `${id}: refused — ${p.conflicts.slice(0, SHOWN_CONFLICTS).join('; ')}${more}`;
  }
  return `${id}: ${p.step} — ${counted(p.moves.length, 'file')} to ${shown(p.to)}/`;
}

/** Apply the compactions `done`; the index is checked writable first, so a refusal leaves everything where it was. */
function applyCompaction(done, desk) {
  if (!done.length) return;
  assertNoSymlink(desk, join(desk, INDEX));
  for (const p of done) applyMoves(p.moves, desk);
}

/** The closing line of an applied compaction: the plans `done`, and the rebuilt index (null: not rebuilt). */
function compactTotal(done, indexed) {
  const files = done.reduce((n, p) => n + p.moves.length, 0);
  return `${counted(done.length, 'topic')} compacted, ${counted(files, 'file')} moved${indexed ? `; ${INDEX} rebuilt (${counted(indexed.lines, 'topic line')})` : ''}`;
}

/** The `--json` shape of the compaction plan `p`. */
const compactJson = (p) => ({
  ...p.topic,
  action: p.skip ? 'skip' : p.conflicts?.length ? 'conflict' : p.step,
  reason: p.skip,
  conflicts: p.conflicts || [],
  files: (p.moves || []).map((m) => ({ from: shown(m.from), to: shown(m.to), fate: m.fate })),
});

// == reopen ==

/** The archived topic `target` (`slug` or `date/slug`) names, or a UsageError saying why not. */
function reopenTarget(topics, target) {
  if (!target) throw new UsageError('name the topic: reopen <slug|date/slug> (desk list --all shows the archived ones)');
  const parts = target.split('/');
  if (parts.length > 2 || (parts.length === 2 && !DATE.test(parts[0]))) throw new UsageError(`reopen target '${target}': name the topic as <slug> or <date>/<slug> (e.g. 2026-06-01/api-review)`);
  const [date, slug] = parts.length === 2 ? parts : [null, target];
  const archived = topics.filter((t) => t.archived);
  const found = archived.filter((t) => t.slug === slug && (!date || t.date === date));
  if (!found.length) throw new UsageError(`no archived topic '${target}' in ${shown(join(deskDir(), ARCHIVE))}/ — ${TOOL} find <text> --archive looks for it`);
  if (found.length > 1) throw new UsageError(`'${target}' is ambiguous: ${found.map((t) => `${t.date}/${t.slug}`).join(', ')} — name one as date/slug`);
  return found[0];
}

const commands = {
  new: {
    help: 'start a topic: new <slug> [--title T] [--tags a,b] [--date YYYY-MM-DD] — notes.md and plan.md in <date>/<slug>/',
    options: { title: { type: 'string' }, tags: { type: 'string' }, date: { type: 'string' } },
    run(values, positionals) {
      const desk = deskDir();
      const slug = slugOf(positionals[0]);
      if (values.title != null && /[\r\n]/.test(values.title)) throw new UsageError('--title is one line');
      const settings = thresholds({});
      const made = newTopic(slug, {
        date: values.date == null ? today() : dateOf(values.date),
        title: values.title?.trim() || slug,
        tags: listed(values.tags),
      }, desk, settings);
      const indexed = writeIndex(desk, settings);
      if (values.json) return printJson({ date: made.date, slug: made.slug, path: shown(made.dir), notes: made.notes, index: indexed });
      console.log(shown(made.dir));
      for (const n of made.notes) console.log(`note: ${n}`);
    },
  },
  index: {
    help: `rebuild ${INDEX} from the topic folders (live and archived); it is derived — never edit it by hand`,
    options: { 'warm-days': { type: 'string' }, 'cold-days': { type: 'string' } },
    run(values) {
      const desk = deskDir();
      const indexed = writeIndex(desk, thresholds(values));
      if (values.json) return printJson(indexed);
      console.log(`${shown(join(desk, INDEX))}: ${counted(indexed.lines, 'topic line')}${indexed.written ? '' : ' (unchanged)'}`);
    },
  },
  list: {
    help: 'the topics with status (open, done, closed), age and tier: list [--all] — --all adds the archived ones',
    options: { all: { type: 'boolean' }, 'warm-days': { type: 'string' }, 'cold-days': { type: 'string' } },
    run(values) {
      const topics = topicsOf(deskDir(), thresholds(values)).filter((t) => values.all || t.liveDir);
      if (values.json) return printJson(topics.map(topicJson));
      if (!topics.length) return console.log(`no topics on the desk — start one: ${TOOL} new <slug>`);
      console.log(countLine(topics));
      for (const t of topics) console.log(listLine(t));
      for (const t of topics.filter((x) => x.stale)) console.log(`note: ${t.date}/${t.slug} has a card.md but a unit is not final — the card is stale`);
    },
  },
  find: {
    help: 'find <text|key> [--archive]: topics by slug, title, keys, tags and the text of card.md and summary.md; --archive also reads everything under _archive/',
    options: { archive: { type: 'boolean' } },
    run(values, positionals) {
      const query = positionals.join(' ').trim();
      if (!query) throw new UsageError('find needs a text or a task key: find <text|key> [--archive]');
      const desk = deskDir();
      const needle = query.toLowerCase();
      const topics = topicsOf(desk, thresholds({}));
      const fields = fieldHits(topics, needle);
      const lines = searchedFiles(topics, desk, values.archive).flatMap((f) => lineHits(f, needle));
      const cut = Math.max(0, lines.length - MAX_FILE_HITS);
      if (values.json) return printJson([...fields.map((t) => ({ type: 'topic', ...topicJson(t) })), ...lines.slice(0, MAX_FILE_HITS).map((l) => ({ type: 'line', ...l }))]);
      if (!fields.length && !lines.length) return console.log(`no hits for '${query}'${values.archive ? '' : ' — --archive also reads the archived raw material'}`);
      console.log(`${counted(fields.length + lines.length, 'hit')} for '${query}'`);
      for (const t of fields) console.log(`${t.date} ${t.slug} (${t.status})`);
      for (const l of lines.slice(0, MAX_FILE_HITS)) console.log(`${l.path}:${l.line}: ${l.text}`);
      if (cut) console.log(`… ${cut} more line hit(s) cut — narrow the text`);
    },
  },
  compact: {
    help: 'compact [--warm-days N] [--cold-days N] [--yes]: closed topics past the thresholds move to _archive/; a plan unless --yes',
    options: { 'warm-days': { type: 'string' }, 'cold-days': { type: 'string' }, yes: { type: 'boolean' } },
    run(values) {
      const desk = deskDir();
      const settings = thresholds(values);
      const plans = topicsOf(desk, settings).map((t) => compactionOf(t, desk, settings)).filter(Boolean);
      const doing = plans.filter((p) => p.step && !p.conflicts.length);
      if (values.yes) applyCompaction(doing, desk);
      const indexed = values.yes && doing.length ? writeIndex(desk, settings) : null;
      if (values.json) return printJson({ applied: Boolean(values.yes), topics: plans.map(compactJson), index: indexed });
      if (!plans.length) return console.log(`nothing to compact — no topic is older than ${settings.warmDays} days (warm) with files to move`);
      console.log(`${values.yes ? 'Compacting' : 'Compaction plan'} — warm after ${settings.warmDays} days, cold after ${settings.coldDays}:`);
      for (const p of plans) console.log(compactLine(p));
      console.log(values.yes ? compactTotal(doing, indexed) : 'preview only — nothing moved; --yes applies it');
    },
  },
  reopen: {
    help: 'reopen <slug|date/slug> [--yes]: move an archived topic back to <date>/<slug>/ and make it hot again; a plan unless --yes',
    options: { yes: { type: 'boolean' } },
    run(values, positionals) {
      const desk = deskDir();
      const settings = thresholds({});
      const topic = reopenTarget(topicsOf(desk, settings), positionals[0]);
      const live = join(desk, topic.date, topic.slug);
      const plan = judgeMoves(filesOf(topic.archiveDir), topic.archiveDir, live);
      const id = `${topic.date}/${topic.slug}`;
      if (plan.conflicts.length) {
        const more = plan.conflicts.length > SHOWN_CONFLICTS ? `; and ${plan.conflicts.length - SHOWN_CONFLICTS} more` : '';
        throw new UsageError(`Refusing to reopen ${id}: ${plan.conflicts.slice(0, SHOWN_CONFLICTS).join('; ')}${more}. Nothing was moved.`);
      }
      let indexed = null;
      if (values.yes) {
        assertNoSymlink(desk, join(desk, INDEX));
        applyMoves(plan.moves, join(desk, ARCHIVE));
        const now = new Date();
        for (const m of plan.moves) utimesSync(m.to, now, now);
        indexed = writeIndex(desk, settings);
      }
      if (values.json) return printJson({ date: topic.date, slug: topic.slug, applied: Boolean(values.yes), files: plan.moves.map((m) => ({ from: shown(m.from), to: shown(m.to), fate: m.fate })), index: indexed });
      console.log(`${values.yes ? 'Reopened' : 'Would reopen'} ${id}: ${counted(plan.moves.length, 'file')} from ${shown(plan.from)}/ to ${shown(live)}/`);
      console.log(values.yes ? `${INDEX} rebuilt (${counted(indexed.lines, 'topic line')})` : 'preview only — nothing moved; --yes applies it');
    },
  },
};

if (isMain(import.meta.url)) runCli('desk', commands);
