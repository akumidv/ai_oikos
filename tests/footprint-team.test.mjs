// The team source (ADR 0008 D07): facts about the people around the work — Jira projects with their
// lead, versions released and people assigned, and the authors of commits per repository — checked
// in-process against a fake Atlassian client (canned answers, no network) and a git fixture; the
// user's counting rule marks members, and nothing is ranked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../tools/common/cli.mjs';
import { gitEnvironment } from '../tools/common/gitwiki.mjs';
import { HttpError } from '../tools/common/http.mjs';
import { collectTeam } from '../tools/footprint/sources/team.mjs';
import { cleanEnv, tempDir } from './helpers/installation.mjs';

const SITE = 'https://acme.atlassian.net';
const PERIOD = { since: '2026-03-02', until: '2026-03-03', tz: 'UTC' };

/** The test's own git: none of the developer's GIT_* variables, no system or global configuration. */
const GIT_ENV = gitEnvironment(null, cleanEnv());
const EMPTY_GIT_CONFIG = join(tempDir('gitconfig-'), 'config');
writeFileSync(EMPTY_GIT_CONFIG, '');
// collectTeam runs git with this process's environment.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' });

/**
 * A client whose `get` answers from `routes` (`url` equal, or `match` a pattern, against the site's
 * URL); a route with `status` answers that HTTP error. Every URL asked is recorded in `calls`.
 */
function fakeClient(routes) {
  const calls = [];
  const get = async (path) => {
    const url = `${SITE}${path}`;
    calls.push(url);
    const route = routes.find((r) => (r.url !== undefined ? r.url === url : new RegExp(r.match).test(url)));
    if (!route) throw new Error(`no route for ${url}`);
    if (route.status >= 400) throw new HttpError(route.status, url, JSON.stringify(route.body), route.headers);
    return typeof route.body === 'function' ? route.body(url) : route.body;
  };
  return { calls, client: { get } };
}

const person = (name, accountId, emailAddress) => ({ displayName: name, accountId, emailAddress });
const ADA = person('Ada Lovelace', 'acc-ada', 'ada@acme.example');
const BOB = person('Bob Builder', 'acc-bob', 'bob@acme.example');
const GRACE = person('Grace Hopper', 'acc-grace', 'grace@acme.example');
const issue = (key, assignee, updated) => ({ key, fields: { summary: `s ${key}`, project: { key: key.split('-')[0] }, assignee, updated } });

const PROJ = { key: 'PROJ', name: 'Project', lead: GRACE };
const OPS = { key: 'OPS', name: 'Operations', lead: BOB };
const VERSIONS = [
  { name: '1.0', released: true, releaseDate: '2026-03-02' }, // in the period
  { name: '0.9', released: true, releaseDate: '2026-02-01' }, // before
  { name: '2.0', released: false, releaseDate: '2026-03-03' }, // planned, not released
  { name: '1.1', released: true, releaseDate: '2026-03-04' }, // after
];
const JIRA_ROUTES = [
  { url: `${SITE}/rest/api/3/project/PROJ`, body: PROJ },
  { url: `${SITE}/rest/api/3/project/PROJ/versions`, body: VERSIONS },
  { url: `${SITE}/rest/api/3/project/OPS`, body: OPS },
  { url: `${SITE}/rest/api/3/project/OPS/versions`, body: [] },
  { url: `${SITE}/rest/api/3/project/GONE`, status: 404, body: { errorMessages: ['No project could be found'] } },
  { match: `^${SITE}/rest/api/3/search/jql\\?`, body: { issues: [
    issue('PROJ-1', ADA, '2026-03-02T10:00:00.000+0000'),
    issue('PROJ-2', ADA, '2026-03-03T09:00:00.000+0000'),
    issue('PROJ-3', BOB, '2026-03-03T10:00:00.000+0000'),
    issue('PROJ-4', null, '2026-03-03T11:00:00.000+0000'), // nobody assigned
    issue('PROJ-5', GRACE, '2026-02-20T11:00:00.000+0000'), // updated before the period
    issue('OPS-1', GRACE, '2026-03-03T12:00:00.000+0000'),
  ] } },
];

const eventsOf = (result, kind) => result.events.filter((e) => e.kind === kind);
const totalsOf = (result) => Object.fromEntries(result.totals);
const notesOf = (result) => result.notes.join('\n');

