// Jira `context` sections (npm test), against canned answers (fake-fetch.mjs) in a copy of
// examples/installation: Sub-tasks, Links with their ids, Code from Jira's development panel
// (pull requests open first, branches without one, commits), Goals of the task and of its epic; a
// section whose read fails prints one unavailable line. Warnings: code exists while the status is
// in the "new" category, an open pull request no comment names, and an open pull request without an
// active sprint. No code host is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installation, tool, withFakeFetch } from './helpers/installation.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const DEV = `${SITE}/rest/dev-status/latest/issue`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
const SPRINT_FIELD = 'customfield_10020';
const GOALS_FIELD = 'customfield_10100';
const goalAri = (n) => `ari:cloud:townsquare:site-1:goal/${n}`;
const PR_URL = 'https://github.com/acme-corp/web/pull/12';
const BLOCKS = { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' };

function run(routes, args = ['context', '--task', 'PROJ-15']) {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...CREDS, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}

/** The lines of the `## <title>` section of `stdout`, up to the next blank line. */
function section(stdout, title) {
  const lines = stdout.split('\n');
  const start = lines.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `no ## ${title} in:\n${stdout}`);
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

const fieldList = { url: `${API}/field`, body: [{ id: SPRINT_FIELD, name: 'Sprint' }, { id: GOALS_FIELD, name: 'Goals' }] };
const epicParent = { parent: { key: 'PROJ-1', fields: { summary: 'Reports', issuetype: { name: 'Epic' } } } };
const task = (status, category, extra = {}) => ({
  match: `^${API}/issue/PROJ-15\\?fields=`,
  body: { id: '10015', key: 'PROJ-15', fields: { summary: 'Export', status: { name: status, statusCategory: { key: category } }, issuetype: { name: 'Task' }, ...extra } },
});
const children = { match: `^${API}/search/jql`, body: { issues: [] } };
const epicGoals = (aris) => ({ url: `${API}/issue/PROJ-1?fields=${GOALS_FIELD}`, body: { key: 'PROJ-1', fields: { [GOALS_FIELD]: aris.map((id) => ({ id })) } } });
const goalById = (key, title) => ({
  graphql: 'OikosGoalById', times: 1,
  body: { data: { goals_byId: { id: goalAri(key), key, name: title, state: { label: 'On track' }, owner: { name: 'Ada' }, tags: { edges: [] } } } },
});

const devNone = { url: `${DEV}/summary?issueId=10015`, body: { summary: { pullrequest: { overall: { count: 0 }, byInstanceType: {} } } } };
const devSummary = {
  url: `${DEV}/summary?issueId=10015`,
  body: { summary: {
    pullrequest: { overall: { count: 2 }, byInstanceType: { GitHub: { count: 2, name: 'GitHub' } } },
    branch: { overall: { count: 2 }, byInstanceType: { GitHub: { count: 2, name: 'GitHub' } } },
    repository: { overall: { count: 5 } },
  } },
};
const devDetail = {
  match: `^${DEV}/detail\\?issueId=10015&applicationType=GitHub&dataType=pullrequest$`,
  body: { detail: [{
    pullRequests: [
      { name: 'PROJ-15 Old try', url: 'https://github.com/acme-corp/web/pull/9', status: 'DECLINED', source: { branch: 'PROJ-15-old' } },
      { name: 'PROJ-15 Export CSV', url: PR_URL, status: 'OPEN', source: { branch: 'PROJ-15-export' } },
    ],
    branches: [
      { name: 'PROJ-15-export', url: 'https://github.com/acme-corp/web/tree/PROJ-15-export' },
      { name: 'PROJ-15-spike', url: 'https://github.com/acme-corp/web/tree/PROJ-15-spike' },
    ],
  }] },
};
const DEV_WITH_CODE = [devSummary, devDetail];

test('context: sub-tasks and links get sections of their own, the links with their ids', () => {
  const links = [{ id: '10234', type: BLOCKS, outwardIssue: { key: 'PROJ-39', fields: { summary: 'Import', status: { name: 'To Do' } } } }];
  const subtasks = [{ key: 'PROJ-16', fields: { summary: 'Write the query', status: { name: 'Done' }, issuetype: { name: 'Sub-task' } } }];
  const r = run([fieldList, task('To Do', 'new', { issuelinks: links, subtasks }), devNone]);
  assert.equal(r.status, 0, r.output);
  assert.match(section(r.stdout, 'Sub-tasks'), /^ {2}PROJ-16 \[Done\] Sub-task · Write the query$/m);
  const linkSection = section(r.stdout, 'Links');
  assert.match(linkSection, /^ {2}blocks PROJ-39 \[To Do\] .* \[link 10234\]$/m);
  assert.match(linkSection, /unlink --id <N> --dry-run/);
  assert.doesNotMatch(section(r.stdout, 'Task'), /^Links:$/m, 'the links are not printed twice');
});

test('context: no sub-tasks, links or code says (none) for each', () => {
  const r = run([fieldList, task('To Do', 'new'), devNone]);
  assert.equal(r.status, 0, r.output);
  assert.equal(section(r.stdout, 'Sub-tasks'), '  (none)');
  assert.equal(section(r.stdout, 'Links'), '  (none)');
  assert.match(section(r.stdout, 'Code'), /no pull request, branch or commit carrying PROJ-15 in Jira's development panel/);
  assert.equal(section(r.stdout, 'Warnings'), '  (none)');
});

test('context: Code lists the panel\'s pull requests open first, branches without one and the commit count; no code host is read', () => {
  const r = run([fieldList, task('In Progress', 'indeterminate', { [SPRINT_FIELD]: [{ id: 7, name: 'S7', state: 'active' }] }), ...DEV_WITH_CODE]);
  assert.equal(r.status, 0, r.output);
  const code = section(r.stdout, 'Code').split('\n');
  assert.match(code[0], /^ {2}\[open\] PROJ-15 Export CSV — https:\/\/github\.com\/acme-corp\/web\/pull\/12 \(branch PROJ-15-export\)$/);
  assert.match(code[1], /^ {2}\[closed\] PROJ-15 Old try/);
  assert.ok(code.includes('  branch PROJ-15-spike — github:acme-corp/web'), code.join('\n'));
  assert.ok(!code.some((l) => l.includes('branch PROJ-15-export —')), 'a branch with a pull request is not listed again');
  assert.ok(code.includes('  5 commit(s)'), code.join('\n'));
  assert.ok(r.calls.every((c) => c.url.startsWith(SITE)), 'only Jira is read');
});

test('context: an unreadable development panel prints the Code section unavailable, and its warnings are skipped', () => {
  const r = run([fieldList, task('To Do', 'new'), { url: `${DEV}/summary?issueId=10015`, status: 404, body: 'none' }]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^_Code: unavailable \(HTTP 404\)_$/m);
  assert.equal(section(r.stdout, 'Warnings'), '  (none)');
});

test('context: code while the status is To Do, and an open pull request no comment names, are warned about', () => {
  const r = run([fieldList, task('To Do', 'new'), ...DEV_WITH_CODE]);
  assert.equal(r.status, 0, r.output);
  const warnings = section(r.stdout, 'Warnings');
  assert.match(warnings, /code exists but the status is To Do — move it .*transition --task PROJ-15 --to <status> --dry-run/);
  assert.match(warnings, /pull request https:\/\/github\.com\/acme-corp\/web\/pull\/12 is open but no comment names it/);
  assert.doesNotMatch(warnings, /pull\/9/, 'a closed pull request is not warned about');
});

test('context: an open pull request a comment names draws no warning', () => {
  const comment = { comments: [{ id: '1', author: { displayName: 'Ada' }, body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `PR: ${PR_URL}` }] }] } }] };
  const r = run([fieldList, task('In Progress', 'indeterminate', { comment, [SPRINT_FIELD]: [{ id: 7, name: 'S7', state: 'active' }] }), ...DEV_WITH_CODE]);
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(section(r.stdout, 'Warnings'), /no comment names it/);
});

