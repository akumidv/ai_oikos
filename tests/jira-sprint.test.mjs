// Jira `sprint`, `sprints` and `context` on an overdue active sprint (npm test), against canned answers
// (fake-fetch.mjs) in a copy of examples/installation: an active sprint whose end date has passed is
// still open, so each prints one warning that a person closes it and decides on the carry-over. The
// dates are far from today (2020, 2099), so no clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installation, tool, withFakeFetch } from './helpers/installation.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const AGILE = `${SITE}/rest/agile/1.0`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
const OVERDUE = /Warning: the active sprint ended on 2020-01-10 \(\d+ days ago\) and is still open — a person closes it and decides on the carry-over\./;

function run(routes, args) {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...CREDS, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}

const sprintOf = (id, state, endDate) => ({ id, name: `S${id}`, state, startDate: '2019-12-27T09:00:00.000Z', endDate });
const activeRoute = (sprint) => ({ match: `^${AGILE}/board/20/sprint\\?state=active&`, body: { isLast: true, values: [sprint] } });
const issuesRoute = { match: `^${AGILE}/sprint/\\d+/issue\\?`, body: { total: 1, issues: [{ key: 'PROJ-7', fields: { summary: 'Export', status: { name: 'In Progress' } } }] } };

test('sprint: an active sprint past its end date warns; one ending in 2099 does not', () => {
  const late = run([activeRoute(sprintOf(46, 'active', '2020-01-10T17:00:00.000Z')), issuesRoute], ['sprint', '--board', '20']);
  assert.equal(late.status, 0, late.output);
  assert.match(late.stdout, /^Sprint 46: S46 \[active\] 2019-12-27 → 2020-01-10$/m);
  assert.match(late.stdout, new RegExp(`^${OVERDUE.source}$`, 'm'));

  const current = run([activeRoute(sprintOf(47, 'active', '2099-01-10T17:00:00.000Z')), issuesRoute], ['sprint', '--board', '20']);
  assert.equal(current.status, 0, current.output);
  assert.doesNotMatch(current.stdout, /Warning/);
});

test('sprints: the overdue active sprint warns below its line; a future or closed one does not', () => {
  const list = { match: `^${AGILE}/board/20/sprint\\?state=active,future&`, body: { isLast: true, values: [
    sprintOf(46, 'active', '2020-01-10T17:00:00.000Z'), sprintOf(48, 'future', '2020-01-24T17:00:00.000Z'),
  ] } };
  const r = run([list], ['sprints', '--board', '20']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, new RegExp(`^ {4}46 {2}\\[active\\] S46 {2}2019-12-27 → 2020-01-10\\n {8}${OVERDUE.source}$`, 'm'));
  assert.equal((r.stdout.match(/Warning/g) || []).length, 1, 'only the active sprint');
});

test('context: the Sprint section warns about the overdue active sprint', () => {
  const sprintField = 'customfield_10020';
  const routes = [
    { url: `${API}/field`, body: [{ id: sprintField, name: 'Sprint' }] },
    { match: `^${API}/issue/PROJ-15\\?fields=`, body: { id: '10015', key: 'PROJ-15', fields: {
      summary: 'Export', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Task' },
      [sprintField]: [sprintOf(46, 'active', '2020-01-10T17:00:00.000Z'), sprintOf(49, 'active', '2099-01-10T17:00:00.000Z')],
    } } },
  ];
  const r = run(routes, ['context', '--task', 'PROJ-15']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, new RegExp(`^ {2}S46 \\[active\\] \\(id 46, ends 2020-01-10\\)\\n {4}${OVERDUE.source}\\n {2}S49 `, 'm'));
});