test('team jira: lead snapshot, versions released in the period, assignees per issue; a 404 project is skipped and named', async () => {
  const { calls, client } = fakeClient(JIRA_ROUTES);
  const r = await collectTeam({ jira: client, projects: ['PROJ', 'GONE'], members: ['bob@acme.example'], ...PERIOD });
  assert.equal(r.source, 'team');
  assert.equal(r.label, 'team facts');
  assert.ok(r.events.every((e) => e.action === false), 'every event is a fact');
  const [lead] = eventsOf(r, 'project lead');
  assert.equal(lead.id, 'lead:PROJ');
  assert.equal(lead.snapshot, true);
  assert.equal(lead.what, 'PROJ: Grace Hopper');
  assert.equal(lead.where, 'PROJ');
  assert.deepEqual(lead.detail, { project: 'PROJ', lead: 'Grace Hopper', member: false });
  assert.ok(!Number.isNaN(Date.parse(lead.at)));
  assert.deepEqual(eventsOf(r, 'version released'), [{
    id: 'version:PROJ:1.0', date: '2026-03-02', kind: 'version released', action: false, what: 'PROJ 1.0', where: 'PROJ', detail: { project: 'PROJ', version: '1.0' },
  }]);
  assert.deepEqual(eventsOf(r, 'assigned issue').map((e) => [e.id, e.at, e.detail]), [
    ['assigned:PROJ-1', '2026-03-02T10:00:00.000+00:00', { project: 'PROJ', person: 'Ada Lovelace', member: false }],
    ['assigned:PROJ-2', '2026-03-03T09:00:00.000+00:00', { project: 'PROJ', person: 'Ada Lovelace', member: false }],
    ['assigned:PROJ-3', '2026-03-03T10:00:00.000+00:00', { project: 'PROJ', person: 'Bob Builder', member: true }],
  ]);
  assert.deepEqual(totalsOf(r), { projects: 1, 'versions released': 1, 'people assigned': 2, 'members among people assigned': 1 });
  assert.match(notesOf(r), /1 Jira read\(s\) refused or missing .*: GONE \(404\)/);
  // The scan names only the readable project, with a day of slack on each side.
  const scan = calls.find((c) => c.includes('/search/jql?'));
  assert.equal(new URL(scan).searchParams.get('jql'), 'project in ("PROJ") AND updated >= "2026-03-01" AND updated < "2026-03-05"');
});

test('team jira: no projects given — the projects of the issues updated in the period, each read once', async () => {
  const { calls, client } = fakeClient(JIRA_ROUTES);
  const r = await collectTeam({ jira: client, members: ['Grace Hopper'], ...PERIOD });
  assert.deepEqual(eventsOf(r, 'project lead').map((e) => [e.where, e.detail.lead, e.detail.member]), [
    ['OPS', 'Bob Builder', false], ['PROJ', 'Grace Hopper', true],
  ]);
  assert.deepEqual(totalsOf(r), { projects: 2, 'versions released': 1, 'people assigned': 3, 'members among people assigned': 1 });
  assert.equal(calls.filter((c) => c.endsWith('/project/PROJ')).length, 1);
  assert.equal(new URL(calls.find((c) => c.includes('/search/jql?'))).searchParams.get('jql'), 'updated >= "2026-03-01" AND updated < "2026-03-05"');
  assert.match(notesOf(r), /Jira projects: those of the 5 issue\(s\) updated in the period/);
});

test('team jira: nobody is ranked — rows sorted by project, people by name, whatever the counts', async () => {
  // Zed has the most issues; the row still lists people by name.
  const busy = { match: `^${SITE}/rest/api/3/search/jql\\?`, body: { issues: [
    issue('PROJ-1', person('Zed Zulu', 'z', null), '2026-03-02T10:00:00.000+0000'), issue('PROJ-2', person('Zed Zulu', 'z', null), '2026-03-02T11:00:00.000+0000'),
    issue('PROJ-3', person('Zed Zulu', 'z', null), '2026-03-02T12:00:00.000+0000'), issue('PROJ-4', ADA, '2026-03-02T13:00:00.000+0000'),
    issue('OPS-1', BOB, '2026-03-02T14:00:00.000+0000'),
  ] } };
  const { client } = fakeClient([busy, ...JIRA_ROUTES.slice(0, 5)]);
  const r = await collectTeam({ jira: client, members: ['ada@acme.example'], ...PERIOD });
  assert.deepEqual(r.breakdown.rows, [
    ['OPS', 'Bob Builder', 0, 'Bob Builder'],
    ['PROJ', 'Grace Hopper', 1, 'Ada Lovelace (member); Zed Zulu'],
  ]);
  assert.deepEqual(r.breakdown.wheres, ['OPS', 'PROJ']);
  assert.match(notesOf(r), /never ordered by a count/);
});

