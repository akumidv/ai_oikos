// The footprint's store and its commands (ADR 0008 D01): saveCrawl's replace rule (an overlapping
// re-crawl replaces inside the crawled period and by id, keeps what is outside, replaces snapshots),
// hours as events and back, a bad line skipped, the dates no crawl covered, totals counted from
// events; the settings the new sources read (places.mjs); and the CLI in a temporary installation:
// `collect` saving into the store (and `--no-save` not), `slice` reporting several windows from it,
// `--out`, an empty store, `sessions` without --me, the default sources, `sources` rows. Nothing
// reaches a network and nothing depends on the machine's time zone or git configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitEnvironment } from '../tools/common/gitwiki.mjs';
import { buildReport } from '../tools/footprint/report.mjs';
import { coverage, crawledMatchKeys, eventId, eventInPeriod, legacyNote, loadStore, partialNotes, recrawlNotes, replaceCrawled, saveCrawl, totalsFromEvents } from '../tools/footprint/store.mjs';
import { cleanEnv, installation, script, tempDir, tool } from './helpers/installation.mjs';

const PERIOD = { since: '2026-03-01', until: '2026-03-03', tz: 'UTC', dayStartsMin: 0 };
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ids = (events) => events.map((e) => e.id).sort();

// == the store ==

test('store: a re-crawl replaces inside its period and by id, keeps what is outside, replaces snapshots', () => {
  const dir = join(tempDir('store-'), 'ada');
  const early = { since: '2026-02-20', until: '2026-02-25', tz: 'UTC', dayStartsMin: 0 };
  saveCrawl(dir, [{ source: 'git', events: [{ id: 'e0', at: '2026-02-21T10:00:00Z', kind: 'commit', what: 'early' }] }], early);
  saveCrawl(dir, [{
    source: 'git',
    events: [
      { id: 'a', at: '2026-03-01T10:00:00Z', kind: 'commit', what: 'a' },
      { id: 'b', at: '2026-03-02T10:00:00Z', kind: 'commit', what: 'b old' },
      { id: 'd', at: '2026-03-03T10:00:00Z', kind: 'commit', what: 'd, not seen again' },
      { id: 'snap', at: '2026-03-01T09:00:00Z', kind: 'uncommitted', action: false, snapshot: true, what: 'old snapshot' },
    ],
  }], PERIOD);
  // Second crawl, 03-02 … 03-05: b is replaced by id, d lies inside and is gone, a lies before it and stays,
  // the old snapshot goes whole; an event with no id keeps one derived from its content.
  const later = { since: '2026-03-02', until: '2026-03-05', tz: 'UTC', dayStartsMin: 0 };
  const noId = { at: '2026-03-04T08:00:00Z', kind: 'commit', what: 'c' };
  saveCrawl(dir, [{
    source: 'git',
    events: [
      { id: 'b', at: '2026-03-02T10:00:00Z', kind: 'commit', what: 'b new' },
      noId,
      { id: 'snap2', at: '2026-03-05T09:00:00Z', kind: 'uncommitted', action: false, snapshot: true, what: 'new snapshot' },
    ],
  }], later);
  const git = loadStore(dir).events.get('git');
  assert.deepEqual(ids(git), ['a', 'b', 'e0', 'snap2', eventId('git', noId)].sort());
  assert.equal(git.find((e) => e.id === 'b').what, 'b new');
  assert.ok(git.every((e) => e.source === 'git'));
  // The same period crawled again with the one event: b (inside the period, not seen) and the snapshot are gone, the event stays once.
  saveCrawl(dir, [{ source: 'git', events: [noId] }], later);
  assert.deepEqual(ids(loadStore(dir).events.get('git')), ['a', 'e0', eventId('git', noId)].sort());
  assert.equal(loadStore(dir).crawls.length, 4);
});

test('store: a partial crawl is merged by id — nothing earlier is dropped, snapshots included — and its row records the reasons', () => {
  const dir = join(tempDir('store-'), 'ada');
  const first = [
    { id: 'a', at: '2026-03-01T10:00:00Z', kind: 'commit', what: 'a' },
    { id: 'b', at: '2026-03-02T10:00:00Z', kind: 'commit', what: 'b old' },
    { id: 'snap', at: '2026-03-01T09:00:00Z', kind: 'uncommitted', action: false, snapshot: true, what: 'old snapshot' },
  ];
  saveCrawl(dir, [{ source: 'git', events: first }], PERIOD);
  const reasons = ['2 repositories failed', 'a cut'];
  saveCrawl(dir, [{ source: 'git', partial: true, partialReasons: reasons, events: [{ id: 'b', at: '2026-03-02T10:00:00Z', kind: 'commit', what: 'b new' }] }], PERIOD);
  const git = loadStore(dir).events.get('git');
  assert.deepEqual(ids(git), ['a', 'b', 'snap']);
  assert.equal(git.find((e) => e.id === 'b').what, 'b new');
  const [plain, partial] = lines(join(dir, 'crawls.jsonl'));
  assert.equal(plain.partial, undefined);
  assert.deepEqual([partial.partial, partial.partialReasons], [true, reasons]);
  // A complete crawl after it replaces the period again.
  saveCrawl(dir, [{ source: 'git', events: [] }], PERIOD);
  assert.deepEqual(ids(loadStore(dir).events.get('git')), []);
  assert.deepEqual(partialNotes([{ source: 'git', partial: true, partialReasons: reasons }, { source: 'jira' }, { source: 'github', partial: true, skipped: 'x' }]),
    [{ source: 'git', note: 'git: partial crawl (2 repositories failed; a cut) — merged by id: same-id events replaced, nothing else dropped' }]);
});

