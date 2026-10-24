// Jira `edit --add-goals`, `create --goals`, `link` and `unlink` (npm test), against canned answers (fake-fetch.mjs) in a
// copy of examples/installation. `link` posts the from-issue as inwardIssue (POST /issueLink names the
// ends mirrored to GET issuelinks) and confirms the direction by reading the from-issue back; `unlink`
// reads the link first and names it (without credentials a dry run names only the id); `--add-goals`
// links each missing goal through goals_linkWorkItem and confirms it by reading the task's Goals
// field back, sending nothing for an issue that already has every goal; `create --goals` sends no
// Goals field and links the new issue the same way; `edit --goals` is refused. No dry run writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installation, tool, withFakeFetch } from './helpers/installation.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
const GOALS_FIELD = 'customfield_10100';
const goalAri = (n) => `ari:cloud:townsquare:site-1:goal/${n}`;
const BLOCKS = { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' };

function run(routes, args) {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...CREDS, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}

const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');

// -- link -----------------------------------------------------------------------------------

const linkPost = { method: 'POST', url: `${API}/issueLink`, status: 201 };
const linkTypes = { url: `${API}/issueLinkType`, body: { issueLinkTypes: [BLOCKS] } };
/** PROJ-15 before the POST: no link yet (answers the pre-check once). */
const noLinksYet = { url: `${API}/issue/PROJ-15?fields=issuelinks`, times: 1, body: { key: 'PROJ-15', fields: { issuelinks: [] } } };

/** PROJ-15's issuelinks: one Blocks link to PROJ-39, with PROJ-39 on the outward or the inward side. */
const linksOf15 = (side) => ({
  url: `${API}/issue/PROJ-15?fields=issuelinks`,
  body: { key: 'PROJ-15', fields: { issuelinks: [{ id: '10234', type: BLOCKS, [side]: { key: 'PROJ-39', fields: {} } }] } },
});

test('link: posts the from-issue as inwardIssue and confirms the direction by reading it back', () => {
  const r = run([linkTypes, noLinksYet, linkPost, linksOf15('outwardIssue')], ['link', '--from', 'PROJ-15', '--type', 'Blocks', '--to', 'PROJ-39']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(writesOf(r.calls).map((c) => c.body), [{ type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-15' }, outwardIssue: { key: 'PROJ-39' } }]);
  assert.match(r.stdout, /^Linked: PROJ-15 blocks PROJ-39 \(link id 10234\), confirmed by reading PROJ-15 back\.$/m);
});

test('link: a link Jira states the other way round exits 2 and names the unlink', () => {
  const r = run([linkTypes, noLinksYet, linkPost, linksOf15('inwardIssue')], ['link', '--from', 'PROJ-15', '--type', 'Blocks', '--to', 'PROJ-39']);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /LINK DIRECTION NOT CONFIRMED: .*PROJ-15 is blocked by PROJ-39 \(link id 10234\)/);
  assert.match(r.stderr, /unlink --id 10234/);
});

test('link: no link of the type found after the POST exits 2', () => {
  const none = { url: `${API}/issue/PROJ-15?fields=issuelinks`, body: { key: 'PROJ-15', fields: { issuelinks: [] } } };
  const r = run([linkTypes, noLinksYet, linkPost, none], ['link', '--from', 'PROJ-15', '--type', 'Blocks', '--to', 'PROJ-39']);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /LINK NOT CONFIRMED: .*PROJ-15 shows no Blocks link to PROJ-39/);
});

// -- unlink ---------------------------------------------------------------------------------

const linkGet = {
  url: `${API}/issueLink/10234`,
  body: { id: '10234', type: BLOCKS, inwardIssue: { key: 'PROJ-15' }, outwardIssue: { key: 'PROJ-39' } },
};

test('unlink --dry-run reads the link and names it, and deletes nothing', () => {
  const r = run([linkGet], ['unlink', '--id', '10234', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Link that WOULD be removed: PROJ-15 blocks PROJ-39 \(link id 10234\)$/m);
  assert.deepEqual(writesOf(r.calls), []);
  assert.deepEqual(r.calls.map((c) => c.url), [`${API}/issueLink/10234`]);
});

test('unlink deletes the link after reading it', () => {
  const r = run([linkGet, { method: 'DELETE', url: `${API}/issueLink/10234`, status: 204 }], ['unlink', '--id', '10234']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.url}`), [`GET ${API}/issueLink/10234`, `DELETE ${API}/issueLink/10234`]);
  assert.match(r.stdout, /^Unlinked: PROJ-15 blocks PROJ-39 \(link id 10234\)$/m);
});

test('unlink refuses an id that is not digits, before any request', () => {
  const r = run([], ['unlink', '--id', '10234;x', '--dry-run']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /--id is a link id, digits only/);
  assert.deepEqual(r.calls, []);
});

test('unlink of an unknown id is refused, nothing deleted', () => {
  const r = run([{ url: `${API}/issueLink/999`, status: 404, body: { errorMessages: ['No issue link with id 999'] } }], ['unlink', '--id', '999']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /No link with id 999\./);
  assert.deepEqual(writesOf(r.calls), []);
});

// -- edit --add-goals -----------------------------------------------------------------------

/** The Goals field, the site's cloud id, and goals_byKey answering GOAL-55 (or nothing, when `known` is false). */
function goalRoutes(known) {
  const goal = known ? { id: goalAri(55), key: 'GOAL-55', name: 'Faster exports' } : null;
  return [
    { url: `${API}/field`, body: [{ id: GOALS_FIELD, name: 'Goals' }, { id: 'summary', name: 'Summary' }] },
    { url: `${SITE}/_edge/tenant_info`, body: { cloudId: 'site-1' } },
    { graphql: 'OikosGoalByKey', body: { data: { goals_byKey: goal } } },
  ];
}

/** The Goals field of `key` naming goals `ns`; `times` limits how often it answers (before a link). */
const goalsOf = (key, ns, times) => ({
  url: `${API}/issue/${key}?fields=${GOALS_FIELD}`,
  ...(times ? { times } : {}),
  body: { id: key === 'PROJ-15' ? '10015' : '10039', key, fields: { [GOALS_FIELD]: ns.map((n) => ({ id: goalAri(n) })) } },
});

const linkOk = { graphql: 'OikosGoalLink', body: { data: { goals_linkWorkItem: { success: true, errors: [] } } } };
const VARS_15 = { goalId: goalAri(55), workItemId: 'ari:cloud:jira:site-1:issue/10015' };
const linksSent = (calls) => calls.filter((c) => c.url.endsWith('/graphql') && c.body.query.includes('goals_linkWorkItem'));

test('edit --add-goals --dry-run shows the goals_linkWorkItem variables and sends nothing', () => {
  const r = run([...goalRoutes(true), goalsOf('PROJ-15', [42])], ['edit', '--task', 'PROJ-15', '--add-goals', 'GOAL-55', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Goal link that WOULD be sent \(goals_linkWorkItem\) for PROJ-15 \(GOAL-55\): (.+)$/m);
  assert.deepEqual(JSON.parse(r.stdout.match(/\(GOAL-55\): (.+)$/m)[1]), VARS_15);
  assert.deepEqual(linksSent(r.calls), []);
  assert.deepEqual(r.calls.filter((c) => c.method === 'PUT'), []);
});

test('edit --add-goals links through the goals service and confirms by reading the task back', () => {
  const routes = [...goalRoutes(true), goalsOf('PROJ-15', [42], 1), linkOk, goalsOf('PROJ-15', [42, 55])];
  const r = run(routes, ['edit', '--task', 'PROJ-15', '--add-goals', 'GOAL-55']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(linksSent(r.calls).map((c) => c.body.variables), [{ input: VARS_15 }]);
  assert.deepEqual(r.calls.filter((c) => c.method === 'PUT'), [], 'the Goals field is not PUT');
  assert.match(r.stdout, /^Goal GOAL-55 set on PROJ-15 \(confirmed by reading PROJ-15 back\)\.$/m);
});

test('edit --add-goals exits 2 when the task does not show the goal after the link', () => {
  const r = run([...goalRoutes(true), goalsOf('PROJ-15', [42]), linkOk], ['edit', '--task', 'PROJ-15', '--add-goals', 'GOAL-55']);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /GOAL NOT CONFIRMED: the goals service accepted GOAL-55, but PROJ-15 does not show it/);
});

test('edit --add-goals exits 2 when the goals service refuses the link', () => {
  const refused = { graphql: 'OikosGoalLink', body: { data: { goals_linkWorkItem: { success: false, errors: [{ message: 'not allowed' }] } } } };
  const r = run([...goalRoutes(true), goalsOf('PROJ-15', []), refused], ['edit', '--task', 'PROJ-15', '--add-goals', 'GOAL-55']);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /Jira did not link goal GOAL-55 to PROJ-15: not allowed\./);
});

test('edit --add-goals skips a goal already set, and sends nothing when nothing changes', () => {
  const r = run([...goalRoutes(true), goalsOf('PROJ-15', [55])], ['edit', '--task', 'PROJ-15', '--add-goals', 'GOAL-55']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Goal GOAL-55 is already set on PROJ-15\.$/m);
  assert.match(r.stdout, /^Nothing to change\.$/m);
  assert.deepEqual(linksSent(r.calls), []);
  assert.deepEqual(r.calls.filter((c) => c.method === 'PUT'), []);
});

test('edit --add-goals links only the issues that lack the goal', () => {
  const routes = [...goalRoutes(true), goalsOf('PROJ-15', [55]), goalsOf('PROJ-39', [], 1), linkOk, goalsOf('PROJ-39', [55])];
  const r = run(routes, ['edit', '--task', 'PROJ-15,PROJ-39', '--add-goals', 'GOAL-55']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(linksSent(r.calls).map((c) => c.body.variables.input.workItemId), ['ari:cloud:jira:site-1:issue/10039']);
  assert.match(r.stdout, /^1\/1 edited$/m);
});

test('edit --add-goals with an unknown goal is refused with the search hint', () => {
  const r = run(goalRoutes(false), ['edit', '--task', 'PROJ-15', '--add-goals', 'GOAL-404', '--dry-run']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /goal GOAL-404: not found.*goals --search/);
  assert.deepEqual(r.calls.filter((c) => c.method === 'PUT'), []);
});

test('edit --goals is refused before any request: Jira drops a written Goals field', () => {
  for (const args of [['--goals', 'GOAL-42'], ['--goals', ''], ['--add-goals', 'GOAL-55', '--goals', 'GOAL-42']]) {
    const r = run([], ['edit', '--task', 'PROJ-15', ...args, '--dry-run']);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, /--goals cannot set the Goals field \(Jira drops the value\): add a goal with --add-goals; removing one is done in Atlassian Home/);
    assert.deepEqual(r.calls, []);
  }
});

// -- create --goals -------------------------------------------------------------------------

const CREATE = ['create', '--project', 'PROJ', '--summary', 'Export the report', '--goals', 'GOAL-55'];
const created = { method: 'POST', url: `${API}/issue`, status: 201, body: { id: '10077', key: 'PROJ-77' } };
const VARS_77 = { goalId: goalAri(55), workItemId: 'ari:cloud:jira:site-1:issue/10077' };
const issuePosts = (calls) => calls.filter((c) => c.method === 'POST' && c.url === `${API}/issue`);

test('create --goals posts no Goals field and links the goal to the new issue, confirmed by reading it back', () => {
  const r = run([...goalRoutes(true), created, linkOk, goalsOf('PROJ-77', [55])], CREATE);
  assert.equal(r.status, 0, r.output);
  const [post] = issuePosts(r.calls);
  assert.ok(post, r.output);
  assert.equal(post.body.fields[GOALS_FIELD], undefined, 'the Goals field is not in the create payload');
  assert.deepEqual(Object.keys(post.body.fields).sort(), ['issuetype', 'project', 'summary']);
  assert.deepEqual(linksSent(r.calls).map((c) => c.body.variables), [{ input: VARS_77 }]);
  assert.match(r.stdout, /^Created PROJ-77: /m);
  assert.match(r.stdout, /^Goal GOAL-55 set on PROJ-77 \(confirmed by reading PROJ-77 back\)\.$/m);
});

test('create --goals exits 2 naming the created issue when the goal is not confirmed', () => {
  const r = run([...goalRoutes(true), created, linkOk, goalsOf('PROJ-77', [])], CREATE);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /GOAL NOT CONFIRMED: the goals service accepted GOAL-55, but PROJ-77 does not show it/);
  assert.match(r.stderr, /PROJ-77 was created, but a goal was not linked/);
});

test('create --goals --dry-run shows the payload without Goals and the link that would be sent', () => {
  const r = run(goalRoutes(true), [...CREATE, '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.stdout, new RegExp(GOALS_FIELD));
  assert.match(r.stdout, /^ {2}summary: "Export the report"$/m);
  const shown = r.stdout.match(/^Goal link that WOULD be sent \(goals_linkWorkItem\) for the new issue \(GOAL-55\): (.+)$/m);
  assert.ok(shown, r.stdout);
  assert.deepEqual(JSON.parse(shown[1]), { goalId: goalAri(55), workItemId: 'ari:cloud:jira:site-1:issue/<id of the new issue>' });
  assert.deepEqual(issuePosts(r.calls), []);
  assert.deepEqual(linksSent(r.calls), []);
});

test('create --goals with an unknown goal is refused before the issue is created', () => {
  const r = run([...goalRoutes(false), created], CREATE);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /goal GOAL-55: not found.*goals --search/);
  assert.deepEqual(issuePosts(r.calls), []);
  assert.deepEqual(linksSent(r.calls), []);
});

test('unlink --dry-run without credentials names only the id and reaches nothing', () => {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, []);
  const r = tool(dir, 'jira', ['unlink', '--id', '10234', '--dry-run'], fake.env, fake);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Link that WOULD be removed: link id 10234$/m);
  assert.match(r.stdout, /no Jira credentials/);
  assert.deepEqual(fake.calls(), []);
});