test('team jira: the issue scan is cut at 1000 and says so', async () => {
  let pages = 0;
  const endless = { match: `^${SITE}/rest/api/3/search/jql\\?`, body: () => {
    pages += 1;
    return { nextPageToken: `t${pages}`, issues: Array.from({ length: 100 }, (_, i) => issue(`PROJ-${pages * 100 + i}`, ADA, '2026-03-02T10:00:00.000+0000')) };
  } };
  const { client } = fakeClient([endless, ...JIRA_ROUTES.slice(0, 2)]);
  const r = await collectTeam({ jira: client, ...PERIOD });
  assert.equal(pages, 10);
  assert.equal(eventsOf(r, 'assigned issue').length, 1000);
  assert.match(notesOf(r), /issue scan cut at 1000/);
  assert.equal(r.partial, true);
  assert.deepEqual(r.partialReasons, ['issue scan cut at 1000']);
});

test('team jira: a 429 is waited out once; a project key that is no key is a usage error', async () => {
  let limited = 0;
  const { client } = fakeClient(JIRA_ROUTES);
  const get = client.get;
  client.get = async (path) => {
    if (path.endsWith('/project/PROJ/versions') && limited === 0) {
      limited += 1;
      throw new HttpError(429, `${SITE}${path}`, '', new Headers({ 'retry-after': '0' }));
    }
    return get(path);
  };
  const r = await collectTeam({ jira: client, projects: ['PROJ'], ...PERIOD });
  assert.equal(eventsOf(r, 'version released').length, 1);
  assert.match(notesOf(r), /rate limit was met 1 time/);
  await assert.rejects(collectTeam({ jira: client, projects: ['PROJ")) OR (x'], ...PERIOD }), UsageError);
});

// == git ==

/** A repository at `dir` with commits at fixed author dates: `commit(name, email, at)`. */
function gitRepo(dir, remote = null) {
  mkdirSync(dir, { recursive: true });
  const git = (args, extra = {}) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...extra } });
    assert.equal(r.status, 0, r.stderr);
  };
  git(['init', '-q', '-b', 'main']);
  if (remote) git(['remote', 'add', 'origin', remote]);
  let n = 0;
  const commit = (name, email, at) => {
    n += 1;
    writeFileSync(join(dir, `f${n}.txt`), `${n}\n`);
    git(['add', '--', `f${n}.txt`]);
    git(['commit', '-q', '-m', `change ${n}`], {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: at, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: at,
    });
  };
  return { commit };
}

/** Two authors on two days (and a commit before the period): the repository `acme/app`, remote `https://example.com/acme/app.git`. */
function appRepo() {
  const repo = join(tempDir('team-'), 'checkout');
  const { commit } = gitRepo(repo, 'https://token@example.com/acme/app.git');
  commit('Ada Lovelace', 'Ada@Acme.example', '2026-03-01T10:00:00+00:00'); // before the period
  commit('Ada Lovelace', 'ada@acme.example', '2026-03-02T10:00:00+00:00');
  commit('Ada Lovelace', 'ada@acme.example', '2026-03-02T11:00:00+00:00');
  commit('Bob Builder', 'bob@acme.example', '2026-03-02T12:00:00+00:00');
  commit('Bob Builder', 'bob@acme.example', '2026-03-03T23:30:00+00:00');
  return repo;
}

