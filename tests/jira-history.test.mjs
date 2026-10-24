// Jira `history` (npm test), against canned answers (fake-fetch.mjs) in a copy of examples/installation:
// the status moves of a task read from its changelog — when, from → to, who, and the role (me: the
// token's account; app: an app, or no author; person) —, the time in each status from the creation on
// (the current one up to now), the returns from review, the moves by role; over a JQL selection one
// block across the issues (median / mean per status) and a line per issue. A read: no --dry-run, and
// nothing but GET.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installation, tool, withFakeFetch } from './helpers/installation.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };

function run(routes, args) {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...CREDS, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}

const ADA = { accountId: 'acc-ada', displayName: 'Ada Lovelace', accountType: 'atlassian' };
const BEN = { accountId: 'acc-ben', displayName: 'Ben Bitdiddle', accountType: 'atlassian' };
const BOT = { accountId: 'acc-bot', displayName: 'Automation for Jira', accountType: 'app' };
const myself = { url: `${API}/myself`, body: ADA };
const move = (created, author, from, to) => ({
  created, ...(author ? { author } : {}), items: [{ field: 'status', fieldId: 'status', fromString: from, toString: to }],
});
const changelog = (key, values) => ({ match: `^${API}/issue/${key}/changelog`, body: { startAt: 0, maxResults: 50, total: values.length, isLast: true, values } });
const fields = (summary, status, created) => ({ summary, status: { name: status }, created });

// PROJ-7: created in To Do; 1 day there, 1 day in progress, 1 day in review, sent back by automation,
// 1 more day in progress, then in review again (by a change with no author) up to now.
const PROJ7 = changelog('PROJ-7', [
  move('2026-10-01T10:00:00.000+0200', ADA, 'To Do', 'In Progress'),
  { created: '2026-10-01T12:00:00.000+0200', author: BEN, items: [{ field: 'assignee', fieldId: 'assignee', fromString: 'Ada', toString: 'Ben' }] },
  move('2026-10-02T10:00:00.000+0200', BEN, 'In Progress', 'Review'),
  move('2026-10-03T10:00:00.000+0200', BOT, 'Review', 'In Progress'),
  move('2026-10-04T10:00:00.000+0200', null, 'In Progress', 'Review'),
]);
const PROJ7_FIELDS = fields('Export the report', 'Review', '2026-09-30T10:00:00.000+0200');
// PROJ-8: two hours in To Do, then Done by Ada.
const PROJ8 = changelog('PROJ-8', [move('2026-10-01T10:00:00.000+0200', ADA, 'To Do', 'Done')]);
const PROJ8_FIELDS = fields('Import', 'Done', '2026-10-01T08:00:00.000+0200');

const issue = (key, f) => ({ url: `${API}/issue/${key}?fields=summary,status,created`, body: { key, fields: f } });
const search = (issues, nextPageToken) => ({ match: `^${API}/search/jql\\?`, body: { issues, ...(nextPageToken ? { nextPageToken } : {}) } });

test('history --task lists every status move with its actor and role, then the time in status, returns and moves by role', () => {
  const r = run([myself, issue('PROJ-7', PROJ7_FIELDS), PROJ7], ['history', '--task', 'PROJ-7']);
  assert.equal(r.status, 0, r.output);
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines.slice(0, 6), [
    'PROJ-7 · Export the report [Review]',
    'Transitions:',
    '  2026-10-01 10:00  To Do → In Progress  Ada Lovelace (me)',
    '  2026-10-02 10:00  In Progress → Review  Ben Bitdiddle (person)',
    '  2026-10-03 10:00  Review → In Progress  Automation for Jira (app)',
    '  2026-10-04 10:00  In Progress → Review  automation (app)',
  ]);
  assert.match(r.stdout, /^Time in status: To Do 1d 0h · In Progress 2d 0h · Review \d+d \d+h \(now\)$/m);
  assert.match(r.stdout, /^Returns from review: 1$/m);
  assert.match(r.stdout, /^Moves by role: me 1, person 1, app 2$/m);
  assert.deepEqual(r.calls.filter((c) => c.method !== 'GET'), []);
});

test('history --task of a task never moved names its status since creation', () => {
  const r = run([myself, issue('PROJ-9', fields('New', 'To Do', '2026-10-20T10:00:00.000+0200')), changelog('PROJ-9', [])], ['history', '--task', 'PROJ-9']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /\(no status change in the changelog — in To Do since it was created\)/);
  assert.match(r.stdout, /^Time in status: To Do \S+.* \(now\)$/m);
  assert.match(r.stdout, /^Moves by role: me 0, person 0, app 0$/m);
});

