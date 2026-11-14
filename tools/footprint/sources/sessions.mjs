// The sessions source: what a person does in agent sessions — the messages typed to a coding agent,
// the agent's final summaries with the decisions they ask for, and the delegations and choice dialogs
// it ran — read from the transcripts on this machine (ADR 0008 D03, docs/design/footprint.md § Sessions).
// One adapter per host (sessions/claude.mjs, qwen.mjs, codex.mjs) turns a transcript into records of one
// shape; this file applies the definitions to them. Text is read in memory and never stored: an event
// carries counts, codes and flags only.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { UsageError } from '../../common/cli.mjs';
import { DEFAULT_DECISION_CODES, codesIn, headingPattern, wordsOf } from '../meaning.mjs';
import { remoteLocation, repoWhere, runGit } from './git.mjs';
import { inWorkingPeriod, periodBounds, workingDate } from './period.mjs';
import * as claude from './sessions/claude.mjs';
import * as codex from './sessions/codex.mjs';
import { CHOICE_DIALOG, DELEGATION } from './sessions/lines.mjs';
import * as qwen from './sessions/qwen.mjs';

/** The hosts read, in the order of the label and the notes. */
const ADAPTERS = [claude, qwen, codex];

/** Elements a host injects into a user message; removed before deciding whether anything was typed. */
const WRAPPER = /<(system-reminder|command-[a-z-]+|local-command-[a-z-]+|ide_[a-z_]+|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;
const CAVEAT_LINE = /^Caveat:.*$/gm;
/** What an injected user message starts with once the wrappers are gone: not typed by the owner. */
const NOT_TYPED = /^(?:Caveat:|\[Request interrupted|Another Claude session sent a message|\[Subagent hand-back\]|<agent-message|<task-notification|(?:Stop|PreToolUse|PostToolUse|UserPromptSubmit|SessionStart)[ -]hook)/i;
/** An item of a decision request that says there is nothing to decide: the whole item is the word, with an optional final `.` or `!`. */
const NONE_ITEM = /^(?:ничего|nothing|none|no (?:new )?questions|нет|новых вопросов нет)[.!]?$/iu;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)/;
const LEAD = /^[\s#*_:.,—-]+/;
const TRAIL = /[\s*_]+$/;
const HAS_TEXT = /[^\s*_:.,—-]/;
const CODE_REACH = 80;

/** Whether an item says there is nothing to decide, once its markdown marks and separators are taken off. */
const isNoneItem = (item) => NONE_ITEM.test(item.replace(LEAD, '').replace(TRAIL, ''));

/** A line that starts with a decision code, after a heading marker, bold or italic marks: `codes` is the user's pattern. */
function codeLinePattern(codes) {
  const source = codes instanceof RegExp ? codes.source : String(codes);
  const flags = codes instanceof RegExp ? codes.flags.replace(/[gy]/g, '') : '';
  return new RegExp(`^\\s*(?:#+\\s*)?(?:\\*\\*|_)?(?:${source})`, flags);
}

/**
 * What the owner typed in a user message: the text without the host's injected wrappers and caveat
 * lines, trimmed — null when nothing is left or the rest is injected (an interruption marker, a
 * message from another session, a sub-agent hand-back, a task notification, a hook's output).
 *
 * @param {string|undefined} text the user record's text
 * @returns {string|null}
 */
export function typedText(text) {
  const typed = String(text ?? '').replace(WRAPPER, '').replace(CAVEAT_LINE, '').trim();
  return !typed || NOT_TYPED.test(typed) ? null : typed;
}

/** The items of a decision request: the heading line's rest, the bullets and code lines below, else the first prose line. */
function requestItems(lines, at, headingEnd, codes) {
  const items = [];
  const rest = lines[at].slice(headingEnd);
  if (HAS_TEXT.test(rest)) items.push(rest.trim());
  const below = lines.slice(at + 1);
  const codeLine = codeLinePattern(codes);
  for (const line of below) {
    const item = line.match(BULLET)?.[1] ?? (codeLine.test(line) ? line.trim() : null);
    if (item !== null) items.push(item);
  }
  if (!items.length) {
    const prose = below.find((line) => line.trim() && !line.trim().startsWith('#'));
    if (prose) items.push(prose.trim());
  }
  return items;
}

/**
 * Whether a final summary is a decision request and what it asks: the first line matching `headings`
 * opens it; its items are the questions unless they say nothing (`NONE_ITEM`).
 *
 * @param {string} text the final summary
 * @param {RegExp} headings the pattern of a heading line (`headingPattern`)
 * @param {RegExp|string} codes the decision codes' pattern
 * @returns {{ request: boolean, questions: number, none: boolean, codes: string[] }}
 */
export function requestOf(text, headings, codes) {
  const pattern = new RegExp(headings.source, headings.flags.replace(/[gy]/g, ''));
  const lines = String(text).split('\n');
  const at = lines.findIndex((line) => pattern.test(line));
  if (at < 0) return { request: false, questions: 0, none: false, codes: [] };
  const questions = [];
  for (const raw of requestItems(lines, at, lines[at].match(pattern)[0].length, codes)) {
    const item = raw.replace(LEAD, '');
    if (item && !isNoneItem(raw)) questions.push(item);
  }
  const found = new Set(questions.flatMap((q) => codesIn(q.slice(0, CODE_REACH), codes)));
  return { request: true, questions: questions.length, none: questions.length === 0, codes: [...found].sort() };
}

/**
 * The clone a linked worktree belongs to: the folder holding the `.git` that is the worktree's git
 * common directory (a worktree outside the clone has its own `.git` file pointing there). Null when
 * the folder is gone, is no repository, or its repository is bare.
 */
function commonRoot(cwd) {
  if (!existsSync(cwd)) return null;
  try {
    const common = realpathSync(resolve(cwd, runGit(cwd, ['rev-parse', '--git-common-dir']).trim()));
    return basename(common) === '.git' ? dirname(common) : null;
  } catch {
    return null;
  }
}

/**
 * Where the work of a working folder belongs: the clone of `repos` that holds it — by path, or as a
 * linked worktree whose git common directory is the clone's (the longest match when clones nest) —
 * named by its remote's path, else its folder; otherwise the folder itself. `inside` says which.
 *
 * @param {string[]} repos repository real paths
 * @returns {(cwd: string|null) => { key: string, label: string, where: string|null, inside: boolean }}
 */
function placeResolver(repos) {
  const roots = repos.map((r) => resolve(r)).sort((a, b) => b.length - a.length);
  const realRoots = new Map(roots.map((root) => [root, existsSync(root) ? realpathSync(root) : root]));
  const inside = (path, root) => path === root || path.startsWith(root + sep);
  const cache = new Map();
  const repoOf = (cwd) => {
    const paths = [resolve(cwd), ...(existsSync(cwd) ? [realpathSync(cwd)] : [])];
    const byPath = roots.find((root) => paths.some((path) => inside(path, root)));
    if (byPath || !roots.length) return byPath;
    const common = commonRoot(cwd);
    return common === null ? undefined : roots.find((root) => root === common || realRoots.get(root) === common);
  };
  const place = (cwd) => {
    if (!cwd) return { key: 'dir:', label: '(unknown folder)', where: null, inside: false };
    const root = repoOf(cwd);
    if (!root) return { key: `dir:${cwd}`, label: basename(cwd) || cwd, where: cwd, inside: false };
    const where = repoWhere(root);
    const label = remoteLocation(where === root ? '' : where.slice(root.length + 1))?.path ?? basename(root);
    return { key: `repo:${label}`, label, where, inside: true };
  };
  return (cwd) => {
    if (!cache.has(cwd)) cache.set(cwd, place(cwd));
    return cache.get(cwd);
  };
}

/**
 * What an owner record counts as: its words, or nothing (`other`) when no text was typed, or a tool's
 * message (`skippedPrompt`). `record.note` is a side agent's note the owner forwarded: the owner's act, so
 * the message counts even with no comment; its owner words are those outside the note, the note's words
 * are read, as a final's.
 */
function ownerPart(record, skipPrompts) {
  const typed = typedText(record.text);
  const forwarded = typeof record.note === 'string';
  if (typed === null && !forwarded) return { role: 'other' };
  // a tool wrote it in the owner's name: counted nowhere, only told in the notes
  if (typed !== null && skipPrompts.some((pattern) => pattern.test(typed))) return { role: 'other', skippedPrompt: true };
  return { words: typed === null ? 0 : wordsOf(typed), ...(forwarded ? { noteWords: wordsOf(record.note) } : {}) };
}

/** A record reduced to what the definitions need: the typed text is counted, the final summary parsed, and neither kept. */
function describe(record, { headings, codes, skipPrompts }) {
  const entry = { role: record.role, at: record.at, session: record.session, recordId: record.recordId, cwd: record.cwd ?? null, tools: record.tools ?? [] };
  if (record.role === 'owner') {
    Object.assign(entry, ownerPart(record, skipPrompts));
  } else if (record.role === 'assistant' && record.finalCandidate && String(record.text ?? '').trim()) {
    entry.final = { words: wordsOf(record.text), ...requestOf(record.text, headings, codes) };
  }
  return entry;
}

/** The events of one session's records, in order: its finals are the candidates that end a run, answered when the owner wrote later. */
function sessionEvents(host, entries, place, file) {
  const lastOwner = entries.findLastIndex((e) => e.role === 'owner');
  const out = [];
  entries.forEach((entry, i) => {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) return;
    const where = place(entry.cwd);
    // A message is an action of the person; the rest are facts (`action: false`).
    const event = (kind, detail, { suffix = '', fact = true } = {}) => ({
      event: {
        id: `${host}:${entry.session}:${entry.recordId}${suffix}`, at: new Date(at).toISOString(), kind,
        what: `${where.label}: ${host} session`, where: where.where,
        ...(fact ? { action: false } : {}), detail: { host, session: entry.session, file, ...detail },
      },
      place: where,
    });
    if (entry.role === 'owner') out.push(event('message', { words: entry.words, ...(entry.noteWords ? { noteWords: entry.noteWords } : {}) }, { fact: false }));
    if (entry.final && entries[i + 1]?.role !== 'assistant') out.push(event('final', { ...entry.final, answered: i < lastOwner }));
    entry.tools.forEach((tool, n) => out.push(event(tool, {}, { suffix: entry.tools.length > 1 ? `:${n}` : '' })));
  });
  return out;
}

/**
 * A transcript's records grouped by session. A session that had owner messages, all of them a tool's
 * (matching `sessions_skip_prompts`), was started by a tool: it is returned apart and counts nowhere.
 */
function sessionsOf(entries) {
  const groups = new Map();
  for (const entry of entries) groups.set(entry.session, [...(groups.get(entry.session) ?? []), entry]);
  const all = [...groups.values()];
  const byTool = (session) => session.some((e) => e.skippedPrompt) && !session.some((e) => e.role === 'owner');
  return { kept: all.filter((session) => !byTool(session)), byTool: all.filter(byTool) };
}

/** The events of a transcript's sessions, each naming the transcript (`file`, `<host>:<path under the host folder>`): finals and answers decided over each session. */
const transcriptEvents = (host, sessions, place, file) => sessions.flatMap((session) => sessionEvents(host, session, place, file));

/** `~` at the start of a folder the settings name stands for the user's home. */
const expandHome = (folder, home) => (folder === '~' || folder.startsWith('~/') ? join(home, folder.slice(1)) : folder);

/**
 * The folders read for a host given its setting: none (`null`) when the settings switch it off, the
 * folder the settings name (with the host's sibling folders, as Codex's archived sessions), else the
 * host's defaults from its home variable or the user's home. Reads nothing from the disk.
 *
 * @param {string} host `claude`, `qwen` or `codex`
 * @param {string|false|null|undefined} setting a folder, `false` for off, `null` or absent for the default
 * @param {{ env: NodeJS.ProcessEnv, home: string }} where the environment and home to read, passed in
 * @returns {string[]|null} the folders in reading order; null when the host is off
 * @throws {UsageError} for a host with no adapter
 */
export function hostFolders(host, setting, { env, home }) {
  const adapter = ADAPTERS.find((a) => a.host === host);
  if (!adapter) throw new UsageError(`sessions: no adapter for host "${host}" (hosts: ${ADAPTERS.map((a) => a.host).join(', ')})`);
  if (setting === false) return null;
  return typeof setting === 'string' && setting.trim() ? adapter.givenFolders(expandHome(setting.trim(), home)) : adapter.defaultFolders({ env, home });
}

/** The numbers of the totals, counted over the events kept. */
function summarize(events) {
  const finals = events.filter((e) => e.kind === 'final');
  const requests = finals.filter((e) => e.detail.request);
  const messages = events.filter((e) => e.kind === 'message');
  const sum = (list, key) => list.reduce((n, e) => n + e.detail[key], 0);
  return {
    sessions: new Set(events.map((e) => `${e.detail.host}:${e.detail.session}`)).size,
    messages, words: sum(messages, 'words'), finals, finalWords: sum(finals, 'words'), requests,
    withQuestions: requests.filter((e) => e.detail.questions > 0).length, none: requests.filter((e) => e.detail.none).length,
    answered: requests.filter((e) => e.detail.answered).length, codes: new Set(requests.flatMap((e) => e.detail.codes)).size,
    delegations: events.filter((e) => e.kind === DELEGATION).length, dialogs: events.filter((e) => e.kind === CHOICE_DIALOG).length,
  };
}

/** The source's totals over its events; active days are the working days with a message of the person. */
function totalsOf(events, period) {
  const t = summarize(events);
  const days = new Set(t.messages.map((e) => workingDate(e.at, period)));
  return [
    ['sessions', t.sessions], ['active days', days.size], ['owner messages', t.messages.length], ['owner words', t.words],
    ['finals', t.finals.length], ['final words', t.finalWords], ['decision requests', t.requests.length],
    ['with questions', t.withQuestions], ['declared none', t.none], ['answered', t.answered], ['distinct codes', t.codes],
    ['delegations', t.delegations], ['choice dialogs', t.dialogs],
  ];
}

/** The per-repository rows: one per place, the most messages first. */
function breakdownOf(items) {
  const groups = new Map();
  for (const { event, place } of items) {
    const group = groups.get(place.key) ?? { place, events: [] };
    group.events.push(event);
    groups.set(place.key, group);
  }
  const rows = [...groups.values()].map(({ place, events }) => ({ place, events, s: summarize(events) }))
    .sort((a, b) => b.s.messages.length - a.s.messages.length || a.place.label.localeCompare(b.place.label));
  return {
    title: 'per repository',
    header: ['Repository', 'Sessions', 'Messages', 'Words', 'Finals', 'Decision requests', 'Delegations', 'Choice dialogs'],
    rows: rows.map(({ place, s }) => [place.label, s.sessions, s.messages.length, s.words, s.finals.length, s.requests.length, s.delegations, s.dialogs]),
    wheres: rows.map(({ place }) => place.where),
  };
}

/** The records of one transcript, reduced; a record already met (a resumed transcript repeats its past) is left out. */
async function readFile(adapter, file, stats, { rules, seen }) {
  const entries = [];
  for await (const record of adapter.readTranscript(file, stats)) {
    const key = `${adapter.host}:${record.session}:${record.recordId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(describe(record, rules));
  }
  return entries;
}

/** What reading a host gives before anything is read. */
const emptyHost = () => ({ read: 0, old: 0, failed: 0, lastError: '', skippedPrompts: 0, toolSessions: 0, files: [], stats: { unreadable: 0, skipped: 0 }, items: [] });

/** One host's transcripts read: its events, with the counts the notes report. */
async function readHost(adapter, folders, context) {
  const result = emptyHost();
  const { stats } = result;
  const fail = (e) => { // one unreadable file or folder does not stop the crawl; the notes say so
    result.failed += 1;
    result.lastError = e.message;
  };
  const listed = folders.flatMap((folder) => adapter.listTranscripts(folder, fail)
    .map((file) => ({ file, key: `${adapter.host}:${relative(folder, file).split(sep).join('/')}` })));
  for (const { file, key } of listed) {
    const skippedBefore = stats.skipped;
    let entries;
    try {
      if (statSync(file).mtimeMs < context.from) {
        result.old += 1;
        continue;
      }
      entries = await readFile(adapter, file, stats, context);
    } catch (e) {
      fail(e);
      continue;
    }
    if (stats.skipped === skippedBefore) result.read += 1;
    result.files.push(key);
    const sessions = sessionsOf(entries);
    result.items.push(...transcriptEvents(adapter.host, sessions.kept, context.place, key).filter(({ event }) => inWorkingPeriod(event.at, context.period)));
    const counted = (e) => e.skippedPrompt && inWorkingPeriod(e.at, context.period) && (!context.scoped || context.place(e.cwd).inside);
    result.skippedPrompts += entries.filter(counted).length;
    result.toolSessions += sessions.byTool.filter((session) => session.some(counted)).length;
  }
  return result;
}

/** The patterns the definitions use: the user's settings, else the defaults of meaning.mjs. */
const rulesOf = (headings = headingPattern(), codes = DEFAULT_DECISION_CODES, skipPrompts = []) => ({ headings, codes, skipPrompts });

/** One host's state: its folders found and missing (or off), and what reading the found ones gave. */
async function hostState(adapter, setting, where, context) {
  const folders = hostFolders(adapter.host, setting, where);
  const found = (folders ?? []).filter((f) => existsSync(f));
  const result = found.length ? await readHost(adapter, found, context) : emptyHost();
  return { off: folders === null, found, missing: (folders ?? []).filter((f) => !existsSync(f)), result };
}

/** The notes about one host: the folders read or why not, files read and skipped, records unreadable. */
function hostNote(adapter, state) {
  if (state.off) return `${adapter.host}: off (sessions.${adapter.host}: false)`;
  if (!state.found.length) return `${adapter.host}: ${state.missing.join(', ')} not found`;
  const r = state.result;
  const parts = [
    `${state.found.join(', ')}${state.missing.length ? ` (not found: ${state.missing.join(', ')})` : ''}`,
    `${r.read} transcript${r.read === 1 ? '' : 's'} read`, `${r.old} skipped as older than the period`,
    ...(r.stats.skipped ? [`${r.stats.skipped} skipped as sub-agent or review threads`] : []),
    `${r.stats.unreadable} record${r.stats.unreadable === 1 ? '' : 's'} unreadable`,
    ...(r.failed ? [`${r.failed} file(s) or folder(s) could not be read (${r.lastError})`] : []),
  ];
  return `${adapter.host}: ${parts.join('; ')}`;
}

/**
 * The items kept for the scope: with `scoped` only those whose place is inside a clone, and how many
 * sessions had items and none of them inside (the sessions skipped).
 */
function scopeItems(all, scoped) {
  const items = scoped ? all.filter(({ place }) => place.inside) : all;
  const sessionOf = ({ event }) => `${event.detail.host}:${event.detail.session}`;
  const kept = new Set(items.map(sessionOf));
  const inScope = new Set(items);
  const outside = new Set(all.filter((i) => !inScope.has(i)).map(sessionOf).filter((key) => !kept.has(key))).size;
  return { items, outside };
}

/** The partial marks of a crawl in which `failed` transcript files or folders could not be read (none when all were). */
const partialOf = (failed) => (failed ? { partial: true, partialReasons: [`${failed} transcript file(s) or folder(s) could not be read`] } : {});

/** The notes for the sessions outside --repos, the messages matching sessions_skip_prompts and the sessions a tool started, each only when there are some. */
function scopeNotes(outside, skippedPrompts, toolSessions) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    ...(outside ? [`${plural(outside, 'session')} outside --repos skipped`] : []),
    ...(skippedPrompts ? [`${plural(skippedPrompts, 'message')} matching sessions_skip_prompts skipped: not the owner's, counted nowhere`] : []),
    ...(toolSessions ? [`${plural(toolSessions, 'session')} started by a tool skipped (no owner message left after sessions_skip_prompts), counted nowhere`] : []),
  ];
}

/**
 * The sessions source: the person's messages, final summaries (with their decision requests),
 * delegations and choice dialogs in the transcripts of the agent hosts on this machine, in the period.
 * A transcript last changed before the period starts is not read; sub-agent transcripts are not read.
 * Whether a summary is a final, and whether a request was answered, is decided over the whole
 * transcript; only the events whose working day lies in the period are kept. An event is `{ id, at,
 * kind: 'message'|'final'|'delegation'|'choice dialog', what, where, action?: false, detail }` and holds
 * no text. The clone of `repos` that holds a record's working folder gives `where` (`repoWhere`);
 * else it is the folder.
 *
 *
 * With `repos` given only the sessions whose working folder lies inside a clone or a linked worktree
 * of one count (D-FP3-SESSIONS-REPOS); the others are skipped and counted in a note. A message that
 * matches a `skipPrompts` pattern is a tool's, not the owner's, and counts nowhere; a session left with
 * no owner message by that was started by a tool and counts nowhere either (a note counts them). The result
 * carries `filesRead` (each transcript read, as the events' `detail.file` names it) so the store
 * replaces only those transcripts' events, and is `partial` when a file or folder could not be read.
 *
 * @param {{ hosts?: { claude?: string|null|false, qwen?: string|null|false, codex?: string|null|false },
 *   repos?: string[], since: string, until: string, tz: string, dayStartsMin?: number,
 *   headings?: RegExp, codes?: RegExp|string, skipPrompts?: RegExp[] }} query
 *   `hosts` each a folder, `null` (or absent) for the host's default, or `false` for off; `repos` the
 *   real paths of the clones (`findRepos`); `headings` from `headingPattern`; `codes` the decision
 *   codes; `skipPrompts` the patterns of messages a tool sent in the owner's name (none by default)
 * @param {{ env: NodeJS.ProcessEnv, home: string }} where the environment and home the host defaults are read from
 * @returns {Promise<object>} a source result (report.mjs)
 * @throws {UsageError} when every host is off or has no folder
 */
export async function collectSessions(
  { hosts = {}, repos = [], since, until, tz, dayStartsMin = 0, headings, codes, skipPrompts = [] },
  { env, home },
) {
  const period = { since, until, tz, dayStartsMin };
  const scoped = repos.length > 0;
  const context = {
    period, from: periodBounds(period).from, place: placeResolver(repos), scoped, rules: rulesOf(headings, codes, skipPrompts), seen: new Set(),
  };
  const states = [];
  for (const adapter of ADAPTERS) states.push(await hostState(adapter, hosts[adapter.host], { env, home }, context));
  const notes = ADAPTERS.map((adapter, i) => hostNote(adapter, states[i]));
  if (!states.some((s) => s.found.length)) throw new UsageError(`sessions: no transcript folder to read — ${notes.join('; ')}`);
  const { items, outside } = scopeItems(states.flatMap((s) => s.result.items), scoped);
  const events = items.map((i) => i.event);
  const skippedPrompts = states.reduce((n, s) => n + s.result.skippedPrompts, 0);
  const toolSessions = states.reduce((n, s) => n + s.result.toolSessions, 0);
  const failed = states.reduce((n, s) => n + s.result.failed, 0);
  return {
    source: 'sessions',
    label: `sessions (${ADAPTERS.map((a, i) => `${a.host} ${states[i].result.read}${i === 0 ? ' transcripts' : ''}`).join(', ')})`,
    totals: totalsOf(events, period),
    events,
    filesRead: states.flatMap((s) => s.result.files),
    ...partialOf(failed),
    breakdown: breakdownOf(items),
    notes: [
      ...notes,
      ...scopeNotes(outside, skippedPrompts, toolSessions),
      'the text of a message or a final summary is read in memory and never kept: events hold counts, codes and flags; a final is the last text of an assistant message when no assistant record follows, a request is answered when the owner wrote later in the same transcript',
    ],
  };
}
