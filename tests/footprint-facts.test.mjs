// The footprint's fact sections (npm test), offline and in-process, on synthetic events: facts stay out
// of the days and of the first and last action while an owner message to an agent is an action; the
// numbers of Sessions, Meaning of changes, Decisions (an ADR counts when added or decided in the
// window, one path once), Releases, the Decision chain (links through the history, an ADR written
// after the window included), Uncommitted and first activity (shown whatever the window) and Team
// facts (by name, never by count); no path or message text in the markdown; the data is JSON-safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, renderMarkdown } from '../tools/footprint/report.mjs';
import { renderFacts, summarizeFacts } from '../tools/footprint/facts.mjs';

const PERIOD = { since: '2026-03-02', until: '2026-03-08', tz: 'UTC' };
const WHERE = '/src/app git@example.com:acme/app.git';
const LIB = '/src/lib';
const lines = (code = [0, 0], tests = [0, 0], docs = [0, 0], other = [0, 0]) => ({ code, tests, docs, other });

const event = (kind, at, detail = {}, extra = {}) => ({ at, kind, what: `app: ${kind}`, where: WHERE, detail, ...extra });
const fact = (kind, at, detail, extra = {}) => event(kind, at, detail, { action: false, ...extra });
const message = (at, session, words, where = WHERE, what = 'app: claude session') => ({ at, kind: 'message', what, where, detail: { host: 'claude', session, words } });
const final = (at, session, words, detail = {}) => ({
  at, kind: 'final', what: 'app: claude session', where: WHERE, action: false,
  detail: { host: 'claude', session, words, request: false, questions: 0, none: false, codes: [], answered: false, ...detail },
});
const sessionFact = (kind, at, session) => ({ at, kind, what: 'app: claude session', where: WHERE, action: false, detail: { host: 'claude', session } });
const commit = (at, subject, repo, linesOfCommit, detail = {}) => ({
  at, kind: 'commit', what: `app: ${subject}`, where: WHERE, lines: linesOfCommit,
  detail: { repo, testsAdded: 0, codes: [], keys: [], decisionDirs: [], ...detail },
});
const document = (path, dir, added, decided, detail = {}) => fact('decision document', added, {
  repo: 'acme/app', path, dir, status: null, added, decided, firstAuthor: 'Ada', byPerson: false, codes: [], words: 100, ...detail,
}, { id: `doc:acme/app:${path}:${added}` });

const source = (name, events, extra = {}) => ({ source: name, label: name, totals: [], notes: [], events, ...extra });

const ADR_0008 = document('docs/adr/0008-first.md', 'docs/adr', '2026-03-02T09:00:00Z', '2026-03-03', { status: 'accepted', byPerson: true, codes: ['D-ORDER'] });
const ADR_0009 = document('docs/adr/0009-second.md', 'docs/adr', '2026-02-20T10:00:00Z', '2026-03-04', { status: 'accepted', firstAuthor: 'Bea' });
const ADR_0010 = document('docs/adr/0010-before.md', 'docs/adr', '2026-02-10T10:00:00Z', '2026-02-12', { status: 'accepted' });
const DESIGN = document('docs/design/footprint.md', 'docs/design', '2026-03-05T10:00:00Z', '2026-03-05T10:00:00Z', { byPerson: true });
const ADR_0011 = document('docs/adr/0011-after.md', 'docs/adr', '2026-03-15T10:00:00Z', '2026-03-15', { status: 'proposed', codes: ['D-SHAPE'] });

