// The footprint's store (ADR 0008 D01, docs/design/footprint.md § Store): `collect` saves the events
// its sources returned under `.local/footprint/events/<person>/`, one `<source>.jsonl` per source
// (one event a line) and `crawls.jsonl` (one line per source per crawl), and `slice` reads them back
// to report windows without crawling again. A re-crawl replaces the stored events of its source that
// lie in the crawled period or share an id with a new one, and every snapshot — except that a source
// that names the transcripts it read (`filesRead`, the sessions source) replaces only those files'
// events, and a partial crawl (`partial`) is merged by id and drops nothing; nothing in an event
// holds message text (the sources keep counts, codes, flags and the subjects the report shows).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../common/cli.mjs';
import { localPath } from '../common/paths.mjs';
import { slugify } from '../common/slug.mjs';
import { LINE_KINDS } from './meaning.mjs';
import { daysOf } from './report.mjs';
import { inWorkingPeriod } from './sources/period.mjs';

const CRAWLS = 'crawls';
const EXTENSION = '.jsonl';

/**
 * The folder of the installation's stored events: `.local/footprint/events/`.
 *
 * @returns {string}
 * @throws {Error} `NoInstallation` outside an installation
 */
export const storeRoot = () => localPath('footprint', 'events');

/**
 * The folder of one person's stored events: `.local/footprint/events/<slug of person>/`.
 *
 * @param {string} person a display name, `me`, an email or a login
 * @returns {string}
 * @throws {UsageError} when nothing of `person` is a latin letter or digit, so no folder name can be made of it
 * @throws {Error} `NoInstallation` outside an installation
 */
export function storeDir(person) {
  const name = slugify(person);
  if (!name) throw new UsageError(`the store keeps a person under a folder named by latin letters and digits; "${person}" has none: pass --person with such a name`);
  return join(storeRoot(), name);
}

/**
 * The people with a store folder, sorted.
 *
 * @returns {string[]} folder names (missing store: none)
 * @throws {Error} `NoInstallation` outside an installation
 */
