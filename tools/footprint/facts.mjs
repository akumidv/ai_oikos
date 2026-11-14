// The fact sections of a footprint report (ADR 0008, docs/design/footprint.md): what an agent's
// sessions held, what the changes meant, the decision documents, the releases, the chain from a
// question to a release, the uncommitted and first activity, and the team's facts. `summarizeFacts`
// turns the events (actions and facts, each with its `source`) into plain data kept in the report
// object; `renderFacts` turns that data into markdown. Nothing here holds message text or a local
// path: the events carry counts, codes and labels only, a place comes from `placeOf(where)` and a
// repository from `detail.repo` (else the label before the colon of `what`).
import { weekOf, workingDay } from './days.mjs';
import { plusMinusTight, table } from './markdown.mjs';
import { LINE_KINDS } from './meaning.mjs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A folder of ADRs: its last segment is `adr`. */
const ADR_DIR = /(^|\/)adrs?$/i;
/** How many tag names a Releases row spells out before "+N more". */
const TAGS_SHOWN = 8;
const EMPTY = '—';
const ALL_PLACES = 'all';

/** The values every section reads: the window, the zone, the day's start and the place of a `where`. */
function contextOf({ since, until, tz = 'UTC', dayStartsMin = 0, placeOf = () => ALL_PLACES, readingReference = null, teamRule = null }) {
  return { since, until, tz, startMin: dayStartsMin, placeOf, readingReference, teamRule };
}

/** The working day of an instant or a date as given (an ISO instant, or `YYYY-MM-DD`); null for none or one unreadable. */
function dayOfValue(ctx, value) {
  if (!value) return null;
  const text = String(value);
  if (DATE.test(text)) return text;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : workingDay(at, ctx.tz, ctx.startMin).date;
}

const inWindow = (ctx, day) => Boolean(day) && day >= ctx.since && day <= ctx.until;
const labelOf = (what) => {
  const text = String(what || '');
  const at = text.indexOf(': ');
  return at > 0 ? text.slice(0, at) : text || 'unknown';
};
const byName = (key) => (a, b) => String(key(a)).localeCompare(String(key(b)));
const distinctBy = (items, key) => [...new Map(items.map((i) => [key(i), i])).values()];
const total = (values) => values.reduce((a, b) => a + b, 0);
const count = (value) => (Array.isArray(value) ? value.length : Number(value) || 0);
const list = (value) => (Array.isArray(value) ? value.map(String) : []);
const lineKinds = (lines) => Object.fromEntries(LINE_KINDS.map((k) => [k, [Number(lines?.[k]?.[0]) || 0, Number(lines?.[k]?.[1]) || 0]]));

/** An event with what the sections ask of it: its working day, place, repository and detail. */
function itemOf(ctx, event) {
  const detail = event.detail ?? {};
  return {
    e: event,
    detail,
    source: event.source ?? null,
    kind: event.kind ?? (event.source === 'git' ? 'commit' : null),
    day: dayOfValue(ctx, event.at ?? event.date),
    place: ctx.placeOf(event.where ?? null),
    repository: detail.repo ?? labelOf(event.what),
  };
}

const isCommit = (i) => i.source === 'git' && i.kind === 'commit';
const eventKey = (i) => i.e.id ?? `${i.e.at ?? i.e.date}\n${i.e.what}`;

// ── Sessions ───────────────────────────────────────────────────────────────────────────────────

function newUnit() {
  return {
    sessions: new Set(), days: new Set(), messages: 0, messageWords: 0, finals: 0, finalWords: 0, noteWords: 0, requests: 0, questions: 0,
    none: 0, answered: 0, codes: new Set(), answeredCodes: new Set(), delegations: 0, dialogs: 0,
  };
}