test('store: under filesRead a stored session event without detail.file is replaced by the period rule and counted as legacy', () => {
  const dir = join(tempDir('store-'), 'ada');
  const old = (id, at = '2026-03-02T10:00:00Z') => ({ id, at, kind: 'message', what: 'x', detail: { host: 'claude', session: id, words: 3 } });
  const filed = { id: 'f1', at: '2026-03-02T11:00:00Z', kind: 'message', what: 'x', detail: { host: 'claude', session: 'f1', file: 'claude:p/gone.jsonl', words: 3 } };
  saveCrawl(dir, [{ source: 'sessions', events: [old('l1'), old('l0', '2026-02-10T10:00:00Z'), filed] }], { ...PERIOD, since: '2026-02-01' });
  const stored = loadStore(dir).events.get('sessions');
  const result = { source: 'sessions', filesRead: ['claude:p/a.jsonl'], events: [] };
  const out = replaceCrawled(stored, result, PERIOD);
  assert.deepEqual(ids(out.events).sort(), ['f1', 'l0']);
  assert.equal(out.legacy, 1);
  // A partial crawl drops nothing, so it replaces no legacy event.
  assert.equal(replaceCrawled(stored, { ...result, partial: true }, PERIOD).legacy, 0);
  assert.equal(legacyNote(1), '1 stored event saved without a transcript file replaced by the crawled period');
  const saved = saveCrawl(dir, [result], PERIOD);
  assert.deepEqual(saved, [{ source: 'sessions', events: 0, legacy: 1 }]);
  assert.deepEqual(ids(loadStore(dir).events.get('sessions')).sort(), ['f1', 'l0']);
});

test('store: a result that names the files it read replaces only those files\' events in the period — a deleted transcript keeps its events, a file read without events clears its own', () => {
  const dir = join(tempDir('store-'), 'ada');
  const message = (id, file, at = '2026-03-02T10:00:00Z') => ({ id, at, kind: 'message', what: 'x', detail: { host: 'claude', session: id, file, words: 3 } });
  saveCrawl(dir, [{ source: 'sessions', filesRead: ['claude:p/a.jsonl', 'claude:p/b.jsonl', 'claude:p/gone.jsonl'], events: [
    message('a1', 'claude:p/a.jsonl'), message('b1', 'claude:p/b.jsonl'), message('g1', 'claude:p/gone.jsonl'),
    message('a0', 'claude:p/a.jsonl', '2026-02-10T10:00:00Z'), // before the period of the next crawl
  ] }], { ...PERIOD, since: '2026-02-01' });
  // Next crawl: a.jsonl re-read with a changed event, b.jsonl re-read with nothing in the period, gone.jsonl no longer exists.
  saveCrawl(dir, [{ source: 'sessions', filesRead: ['claude:p/a.jsonl', 'claude:p/b.jsonl'], events: [message('a2', 'claude:p/a.jsonl', '2026-03-03T10:00:00Z')] }], PERIOD);
  assert.deepEqual(ids(loadStore(dir).events.get('sessions')), ['a0', 'a2', 'g1']);
  // The same through replaceCrawled (what a run that does not save reads).
  const stored = loadStore(dir).events.get('sessions');
  assert.deepEqual(ids(replaceCrawled(stored, { source: 'sessions', filesRead: ['claude:p/gone.jsonl'], events: [] }, PERIOD).events), ['a0', 'a2']);
  // No filesRead: the period rule as before.
  assert.deepEqual(ids(replaceCrawled(stored, { source: 'sessions', events: [] }, PERIOD).events), ['a0']);
  // A partial sessions crawl merges by id even though it names files.
  assert.deepEqual(ids(replaceCrawled(stored, { source: 'sessions', partial: true, filesRead: ['claude:p/a.jsonl'], events: [] }, PERIOD).events), ['a0', 'a2', 'g1']);
});

test('store: the day decides, not an hour of slack — an event just before the period is kept, one just after is kept', () => {
  const dir = join(tempDir('store-'), 'ada');
  const period = { since: '2026-03-02', until: '2026-03-02', tz: 'UTC', dayStartsMin: 0 };
  saveCrawl(dir, [{
    source: 'git',
    events: [
      { id: 'before', at: '2026-03-01T23:30:00Z', kind: 'commit', what: 'before' },
      { id: 'in', at: '2026-03-02T12:00:00Z', kind: 'commit', what: 'in' },
      { id: 'after', at: '2026-03-03T00:30:00Z', kind: 'commit', what: 'after' },
    ],
  }], { since: '2026-03-01', until: '2026-03-03', tz: 'UTC', dayStartsMin: 0 });
  saveCrawl(dir, [{ source: 'git', events: [] }], period);
  assert.deepEqual(ids(loadStore(dir).events.get('git')), ['after', 'before']);
});

test('store: a source\'s hours are saved as hours events and read back; a re-crawl replaces them', () => {
  const dir = join(tempDir('store-'), 'ada');
  saveCrawl(dir, [{ source: 'jira', events: [], hours: new Map([['2026-03-01', 7.5], ['2026-03-02', 4]]) }], PERIOD);
  const [first, second] = loadStore(dir).events.get('jira');
  assert.deepEqual(first, { kind: 'hours', date: '2026-03-01', action: false, detail: { hours: 7.5 }, id: 'hours:2026-03-01', source: 'jira' });
  assert.equal(second.detail.hours, 4);
  saveCrawl(dir, [{ source: 'jira', events: [], hours: new Map([['2026-03-02', 6]]) }], PERIOD);
  assert.deepEqual(loadStore(dir).events.get('jira').map((e) => [e.date, e.detail.hours]), [['2026-03-02', 6]]);
});