test('team git: author and working day per repository, commits counted, members marked, the label from the remote without credentials', async () => {
  const repo = appRepo();
  const r = await collectTeam({ repos: [repo], members: ['ADA@acme.example'], ...PERIOD });
  assert.deepEqual(r.events.map((e) => [e.id, e.date, e.detail.commits, e.detail.member]), [
    ['author:acme/app:ada@acme.example:2026-03-02', '2026-03-02', 2, true],
    ['author:acme/app:bob@acme.example:2026-03-02', '2026-03-02', 1, false],
    ['author:acme/app:bob@acme.example:2026-03-03', '2026-03-03', 1, false],
  ]);
  const [first] = r.events;
  assert.equal(first.kind, 'repository author');
  assert.equal(first.action, false);
  assert.equal(first.what, 'acme/app');
  assert.equal(first.where, `${repo} https://example.com/acme/app.git`);
  assert.deepEqual(first.detail, { repo: 'acme/app', author: 'Ada Lovelace', email: 'ada@acme.example', commits: 2, member: true });
  assert.deepEqual(totalsOf(r), { repositories: 1, authors: 2, 'members among authors': 1 });
  assert.deepEqual(r.breakdown.rows, [['acme/app', '—', '—', 'Ada Lovelace (member); Bob Builder']]);
  assert.deepEqual(r.breakdown.wheres, [first.where]);
  assert.doesNotMatch(JSON.stringify(r), /token@/);
});

test('team git: the working day (day_starts) decides the day; two clones of one remote are one repository', async () => {
  const repo = appRepo();
  const late = await collectTeam({ repos: [repo], since: '2026-03-02', until: '2026-03-03', tz: 'UTC', dayStartsMin: 4 * 60 });
  assert.ok(late.events.some((e) => e.id === 'author:acme/app:bob@acme.example:2026-03-03'));
  // A commit at 01:00 UTC belongs to the day before for a day that starts at 04:00.
  const night = join(tempDir('team-'), 'night');
  gitRepo(night).commit('Cy Night', 'cy@acme.example', '2026-03-04T01:00:00+00:00');
  const early = await collectTeam({ repos: [night], since: '2026-03-03', until: '2026-03-03', tz: 'UTC', dayStartsMin: 4 * 60 });
  assert.deepEqual(early.events.map((e) => e.date), ['2026-03-03']);
  const twin = join(tempDir('team-'), 'twin');
  const clone = spawnSync('git', ['clone', '-q', repo, twin], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(clone.status, 0, clone.stderr);
  spawnSync('git', ['-C', twin, 'remote', 'set-url', 'origin', 'https://example.com/acme/app.git'], { env: GIT_ENV });
  const both = await collectTeam({ repos: [repo, twin], ...PERIOD });
  assert.deepEqual(totalsOf(both), { repositories: 1, authors: 2 });
  assert.equal(both.events.find((e) => e.id === 'author:acme/app:ada@acme.example:2026-03-02').detail.commits, 2);
});

test('team: no members rule prints "people seen in the period, not a team" and no member totals; a rule prints as given', async () => {
  const repo = appRepo();
  const none = await collectTeam({ repos: [repo], ...PERIOD });
  assert.match(notesOf(none), /no members rule: people seen in the period, not a team/);
  assert.ok(!('members among authors' in totalsOf(none)));
  assert.ok(none.events.every((e) => e.detail.member === false));
  const ruled = await collectTeam({ repos: [repo], members: ['Bob Builder', 'ada@acme.example'], ...PERIOD });
  assert.match(notesOf(ruled), /counting rule \(team\.members, as given\): Bob Builder, ada@acme\.example/);
  assert.doesNotMatch(notesOf(ruled), /no members rule/);
  assert.equal(totalsOf(ruled)['members among authors'], 2);
});

test('team: jira null — git only, with a note that Jira was not read; Jira only works without repositories', async () => {
  const r = await collectTeam({ jira: null, repos: [appRepo()], ...PERIOD });
  assert.match(notesOf(r), /Jira was not read/);
  assert.deepEqual(totalsOf(r), { repositories: 1, authors: 2 });
  const { client } = fakeClient(JIRA_ROUTES);
  const jiraOnly = await collectTeam({ jira: client, repos: [], ...PERIOD });
  assert.ok(!('repositories' in totalsOf(jiraOnly)));
  assert.ok(eventsOf(jiraOnly, 'project lead').length);
});

test('team: nothing to read is a usage error; an empty result is not', async () => {
  await assert.rejects(collectTeam({ ...PERIOD }), UsageError);
  const { client } = fakeClient([{ match: `^${SITE}/rest/api/3/search/jql\\?`, body: { issues: [] } }]);
  const empty = await collectTeam({ jira: client, ...PERIOD });
  assert.deepEqual(empty.events, []);
  assert.deepEqual(totalsOf(empty), { projects: 0, 'versions released': 0, 'people assigned': 0 });
  const notRepo = tempDir('empty-');
  await assert.rejects(collectTeam({ repos: [notRepo], ...PERIOD }), UsageError);
});