/** A final summary's part of a unit: its words and, for a decision request, its questions, codes and answer. */
function addFinal(unit, detail) {
  unit.finals += 1;
  unit.finalWords += Number(detail.words) || 0;
  if (!detail.request) return;
  unit.requests += 1;
  unit.questions += count(detail.questions);
  if (detail.none) unit.none += 1;
  if (detail.answered) unit.answered += 1;
  for (const code of list(detail.codes)) {
    unit.codes.add(code);
    if (detail.answered) unit.answeredCodes.add(code);
  }
}

function addToUnit(unit, i) {
  const { detail } = i;
  if (detail.session) unit.sessions.add(String(detail.session));
  if (i.kind === 'message') {
    if (i.day) unit.days.add(i.day); // active days count the owner's messages only; the agent's output is fact (ADR 0008 D02)
    unit.messages += 1;
    unit.messageWords += Number(detail.words) || 0;
    unit.noteWords += Number(detail.noteWords) || 0; // a forwarded side-agent note: read, not the owner's words
  } else if (i.kind === 'final') addFinal(unit, detail);
  else if (i.kind === 'delegation') unit.delegations += 1;
  else if (i.kind === 'choice dialog') unit.dialogs += 1;
}

const rowOfUnit = (unit) => ({
  sessions: unit.sessions.size, activeDays: unit.days.size, messages: unit.messages, messageWords: unit.messageWords,
  finals: unit.finals, finalWords: unit.finalWords, requests: unit.requests, questions: unit.questions, none: unit.none,
  answered: unit.answered, codes: unit.codes.size, answeredCodes: unit.answeredCodes.size, delegations: unit.delegations,
  choiceDialogs: unit.dialogs,
});

/** The reading reference as `{ label, referenceWords, times }`, or null when none is set. */
function readingOf(ctx, words) {
  const ref = ctx.readingReference;
  if (!ref || !(Number(ref.words) > 0)) return null;
  return { label: String(ref.label ?? ''), referenceWords: Number(ref.words), times: Math.round((words / Number(ref.words)) * 10) / 10 };
}

/** Sessions per place and repository, per week, and the words read against the reading reference. */
function sessionsOf(ctx, live) {
  const events = live.filter((i) => i.source === 'sessions' && ['message', 'final', 'delegation', 'choice dialog'].includes(i.kind));
  if (!events.length) return null;
  const places = new Map();
  const weeks = new Map();
  for (const i of events) {
    const place = places.get(i.place) ?? { total: newUnit(), repositories: new Map() };
    places.set(i.place, place);
    const repository = place.repositories.get(i.repository) ?? newUnit();
    place.repositories.set(i.repository, repository);
    addToUnit(place.total, i);
    addToUnit(repository, i);
    if (i.day) {
      const week = weeks.get(weekOf(i.day)) ?? newUnit();
      weeks.set(weekOf(i.day), week);
      addToUnit(week, i);
    }
  }
  const wordsRead = total([...places.values()].map((p) => p.total.finalWords + p.total.noteWords));
  return {
    places: [...places].sort(byName(([place]) => place)).map(([place, p]) => ({
      place,
      total: rowOfUnit(p.total),
      repositories: [...p.repositories].sort(byName(([repository]) => repository)).map(([repository, unit]) => ({ repository, ...rowOfUnit(unit) })),
    })),
    weeks: [...weeks].sort(byName(([week]) => week)).map(([week, unit]) => ({ week, ...rowOfUnit(unit) })),
    wordsRead,
    reading: readingOf(ctx, wordsRead),
  };
}

// ── Meaning of changes ─────────────────────────────────────────────────────────────────────────

function newMeaning() {
  return { commits: 0, lines: Object.fromEntries(LINE_KINDS.map((k) => [k, [0, 0]])), testsAdded: 0 };
}

function addCommit(meaning, i) {
  const lines = lineKinds(i.e.lines);
  meaning.commits += i.e.count ?? 1;
  meaning.testsAdded += Number(i.detail.testsAdded) || 0;
  for (const k of LINE_KINDS) { meaning.lines[k][0] += lines[k][0]; meaning.lines[k][1] += lines[k][1]; }
}