test('store: a skipped source is recorded and changes no event; a bad line is skipped and counted; a missing folder is empty', () => {
  const dir = join(tempDir('store-'), 'ada');
  saveCrawl(dir, [{ source: 'git', events: [{ id: 'a', at: '2026-03-01T10:00:00Z', kind: 'commit', what: 'a' }] }], PERIOD);
  saveCrawl(dir, [{ source: 'git', skipped: 'no repository' }], PERIOD);
  assert.deepEqual(ids(loadStore(dir).events.get('git')), ['a']);
  const crawls = lines(join(dir, 'crawls.jsonl'));
  assert.deepEqual(crawls.map((c) => [c.source, c.events, c.skipped ?? null]), [['git', 1, null], ['git', 0, 'no repository']]);
  assert.deepEqual([crawls[0].since, crawls[0].until, crawls[0].tz, crawls[0].dayStarts], ['2026-03-01', '2026-03-03', 'UTC', 0]);
  assert.match(crawls[0].at, /^\d{4}-\d\d-\d\dT/);
  appendFileSync(join(dir, 'git.jsonl'), 'not json\n[1]\n');
  const store = loadStore(dir);
  assert.equal(store.bad, 2);
  assert.equal(store.events.get('git').length, 1);
  const none = loadStore(join(tempDir('store-'), 'nobody'));
  assert.deepEqual([none.events.size, none.crawls, none.bad], [0, [], 0]);
});

test('store: no temporary file is left behind a save', () => {
  const dir = join(tempDir('store-'), 'ada');
  saveCrawl(dir, [{ source: 'git', events: [{ id: 'a', at: '2026-03-01T10:00:00Z', kind: 'commit', what: 'a' }] }], PERIOD);
  const r = spawnSync('ls', [dir], { encoding: 'utf8' });
  assert.deepEqual(r.stdout.split('\n').filter(Boolean).sort(), ['crawls.jsonl', 'git.jsonl']);
});

test('store: eventId is the given id, else a stable digest of the content that ignores key order and source', () => {
  assert.equal(eventId('git', { id: 'abc', what: 'x' }), 'abc');
  const a = eventId('git', { at: '2026-03-01T10:00:00Z', kind: 'commit', detail: { b: 1, a: [1, { y: 1, x: 2 }] } });
  const b = eventId('git', { detail: { a: [1, { x: 2, y: 1 }], b: 1 }, kind: 'commit', at: '2026-03-01T10:00:00Z', source: 'git' });
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, eventId('github', { at: '2026-03-01T10:00:00Z', kind: 'commit', detail: { b: 1, a: [1, { y: 1, x: 2 }] } }));
});

test('store: coverage names the dates of the window no (non-skipped) crawl of the source covered', () => {
  const crawls = [
    { source: 'git', since: '2026-03-01', until: '2026-03-03' },
    { source: 'git', since: '2026-03-05', until: '2026-03-06' },
    { source: 'git', since: '2026-03-04', until: '2026-03-04', skipped: 'no repository' },
    { source: 'jira', since: '2026-03-01', until: '2026-03-07' },
  ];
  assert.deepEqual(coverage(crawls, 'git', '2026-03-01', '2026-03-07'), ['2026-03-04', '2026-03-07']);
  assert.deepEqual(coverage(crawls, 'jira', '2026-03-02', '2026-03-03'), []);
  assert.deepEqual(coverage(crawls, 'github', '2026-03-02', '2026-03-03'), ['2026-03-02', '2026-03-03']);
});

test('store: a decision document belongs to a period when its add instant, added date or decided date lies in it — slice keeps it, a re-crawl replaces it', () => {
  const adr = (id, at, added, decided) => ({ id, at, kind: 'decision document', action: false, detail: { added, decided } });
  const decidedInside = adr('late', '2026-02-10T09:00:00Z', '2026-02-10', '2026-03-02');
  const addedInside = adr('early', '2026-03-02T09:00:00Z', '2026-03-02', '2026-03-02');
  const outside = adr('old', '2026-02-10T09:00:00Z', '2026-02-10', '2026-02-12');
  const instantDecided = adr('instant', '2026-02-10T09:00:00Z', '2026-02-10', '2026-03-03T10:00:00Z');
  assert.deepEqual([decidedInside, addedInside, outside, instantDecided].map((e) => eventInPeriod(e, PERIOD)), [true, true, false, true]);
  // Only a decision document reads the two fields: a commit with the same detail is by its instant.
  assert.equal(eventInPeriod({ ...decidedInside, kind: 'commit' }, PERIOD), false);
  // A re-crawl of the period replaces what the earlier crawl stored for it, a document decided there included.
  const dir = join(tempDir('store-'), 'ada');
  saveCrawl(dir, [{ source: 'git', events: [decidedInside, outside] }], { since: '2026-02-01', until: '2026-03-03', tz: 'UTC', dayStartsMin: 0 });
  saveCrawl(dir, [{ source: 'git', events: [addedInside] }], PERIOD);
  assert.deepEqual(ids(loadStore(dir).events.get('git')), ['early', 'old']);
});

