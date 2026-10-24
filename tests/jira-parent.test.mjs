// Jira `edit --parent` and `create --parent` (npm test), against canned answers (fake-fetch.mjs) in a
// copy of examples/installation. The parent is read before the dry run and before the write; a parent
// in another project is refused for the whole command when either project is team-managed (Jira
// answers such a write with HTTP 400), naming every offending issue and the link to make instead, and
// the issues that can take it with an edit of their own; it passes with a note when both are
// company-managed. A same-project parent reads no project.
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

const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');
const projectReads = (calls) => calls.filter((c) => c.url.startsWith(`${API}/project/`)).map((c) => c.url.slice(`${API}/project/`.length));

/** The parent `key` as the check reads it: its project, type, status and summary. */
const parentRoute = (key, summary) => ({
  url: `${API}/issue/${key}?fields=project,issuetype,status,summary`,
  body: { key, fields: { project: { key: key.split('-')[0] }, issuetype: { name: 'Epic' }, status: { name: 'In Progress' }, summary } },
});
const project = (key, team) => ({ url: `${API}/project/${key}`, body: team ? { key, simplified: true, style: 'next-gen' } : { key, simplified: false, style: 'classic' } });
const put = (key) => ({ method: 'PUT', url: `${API}/issue/${key}`, status: 204 });

test('parent: a parent in the same project shows its summary and status, reads no project, and is written', () => {
  const routes = [parentRoute('PROJ-3', 'Reporting'), put('PROJ-7')];
  const dry = run(routes, ['edit', '--task', 'PROJ-7', '--parent', 'PROJ-3', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /^ {2}parent: PROJ-3 — Reporting \[In Progress\]$/m);
  assert.doesNotMatch(dry.stdout, /note:/);
  assert.deepEqual(projectReads(dry.calls), []);
  assert.deepEqual(writesOf(dry.calls), []);

  const real = run(routes, ['edit', '--task', 'PROJ-7', '--parent', 'PROJ-3']);
  assert.equal(real.status, 0, real.output);
  assert.deepEqual(writesOf(real.calls).map((c) => c.body.fields), [{ parent: { key: 'PROJ-3' } }]);
});

test('parent: another project where one side is team-managed is refused in the dry run and before the write', () => {
  const routes = [parentRoute('OTHER-3', 'Platform'), project('PROJ', false), project('OTHER', true), put('PROJ-7')];
  for (const args of [['--dry-run'], []]) {
    const r = run(routes, ['edit', '--task', 'PROJ-7', '--parent', 'OTHER-3', ...args]);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, /^PROJ-7: parent OTHER-3 is in project OTHER; OTHER is team-managed, so a parent must be in PROJ\.$/m);
    assert.match(r.stderr, /^ {2}Set an epic of PROJ as the parent and link the other one: node oikos\/tools\/jira\/cli\.mjs link --from PROJ-7 --type Relates --to OTHER-3 --dry-run$/m);
    assert.doesNotMatch(r.stderr, /can take/, 'no other issue to name');
    assert.deepEqual(writesOf(r.calls), [], 'no PUT');
  }
});

test('parent: a bulk edit with one offending issue refuses every one, each project read once', () => {
  const routes = [parentRoute('OTHER-3', 'Platform'), project('PROJ', true), project('OTHER', false), put('PROJ-7'), put('PROJ-8'), put('OTHER-9')];
  const r = run(routes, ['edit', '--task', 'PROJ-7,OTHER-9,PROJ-8', '--parent', 'OTHER-3']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /refusing --parent OTHER-3, nothing written/);
  assert.match(r.stderr, /^PROJ-7: parent OTHER-3 is in project OTHER; PROJ is team-managed, so a parent must be in PROJ\.$/m);
  assert.match(r.stderr, /^PROJ-8: parent OTHER-3 is in project OTHER; PROJ is team-managed/m);
  assert.doesNotMatch(r.stderr, /^OTHER-9:/m, 'a same-project issue is not named');
  assert.match(r.stderr, /^OTHER-9 can take OTHER-3: run node oikos\/tools\/jira\/cli\.mjs edit --task OTHER-9 --parent OTHER-3 --dry-run$/m,
    'the issues that can take the parent are named with the edit that sets it on them alone');
  assert.deepEqual(writesOf(r.calls), []);
  assert.deepEqual(projectReads(r.calls), ['PROJ'], 'PROJ once for both its issues; a team-managed target settles it without OTHER');
});

test('parent: another project where both are company-managed passes with a note', () => {
  const routes = [parentRoute('OTHER-3', 'Platform'), project('PROJ', false), project('OTHER', false)];
  const r = run(routes, ['edit', '--task', 'PROJ-7', '--parent', 'OTHER-3', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}parent: OTHER-3 — Platform \[In Progress\]$/m);
  assert.match(r.stdout, /^ {2}note: the parent OTHER-3 is in project OTHER, not that of PROJ-7; company-managed projects allow a parent in another project\.$/m);
  assert.deepEqual(writesOf(r.calls), []);
});

test('parent: create checks the parent against the target project', () => {
  const routes = [parentRoute('OTHER-3', 'Platform'), project('PROJ', true), project('OTHER', false), { method: 'POST', url: `${API}/issue`, status: 201, body: { id: '1', key: 'PROJ-77' } }];
  const r = run(routes, ['create', '--project', 'PROJ', '--summary', 'Export the report', '--parent', 'OTHER-3']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /^the new issue in PROJ: parent OTHER-3 is in project OTHER; PROJ is team-managed, so a parent must be in PROJ\.$/m);
  assert.match(r.stderr, /link --from <KEY of the new issue> --type Relates --to OTHER-3 --dry-run/);
  assert.deepEqual(writesOf(r.calls), []);
});

test('parent: a missing parent is an error naming it, nothing written', () => {
  const routes = [
    { url: `${API}/issue/PROJ-404?fields=project,issuetype,status,summary`, status: 404, body: { errorMessages: ['Issue does not exist'] } },
    { url: `${API}/myself`, body: { accountId: 'a-1' } }, put('PROJ-7'),
  ];
  const r = run(routes, ['edit', '--task', 'PROJ-7', '--parent', 'PROJ-404']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /--parent PROJ-404: PROJ-404: does not exist, or the authenticated account cannot see it\./);
  assert.deepEqual(writesOf(r.calls), []);
});