function rowOfMeaning(meaning) {
  const added = total(LINE_KINDS.map((k) => meaning.lines[k][0]));
  const deleted = total(LINE_KINDS.map((k) => meaning.lines[k][1]));
  return { ...meaning, added, deleted, ratio: added ? Math.round((deleted / added) * 100) / 100 : null };
}

/** The window's commits per place and repository: lines by kind, tests added, deleted ÷ added. */
function meaningOf(live) {
  const commits = live.filter(isCommit);
  if (!commits.length) return null;
  const places = new Map();
  for (const i of commits) {
    const place = places.get(i.place) ?? { total: newMeaning(), repositories: new Map() };
    places.set(i.place, place);
    const repository = place.repositories.get(i.repository) ?? newMeaning();
    place.repositories.set(i.repository, repository);
    addCommit(place.total, i);
    addCommit(repository, i);
  }
  return {
    places: [...places].sort(byName(([place]) => place)).map(([place, p]) => ({
      place,
      total: rowOfMeaning(p.total),
      repositories: [...p.repositories].sort(byName(([repository]) => repository)).map(([repository, m]) => ({ repository, ...rowOfMeaning(m) })),
    })),
  };
}

// ── Decisions ──────────────────────────────────────────────────────────────────────────────────

/** A document's first author as a name: the `{ name, email }` the git source gives (the email when the name is empty), or a plain string; null for none. */
function authorName(author) {
  if (author && typeof author === 'object') return String(author.name || author.email || '') || null;
  return author ? String(author) : null;
}

/** The decision documents added or decided in the window, one per path; null when there are none. */
function decisionsOf(ctx, items, live) {
  const documents = items.filter((i) => i.kind === 'decision document').map((i) => ({
    repository: i.repository,
    path: String(i.detail.path ?? i.e.what ?? ''),
    dir: String(i.detail.dir ?? ''),
    status: i.detail.status ?? null,
    added: dayOfValue(ctx, i.detail.added) ?? i.day,
    decided: dayOfValue(ctx, i.detail.decided) ?? dayOfValue(ctx, i.detail.added) ?? i.day,
    firstAuthor: authorName(i.detail.firstAuthor),
    byPerson: Boolean(i.detail.byPerson),
  })).filter((d) => inWindow(ctx, d.added) || inWindow(ctx, d.decided));
  const unique = distinctBy(documents, (d) => `${d.repository}\n${d.path}`);
  const amendments = distinctBy(live.filter((i) => isCommit(i) && list(i.detail.decisionDirs).some((dir) => ADR_DIR.test(dir))), eventKey).length;
  if (!unique.length && !amendments) return null;
  const dirs = new Map();
  for (const d of unique) {
    const row = dirs.get(d.dir) ?? { dir: d.dir, documents: 0, byPerson: 0 };
    row.documents += 1;
    if (d.byPerson) row.byPerson += 1;
    dirs.set(d.dir, row);
  }
  const adrs = unique.filter((d) => ADR_DIR.test(d.dir)).sort((a, b) => String(a.added).localeCompare(String(b.added)) || a.path.localeCompare(b.path));
  const byStatus = {};
  for (const d of adrs) byStatus[d.status ?? 'other'] = (byStatus[d.status ?? 'other'] || 0) + 1;
  return {
    dirs: [...dirs.values()].sort(byName((d) => d.dir)),
    adrs,
    byStatus,
    adrsByPerson: adrs.filter((d) => d.byPerson).length,
    amendments,
  };
}

// ── Releases ───────────────────────────────────────────────────────────────────────────────────

const groupedBy = (items, key) => {
  const map = new Map();
  for (const i of items) map.set(key(i), [...(map.get(key(i)) ?? []), i]);
  return [...map].sort(byName(([k]) => k));
};