test('store: facts with action false — first commit, uncommitted, tag, changelog entry, decision document — are no action in the totals, only "(fact)" rows', () => {
  const events = [
    { kind: 'commit', at: '2026-03-02T10:00:00Z', lines: { code: [3, 0], tests: [0, 0], docs: [0, 0], other: [0, 0] }, detail: { testsAdded: 1 } },
    { kind: 'first commit', at: '2026-03-02T09:00:00Z', action: false, snapshot: true, detail: { hash: 'abc' } },
    { kind: 'uncommitted', at: '2026-03-02T11:00:00Z', action: false, snapshot: true, lines: { code: [50, 0], tests: [0, 0], docs: [0, 0], other: [0, 0] } },
    { kind: 'tag', at: '2026-03-02T12:00:00Z', action: false },
    { kind: 'changelog entry', date: '2026-03-02', action: false },
    { kind: 'decision document', at: '2026-03-02T13:00:00Z', action: false, detail: { added: '2026-03-02', decided: '2026-03-02' } },
  ];
  assert.deepEqual(totalsFromEvents('git', events), [
    ['commit', 1],
    ['code lines', '+3 −0'], ['tests lines', '+0 −0'], ['docs lines', '+0 −0'], ['other lines', '+0 −0'], ['tests added', 1],
    ['first commit (fact)', 1], ['uncommitted (fact)', 1], ['tag (fact)', 1], ['changelog entry (fact)', 1], ['decision document (fact)', 1],
  ]);
  // Saving them leaves the crawl's coverage to the crawl lines, never to an event.
  const dir = join(tempDir('store-'), 'ada');
  saveCrawl(dir, [{ source: 'git', events }], { since: '2026-03-02', until: '2026-03-02', tz: 'UTC', dayStartsMin: 0 });
  const { crawls } = loadStore(dir);
  assert.deepEqual(coverage(crawls, 'git', '2026-03-01', '2026-03-03'), ['2026-03-01', '2026-03-03']);
});

test('store: a crawl records its scope, and a later crawl over an overlap with another --repos or identity is told it replaces that crawl\'s events', () => {
  const dir = join(tempDir('store-'), 'ada');
  const scope = (repos, identity) => ({ git: { repos, identity }, jira: { repos: null, identity: 'acct-1' } });
  const result = (source) => ({ source, events: [] });
  const first = scope(['/src/app', '/src/lib'], 'ada@example.com');
  saveCrawl(dir, [result('git'), result('jira')], PERIOD, first);
  const [gitRow, jiraRow] = lines(join(dir, 'crawls.jsonl'));
  assert.deepEqual([gitRow.repos, gitRow.identity, jiraRow.repos, jiraRow.identity], [['/src/app', '/src/lib'], 'ada@example.com', null, 'acct-1']);
  const { crawls } = loadStore(dir);
  const later = { since: '2026-03-02', until: '2026-03-06' };
  // The same scope (in another order), or no overlap: nothing to say.
  assert.deepEqual(recrawlNotes(crawls, [result('git'), result('jira')], later, scope(['/src/lib', '/src/app'], 'ada@example.com')), []);
  assert.deepEqual(recrawlNotes(crawls, [result('git')], { since: '2026-03-04', until: '2026-03-06' }, scope(['/src/app'], 'other@example.com')), []);
  // Other repositories, or another identity, over the overlap 03-02 … 03-03.
  const [repos] = recrawlNotes(crawls, [result('git')], later, scope(['/src/app'], 'ada@example.com'));
  assert.equal(repos.source, 'git');
  assert.match(repos.note, /^git: the earlier crawl of 2026-03-01 … 2026-03-03 \(saved .*\) used a different --repos; this crawl replaces its stored git events of 2026-03-02 … 2026-03-03$/);
  const [both] = recrawlNotes(crawls, [result('git')], later, scope(['/src/app'], 'bea@example.com'));
  assert.match(both.note, /a different --repos and identity;/);
  assert.match(recrawlNotes(crawls, [result('jira')], later, { jira: { repos: null, identity: 'acct-2' } })[0].note, /a different identity;/);
  // A skipped source, a source without a scope, and an earlier crawl that recorded none are not compared.
  assert.deepEqual(recrawlNotes(crawls, [{ source: 'git', skipped: 'x' }], later, scope([], 'z')), []);
  assert.deepEqual(recrawlNotes(crawls, [result('github')], later, scope([], 'z')), []);
  assert.deepEqual(recrawlNotes([{ source: 'git', since: '2026-03-01', until: '2026-03-03', at: 'x' }], [result('git')], later, scope([], 'z')), []);
});

test('store: totalsFromEvents counts by kind, git lines by kind and tests, session words; facts apart', () => {
  const events = [
    { kind: 'commit', lines: { code: [3, 1], tests: [2, 0], docs: [0, 0], other: [1, 1] }, detail: { testsAdded: 2 } },
    { kind: 'commit', lines: { code: [4, 0], tests: [0, 0], docs: [5, 2], other: [0, 0] }, detail: { testsAdded: 0 } },
    { kind: 'commit' }, // a pipeline repository's commit: no lines
    { kind: 'message', detail: { words: 10 } },
    { kind: 'message', detail: { words: 5 } },
    { kind: 'final', action: false, detail: { words: 40 } },
    { kind: 'tag', action: false },
    { kind: 'hours', date: '2026-03-01', action: false, detail: { hours: 7 } },
  ];
  assert.deepEqual(totalsFromEvents('git', events), [
    ['commit', 3], ['message', 2],
    ['code lines', '+7 −1'], ['tests lines', '+2 −0'], ['docs lines', '+5 −2'], ['other lines', '+1 −1'], ['tests added', 2],
    ['owner words', 15], ['final words', 40],
    ['final (fact)', 1], ['tag (fact)', 1],
  ]);
  assert.deepEqual(totalsFromEvents('git', []), []);
});

test('store: a code host\'s slice has no line or tests rows — its commits carry no lines — but the reviewed lines its review events carry', () => {
  const commits = [{ kind: 'commit', what: 'acme/app#1' }, { kind: 'commit', what: 'acme/app#2' }];
  assert.deepEqual(totalsFromEvents('github', commits), [['commit', 2]]);
  const events = [
    ...commits,
    { kind: 'pr opened', what: 'acme/app#1' },
    { kind: 'review', what: 'acme/app#3', others: true, reviewed: [10, 4] },
    { kind: 'review', what: 'acme/app#3', others: true, reviewed: [10, 4] },
    { kind: 'review comment', what: 'acme/app#5', others: true },
  ];
  assert.deepEqual(totalsFromEvents('github', events), [
    ['commit', 2], ['pr opened', 1], ['review', 2], ['review comment', 1], ['reviewed lines (their lines, per pull request and day)', '+20 −8'],
  ]);
  // Git commits that carry lines still give the rows.
  assert.ok(totalsFromEvents('git', [{ kind: 'commit', lines: { code: [1, 0] } }]).some(([row]) => row === 'tests added'));
});