/** One week: git, sessions, Jira, GitHub and team events, facts among them. */
function results() {
  return [
    source('git', [
      commit('2026-03-02T12:00:00Z', 'Add login', 'acme/app', lines([100, 20], [40, 0], [10, 0], [5, 5]), {
        testsAdded: 3, decisionDirs: ['docs/adr'], codes: ['D-ORDER'], keys: ['PROJ-1'], releasedIn: { tag: 'v1.1.0', at: '2026-03-20T10:00:00Z' },
      }),
      commit('2026-03-03T12:00:00Z', 'Trim', 'acme/app', lines([10, 30]), { testsAdded: 1 }),
      ADR_0008, { ...ADR_0008, id: 'doc:acme/app:docs/adr/0008-first.md:again' }, ADR_0009, ADR_0010, DESIGN,
      fact('tag', '2026-03-04T10:00:00Z', { repo: 'acme/app', tag: 'v1.0.0' }),
      fact('tag', '2026-02-01T10:00:00Z', { repo: 'acme/app', tag: 'v0.9.0' }),
      fact('changelog entry', undefined, { repo: 'acme/app', version: '1.0.0', breaking: true }, { date: '2026-03-04', at: undefined }),
      fact('uncommitted', '2026-02-01T10:00:00Z', { repo: 'acme/app', path: 'a.js', untracked: false }, { snapshot: true, lines: lines([10, 0]) }),
      fact('uncommitted', '2026-02-01T11:00:00Z', { repo: 'acme/app', path: 'b.md', untracked: true }, { snapshot: true, lines: lines(undefined, undefined, [5, 0]) }),
      fact('first commit', '2025-06-01T09:00:00Z', { repo: 'acme/app', hash: 'abc' }, { snapshot: true }),
      fact('first commit', '2025-01-10T09:00:00Z', { repo: 'acme/lib', hash: 'def' }, { snapshot: true }),
    ]),
    source('sessions', [
      message('2026-03-02T09:00:00Z', 's1', 10),
      message('2026-03-02T09:30:00Z', 's1', 5),
      final('2026-03-02T10:00:00Z', 's1', 100, { request: true, questions: 2, codes: ['D-ORDER', 'D-SHAPE'], answered: true }),
      sessionFact('delegation', '2026-03-02T09:10:00Z', 's1'),
      sessionFact('choice dialog', '2026-03-02T09:20:00Z', 's1'),
      message('2026-03-03T08:00:00Z', 's1', 7),
      final('2026-03-04T10:00:00Z', 's2', 50, { request: true, none: true }),
      final('2026-03-04T11:00:00Z', 's2', 30),
      message('2026-03-05T09:00:00Z', 's3', 3, LIB, 'lib: claude session'),
      message('2026-02-20T09:00:00Z', 's0', 99), // before the period
    ]),
    source('jira', [
      { at: '2026-03-02T11:00:00Z', kind: 'status', what: 'PROJ-1 Login page', where: 'PROJ' },
      { date: '2026-03-02', kind: 'hours', action: false, what: 'hours', where: 'PROJ', detail: { hours: 7 } },
    ]),
    source('github', [
      fact('github release', '2026-03-04T12:00:00Z', { repo: 'acme/app', tag: 'v1.0.0', prerelease: false }),
      fact('production release', undefined, { repos: ['acme/app'], pulls: 2 }, { date: '2026-03-04', at: undefined }),
      fact('production release', undefined, { repos: ['acme/app'], pulls: 1 }, { date: '2026-03-06', at: undefined }),
      fact('first pull request', '2025-08-01T09:00:00Z', { repo: 'acme/app', number: 1 }, { snapshot: true }),
    ]),
    source('team', [
      fact('project lead', '2026-03-08T00:00:00Z', { project: 'PROJ', lead: 'Bea', member: true }, { snapshot: true }),
      fact('version released', undefined, { project: 'PROJ', version: '1.0' }, { date: '2026-03-03', at: undefined }),
      ...['Zed', 'Zed', 'Zed', 'Ada', 'Bob'].map((person, n) => fact('assigned issue', `2026-03-0${n + 2}T10:00:00Z`, { project: 'PROJ', person, member: person === 'Ada' })),
      fact('repository author', undefined, { repo: 'acme/app', author: 'Zed', email: 'zed@example.com', commits: 50, member: false }, { date: '2026-03-02', at: undefined }),
      fact('repository author', undefined, { repo: 'acme/app', author: 'Ada', email: 'ada@example.com', commits: 1, member: true }, { date: '2026-03-03', at: undefined }),
    ]),
  ];
}