/** Tags, changelog entries, GitHub releases and production release dates of the window — team and repository facts. */
function releasesOf(live) {
  const of = (kind) => live.filter((i) => i.kind === kind);
  const tags = groupedBy(distinctBy(of('tag'), (i) => `${i.repository}\n${i.detail.tag}`), (i) => i.repository)
    .map(([repository, rows]) => ({ repository, tags: rows.map((i) => String(i.detail.tag)).sort() }));
  const changelog = groupedBy(distinctBy(of('changelog entry'), (i) => `${i.repository}\n${i.detail.version}`), (i) => i.repository)
    .map(([repository, rows]) => ({
      repository,
      entries: rows.map((i) => ({ version: String(i.detail.version), date: i.day, breaking: Boolean(i.detail.breaking) }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.version.localeCompare(b.version)),
    }));
  const github = groupedBy(distinctBy(of('github release'), (i) => `${i.repository}\n${i.detail.tag}`), (i) => i.repository)
    .map(([repository, rows]) => ({
      repository, releases: rows.map((i) => ({ tag: String(i.detail.tag), prerelease: Boolean(i.detail.prerelease) })).sort(byName((r) => r.tag)),
    }));
  const dates = [...new Set(of('production release').map((i) => i.day).filter(Boolean))].sort();
  if (!tags.length && !changelog.length && !github.length && !dates.length) return null;
  return { tags, changelog, github, production: { dates, count: dates.length } };
}

// ── Decision chain ─────────────────────────────────────────────────────────────────────────────

const instantOf = (i) => Date.parse(i.e.at ?? '') || 0;

const isAsk = (i) => i.source === 'sessions' && i.kind === 'final' && i.detail.request && list(i.detail.codes).length;

/**
 * The release of a decision: the first tag that holds every linked commit — where the decision shipped
 * whole. Each commit's `releasedIn` is the oldest tag containing it, so the tag that holds them all is
 * the latest of those (ties by tag name); one commit no tag contains leaves the decision unreleased.
 * This assumes the tags lie along one line of history, and is exact there; across diverging release
 * lines the latest of the oldest tags can name a tag that does not contain the commit of another line.
 */
function releaseOf(ctx, commits) {
  const releases = commits.map((i) => i.detail.releasedIn);
  if (!releases.length || releases.some((r) => !r?.tag)) return null;
  const last = [...releases].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || String(b.tag).localeCompare(String(a.tag)))[0];
  return { tag: String(last.tag), date: dayOfValue(ctx, last.at) };
}

/**
 * Per decision code asked in the window's finals: first asked (over every stored event), answered, the
 * decision documents naming it, the commits linked to it — those naming it in their message
 * (`detail.codes`) or touching a document that names it (`detail.decisionPaths`), on or after the day
 * it was first asked — the release where the decision shipped whole, their task keys and the
 * tracker's status changes on them; each link searched in `history`, an empty link is null.
 */
function chainOf(ctx, live, history) {
  const wanted = new Set(live.filter(isAsk).flatMap((i) => list(i.detail.codes)));
  if (!wanted.size) return null;
  const firstAsk = new Map();
  for (const i of history.filter(isAsk).sort((a, b) => instantOf(a) - instantOf(b))) {
    for (const code of list(i.detail.codes)) if (wanted.has(code) && !firstAsk.has(code)) firstAsk.set(code, i);
  }
  const messages = history.filter((i) => i.source === 'sessions' && i.kind === 'message');
  const documents = history.filter((i) => i.kind === 'decision document');
  const commits = history.filter(isCommit);
  const statuses = history.filter((i) => i.source === 'jira' && i.kind === 'status');
  const rows = [...firstAsk].map(([code, ask]) => {
    const reply = messages.filter((m) => m.detail.session === ask.detail.session && instantOf(m) > instantOf(ask)).sort((a, b) => instantOf(a) - instantOf(b))[0];
    const docs = distinctBy(documents.filter((i) => list(i.detail.codes).includes(code)), (i) => `${i.repository}\n${i.detail.path}`)
      .map((i) => ({ repository: i.repository, path: String(i.detail.path ?? '') })).sort(byName((d) => `${d.repository}\n${d.path}`));
    const paths = new Set(docs.map((d) => `${d.repository}\n${d.path}`));
    const linked = distinctBy(commits.filter((i) => i.day && i.day >= ask.day
      && (list(i.detail.codes).includes(code) || list(i.detail.decisionPaths).some((p) => paths.has(`${i.repository}\n${p}`)))), eventKey);
    const keys = [...new Set(linked.flatMap((i) => list(i.detail.keys)))].sort();
    const changes = keys.map((key) => ({
      key, changes: distinctBy(statuses.filter((i) => i.e.what === key || String(i.e.what).startsWith(`${key} `)), eventKey).length,
    })).filter((k) => k.changes);
    return {
      code,
      asked: ask.day,
      answered: reply ? reply.day : ask.detail.answered ? 'Y' : 'N',
      documents: docs,
      commits: linked.length,
      released: releaseOf(ctx, linked),
      keys,
      statusChanges: changes,
    };
  });
  return { rows: rows.sort((a, b) => String(a.asked).localeCompare(String(b.asked)) || a.code.localeCompare(b.code)) };
}