test('store: the words rows of a slice carry the names the sessions source\'s totals give (owner words, final words)', async () => {
  const { collectSessions } = await import('../tools/footprint/sources/sessions.mjs');
  const empty = tempDir('sessions-');
  const result = await collectSessions(
    { hosts: { claude: empty, qwen: false, codex: false }, since: '2026-03-01', until: '2026-03-02', tz: 'UTC' },
    { env: {}, home: empty },
  );
  const collectNames = result.totals.map(([row]) => row);
  const sliceNames = totalsFromEvents('sessions', [
    { kind: 'message', detail: { words: 3 } }, { kind: 'final', action: false, detail: { words: 4 } },
  ]).filter(([row]) => /words/.test(row)).map(([row]) => row);
  assert.deepEqual(sliceNames, ['owner words', 'final words']);
  for (const name of sliceNames) assert.ok(collectNames.includes(name), `${name} is a row of the sessions totals`);
});

// == a code host's copy of a commit, in a slice as in collect ==

test('store: a crawl row records git\'s remotes and a code host\'s site, and crawledMatchKeys reads them back as the union over the source\'s crawls', () => {
  const dir = join(tempDir('store-'), 'ada');
  const git = (remotes) => ({ source: 'git', events: [], remotes });
  saveCrawl(dir, [git(['github.com/acme/app']), { source: 'github', events: [], site: 'https://github.com' }, { source: 'jira', events: [] }], PERIOD);
  saveCrawl(dir, [git(['gitlab.example.com/acme/api', 'github.com/acme/app']), { source: 'github', events: [], site: 'https://ghe.example.com' },
    { source: 'gitlab', skipped: 'no token', site: 'https://x.example.com' }], PERIOD);
  const [first, , jiraRow] = lines(join(dir, 'crawls.jsonl'));
  assert.deepEqual(first.remotes, ['github.com/acme/app']);
  assert.equal(jiraRow.remotes, undefined);
  assert.equal(jiraRow.site, undefined);
  const { crawls } = loadStore(dir);
  assert.deepEqual(crawledMatchKeys(crawls, 'git'), { remotes: ['github.com/acme/app', 'gitlab.example.com/acme/api'], sites: [] });
  assert.deepEqual(crawledMatchKeys(crawls, 'github'), { remotes: [], sites: ['https://ghe.example.com', 'https://github.com'] });
  // A skipped crawl read nothing, a source with no crawl and an older row without the keys add nothing.
  assert.deepEqual(crawledMatchKeys(crawls, 'gitlab'), { remotes: [], sites: [] });
  assert.deepEqual(crawledMatchKeys([{ source: 'git', since: 'a', until: 'b' }], 'git'), { remotes: [], sites: [] });
});

test('slice: a window where git and the code hosts ran counts a pushed commit once — the same actions, days, first and last action as collect', () => {
  const dir = installation((t) => t);
  const store = join(dir, '.local', 'footprint', 'events', 'ada');
  const window = { since: '2026-03-02', until: '2026-03-08', tz: 'UTC', dayStartsMin: 0 };
  const results = [
    { source: 'git', label: 'git', totals: [], notes: [], remotes: ['github.com/acme/app', 'gitlab.example.com/acme/api'], events: [
      { id: 'h1', at: '2026-03-02T10:00:00Z', kind: 'commit', what: 'app: Add', where: '/src/app git@github.com:acme/app.git' },
      { id: 'h2', at: '2026-03-04T09:00:00Z', kind: 'commit', what: 'api: Fix', where: '/src/api' },
    ] },
    { source: 'github', label: 'GitHub', site: 'https://github.com', totals: [], notes: [], events: [
      { id: 'g1', at: '2026-03-02T07:00:00Z', kind: 'commit', what: 'acme/app#1', where: 'acme/app', pr: 'u1' },
      { id: 'g2', at: '2026-03-03T06:00:00Z', kind: 'commit', what: 'acme/other#2', where: 'acme/other', pr: 'u2' },
    ] },
    { source: 'gitlab', label: 'GitLab', site: 'https://gitlab.example.com/', totals: [], notes: [], events: [
      { id: 'p1', at: '2026-03-04T09:05:00Z', kind: 'push', what: 'acme/api', where: 'acme/api' },
    ] },
  ];
  saveCrawl(store, results, window);
  const collected = buildReport(results, { ...window, today: '2026-03-09' });
  const sliced = JSON.parse(footprint(dir, ['slice', '--window', '2026-03-02', '--until', '2026-03-08', '--tz', 'UTC', '--json']).stdout)[0];
  const shape = (r) => ({
    actions: r.all.actions, activeDays: r.activeDays, days: r.days.map((d) => [d.date, d.first, d.last, d.bySource]),
    calendar: r.all.days.map((d) => [d.date, d.actions]),
  });
  // Two commits in git and one commit of a repository git did not read (g2): the copies g1 and p1 are no action.
  assert.equal(collected.all.actions, 3);
  assert.deepEqual(shape(sliced), shape(collected));
  const slicedGithub = sliced.sources.find((s) => s.source === 'github');
  assert.match(slicedGithub.notes.join('\n'), /^1 commit event\(s\) left out of the actions/m);
});

// == places: the settings the new sources read ==