test('context: an open pull request counts as work going on for the active-sprint warning', () => {
  const r = run([fieldList, task('To Do', 'new'), ...DEV_WITH_CODE]);
  assert.match(section(r.stdout, 'Warnings'), /work is going on but the task is not in an active sprint/);
  const closedOnly = { ...devDetail, body: { detail: [{ pullRequests: [devDetail.body.detail[0].pullRequests[0]], branches: [] }] } };
  const idle = run([fieldList, task('To Do', 'new'), devSummary, closedOnly]);
  assert.doesNotMatch(idle.stdout, /not in an active sprint/);
});

test('context: Goals lists the task\'s goals, then its epic\'s, marked', () => {
  const routes = [fieldList, task('To Do', 'new', { ...epicParent, [GOALS_FIELD]: [{ id: goalAri('G-1') }] }), children, devNone,
    epicGoals([goalAri('G-1'), goalAri('G-2')]), goalById('G-1', 'Ship exports'), goalById('G-2', 'Grow revenue')];
  const r = run(routes);
  assert.equal(r.status, 0, r.output);
  const goals = section(r.stdout, 'Goals').split('\n');
  assert.equal(goals.length, 2, goals.join('\n'));
  assert.match(goals[0], /^ {2}G-1 Ship exports — On track/);
  assert.doesNotMatch(goals[0], /on epic/);
  assert.match(goals[1], /^ {2}G-2 Grow revenue — On track.*\(on epic\)$/);
});

test('context: no goals, a site without a Goals field, and an unreadable epic each say so', () => {
  const none = run([fieldList, task('To Do', 'new', epicParent), children, devNone, epicGoals([])]);
  assert.equal(section(none.stdout, 'Goals'), '  (none on the task or its epic)');
  const noField = run([{ url: `${API}/field`, body: [{ id: SPRINT_FIELD, name: 'Sprint' }] }, task('To Do', 'new'), devNone]);
  assert.equal(section(noField.stdout, 'Goals'), '  (this Jira site has no Goals field)');
  const failing = run([fieldList, task('To Do', 'new', epicParent), children, devNone, { url: `${API}/issue/PROJ-1?fields=${GOALS_FIELD}`, status: 500, body: 'boom' }]);
  assert.equal(failing.status, 0, failing.output);
  assert.match(failing.stdout, /^_Goals: unavailable \(HTTP 500\)_$/m);
});