// ── Uncommitted and first activity ─────────────────────────────────────────────────────────────

/** The earliest `{ repository, date }` per repository, and the earliest of all. */
function firstOf(live, kind) {
  const best = new Map();
  for (const i of live.filter((x) => x.kind === kind && x.day)) {
    if (!best.has(i.repository) || i.day < best.get(i.repository)) best.set(i.repository, i.day);
  }
  const rows = [...best].map(([repository, date]) => ({ repository, date })).sort(byName((r) => r.repository));
  const earliest = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.repository.localeCompare(b.repository))[0] ?? null;
  return { rows, earliest };
}

/** Uncommitted lines by modification date and repository, and the first commit and first pull request. */
function snapshotOf(live) {
  const files = new Map();
  for (const i of live.filter((x) => x.kind === 'uncommitted')) {
    const key = `${i.day}\n${i.place}\n${i.repository}`;
    const row = files.get(key) ?? { date: i.day, place: i.place, repository: i.repository, files: 0, untracked: 0, lines: Object.fromEntries(LINE_KINDS.map((k) => [k, [0, 0]])) };
    const lines = lineKinds(i.e.lines);
    row.files += 1;
    if (i.detail.untracked) row.untracked += 1;
    for (const k of LINE_KINDS) { row.lines[k][0] += lines[k][0]; row.lines[k][1] += lines[k][1]; }
    files.set(key, row);
  }
  const uncommitted = [...files.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.place.localeCompare(b.place) || a.repository.localeCompare(b.repository));
  const commits = firstOf(live, 'first commit');
  const pulls = firstOf(live, 'first pull request');
  if (!uncommitted.length && !commits.rows.length && !pulls.rows.length) return null;
  return { uncommitted, firstCommits: commits.rows, earliestCommit: commits.earliest, firstPullRequests: pulls.rows, earliestPullRequest: pulls.earliest };
}

// ── Team facts ─────────────────────────────────────────────────────────────────────────────────

/** Project leads, versions released, people assigned and repository authors — listed by name, never by count. */
function teamOf(ctx, live) {
  const projects = new Map();
  const repositories = new Map();
  const project = (name) => {
    const row = projects.get(name) ?? { project: name, lead: null, leadMember: false, versions: [], people: new Map() };
    projects.set(name, row);
    return row;
  };
  const authorsOf = (repository) => {
    const authors = repositories.get(repository) ?? new Map();
    repositories.set(repository, authors);
    return authors;
  };
  for (const i of live) {
    const d = i.detail;
    const member = Boolean(d.member);
    if (i.kind === 'project lead' && d.project) Object.assign(project(String(d.project)), { lead: d.lead ?? null, leadMember: member });
    else if (i.kind === 'version released' && d.project) project(String(d.project)).versions.push({ version: String(d.version ?? ''), date: i.day });
    else if (i.kind === 'assigned issue' && d.project && d.person) project(String(d.project)).people.set(String(d.person), member);
    else if (i.kind === 'repository author' && d.repo && d.author) authorsOf(String(d.repo)).set(String(d.author), member);
  }
  if (!projects.size && !repositories.size) return null;
  const named = (map) => [...map].sort(byName(([name]) => name)).map(([name, member]) => ({ name, member }));
  return {
    rule: ctx.teamRule,
    projects: [...projects.values()].sort(byName((p) => p.project)).map((p) => ({
      project: p.project,
      lead: p.lead,
      leadMember: p.leadMember,
      versions: [...p.versions].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.version.localeCompare(b.version)),
      people: named(p.people),
    })),
    repositories: [...repositories].sort(byName(([repository]) => repository)).map(([repository, authors]) => ({ repository, authors: named(authors) })),
  };
}