/** `footprintSettings({ file })` run in the installation `dir` for each text of a settings file: what it gave, or its error. */
function settingsOf(dir, texts) {
  const places = pathToFileURL(join(dir, 'oikos', 'tools', 'footprint', 'places.mjs')).href;
  const files = texts.map((text, i) => {
    const file = join(dir, `settings-${i}.yaml`);
    writeFileSync(file, text);
    return file;
  });
  const code = `import { footprintSettings } from ${JSON.stringify(places)};
    const out = ${JSON.stringify(files)}.map((file) => {
      try {
        const s = footprintSettings({ file });
        return { sessions: s.sessions, headings: [s.decisionHeadings.source, s.decisionHeadings.flags],
          codes: [s.decisionCodes.source, s.decisionCodes.flags], reading: s.readingReference, dirs: s.decisionDirs,
          releases: s.releases, team: s.team, skipPrompts: s.sessionsSkipPrompts.map((r) => [r.source, r.flags]), heading: s.decisionHeadings.test('## Нужно от вас'), code: 'see D-ORDER and Q-C1-X'.match(s.decisionCodes) };
      } catch (e) { return { error: e.message }; }
    });
    console.log(JSON.stringify(out));`;
  const r = script(dir, code, { HOME: '/home/ada' });
  assert.equal(r.status, 0, r.output);
  return JSON.parse(r.stdout);
}

test('places: the defaults, then every new key parsed', () => {
  const dir = installation((t) => t);
  const [none, all] = settingsOf(dir, ['default_place: Elsewhere\n', [
    'sessions: { claude: ~/.claude-work/projects, qwen: false, codex: /data/codex }',
    'decision_headings: ["Needed from you", "Нужно от вас"]',
    'decision_codes: "\\\\bK-\\\\d+\\\\b"',
    'reading_reference: { label: a long novel, words: 580000 }',
    'decision_dirs: [docs/adr/, notes]',
    'releases: { rule: merge-days, repos: [acme/app, acme/api] }',
    'team: { members: [ada@example.com, Grace Hopper], projects: [PROJ] }',
    'sessions_skip_prompts: ["^Run the digest", "\\\\[automated\\\\]"]', '',
  ].join('\n')]);
  assert.deepEqual(none.sessions, { claude: null, qwen: null, codex: null });
  assert.equal(none.heading, true);
  assert.deepEqual(none.codes, ['\\b[DQ]-[A-Z0-9]+(?:-[A-Z0-9]+)*\\b', 'g']);
  assert.deepEqual(none.code, ['D-ORDER', 'Q-C1-X']);
  assert.equal(none.reading, null);
  assert.deepEqual(none.dirs, ['docs/adr', 'docs/design', 'docs/measurements', 'docs/reviews']);
  assert.equal(none.releases, null);
  assert.deepEqual(none.team, { members: [], projects: [] });
  assert.deepEqual(none.skipPrompts, []); // the core names no machine prompt
  assert.deepEqual(all.sessions, { claude: '/home/ada/.claude-work/projects', qwen: false, codex: '/data/codex' });
  assert.equal(all.heading, true);
  assert.deepEqual(all.codes, ['\\bK-\\d+\\b', 'g']);
  assert.deepEqual(all.reading, { label: 'a long novel', words: 580000 });
  assert.deepEqual(all.dirs, ['docs/adr', 'notes']);
  assert.deepEqual(all.releases, { rule: 'merge-days', base: 'main', repos: ['acme/app', 'acme/api'] });
  assert.deepEqual(all.team, { members: ['ada@example.com', 'Grace Hopper'], projects: ['PROJ'] });
  assert.deepEqual(all.skipPrompts, [['^Run the digest', ''], ['\\[automated\\]', '']]);
});

test('places: a bad value is a usage error naming the key', () => {
  const dir = installation((t) => t);
  const cases = [
    ['sessions: { gemini: /x }', /sessions takes claude, qwen, codex; got: gemini/],
    ['sessions: { claude: true }', /sessions\.claude takes a folder or false/],
    ['sessions: [claude]', /sessions must be a mapping/],
    ['decision_codes: "("', /decision_codes \( is not a regular expression/],
    ['decision_headings: []', /decision_headings must name at least one heading/],
    ['reading_reference: { label: novel, words: 0 }', /reading_reference takes \{ label: <text>, words: <a positive number> \}/],
    ['reading_reference: { words: 5 }', /reading_reference takes/],
    ['releases: { rule: weekly, repos: [a/b] }', /releases takes \{ rule: merge-days/],
    ['releases: { rule: merge-days, repos: [] }', /releases takes/],
    ['team: [ada]', /team takes \{ members/],
    ['sessions_skip_prompts: ["^ok", "("]', /sessions_skip_prompts pattern \( is not a regular expression/],
  ];
  const got = settingsOf(dir, cases.map(([text]) => `${text}\n`));
  cases.forEach(([text, pattern], i) => assert.match(got[i].error ?? '(no error)', pattern, text));
});

// == the commands ==

const GIT_ENV = gitEnvironment(null, cleanEnv());
const EMPTY_GIT_CONFIG = join(tempDir('gitconfig-'), 'config');
writeFileSync(EMPTY_GIT_CONFIG, '');
const GIT_RUN = { TZ: 'UTC', GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };
const ADA = 'ada@acme.example';

/** A repository at `dir` with Ada's commits on 2026-03-02 10:00 and 2026-03-03 23:30 (UTC). */
function repoWithTwoCommits(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (args, extra = {}) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...GIT_RUN, ...extra } });
    assert.equal(r.status, 0, r.stderr);
  };
  const commit = (at, file, text) => {
    writeFileSync(join(dir, file), text);
    git(['add', '--', file]);
    git(['commit', '-q', '-m', `change ${file}`], {
      GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: ADA, GIT_AUTHOR_DATE: at, GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: ADA, GIT_COMMITTER_DATE: at,
    });
  };
  git(['init', '-q', '-b', 'main']);
  commit('2026-03-02T10:00:00+00:00', 'one.js', 'a\nb\n');
  commit('2026-03-03T23:30:00+00:00', 'two.js', 'c\n');
  return dir;
}