export function storePeople() {
  const root = storeRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** `value` as JSON with the keys of every object sorted, so equal content gives equal text. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * An event's identity: the `id` the source gave, else the first 16 hex digits of the SHA-1 of the
 * source and the event's content (without `id` and `source`), so the same event crawled twice has one.
 *
 * @param {string} source
 * @param {object} event
 * @returns {string}
 */
export function eventId(source, event) {
  if (typeof event.id === 'string' && event.id) return event.id;
  const { id: _id, source: _source, ...content } = event;
  return createHash('sha1').update(`${source}\0${canonical(content)}`).digest('hex').slice(0, 16);
}

/** A source's `hours` (date → hours, as a Map or pairs) as the events the store keeps. */
function hoursEvents(hours) {
  return [...(hours || [])].map(([date, h]) => ({ kind: 'hours', date, action: false, detail: { hours: h }, id: `hours:${date}` }));
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a `YYYY-MM-DD` date, or else an instant (its working day), lies in the period. */
function valueInPeriod(value, period) {
  if (!value) return false;
  if (DATE_ONLY.test(String(value))) return value >= period.since && value <= period.until;
  return inWorkingPeriod(value, period);
}

/**
 * Whether the event lies in the period: its working day for an instant, its date otherwise; an event
 * with neither is in none. A `decision document` lies in the period of its add instant (`at`) and of
 * its `detail.added` and `detail.decided` as well — an ADR added earlier and decided in the period
 * belongs to it (ADR 0008 D04) — the same days the sources crawl it for and `facts.mjs` reads.
 *
 * @param {{ at?: string, date?: string, kind?: string, detail?: { added?: string, decided?: string } }} event
 * @param {{ since: string, until: string, tz: string, dayStartsMin?: number }} period
 * @returns {boolean}
 */
export function eventInPeriod(event, period) {
  if (event.kind === 'decision document' && (valueInPeriod(event.detail?.added, period) || valueInPeriod(event.detail?.decided, period))) return true;
  if (event.at) return inWorkingPeriod(event.at, period);
  return Boolean(event.date) && event.date >= period.since && event.date <= period.until;
}

/** The lines of a JSONL file as objects, and how many lines were not one (missing file: none). */
function readLines(file) {
  const rows = [];
  let bad = 0;
  if (!existsSync(file)) return { rows, bad };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { rows, bad };
}

/** `file` replaced whole: written beside it, then renamed over it. */
function writeAtomically(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/**
 * The events a source's store holds after its crawl `result`: the stored ones except those whose id
 * is among the new events, whose working day lies in the period (a date-only event: its date; a
 * decision document: also its added or decided date) and every snapshot, then the new events (with `source` and `id` set, a source's `hours` as `hours`
 * events). Two rules narrow that, so a re-crawl never erases what its source could not see
 * (D-FP3-PARTIAL-RECRAWL): a `partial` result drops only the stored events whose id is among the new
 * ones (merge by id); a result with `filesRead` (a list of transcript keys, as an event's `detail.file`
 * names them) drops in-period events only of those files — a transcript read that gave no event in the
 * period still clears its old ones, a transcript no longer there keeps them. A stored event with no
 * `detail.file` (saved before that field existed) names no file to match, so the period rule decides it
 * and it is counted in `legacy`. Changes nothing; `saveCrawl` writes it, and a run that does not save
 * reads the same.
 *
 * @param {object[]} stored the source's events as the store holds them
 * @param {{ source: string, events?: object[], hours?: Map<string, number>, partial?: boolean, filesRead?: string[] }} result a source that ran
 * @param {{ since: string, until: string, tz: string, dayStartsMin?: number }} period what was crawled
 * @returns {{ events: object[], fresh: number, legacy: number }} the events after the crawl, how many of them are new, and
 *   how many stored events without `detail.file` the period rule replaced under `filesRead`
 */
export function replaceCrawled(stored, result, period) {
  const fresh = [...(result.events || []), ...hoursEvents(result.hours)].map((e) => ({ ...e, source: result.source, id: eventId(result.source, e) }));
  const ids = new Set(fresh.map((e) => e.id));
  const files = Array.isArray(result.filesRead) ? new Set(result.filesRead) : null;
  const hasFile = (e) => typeof e.detail?.file === 'string';
  const isLegacy = (e) => files !== null && !e.snapshot && !hasFile(e) && eventInPeriod(e, period);
  const replaced = (e) => {
    if (e.snapshot) return true;
    return files && hasFile(e) ? files.has(e.detail.file) && eventInPeriod(e, period) : eventInPeriod(e, period);
  };
  const kept = stored.filter((e) => !ids.has(e.id) && !(!result.partial && replaced(e)));
  const legacy = result.partial ? 0 : stored.filter((e) => !ids.has(e.id) && isLegacy(e)).length;
  return { events: [...kept, ...fresh], fresh: fresh.length, legacy };
}

/**
 * Save the crawl of each source in `results` into the store at `dir`. A source that ran: its stored
 * events are replaced as `replaceCrawled` says and the file is written atomically. A source that did
 * not run (`skipped`) changes no event and is recorded as skipped. One line per source goes to
 * `crawls.jsonl`, with the scope it ran with (`repos`, `identity`) when `scopes` gives one, so a later
 * crawl can tell that it replaces events another scope collected (`recrawlNotes`), and with what the
 * report matches a code host's copy of a commit by: git's `remotes` and a code host's `site`
 * (`crawledMatchKeys` reads them back).
 *
 * @param {string} dir the person's folder (`storeDir`), created when missing
 * @param {{ source: string, events?: object[], hours?: Map<string, number>, skipped?: string }[]} results source results
 * @param {{ since: string, until: string, tz: string, dayStartsMin?: number }} period what was crawled
 * @param {Record<string, { repos: string[]|null, identity: string|null }>} [scopes] per source: the repositories read and who the events are of
 * @returns {{ source: string, events: number, legacy?: number, skipped?: string }[]} what was saved per source
 *   (`legacy`: stored events without `detail.file` that the period rule replaced, see `replaceCrawled`)
 */
export function saveCrawl(dir, results, period, scopes = {}) {
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const saved = [];
  const crawls = [];
  for (const r of results) {
    const record = {
      at, source: r.source, since: period.since, until: period.until, tz: period.tz, dayStarts: period.dayStartsMin ?? 0,
      ...(scopes[r.source] ? { repos: scopes[r.source].repos, identity: scopes[r.source].identity } : {}),
      ...matchKeys(r),
      ...(r.partial ? { partial: true, partialReasons: partialReasons(r) } : {}),
    };
    if (r.skipped) {
      crawls.push({ ...record, events: 0, skipped: r.skipped });
      saved.push({ source: r.source, events: 0, skipped: r.skipped });
      continue;
    }
    const file = join(dir, `${r.source}${EXTENSION}`);
    const { events, fresh, legacy } = replaceCrawled(readLines(file).rows, r, period);
    writeAtomically(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
    crawls.push({ ...record, events: fresh });
    saved.push({ source: r.source, events: fresh, ...(legacy ? { legacy } : {}) });
  }
  appendFileSync(join(dir, `${CRAWLS}${EXTENSION}`), crawls.map((c) => `${JSON.stringify(c)}\n`).join(''));
  return saved;
}

/**
 * The note for a source whose crawl replaced stored events saved before `detail.file` existed, by the
 * period rule (`replaceCrawled`'s `legacy`), without the source's name: the report's notes carry it.
 *
 * @param {number} legacy how many were replaced
 * @returns {string}
 */
export const legacyNote = (legacy) => `${legacy} stored event${legacy === 1 ? '' : 's'} saved without a transcript file replaced by the crawled period`;

/** A partial result's reasons, as text (none given: a plain statement). */
const partialReasons = (result) => (Array.isArray(result.partialReasons) && result.partialReasons.length ? result.partialReasons.map(String) : ['a part of the source could not be read']);

/**
 * The notes for the sources whose crawl was partial: it is merged by id — same-id events replaced, nothing else dropped.
 *
 * @param {{ source: string, skipped?: string, partial?: boolean, partialReasons?: string[] }[]} results source results of this run
 * @returns {{ source: string, note: string }[]} one per partial source
 */
export function partialNotes(results) {
  return results.filter((r) => r.partial && !r.skipped)
    .map((r) => ({ source: r.source, note: `${r.source}: partial crawl (${partialReasons(r).join('; ')}) — merged by id: same-id events replaced, nothing else dropped` }));
}

/** The `remotes` (git) and `site` (a code host) of a source result, as the keys a crawl row records. */
function matchKeys(result) {
  return {
    ...(Array.isArray(result.remotes) ? { remotes: result.remotes } : {}),
    ...(result.site !== undefined ? { site: result.site ?? null } : {}),
  };
}

/**
 * What the report needs to tell a code host's copy of a commit from an action, rebuilt from the
 * crawl rows of `source`: the union of the `remotes` git read and of the `site`s the host was crawled
 * at (a skipped crawl read nothing). A row that recorded neither (an older store) adds nothing.
 *
 * @param {{ source: string, skipped?: string, remotes?: string[], site?: string|null }[]} crawls from `loadStore`
 * @param {string} source
 * @returns {{ remotes: string[], sites: string[] }} sorted, without repeats
 */
export function crawledMatchKeys(crawls, source) {
  const own = crawls.filter((c) => c.source === source && !c.skipped);
  const union = (values) => [...new Set(values.filter((v) => typeof v === 'string' && v))].sort();
  return {
    remotes: union(own.flatMap((c) => (Array.isArray(c.remotes) ? c.remotes : []))),
    sites: union(own.map((c) => c.site)),
  };
}

/** A scope's repositories as one comparable text: sorted, `null` for a source that reads none. */
const reposKey = (repos) => (Array.isArray(repos) ? JSON.stringify([...repos].sort()) : 'null');

/**
 * The notes for a crawl that would replace events another scope collected: for each source that ran,
 * the latest earlier crawl of it over an overlapping period (a skipped one collected nothing) whose
 * recorded `repos` or `identity` differ from this run's. The replace rule drops that crawl's events of
 * the overlap, so the person is told; nothing is blocked. A crawl that recorded no scope (an older
 * store) is not compared.
 *
 * @param {object[]} crawls the store's crawl lines (`loadStore`), before this run's are added
 * @param {{ source: string, skipped?: string }[]} results source results of this run
 * @param {{ since: string, until: string }} period what is crawled
 * @param {Record<string, { repos: string[]|null, identity: string|null }>} scopes this run's scope per source
 * @returns {{ source: string, note: string }[]} one per source with a differing earlier crawl
 */
export function recrawlNotes(crawls, results, period, scopes) {
  const notes = [];
  for (const { source, skipped } of results) {
    const now = scopes[source];
    if (skipped || !now) continue;
    const before = crawls.filter((c) => c.source === source && !c.skipped && 'identity' in c && c.since <= period.until && c.until >= period.since).at(-1);
    if (!before) continue;
    const differs = [
      ...(reposKey(before.repos) === reposKey(now.repos) ? [] : ['--repos']),
      ...((before.identity ?? null) === (now.identity ?? null) ? [] : ['identity']),
    ];
    if (!differs.length) continue;
    const [from, to] = [[before.since, period.since].sort().at(-1), [before.until, period.until].sort()[0]];
    notes.push({
      source,
      note: `${source}: the earlier crawl of ${before.since} … ${before.until} (saved ${before.at}) used a different ${differs.join(' and ')}; `
        + `this crawl replaces its stored ${source} events of ${from} … ${to}`,
    });
  }
  return notes;
}

/**
 * Read a person's store.
 *
 * @param {string} dir the person's folder (`storeDir`); a missing one is an empty store
 * @returns {{ events: Map<string, object[]>, crawls: object[], bad: number }} events per source (each with
 *   `source`), the crawl lines in file order, and how many lines could not be read and were skipped
 */
export function loadStore(dir) {
  const events = new Map();
  const store = { events, crawls: [], bad: 0 };
  if (!existsSync(dir)) return store;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(EXTENSION)).sort()) {
    const source = name.slice(0, -EXTENSION.length);
    const { rows, bad } = readLines(join(dir, name));
    store.bad += bad;
    if (source === CRAWLS) store.crawls = rows;
    else events.set(source, rows.map((e) => ({ ...e, source })));
  }
  return store;
}

/**
 * The dates of `since` … `until` that no crawl of `source` covered: a skipped crawl covers nothing.
 *
 * @param {{ source: string, since: string, until: string, skipped?: string }[]} crawls from `loadStore`
 * @param {string} source
 * @param {string} since `YYYY-MM-DD`
 * @param {string} until `YYYY-MM-DD`
 * @returns {string[]} the uncovered dates in order
 */
export function coverage(crawls, source, since, until) {
  const own = crawls.filter((c) => c.source === source && !c.skipped);
  return daysOf(since, until).filter((d) => !own.some((c) => c.since <= d && d <= c.until));
}

const delta = ([added, deleted]) => `+${added} −${deleted}`;

/**
 * The totals rows of a slice, counted from a source's stored events: events by kind (facts apart,
 * as `<kind> (fact)`), for commits that carry lines (git's) their lines by kind and the tests they added, for review events
 * that carry `reviewed` (a code host's) the lines reviewed, for messages and
 * final summaries their words, named `owner words` and `final words` as the sessions source's totals say them. `hours` events are not events of the person and are left out.
 * Commits' tests are `detail.testsAdded`, words `detail.words`.
 *
 * @param {string} source
 * @param {object[]} events the source's events in the window
 * @returns {[string, string|number][]} rows as a source's `totals`
 */
export function totalsFromEvents(source, events) {
  const own = events.filter((e) => e.kind !== 'hours');
  const actions = own.filter((e) => e.action !== false);
  return [
    ...tally(actions),
    ...commitRows(actions.filter((e) => e.kind === 'commit')),
    ...reviewedRows(actions),
    ...wordRows(own),
    ...[...tally(own.filter((e) => e.action === false))].map(([kind, n]) => [`${kind} (fact)`, n]),
  ];
}

/** How many events of each kind, in the order each kind first appears. */
function tally(events) {
  const counts = new Map();
  for (const e of events) counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
  return counts;
}

/**
 * The rows for commits: their lines by kind and the test functions they added. Only commits that
 * carry `lines` (git's) give rows: a code host's commits in pull requests carry none, so no commits
 * with lines means no rows rather than zeros.
 */
function commitRows(commits) {
  if (!commits.some((e) => e.lines)) return [];
  const sum = (kind, side) => commits.reduce((n, e) => n + (e.lines?.[kind]?.[side] || 0), 0);
  return [
    ...LINE_KINDS.map((k) => [`${k} lines`, delta([sum(k, 0), sum(k, 1)])]),
    ['tests added', commits.reduce((n, e) => n + (e.detail?.testsAdded || 0), 0)],
  ];
}

/**
 * The row for the lines of others' pull or merge requests reviewed: the `reviewed` pair a review
 * event of a code host carries on the first review of each working day, summed (a request reviewed on
 * two days counts on both). No such event: no row.
 */
function reviewedRows(events) {
  const reviewed = events.filter((e) => Array.isArray(e.reviewed));
  if (!reviewed.length) return [];
  const sum = (side) => reviewed.reduce((n, e) => n + (Number(e.reviewed[side]) || 0), 0);
  return [['reviewed lines (their lines, per pull request and day)', delta([sum(0), sum(1)])]];
}

/** The words rows' names by the kind they count: as the sessions source's totals say them. */
const WORD_ROWS = { message: 'owner words', final: 'final words' };

/** The rows for the words of owner messages and of an agent's final summaries. */
function wordRows(events) {
  const words = new Map();
  for (const e of events.filter((x) => WORD_ROWS[x.kind])) words.set(e.kind, (words.get(e.kind) || 0) + (e.detail?.words || 0));
  return [...words].map(([kind, n]) => [WORD_ROWS[kind], n]);
}