/**
 * The fact sections of a report as plain data (JSON-safe; a section with nothing to show is null).
 * The window's actions and facts, and the snapshot facts whatever the window, are summarized; a
 * decision document counts when it was added or decided in the window, one path once.
 *
 * @param {object[]} events actions and facts, each with `source` (the stored hours facts are ignored)
 * @param {{ since: string, until: string, tz?: string, dayStartsMin?: number, placeOf?: (where: string|null) => string,
 *   history?: object[]|null, readingReference?: { label: string, words: number }|null, teamRule?: string|null }} options
 *   the window and the working day (as `buildReport`), `placeOf` the settings' place of a `where`,
 *   `history` every stored event for the decision chain's links beyond the window (null: `events`)
 * @returns {{ sessions: object|null, meaning: object|null, decisions: object|null, releases: object|null,
 *   chain: object|null, snapshot: object|null, team: object|null }}
 */
export function summarizeFacts(events, options) {
  const ctx = contextOf(options);
  const kept = (all) => all.filter((e) => e.kind !== 'hours').map((e) => itemOf(ctx, e));
  const items = kept(events);
  const live = items.filter((i) => i.e.snapshot === true || inWindow(ctx, i.day));
  const history = options.history ? kept(options.history) : items;
  return {
    sessions: sessionsOf(ctx, live),
    meaning: meaningOf(live),
    decisions: decisionsOf(ctx, items, live),
    releases: releasesOf(live),
    chain: chainOf(ctx, live, history),
    snapshot: snapshotOf(live),
    team: teamOf(ctx, live),
  };
}

// ── Markdown ───────────────────────────────────────────────────────────────────────────────────

const dash = (value) => (value === null || value === undefined || value === '' ? EMPTY : value);
const unitCells = (u) => [
  u.sessions, u.activeDays, `${u.messages} · ${u.messageWords}`, `${u.finals} · ${u.finalWords}`,
  `${u.requests} (${u.questions} · ${u.none} · ${u.answered})`, `${u.codes} (${u.answeredCodes})`, u.delegations, u.choiceDialogs,
];

function sessionsLines(s) {
  if (!s) return [];
  const out = [
    '', '## Sessions', '',
    'Agent sessions as counts. Owner messages are the person\'s actions; the agents\' final summaries, delegations and choice dialogs are facts counted here, '
    + 'not actions. Decision requests: (questions · declared none · answered); codes: distinct (of them in answered requests).',
  ];
  const header = ['Sessions', 'Active days', 'Owner messages · words', 'Finals · words', 'Decision requests', 'Codes', 'Delegations', 'Choice dialogs'];
  for (const p of s.places) {
    if (s.places.length > 1) out.push('', `### ${p.place}`);
    const rows = p.repositories.map((r) => [r.repository, ...unitCells(r)]);
    if (p.repositories.length > 1) rows.push(['all repositories', ...unitCells(p.total)]);
    out.push('', ...table(['Repository', ...header], rows));
  }
  out.push('', '### Sessions by week', '', ...table(['Week of', ...header],
    s.weeks.map((w) => [w.week, ...unitCells(w)])));
  if (s.reading) out.push('', `Words read: ${s.wordsRead} ≈ ${s.reading.times}× ${s.reading.label} (the words of the agents' final summaries and of the side-agent notes the owner forwarded).`);
  return out;
}