const footprint = (dir, args, env = {}) => tool(dir, 'footprint', args, { ...GIT_RUN, ...env });
const collectGitArgs = (work, extra = []) => ['collect', '--since', '2026-03-01', '--until', '2026-03-07', '--tz', 'UTC', '--email', ADA,
  '--repos', work, '--source', 'git', '--person', 'Ada', ...extra];
/** A row of the git totals: `commits` as collect counts them, `commit` as slice counts events. */
const totalOf = (report, row) => Object.fromEntries(report.sources.find((s) => s.source === 'git').totals)[row];
const commitsOf = (report) => totalOf(report, 'commit');

test('collect saves the events into the store, --no-save does not; slice reports each window from the store', () => {
  const dir = installation((t) => t);
  const work = repoWithTwoCommits(tempDir('work-'));
  const store = join(dir, '.local', 'footprint', 'events', 'ada');
  const unsaved = footprint(dir, collectGitArgs(work, ['--no-save', '--json']));
  assert.equal(unsaved.status, 0, unsaved.output);
  assert.equal(existsSync(join(dir, '.local', 'footprint', 'events')), false);
  const saved = footprint(dir, collectGitArgs(work, ['--json']));
  assert.equal(saved.status, 0, saved.output);
  assert.equal(totalOf(JSON.parse(saved.stdout), 'commits'), 2);
  assert.equal(lines(join(store, 'git.jsonl')).filter((e) => e.kind === 'commit').length, 2);
  const [crawl] = lines(join(store, 'crawls.jsonl'));
  assert.deepEqual([crawl.source, crawl.since, crawl.until, crawl.tz], ['git', '2026-03-01', '2026-03-07', 'UTC']);

  // Two windows ending 03-04: the last 2 days hold one commit, from 03-01 both; the third starts before the crawl.
  const r = footprint(dir, ['slice', '--window', '2', '--window', '2026-03-01', '--window', '2026-02-27', '--until', '2026-03-04', '--tz', 'UTC', '--json']);
  assert.equal(r.status, 0, r.output);
  const [last2, fromFirst, fromEarlier] = JSON.parse(r.stdout);
  assert.deepEqual([last2.since, last2.until], ['2026-03-03', '2026-03-04']);
  assert.deepEqual([fromFirst.since, fromFirst.until], ['2026-03-01', '2026-03-04']);
  assert.deepEqual([commitsOf(last2), commitsOf(fromFirst), commitsOf(fromEarlier)], [1, 2, 2]);
  assert.equal(last2.person, 'ada');
  assert.equal(last2.sources[0].label, 'git (stored)');
  assert.deepEqual(fromFirst.sources[0].notes, []);
  assert.deepEqual(fromEarlier.sources[0].notes, ['no crawl of git covered 2026-02-27 … 2026-02-28']);
  assert.equal(last2.days.find((d) => d.date === '2026-03-03').bySource.git, 1);

  // Markdown: the reports one after another, a `---` line between them.
  const text = footprint(dir, ['slice', '--window', '2', '--window', '3', '--until', '2026-03-04', '--tz', 'UTC']);
  assert.equal(text.status, 0, text.output);
  assert.equal(text.stdout.split('\n---\n').length, 2);
  assert.match(text.stdout, /2026-03-03/);

  // --out: one file per window, the paths printed.
  const out = join(dir, 'reports');
  const written = footprint(dir, ['slice', '--window', '2', '--window', '2026-03-01', '--until', '2026-03-04', '--tz', 'UTC', '--out', out]);
  assert.equal(written.status, 0, written.output);
  assert.deepEqual(written.stdout.split('\n').filter(Boolean), [join(out, 'ada-2026-03-03-2026-03-04.md'), join(out, 'ada-2026-03-01-2026-03-04.md')]);
  assert.match(readFileSync(join(out, 'ada-2026-03-03-2026-03-04.md'), 'utf8'), /2026-03-03/);
});

test('collect: a second crawl of an overlapping period leaves one copy of each event in the store', () => {
  const dir = installation((t) => t);
  const work = repoWithTwoCommits(tempDir('work-'));
  assert.equal(footprint(dir, collectGitArgs(work, ['--json'])).status, 0);
  const again = footprint(dir, ['collect', '--since', '2026-03-03', '--until', '2026-03-09', '--tz', 'UTC', '--email', ADA,
    '--repos', work, '--source', 'git', '--person', 'Ada', '--json']);
  assert.equal(again.status, 0, again.output);
  const commits = lines(join(dir, '.local', 'footprint', 'events', 'ada', 'git.jsonl')).filter((e) => e.kind === 'commit');
  assert.equal(commits.length, 2);
  assert.equal(lines(join(dir, '.local', 'footprint', 'events', 'ada', 'crawls.jsonl')).length, 2);
  assert.doesNotMatch(again.stderr, /used a different/); // the same --repos and identity: nothing to tell
});