const flat = (list) => list.flatMap((r) => r.events.map((e) => ({ ...e, source: r.source })));
/** What the history holds beyond the week: an ADR written after it, a commit naming its code, status changes on its key. */
const AFTER = [
  { ...ADR_0011, source: 'git' },
  { ...commit('2026-03-16T10:00:00Z', 'Implement', 'acme/app', lines([5, 0]), { codes: ['D-SHAPE'], keys: ['PROJ-2'], releasedIn: { tag: 'v1.2.0', at: '2026-03-18T00:00:00Z' } }), source: 'git' },
  { at: '2026-03-17T10:00:00Z', kind: 'status', what: 'PROJ-2 Search', where: 'PROJ', source: 'jira' },
  { at: '2026-03-18T10:00:00Z', kind: 'status', what: 'PROJ-2 Search', where: 'PROJ', source: 'jira' },
];
const FACT_SETTINGS = { readingReference: { label: 'a long novel', words: 360 }, teamRule: 'members: ada@example.com' };
const build = (extra = {}) => buildReport(results(), { ...PERIOD, history: [...flat(results()), ...AFTER], factSettings: FACT_SETTINGS, ...extra });
const markdown = (r) => renderMarkdown(r, { person: 'Ada', collectedAt: '2026-03-09 10:00' });
const section = (md, heading) => md.split(`\n${heading}\n`)[1].split(/\n## /)[0];

test('buildReport: facts stay out of the days and of the first and last action; an owner message to an agent is an action', () => {
  const git = source('git', [event('commit', '2026-03-02T12:00:00Z', {}, { lines: lines([1, 0]) })]);
  const noise = source('sessions', [final('2026-03-02T23:50:00Z', 's1', 10), sessionFact('delegation', '2026-03-03T08:00:00Z', 's1')]);
  const before = buildReport([git, noise], PERIOD);
  assert.deepEqual([before.all.activeDays, before.days[0].first, before.days[0].last, before.days[0].bySource], [1, '12:00', '12:00', { git: 1 }]);
  assert.deepEqual(before.activeDays, 1);
  assert.equal(before.all.days.length, 1);
  assert.equal(before.sources.length, 2);
  const typed = buildReport([git, source('sessions', [...noise.events, message('2026-03-04T06:00:00Z', 's1', 4)])], PERIOD);
  assert.deepEqual([typed.activeDays, typed.all.measures.firstMedian, typed.all.measures.lastMedian], [2, 540, 540]);
  assert.deepEqual(typed.all.days.map((d) => [d.date, d.first, d.last]), [['2026-03-02', '12:00', '12:00'], ['2026-03-04', '06:00', '06:00']]);
  assert.deepEqual(typed.days[2].bySource, { sessions: 1 });
});

test('buildReport: a first commit, a tag, a changelog entry, uncommitted work and a decision document inside the period are no actions', () => {
  const commitEvent = event('commit', '2026-03-02T12:00:00Z', { repo: 'acme/app' }, { lines: lines([1, 0]) });
  const facts = [
    fact('first commit', '2026-03-04T03:00:00Z', { repo: 'acme/app', hash: 'abc' }, { snapshot: true }),
    fact('tag', '2026-03-05T10:00:00Z', { repo: 'acme/app', tag: 'v1.0.0' }),
    fact('changelog entry', undefined, { repo: 'acme/app', version: '1.0.0', breaking: false }, { date: '2026-03-06', at: undefined }),
    fact('uncommitted', '2026-03-06T10:00:00Z', { repo: 'acme/app', path: 'a.js', untracked: false }, { snapshot: true, lines: lines([9, 0]) }),
    document('docs/adr/0030-new.md', 'docs/adr', '2026-03-07T10:00:00Z', '2026-03-07', { status: 'proposed' }),
  ];
  const alone = buildReport([source('git', [commitEvent])], PERIOD);
  const withFacts = buildReport([source('git', [commitEvent, ...facts])], PERIOD);
  const shape = (r) => [r.activeDays, r.all.actions, r.all.activeDays, r.all.days.map((d) => [d.date, d.first, d.last, d.actions]), r.days.map((d) => d.bySource), r.all.measures.totals];
  assert.deepEqual(shape(withFacts), shape(alone));
  assert.equal(withFacts.all.actions, 1);
  assert.deepEqual(withFacts.days.map((d) => d.bySource).filter((s) => Object.keys(s).length), [{ git: 1 }]);
  // ... yet they are gathered for their own sections
  assert.equal(withFacts.facts.decisions.adrs.length, 1);
});

test('buildReport: the stored hours facts are ignored by the days and the sections', () => {
  const r = build();
  assert.deepEqual(r.days[0].bySource, { git: 1, sessions: 2, jira: 1 });
  assert.equal(r.days[0].hours.jira, undefined);
  assert.ok(!JSON.stringify(r.facts).includes('"hours"'));
});

test('Sessions: the words of a forwarded side-agent note are read — added to the words read, not to the owner\'s words', () => {
  const forwarded = { ...message('2026-03-04T09:00:00Z', 's1', 2), detail: { host: 'claude', session: 's1', words: 2, noteWords: 50 } };
  const sessions = source('sessions', [forwarded, final('2026-03-04T10:00:00Z', 's1', 130)]);
  const r = buildReport([sessions], { ...PERIOD, factSettings: FACT_SETTINGS });
  assert.equal(r.facts.sessions.places[0].total.messageWords, 2);
  assert.deepEqual([r.facts.sessions.wordsRead, r.facts.sessions.reading.times], [180, 0.5]);
  assert.match(markdown(r), /^Words read: 180 ≈ 0\.5× a long novel/m);
});

test('buildReport: owner messages per active day and in the period, and the Messages column of By week — only when the sessions source ran', () => {
  const r = build();
  assert.deepEqual(r.all.measures.perActiveDay.messages, { median: 1, mean: 4 / 3 });
  assert.equal(r.all.measures.totals.messages, 4);
  const md = markdown(r);
  assert.match(section(md, '## Per day, by place'), /^\| Owner messages to agents per active day, median · mean \| 1 · 1\.3 \|$/m);
  assert.match(section(md, '## Per day, by place'), /^\| Owner messages to agents in the period \| 4 \|$/m);
  assert.match(section(md, '## By week'), /^\| Week of \| .* \| Messages \| .*\|\n.*\n\| 2026-03-02 \| .* \| 4 \|/m);
  const without = markdown(buildReport(results().filter((x) => x.source !== 'sessions'), PERIOD));
  assert.doesNotMatch(without, /Owner messages to agents/);
  assert.doesNotMatch(section(without, '## By week'), /Messages/);
});

test('Sessions: sessions, active days, messages, finals, decision requests, codes, delegations and dialogs per repository; a week table; words read', () => {
  const { sessions } = build().facts;
  assert.equal(sessions.places.length, 1);
  const [place] = sessions.places;
  const app = place.repositories.find((r) => r.repository === 'app');
  assert.deepEqual(app, {
    repository: 'app', sessions: 2, activeDays: 2, messages: 3, messageWords: 22, finals: 3, finalWords: 180, requests: 2, questions: 2, none: 1,
    answered: 1, codes: 2, answeredCodes: 2, delegations: 1, choiceDialogs: 1,
  });
  assert.deepEqual(place.repositories.find((r) => r.repository === 'lib'), {
    repository: 'lib', sessions: 1, activeDays: 1, messages: 1, messageWords: 3, finals: 0, finalWords: 0, requests: 0, questions: 0, none: 0,
    answered: 0, codes: 0, answeredCodes: 0, delegations: 0, choiceDialogs: 0,
  });
  assert.deepEqual([place.total.sessions, place.total.activeDays, place.total.messages, place.total.messageWords], [3, 3, 4, 25]);
  assert.deepEqual(sessions.weeks.map((w) => [w.week, w.sessions, w.messages]), [['2026-03-02', 3, 4]]);
  assert.deepEqual([sessions.wordsRead, sessions.reading], [180, { label: 'a long novel', referenceWords: 360, times: 0.5 }]);
  const md = section(markdown(build()), '## Sessions');
  assert.match(md, /^\| Repository \| Sessions \| Active days \| Owner messages · words \| Finals · words \| Decision requests \| Codes \| Delegations \| Choice dialogs \|$/m);
  assert.match(md, /^\| app \| 2 \| 2 \| 3 · 22 \| 3 · 180 \| 2 \(2 · 1 · 1\) \| 2 \(2\) \| 1 \| 1 \|$/m);
  assert.match(md, /^\| all repositories \| 3 \| 3 \| 4 · 25 \| 3 · 180 \| 2 \(2 · 1 · 1\) \| 2 \(2\) \| 1 \| 1 \|$/m);
  assert.match(md, /^\| 2026-03-02 \| 3 \| 3 \| 4 · 25 \|/m);
  assert.match(md, /^Words read: 180 ≈ 0\.5× a long novel/m);
  assert.doesNotMatch(markdown(build({ factSettings: {} })), /Words read/);
});

test('Sessions: a place per rule, the working day decides the window, a session event outside the window is left out', () => {
  const placeOf = (where) => (String(where).includes('lib') ? 'personal' : 'ACME Corp');
  const events = [
    message('2026-03-02T09:00:00Z', 's1', 10), message('2026-03-02T10:00:00Z', 's9', 4, LIB, 'lib: claude session'),
    sessionFact('delegation', '2026-03-09T01:00:00Z', 's1'), // 01:00 with a 04:00 day start is still the 8th
    sessionFact('delegation', '2026-03-09T05:00:00Z', 's1'), // the 9th: outside
    sessionFact('delegation', '2026-03-01T05:00:00Z', 's1'),
  ].map((e) => ({ ...e, source: 'sessions' }));
  const { sessions } = summarizeFacts(events, { ...PERIOD, dayStartsMin: 240, placeOf });
  assert.deepEqual(sessions.places.map((p) => [p.place, p.total.messages, p.total.delegations]), [['ACME Corp', 1, 1], ['personal', 1, 0]]);
  assert.match(section(renderMd(sessions), '## Sessions'), /^### personal$/m);
});

test('Sessions: active days are the days with an owner message — finals, delegations and dialogs of other days add none', () => {
  const events = [
    message('2026-03-02T09:00:00Z', 's1', 10), final('2026-03-03T10:00:00Z', 's1', 5),
    sessionFact('delegation', '2026-03-04T10:00:00Z', 's1'), sessionFact('choice dialog', '2026-03-05T10:00:00Z', 's1'),
  ].map((e) => ({ ...e, source: 'sessions' }));
  const { sessions } = summarizeFacts(events, PERIOD);
  const [place] = sessions.places;
  assert.deepEqual([place.total.activeDays, place.total.finals, place.total.delegations, place.total.choiceDialogs], [1, 1, 1, 1]);
  assert.deepEqual(place.repositories.map((r) => r.activeDays), [1]);
});

/** The markdown of a facts object made of `sessions` alone, for tests of one section. */
const renderMd = (sessions) => `\n${renderFacts({ sessions }).join('\n')}\n`;

test('Meaning of changes: lines by kind with other, tests added, and deleted ÷ added to two decimals per repository', () => {
  const { meaning } = build().facts;
  const [place] = meaning.places;
  assert.deepEqual(place.repositories, [{
    repository: 'acme/app', commits: 2, testsAdded: 4, added: 165, deleted: 55, ratio: 0.33,
    lines: { code: [110, 50], tests: [40, 0], docs: [10, 0], other: [5, 5] },
  }]);
  const md = section(markdown(build()), '## Meaning of changes');
  assert.match(md, /^\| Repository \| Commits \| Code \| Tests \| Docs \| Other \| Tests added \| Deleted ÷ added \|$/m);
  assert.match(md, /^\| acme\/app \| 2 \| \+110 −50 \| \+40 −0 \| \+10 −0 \| \+5 −5 \| 4 \| 0\.33 \|$/m);
});

test('Decisions: an ADR counts when added or decided in the window, one path once, by folder, status and person; amendments are the person\'s ADR-folder commits', () => {
  const { decisions } = build().facts;
  assert.deepEqual(decisions.adrs.map((a) => [a.path, a.added, a.decided, a.status, a.firstAuthor, a.byPerson]), [
    ['docs/adr/0009-second.md', '2026-02-20', '2026-03-04', 'accepted', 'Bea', false],
    ['docs/adr/0008-first.md', '2026-03-02', '2026-03-03', 'accepted', 'Ada', true],
  ]);
  assert.deepEqual(decisions.dirs, [{ dir: 'docs/adr', documents: 2, byPerson: 1 }, { dir: 'docs/design', documents: 1, byPerson: 1 }]);
  assert.deepEqual([decisions.byStatus, decisions.adrsByPerson, decisions.amendments], [{ accepted: 2 }, 1, 1]);
  const md = section(markdown(build()), '## Decisions');
  assert.match(md, /^\| docs\/adr \| 2 \| 1 \|$/m);
  assert.match(md, /^\| docs\/adr\/0009-second\.md \| acme\/app \| accepted \| 2026-02-20 \| 2026-03-04 \| Bea \| no \|$/m);
  assert.match(md, /^ADRs: 2 \(accepted 2\); written by the person: 1\.$/m);
  assert.match(md, /^Amendments — the person's commits that touched an ADR folder: 1\.$/m);
  const proposed = summarizeFacts([{ ...ADR_0011, source: 'git' }], { ...PERIOD, since: '2026-03-10', until: '2026-03-20' }).decisions;
  assert.deepEqual([proposed.adrs.length, proposed.byStatus], [1, { proposed: 1 }]);
});

test('Decisions: the first author the git source gives as { name, email } is shown by name, by email when it has no name', () => {
  const named = document('docs/adr/0020-named.md', 'docs/adr', '2026-03-02T09:00:00Z', '2026-03-02', { status: 'accepted', firstAuthor: { name: 'Ada', email: 'ada@example.com' } });
  const unnamed = document('docs/adr/0021-unnamed.md', 'docs/adr', '2026-03-03T09:00:00Z', '2026-03-03', { status: 'accepted', firstAuthor: { name: '', email: 'bea@example.com' } });
  const { decisions } = summarizeFacts([{ ...named, source: 'git' }, { ...unnamed, source: 'git' }], PERIOD);
  assert.deepEqual(decisions.adrs.map((a) => a.firstAuthor), ['Ada', 'bea@example.com']);
  const md = section(markdown(buildReport([source('git', [named, unnamed])], PERIOD)), '## Decisions');
  assert.match(md, /\| 2026-03-02 \| Ada \| no \|$/m);
  assert.match(md, /\| 2026-03-03 \| bea@example\.com \| no \|$/m);
  assert.doesNotMatch(md, /\[object Object\]/);
});

test('Releases: tags, changelog entries with breaking marked, GitHub releases and production release dates of the window, said to be no actions', () => {
  const { releases } = build().facts;
  assert.deepEqual(releases.tags, [{ repository: 'acme/app', tags: ['v1.0.0'] }]);
  assert.deepEqual(releases.changelog, [{ repository: 'acme/app', entries: [{ version: '1.0.0', date: '2026-03-04', breaking: true }] }]);
  assert.deepEqual(releases.github, [{ repository: 'acme/app', releases: [{ tag: 'v1.0.0', prerelease: false }] }]);
  assert.deepEqual(releases.production, { dates: ['2026-03-04', '2026-03-06'], count: 2 });
  const md = section(markdown(build()), '## Releases');
  assert.match(md, /^Team and repository facts, not the person's actions\.$/m);
  assert.match(md, /^\| acme\/app \| 1 \| v1\.0\.0 \|$/m);
  assert.match(md, /^\| acme\/app \| 1\.0\.0 \| 2026-03-04 \| breaking \|$/m);
  assert.match(md, /^Production releases by the user's rule: 2 — 2026-03-04, 2026-03-06\.$/m);
  assert.doesNotMatch(md, /v0\.9\.0/);
});

test('Decision chain: a code asked in the window, answered, its documents, commits, release, task keys and status changes — an ADR written after the window through the history', () => {
  const { chain } = build().facts;
  assert.deepEqual(chain.rows, [
    {
      code: 'D-ORDER', asked: '2026-03-02', answered: '2026-03-03', documents: [{ repository: 'acme/app', path: 'docs/adr/0008-first.md' }], commits: 1,
      released: { tag: 'v1.1.0', date: '2026-03-20' }, keys: ['PROJ-1'], statusChanges: [{ key: 'PROJ-1', changes: 1 }],
    },
    {
      code: 'D-SHAPE', asked: '2026-03-02', answered: '2026-03-03', documents: [{ repository: 'acme/app', path: 'docs/adr/0011-after.md' }], commits: 1,
      released: { tag: 'v1.2.0', date: '2026-03-18' }, keys: ['PROJ-2'], statusChanges: [{ key: 'PROJ-2', changes: 2 }],
    },
  ]);
  const md = section(markdown(build()), '## Decision chain');
  assert.match(md, /^\| D-SHAPE \| 2026-03-02 \| 2026-03-03 \| acme\/app \| docs\/adr\/0011-after\.md \| 1 \| v1\.2\.0 \(2026-03-18\) \| PROJ-2 \| PROJ-2 ×2 \|$/m);
  // Without the history only the window's own events link: the ADR after the window is not found.
  const own = buildReport(results(), { ...PERIOD }).facts.chain.rows;
  assert.deepEqual(own.map((r) => [r.code, r.documents.length, r.commits, r.released, r.keys]), [['D-ORDER', 1, 1, { tag: 'v1.1.0', date: '2026-03-20' }, ['PROJ-1']], ['D-SHAPE', 0, 0, null, []]]);
  assert.match(section(markdown(buildReport(results(), PERIOD)), '## Decision chain'), /^\| D-SHAPE \| 2026-03-02 \| 2026-03-03 \| — \| — \| — \| — \| — \| — \|$/m);
});

test('Decision chain: the same document path in two repositories gives two rows of the Repository column, in the order of the Documents column', () => {
  const asked = { ...final('2026-03-05T10:00:00Z', 's1', 10, { request: true, questions: 1, codes: ['D-TWIN'] }), source: 'sessions' };
  const twin = (repo) => ({ ...document('docs/adr/0001-twin.md', 'docs/adr', '2026-03-05T11:00:00Z', '2026-03-05', { repo, codes: ['D-TWIN'] }), id: `doc:${repo}`, source: 'git' });
  const { chain } = summarizeFacts([asked, twin('acme/app'), twin('acme/lib')], PERIOD);
  assert.deepEqual(chain.rows[0].documents.map((d) => [d.repository, d.path]), [['acme/app', 'docs/adr/0001-twin.md'], ['acme/lib', 'docs/adr/0001-twin.md']]);
  const md = section(markdown(buildReport([source('sessions', [asked]), source('git', [twin('acme/app'), twin('acme/lib')])], PERIOD)), '## Decision chain');
  assert.match(md, /^\| D-TWIN \| 2026-03-05 \| N \| acme\/app, acme\/lib \| docs\/adr\/0001-twin\.md, docs\/adr\/0001-twin\.md \|/m);
});

test('Decision chain: answered is the date of the next owner message, else Y when the final says so, else N', () => {
  const asked = (id, answered, codes) => ({ ...final('2026-03-05T10:00:00Z', id, 10, { request: true, questions: 1, codes, answered }), source: 'sessions' });
  const { chain } = summarizeFacts([asked('s1', true, ['Q-GONE']), asked('s2', false, ['Q-LATER'])], PERIOD);
  assert.deepEqual(chain.rows.map((r) => [r.code, r.answered]), [['Q-GONE', 'Y'], ['Q-LATER', 'N']]);
  const reply = { ...message('2026-03-05T12:00:00Z', 's2', 3), source: 'sessions' };
  const later = summarizeFacts([asked('s2', false, ['Q-LATER'])], { ...PERIOD, history: [asked('s2', false, ['Q-LATER']), reply] });
  assert.deepEqual(later.chain.rows.map((r) => [r.code, r.answered]), [['Q-LATER', '2026-03-05']]);
  assert.equal(summarizeFacts([{ ...final('2026-03-05T10:00:00Z', 's1', 10, { codes: ['D-X'] }), source: 'sessions' }], PERIOD).chain, null);
});

test('Uncommitted and first activity: shown whatever the window, uncommitted by modification date, the earliest first commit and pull request', () => {
  const { snapshot } = build({ since: '2026-03-02', until: '2026-03-08' }).facts;
  assert.deepEqual(snapshot.uncommitted, [{
    date: '2026-02-01', place: 'all', repository: 'acme/app', files: 2, untracked: 1,
    lines: { code: [10, 0], tests: [0, 0], docs: [5, 0], other: [0, 0] },
  }]);
  assert.deepEqual(snapshot.firstCommits, [{ repository: 'acme/app', date: '2025-06-01' }, { repository: 'acme/lib', date: '2025-01-10' }]);
  assert.deepEqual([snapshot.earliestCommit, snapshot.earliestPullRequest], [{ repository: 'acme/lib', date: '2025-01-10' }, { repository: 'acme/app', date: '2025-08-01' }]);
  const md = section(markdown(build()), '## Uncommitted and first activity');
  assert.match(md, /^Not yet committed — /m);
  assert.match(md, /^\| 2026-02-01 \| acme\/app \| 2 \| 1 \| \+10 −0 \| \+0 −0 \| \+5 −0 \| \+0 −0 \|$/m);
  assert.match(md, /^Earliest: 2025-01-10 \(acme\/lib\)\.$/m);
  assert.match(md, /^Earliest: 2025-08-01 \(acme\/app\)\.$/m);
  const elsewhere = buildReport(results(), { ...PERIOD, since: '2026-06-01', until: '2026-06-07' }).facts.snapshot;
  assert.equal(elsewhere.uncommitted.length, 1);
});

test('Team facts: the counting rule first, people and authors by name — never by count — members marked, no emails', () => {
  const { team } = build().facts;
  assert.equal(team.rule, 'members: ada@example.com');
  assert.deepEqual(team.projects, [{
    project: 'PROJ', lead: 'Bea', leadMember: true, versions: [{ version: '1.0', date: '2026-03-03' }],
    people: [{ name: 'Ada', member: true }, { name: 'Bob', member: false }, { name: 'Zed', member: false }],
  }]);
  assert.deepEqual(team.repositories, [{ repository: 'acme/app', authors: [{ name: 'Ada', member: true }, { name: 'Zed', member: false }] }]);
  const md = section(markdown(build()), '## Team facts');
  assert.match(md, /^Counting rule \(the user's\): members: ada@example\.com$/m);
  assert.match(md, /^\| PROJ \| Bea \(member\) \| 1\.0 \(2026-03-03\) \| Ada \(member\), Bob, Zed \|$/m);
  assert.match(md, /^\| acme\/app \| Ada \(member\), Zed \|$/m);
  assert.doesNotMatch(md, /zed@example\.com|\b50\b/);
  assert.match(section(markdown(build({ factSettings: {} })), '## Team facts'), /^No counting rule given: the people listed are those seen in the period, not a team\.$/m);
});

test('renderMarkdown: the sections follow What changed in order, with no path, remote or message text in them', () => {
  const md = markdown(build());
  const at = (heading) => md.indexOf(`\n${heading}\n`);
  const order = ['## What changed', '## Sessions', '## Meaning of changes', '## Decisions', '## Releases', '## Decision chain', '## Uncommitted and first activity', '## Team facts', '## By day'];
  assert.ok(order.every((h) => at(h) >= 0), 'every section is there');
  assert.deepEqual(order.map(at), [...order.map(at)].sort((a, b) => a - b));
  assert.ok(!md.includes('/src/app') && !md.includes('git@example.com'), 'no path or remote');
});

test('summarizeFacts: a section with nothing to show is null, and its markdown is empty; the data is JSON-safe', () => {
  const none = summarizeFacts([], PERIOD);
  assert.deepEqual(none, { sessions: null, meaning: null, decisions: null, releases: null, chain: null, snapshot: null, team: null });
  assert.deepEqual(renderFacts(none), []);
  assert.deepEqual(renderFacts(undefined), []);
  const { facts } = build();
  assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts);
  const md = markdown(buildReport([source('git', [event('commit', '2026-03-02T12:00:00Z', {}, { lines: lines([1, 0]) })])], PERIOD));
  assert.doesNotMatch(md, /^## (Sessions|Decisions|Releases|Decision chain|Team facts)$/m);
});