const ratioText = (ratio) => (ratio === null ? EMPTY : ratio.toFixed(2));

function meaningLines(m) {
  if (!m) return [];
  const out = ['', '## Meaning of changes', '', 'Lines by kind per repository, the test functions the commits added, and deleted lines ÷ added lines.'];
  const header = ['Repository', 'Commits', ...LINE_KINDS.map((k) => k[0].toUpperCase() + k.slice(1)), 'Tests added', 'Deleted ÷ added'];
  const cells = (r) => [r.commits, ...LINE_KINDS.map((k) => plusMinusTight(r.lines[k])), r.testsAdded, ratioText(r.ratio)];
  for (const p of m.places) {
    if (m.places.length > 1) out.push('', `### ${p.place}`);
    const rows = p.repositories.map((r) => [r.repository, ...cells(r)]);
    if (p.repositories.length > 1) rows.push(['all repositories', ...cells(p.total)]);
    out.push('', ...table(header, rows));
  }
  return out;
}

function decisionsLines(d) {
  if (!d) return [];
  const out = ['', '## Decisions', '', 'Decision documents added or decided in the period, from every ref, any status; one path counts once.'];
  if (d.dirs.length) out.push('', ...table(['Folder', 'Documents', 'By the person'], d.dirs.map((x) => [x.dir, x.documents, x.byPerson])));
  if (d.adrs.length) {
    out.push('', ...table(['ADR', 'Repository', 'Status', 'Added', 'Decided', 'First author', 'By the person'],
      d.adrs.map((a) => [a.path, a.repository, dash(a.status), dash(a.added), dash(a.decided), dash(a.firstAuthor), a.byPerson ? 'yes' : 'no'])));
    const statuses = Object.entries(d.byStatus).sort(byName(([status]) => status)).map(([status, n]) => `${status} ${n}`).join(', ');
    out.push('', `ADRs: ${d.adrs.length} (${statuses}); written by the person: ${d.adrsByPerson}.`);
  }
  out.push('', `Amendments — the person's commits that touched an ADR folder: ${d.amendments}.`);
  return out;
}

function releasesLines(r) {
  if (!r) return [];
  const out = ['', '## Releases', '', 'Team and repository facts, not the person\'s actions.'];
  if (r.tags.length) {
    const names = (tags) => (tags.length > TAGS_SHOWN ? `${tags.slice(0, TAGS_SHOWN).join(', ')} +${tags.length - TAGS_SHOWN} more` : tags.join(', '));
    out.push('', 'Tags created in the period:', '', ...table(['Repository', 'Tags', 'Names'], r.tags.map((t) => [t.repository, t.tags.length, names(t.tags)])));
  }
  if (r.changelog.length) {
    out.push('', 'Changelog entries of the period:', '', ...table(['Repository', 'Version', 'Date', 'Breaking'],
      r.changelog.flatMap((c) => c.entries.map((e) => [c.repository, e.version, dash(e.date), e.breaking ? 'breaking' : '']))));
  }
  if (r.github.length) {
    out.push('', 'GitHub releases published in the period:', '', ...table(['Repository', 'Releases', 'Tags'],
      r.github.map((g) => [g.repository, g.releases.length, g.releases.map((x) => (x.prerelease ? `${x.tag} (pre-release)` : x.tag)).join(', ')])));
  }
  if (r.production.count) out.push('', `Production releases by the user's rule: ${r.production.count} — ${r.production.dates.join(', ')}.`);
  return out;
}