test('collect: a crawl over an overlap with another --repos says so on stderr and in the report\'s notes, and still saves', () => {
  const dir = installation((t) => t);
  const work = repoWithTwoCommits(tempDir('work-'));
  const other = repoWithTwoCommits(tempDir('work-'));
  const first = footprint(dir, collectGitArgs(work, ['--json']));
  assert.equal(first.status, 0, first.output);
  const [crawl] = lines(join(dir, '.local', 'footprint', 'events', 'ada', 'crawls.jsonl'));
  assert.deepEqual([crawl.repos.length, crawl.identity], [1, ADA]);
  const again = footprint(dir, collectGitArgs(other, ['--json']));
  assert.equal(again.status, 0, again.output);
  assert.match(again.stderr, /footprint: git: the earlier crawl of 2026-03-01 … 2026-03-07 .* used a different --repos; this crawl replaces its stored git events of 2026-03-01 … 2026-03-07/);
  const git = JSON.parse(again.stdout).sources.find((s) => s.source === 'git');
  assert.ok(git.notes.some((n) => /used a different --repos/.test(n)));
  assert.equal(lines(join(dir, '.local', 'footprint', 'events', 'ada', 'crawls.jsonl')).length, 2);
  // --no-save replaces nothing, so it tells nothing.
  assert.doesNotMatch(footprint(dir, collectGitArgs(work, ['--no-save', '--json'])).stderr, /used a different/);
});

test('collect: a team crawl without --person says where it is saved and suggests --person <team>; with --person it does not', () => {
  const dir = installation((t) => t);
  const work = repoWithTwoCommits(tempDir('work-'));
  const args = ['collect', '--since', '2026-03-01', '--until', '2026-03-07', '--tz', 'UTC', '--source', 'team', '--repos', work, '--json'];
  const bare = footprint(dir, args);
  assert.equal(bare.status, 0, bare.output);
  assert.match(bare.stderr, /footprint: team: its events are saved under unknown \(no --person\).*pass --person <team>/);
  assert.ok(JSON.parse(bare.stdout).sources.find((x) => x.source === 'team').notes.some((n) => /pass --person <team>/.test(n)));
  const named = footprint(dir, [...args, '--person', 'Platform team']);
  assert.equal(named.status, 0, named.output);
  assert.doesNotMatch(named.stderr, /pass --person <team>/);
  assert.ok(existsSync(join(dir, '.local', 'footprint', 'events', 'platform-team', 'team.jsonl')));
  assert.doesNotMatch(footprint(dir, [...args, '--no-save']).stderr, /pass --person <team>/);
});

test('slice: an empty store exits 1; --window is required; a bad window, a person that is not stored and several people are refused', () => {
  const dir = installation((t) => t);
  const empty = footprint(dir, ['slice', '--window', '7']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /the store holds no event/);
  assert.equal(footprint(dir, ['slice']).status, 1);
  assert.match(footprint(dir, ['slice']).stderr, /slice needs --window/);
  assert.match(footprint(dir, ['slice', '--window', 'soon']).stderr, /--window takes a number of days or a start date YYYY-MM-DD; got: soon/);
  assert.match(footprint(dir, ['slice', '--window', '2026-04-01', '--until', '2026-03-01']).stderr, /starts after --until/);

  const work = repoWithTwoCommits(tempDir('work-'));
  assert.equal(footprint(dir, collectGitArgs(work, ['--json'])).status, 0);
  const other = footprint(dir, ['slice', '--window', '7', '--person', 'Grace']);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /the store holds no event for Grace/);
  // The only person in the store is the default; two people with none called `me` are a usage error.
  assert.equal(footprint(dir, ['slice', '--window', '7', '--until', '2026-03-07', '--tz', 'UTC', '--json']).status, 0);
  mkdirSync(join(dir, '.local', 'footprint', 'events', 'grace'));
  const several = footprint(dir, ['slice', '--window', '7']);
  assert.equal(several.status, 1);
  assert.match(several.stderr, /the store holds several people \(ada, grace\): pass --person/);
});

test('collect: sessions without --me is not collected and says why; team is not among the default sources', () => {
  const dir = installation((t) => t);
  const r = footprint(dir, ['collect', '--since', '2026-03-01', '--until', '2026-03-07', '--tz', 'UTC', '--email', ADA, '--no-save']);
  assert.match(r.stdout, /^- sessions: not collected — sessions runs with --me: the transcripts on this machine are the user's$/m);
  assert.doesNotMatch(r.stdout, /^- team:/m);
  const named = footprint(dir, ['collect', '--since', '2026-03-01', '--until', '2026-03-07', '--tz', 'UTC', '--source', 'team,sessions', '--no-save']);
  assert.match(named.stdout, /^- sessions: not collected — sessions runs with --me/m);
  assert.match(named.stdout, /^- team: /m); // runs (here: the zone's own result or its failure), named and not skipped for identity
  assert.doesNotMatch(named.stdout, /^- team: not collected — no identity/m);
});

test('sources lists sessions (each host\'s folder, none read) and team (not a default source)', () => {
  const dir = installation((t) => t);
  const home = tempDir('home-');
  mkdirSync(join(home, '.qwen', 'projects'), { recursive: true });
  mkdirSync(join(dir, '.local', 'footprint'), { recursive: true });
  writeFileSync(join(dir, '.local', 'footprint', 'config.yaml'), 'sessions: { codex: false }\n');
  const r = footprint(dir, ['sources', '--json'], { HOME: home });
  assert.equal(r.status, 0, r.output);
  const rows = JSON.parse(r.stdout);
  const sessions = rows.find((x) => x.source === 'sessions');
  assert.deepEqual(sessions.hosts, [
    { host: 'claude', folders: [{ folder: join(home, '.claude', 'projects'), state: 'not found' }], state: 'not found' },
    { host: 'qwen', folders: [{ folder: join(home, '.qwen', 'projects'), state: 'found' }], state: 'found' },
    { host: 'codex', folders: [], state: 'off' },
  ]);
  assert.match(sessions.identity, /--me/);
  const team = rows.find((x) => x.source === 'team');
  assert.deepEqual([team.connector, team.listed], [null, null]);
  const text = footprint(dir, ['sources'], { HOME: home });
  assert.match(text.stdout, /^sessions\s+agent transcripts on this machine: claude not found .*, qwen found .*, codex off$/m);
  assert.match(text.stdout, /^team\s+only with --source team/m);
});