test('history --jql prints one block across the issues (median / mean per status) and one line per issue', () => {
  const r = run([myself, search([{ key: 'PROJ-7', fields: PROJ7_FIELDS }, { key: 'PROJ-8', fields: PROJ8_FIELDS }]), PROJ7, PROJ8],
    ['history', '--jql', 'project = PROJ']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^## 2 issues$/m);
  assert.match(r.stdout, /^ {2}To Do {8}13h 0m \/ 13h 0m {2}\(2 issues\)$/m);
  assert.match(r.stdout, /^ {2}In Progress {2}2d 0h \/ 2d 0h {2}\(1 issue\)$/m);
  assert.match(r.stdout, /^Returns from review: 1 \(in 1 issue\)$/m);
  assert.match(r.stdout, /^Moves by role: me 2, person 1, app 2$/m);
  assert.match(r.stdout, /^ {2}PROJ-7 \[Review\] · 4 moves \(me 1, person 1, app 2\) · returns 1 · To Do 1d 0h · In Progress 2d 0h · Review .*\(now\)$/m);
  assert.match(r.stdout, /^ {2}PROJ-8 \[Done\] · 1 move \(me 1, person 0, app 0\) · returns 0 · To Do 2h 0m · Done .*\(now\)$/m);
  const searched = r.calls.find((c) => c.url.includes('/search/jql'));
  assert.match(searched.url, /fields=summary,status,created&maxResults=50/);
});

test('history --jql --max reads only that many issues and says more match', () => {
  const r = run([myself, search([{ key: 'PROJ-7', fields: PROJ7_FIELDS }], 'next'), PROJ7], ['history', '--jql', 'project = PROJ', '--max', '1']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^## 1 issue \(the first 1; more match — raise --max\)$/m);
  assert.equal(r.calls.filter((c) => c.url.includes('/changelog')).length, 1);
});

test('history --json prints each issue\'s moves and totals and the aggregate, not the raw changelog', () => {
  const r = run([myself, issue('PROJ-7', PROJ7_FIELDS), PROJ7], ['history', '--task', 'PROJ-7', '--json']);
  assert.equal(r.status, 0, r.output);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out.issues[0]).sort(), ['created', 'key', 'moves', 'status', 'summary', 'totals', 'truncated']);
  assert.equal(out.issues[0].truncated, false);
  assert.equal(out.issues[0].moves.length, 4);
  assert.deepEqual(out.issues[0].totals.byRole, { me: 1, person: 1, app: 2 });
  assert.equal(out.issues[0].totals.time['To Do'], 24 * 60 * 60 * 1000);
  assert.equal(out.issues[0].totals.open, 'Review');
  assert.equal(out.aggregate.returns, 1);
  assert.equal(out.aggregate.truncated, 0);
});

test('history --json --raw adds the raw changelog of each issue', () => {
  const r = run([myself, issue('PROJ-7', PROJ7_FIELDS), PROJ7], ['history', '--task', 'PROJ-7', '--json', '--raw']);
  assert.equal(r.status, 0, r.output);
  const out = JSON.parse(r.stdout);
  assert.equal(out.issues[0].changelog.length, 5);
  assert.equal(out.issues[0].moves.length, 4);
});

test('history counts a return only back from review to a non-review status the issue was in before', () => {
  const at = (n) => `2026-10-0${n}T10:00:00.000+0200`;
  const chain = (key, statuses) => changelog(key, statuses.slice(1).map((to, n) => move(at(n + 1), ADA, statuses[n], to)));
  const cases = {
    'PROJ-1': [['To Do', 'In Review', 'QA'], 0],
    'PROJ-2': [['To Do', 'Ready for Review', 'In Review'], 0],
    'PROJ-3': [['In Progress', 'In Review', 'In Progress'], 1],
    'PROJ-4': [['In Progress', 'In Review', 'Approved'], 0],
    'PROJ-5': [['In Review', 'QA', 'In Review', 'QA'], 1],
    'PROJ-6': [['In Review', 'To Do'], 0],
  };
  const keys = Object.keys(cases);
  const routes = [myself, search(keys.map((key) => ({ key, fields: fields(key, cases[key][0].at(-1), '2026-09-30T10:00:00.000+0200') }))),
    ...keys.map((key) => chain(key, cases[key][0]))];
  const r = run(routes, ['history', '--jql', 'project = PROJ', '--json']);
  assert.equal(r.status, 0, r.output);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.fromEntries(out.issues.map((h) => [h.key, h.totals.returns])), Object.fromEntries(keys.map((key) => [key, cases[key][1]])));
  assert.equal(out.aggregate.returns, 2);
});

test('history of a changelog over the limit says it is truncated and credits no status with the time after the last move read', () => {
  const assignee = (n) => ({ created: '2026-10-02T10:00:00.000+0200', author: BEN, items: [{ field: 'assignee', fieldId: 'assignee', fromString: `a${n}`, toString: `b${n}` }] });
  const page = (values) => ({ startAt: 0, maxResults: 50, isLast: false, values });
  const first = { match: `^${API}/issue/PROJ-7/changelog`, times: 1,
    body: page([move('2026-10-01T10:00:00.000+0200', ADA, 'To Do', 'In Progress'), ...Array.from({ length: 49 }, (_, n) => assignee(n))]) };
  const rest = { match: `^${API}/issue/PROJ-7/changelog`, body: page(Array.from({ length: 50 }, (_, n) => assignee(n))) };
  const routes = [myself, issue('PROJ-7', PROJ7_FIELDS), first, rest];
  const text = run(routes, ['history', '--task', 'PROJ-7']);
  assert.equal(text.status, 0, text.output);
  assert.match(text.stdout, /^TRUNCATED: the changelog has more than 5000 entries and only the first 5000 were read: .*partial/m);
  assert.match(text.stdout, /^Time in status \(partial\): To Do 1d 0h$/m);
  assert.equal(text.calls.filter((c) => c.url.includes('/changelog')).length, 101);
  const json = JSON.parse(run(routes, ['history', '--task', 'PROJ-7', '--json']).stdout);
  assert.equal(json.issues[0].truncated, true);
  assert.deepEqual(json.issues[0].totals.time, { 'To Do': 24 * 60 * 60 * 1000 });
  assert.equal(json.issues[0].totals.open, null);
  assert.equal(json.aggregate.truncated, 1);
});

test('history takes no --dry-run, and needs exactly one of --task and --jql, before any request', () => {
  for (const args of [['--task', 'PROJ-7', '--dry-run'], [], ['--task', 'PROJ-7', '--jql', 'x'], ['--task', 'PROJ-7', '--max', '5'], ['--task', 'PROJ-7', '--raw']]) {
    const r = run([myself], ['history', ...args]);
    assert.equal(r.status, 1, `${args}: ${r.output}`);
    assert.deepEqual(r.calls, [], args.join(' '));
  }
});