function chainLines(c) {
  if (!c) return [];
  return [
    '', '## Decision chain', '',
    'Each decision code asked in the period: answered (the date of the owner\'s next message, else Y or N) → decision documents naming it (Repository and Documents list them in the same order: one path can exist in two repositories) → commits naming it or touching those documents → '
    + 'the first tag that holds all of them → their task keys → the tracker\'s status changes on them. — is an empty link.',
    '', ...table(['Code', 'First asked', 'Answered', 'Repository', 'Documents', 'Commits', 'Released in', 'Task keys', 'Status changes'],
      c.rows.map((r) => [
        r.code, dash(r.asked), r.answered, dash(r.documents.map((d) => d.repository).join(', ')), dash(r.documents.map((d) => d.path).join(', ')), r.commits || EMPTY,
        r.released ? `${r.released.tag}${r.released.date ? ` (${r.released.date})` : ''}` : EMPTY, dash(r.keys.join(', ')),
        dash(r.statusChanges.map((k) => `${k.key} ×${k.changes}`).join(', ')),
      ])),
  ];
}

function snapshotLines(s) {
  if (!s) return [];
  const out = ['', '## Uncommitted and first activity'];
  if (s.uncommitted.length) {
    const withPlace = new Set(s.uncommitted.map((u) => u.place)).size > 1;
    out.push('', 'Not yet committed — the clones\' uncommitted and untracked lines, by the files\' modification date (a snapshot of the day of collection):', '',
      ...table(['Modified', ...(withPlace ? ['Place'] : []), 'Repository', 'Files', 'Untracked', ...LINE_KINDS.map((k) => k[0].toUpperCase() + k.slice(1))],
        s.uncommitted.map((u) => [dash(u.date), ...(withPlace ? [u.place] : []), u.repository, u.files, u.untracked, ...LINE_KINDS.map((k) => plusMinusTight(u.lines[k]))])));
  }
  const first = (title, rows, earliest) => {
    if (!rows.length) return;
    out.push('', `${title}:`, '', ...table(['Repository', 'Date'], rows.map((r) => [r.repository, r.date])), '', `Earliest: ${earliest.date} (${earliest.repository}).`);
  };
  first('First commit of the person per repository', s.firstCommits, s.earliestCommit);
  first('First pull request of the person per repository', s.firstPullRequests, s.earliestPullRequest);
  return out;
}

const marked = (name, member) => (member ? `${name} (member)` : name);

function teamLines(t) {
  if (!t) return [];
  const out = [
    '', '## Team facts', '',
    t.rule ? `Counting rule (the user's): ${t.rule}` : 'No counting rule given: the people listed are those seen in the period, not a team.',
    'Facts about a team and its repositories, not the person\'s actions; people are listed by name, never ordered by count.',
  ];
  if (t.projects.length) {
    out.push('', ...table(['Project', 'Lead', 'Versions released', 'People assigned'], t.projects.map((p) => [
      p.project, p.lead ? marked(p.lead, p.leadMember) : EMPTY,
      dash(p.versions.map((v) => `${v.version}${v.date ? ` (${v.date})` : ''}`).join(', ')),
      dash(p.people.map((x) => marked(x.name, x.member)).join(', ')),
    ])));
  }
  if (t.repositories.length) {
    out.push('', ...table(['Repository', 'Authors in the period'], t.repositories.map((r) => [r.repository, r.authors.map((a) => marked(a.name, a.member)).join(', ')])));
  }
  return out;
}

/**
 * The fact sections as markdown lines, in the report's order after "What changed": Sessions,
 * Meaning of changes, Decisions, Releases, Decision chain, Uncommitted and first activity, Team facts.
 *
 * @param {object|null|undefined} facts what `summarizeFacts` returned (kept in `report.facts`)
 * @returns {string[]} the lines, each section opening with a blank line and its `##` heading; none for no facts
 */
export function renderFacts(facts) {
  if (!facts) return [];
  return [
    ...sessionsLines(facts.sessions), ...meaningLines(facts.meaning), ...decisionsLines(facts.decisions), ...releasesLines(facts.releases),
    ...chainLines(facts.chain), ...snapshotLines(facts.snapshot), ...teamLines(facts.team),
  ];
}
