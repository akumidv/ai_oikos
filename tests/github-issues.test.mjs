// The github-issues connector (npm test): the tool runs in a copy of examples/installation (ACME
// Corp) that lists it under task-tracking, against canned answers (fake-fetch.mjs) — reads and
// pagination, every write's dry run (no mutation, no non-GET call), the guards (exit 3), and one
// real write per command with its request body checked. The pure helpers are called in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { UsageError } from '../tools/common/cli.mjs';
import { parseTask, searchQuery, mentions, attachmentUrls } from '../tools/github-issues/cli.mjs';
import { assertNoCrashNoRequest, installation, tempDir, tool, withFakeFetch } from './helpers/installation.mjs';

const API = 'https://api.github.com';
const TOKEN = { GITHUB_TOKEN: 'ghp_fake_token' };
const NO_PROGRAMS = tempDir('no-programs-');

/** The fixture with github-issues as the tracker, GITHUB_REPO tools, and `extra` settings. */
const withIssues = (extra = {}) => (t) => {
  const lines = Object.entries({ GITHUB_REPO: 'tools', ...extra }).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  return t.replace('task-tracking: [jira]', 'task-tracking: [github-issues]').replace('settings:', `settings:\n${lines}`);
};

function run(dir, routes, args, env = {}) {
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'github-issues', args, { ...TOKEN, ...fake.env, ...env }, fake);
  return { ...r, calls: fake.calls() };
}

const isGraphql = (c) => /\/graphql$/.test(c.url);
const isMutation = (c) => isGraphql(c) && /^\s*mutation\b/.test(c.body?.query || '');
/** The calls that change something: every non-GET except a GraphQL query. */
const writesOf = (calls) => calls.filter((c) => c.method !== 'GET' && !(isGraphql(c) && !isMutation(c)));

function assertDryRun(r) {
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^--- DRY RUN \(requested --dry-run\) ---$/m);
  assert.match(r.stdout, /^DRY RUN — nothing written to GitHub\.$/m);
  assert.deepEqual(writesOf(r.calls), [], 'a dry run makes no non-GET call and no mutation');
  assert.doesNotMatch(r.output, /NETWORK ATTEMPT/);
}

function assertRefused(r, pattern) {
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, /^refused: /m);
  assert.match(r.stderr, pattern);
  assert.deepEqual(writesOf(r.calls), [], 'a refusal writes nothing');
}

const repo = (visibility = 'private', full = 'acme-corp/tools') => ({
  url: `${API}/repos/${full}`,
  body: { full_name: full, private: visibility === 'private', visibility, html_url: `https://github.com/${full}` },
});

const issue = (n, extra = {}) => ({
  id: 1000 + n, node_id: `I_${n}`, number: n, title: `Issue ${n}`, state: 'open', html_url: `https://github.com/acme-corp/tools/issues/${n}`,
  repository_url: `${API}/repos/acme-corp/tools`, user: { login: 'ada' }, assignees: [], labels: [], comments: 0, body: '', ...extra,
});
const issueRoute = (n, extra) => ({ url: `${API}/repos/acme-corp/tools/issues/${n}`, body: issue(n, extra) });
const labelsRoute = (...names) => ({ url: `${API}/repos/acme-corp/tools/labels?per_page=100`, body: names.map((name) => ({ name })) });
const RELATIONS = { graphql: 'OikosIssueRelations', body: { data: { repository: { issue: { parent: null, subIssues: { totalCount: 0, nodes: [] }, blockedBy: { nodes: [] }, blocking: { nodes: [] } } } } } };

// Iterations relative to today, so the active one stays active.
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const PROJECT = {
  graphql: 'OikosProject(',
  body: { data: { organization: { projectV2: {
    id: 'PVT_1', number: 3, title: 'Roadmap', url: 'https://github.com/orgs/acme-corp/projects/3', closed: false,
    fields: { nodes: [
      { __typename: 'ProjectV2Field', id: 'F_title', name: 'Title' },
      { __typename: 'ProjectV2SingleSelectField', id: 'F_status', name: 'Status', options: [
        { id: 'O_todo', name: 'Todo' }, { id: 'O_prog', name: 'In Progress' }, { id: 'O_rev', name: 'In Review' }, { id: 'O_done', name: 'Done' }] },
      { __typename: 'ProjectV2IterationField', id: 'F_iter', name: 'Iteration', configuration: {
        iterations: [{ id: 'it5', title: 'Sprint 5', startDate: day(-3), duration: 14 }, { id: 'it6', title: 'Sprint 6', startDate: day(11), duration: 14 }],
        completedIterations: [{ id: 'it4', title: 'Sprint 4', startDate: day(-17), duration: 14 }] } },
    ] },
  } } } },
};
const statusValue = (name) => ({ __typename: 'ProjectV2ItemFieldSingleSelectValue', name, optionId: `O_${name}`, field: { id: 'F_status', name: 'Status' } });
const iterationValue = (id, title) => ({ __typename: 'ProjectV2ItemFieldIterationValue', title, iterationId: id, startDate: day(-17), duration: 14, field: { id: 'F_iter', name: 'Iteration' } });
/** The issue's items: in project 3 with `values`, or in no project (`values` null). */
const itemsRoute = (n, values) => ({
  graphql: 'OikosIssueItems',
  body: { data: { repository: { issue: {
    id: `I_${n}`, databaseId: 1000 + n, number: n, title: `Issue ${n}`, state: 'OPEN', url: `https://github.com/acme-corp/tools/issues/${n}`,
    projectItems: { nodes: values ? [{ id: `PVTI_${n}`, project: { id: 'PVT_1', number: 3 }, fieldValues: { nodes: values } }] : [] },
  } } } },
});
const MUTATION_OK = (name, data) => ({ graphql: name, body: { data } });

// == pure helpers ===============================================================================

test('parseTask reads owner/repo#12, repo#12, #12, 12 and an issue URL', () => {
  const d = { org: 'acme-corp', repo: 'tools' };
  const key = (v, defaults = d) => parseTask(v, defaults).key;
  assert.equal(key('acme-corp/site#7'), 'acme-corp/site#7');
  assert.equal(key('site#7'), 'acme-corp/site#7');
  assert.equal(key('#7'), 'acme-corp/tools#7');
  assert.equal(key('7'), 'acme-corp/tools#7');
  assert.equal(key('7', { org: null, repo: 'other/tools' }), 'other/tools#7');
  assert.equal(key('https://github.com/acme-corp/site/issues/42'), 'acme-corp/site#42');
  assert.equal(key('https://github.example.com/acme-corp/site/issues/42#issuecomment-1'), 'acme-corp/site#42');
  assert.deepEqual({ ...parseTask('acme-corp/tools#3', d) }, { owner: 'acme-corp', repo: 'tools', number: 3, full: 'acme-corp/tools', key: 'acme-corp/tools#3' });
  assert.throws(() => parseTask('site#7', {}), (e) => e instanceof UsageError && /GITHUB_ORG/.test(e.message));
  assert.throws(() => parseTask('#7', { org: 'acme-corp' }), (e) => e instanceof UsageError && /GITHUB_REPO/.test(e.message));
  for (const bad of ['PROJ-123', 'https://github.com/acme-corp/site/pull/4', '', 'a/b/c#1']) {
    assert.throws(() => parseTask(bad, d), UsageError, bad);
  }
});

test('searchQuery adds is:issue and the scope only when the query has none', () => {
  assert.deepEqual(searchQuery('label:bug', { org: 'acme-corp', repo: 'tools' }), { q: 'label:bug is:issue repo:acme-corp/tools', added: ['is:issue', 'repo:acme-corp/tools'] });
  assert.deepEqual(searchQuery('label:bug', { org: 'acme-corp', repo: null }), { q: 'label:bug is:issue org:acme-corp', added: ['is:issue', 'org:acme-corp'] });
  assert.deepEqual(searchQuery('is:issue repo:acme-corp/site crash', { org: 'acme-corp', repo: 'tools' }), { q: 'is:issue repo:acme-corp/site crash', added: [] });
});

test('mentions lists users and teams outside code; attachmentUrls lists uploaded files', () => {
  assert.deepEqual(mentions('Thanks @ada and @acme-corp/core. Mail ada@acme.example; `@notme`\n```\n@nor-me\n```'), ['ada', 'acme-corp/core']);
  const text = '![x](https://github.com/user-attachments/assets/abc) see https://example.com/a.png and https://private-user-images.githubusercontent.com/1/b.png?jwt=1';
  assert.deepEqual(attachmentUrls(text, 'https://github.com'), ['https://github.com/user-attachments/assets/abc', 'https://private-user-images.githubusercontent.com/1/b.png?jwt=1']);
});

// == the connector guard and credentials ========================================================

test('github-issues unlisted is a usage error, before any credential or request', () => {
  const dir = installation((t) => t);
  const r = tool(dir, 'github-issues', ['whoami'], TOKEN);
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /^github-issues: github-issues is not a connector of this installation/m);
});

test('github-issues without a credential names GITHUB_TOKEN and the write permissions, before any request', () => {
  const dir = installation(withIssues());
  for (const args of [['whoami'], ['info', '--task', '#12'], ['search', '--query', 'bug'], ['comment', '--task', '#12', '--text', 'Done.'],
    ['transition', '--task', '#12', '--to', 'In Progress', '--dry-run'], ['create', '--summary', 'A task', '--dry-run'], ['link', '--from', '#1', '--type', 'blocks', '--to', '#2', '--dry-run']]) {
    const r = tool(dir, 'github-issues', args, { PATH: NO_PROGRAMS });
    assertNoCrashNoRequest(r);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.output}`);
    assert.match(r.stderr, /^github-issues: no GitHub credential$/m);
    assert.match(r.stderr, /GITHUB_TOKEN\s+missing/);
    assert.match(r.stderr, /Issues read\/write/);
    assert.doesNotMatch(r.stdout, /DRY RUN/, 'never a dry run in place of the command');
  }
});

test('comment --dry-run previews without a credential, and says the write needs it', () => {
  const dir = installation(withIssues());
  const r = tool(dir, 'github-issues', ['comment', '--task', '#12', '--text', 'Done, @ada.', '--dry-run'], { PATH: NO_PROGRAMS });
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /--- DRY RUN \(requested --dry-run\) ---/);
  assert.match(r.stdout, /^Target: +https:\/\/github\.com\/acme-corp\/tools\/issues\/12$/m);
  assert.match(r.stdout, /^will notify @ada$/m);
  assert.match(r.stdout, /no GitHub credentials — the write itself needs them/);
});

// == reads ======================================================================================

test('whoami shows the scopes, and flags a read-only token', () => {
  const dir = installation(withIssues({ GITHUB_PROJECT: 3 }));
  const readOnly = run(dir, [{ url: `${API}/user`, headers: { 'X-OAuth-Scopes': 'read:org, read:project' }, body: { login: 'ada', name: 'Ada' } }], ['whoami']);
  assert.equal(readOnly.status, 0, readOnly.output);
  assert.match(readOnly.stdout, /^@ada \(Ada\) via token \(env\) on https:\/\/api\.github\.com$/m);
  assert.match(readOnly.stdout, /^Scopes: read:org, read:project$/m);
  assert.match(readOnly.stdout, /writes configured, token read-only/);
  assert.match(readOnly.stdout, /lacks the project scope/);
  const fine = run(dir, [{ url: `${API}/user`, body: { login: 'ada', name: 'Ada' } }], ['whoami']);
  assert.match(fine.stdout, /^Scopes: not reported — fine-grained token or gh$/m);
  assert.doesNotMatch(fine.stdout, /read-only/);
  const full = run(dir, [{ url: `${API}/user`, headers: { 'X-OAuth-Scopes': 'repo, project' }, body: { login: 'ada' } }], ['whoami']);
  assert.doesNotMatch(full.stdout, /WARNING/);
});

test('info reads the issue, its comments over Link pages, and its relations', () => {
  const dir = installation(withIssues());
  const page2 = `${API}/repositories/1/issues/12/comments?per_page=100&page=2`;
  const r = run(dir, [
    issueRoute(12, { comments: 2, labels: [{ name: 'In Progress' }, { name: 'bug' }], assignees: [{ login: 'bob' }], body: 'Do it.\n![s](https://github.com/user-attachments/assets/a1)' }),
    { url: `${API}/repos/acme-corp/tools/issues/12/comments?per_page=100`, headers: { Link: `<${page2}>; rel="next"` }, body: [{ user: { login: 'bob' }, created_at: '2026-10-01T00:00:00Z', body: 'First.' }] },
    { url: page2, body: [{ user: { login: 'ada' }, created_at: '2026-10-02T00:00:00Z', body: 'Second.' }] },
    { graphql: 'OikosIssueRelations', body: { data: { repository: { issue: {
      parent: { number: 1, title: 'Epic', state: 'OPEN', repository: { nameWithOwner: 'acme-corp/tools' }, assignees: { nodes: [] }, subIssues: { nodes: [] } },
      subIssues: { totalCount: 0, nodes: [] }, blockedBy: { nodes: [{ number: 9, title: 'Base', state: 'OPEN', repository: { nameWithOwner: 'acme-corp/tools' }, assignees: { nodes: [] } }] }, blocking: { nodes: [] },
    } } } } },
  ], ['info', '--task', '#12']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Task: acme-corp\/tools#12$/m);
  assert.match(r.stdout, /Status: In Progress \(labels\)/);
  assert.match(r.stdout, /^Parent: acme-corp\/tools#1 \[open\] Epic$/m);
  assert.match(r.stdout, /^ {2}acme-corp\/tools#9 \[open\] Base$/m);
  assert.match(r.stdout, /^Comments \(2\):$/m);
  assert.match(r.stdout, /Second\./);
  assert.match(r.stdout, /\[1\] https:\/\/github\.com\/user-attachments\/assets\/a1 — NOT READ/);
  assert.deepEqual(writesOf(r.calls), []);
});

test('search adds is:issue and the repository, says so, and follows Link pages', () => {
  const dir = installation(withIssues());
  const page2 = `${API}/search/issues?q=x&page=2`;
  const r = run(dir, [
    { match: '^https://api\\.github\\.com/search/issues\\?q=label', headers: { Link: `<${page2}>; rel="next"` }, body: { total_count: 3, items: [issue(1), issue(2)] } },
    { url: page2, body: { total_count: 3, items: [issue(3)] } },
  ], ['search', '--query', 'label:bug']);
  assert.equal(r.status, 0, r.output);
  assert.equal(new URL(r.calls[0].url).searchParams.get('q'), 'label:bug is:issue repo:acme-corp/tools');
  assert.match(r.stdout, /^# added to the query: is:issue repo:acme-corp\/tools/m);
  assert.match(r.stdout, /^acme-corp\/tools#3 \[open\] Issue 3$/m);
  assert.match(r.stdout, /^3 issue\(s\)$/m);
});

test('sprints lists the iterations; sprint groups the active one by Status', () => {
  const dir = installation(withIssues({ GITHUB_PROJECT: 3 }));
  const sprints = run(dir, [PROJECT], ['sprints']);
  assert.equal(sprints.status, 0, sprints.output);
  assert.match(sprints.stdout, /^it5 +\[active\] Sprint 5/m);
  assert.match(sprints.stdout, /^it6 +\[future\] Sprint 6/m);
  assert.doesNotMatch(sprints.stdout, /Sprint 4/);
  const node = (n, status, it) => ({ id: `PVTI_${n}`, content: { __typename: 'Issue', number: n, title: `Issue ${n}`, state: 'OPEN', repository: { nameWithOwner: 'acme-corp/tools' }, assignees: { nodes: [{ login: 'ada' }] } },
    fieldValues: { nodes: [statusValue(status), iterationValue(it, it)] } });
  const sprint = run(dir, [PROJECT, { graphql: 'OikosProjectItems', body: { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [node(1, 'Todo', 'it5'), node(2, 'Done', 'it5'), node(3, 'Todo', 'it6')] } } } } }], ['sprint']);
  assert.equal(sprint.status, 0, sprint.output);
  assert.match(sprint.stdout, /^Iteration it5: Sprint 5 \[active\]/m);
  assert.match(sprint.stdout, /^## Todo \(1\)$/m);
  assert.match(sprint.stdout, /^## Done \(1\)$/m);
  assert.match(sprint.stdout, /^ {2}@ada +1\/2 done$/m);
  assert.doesNotMatch(sprint.stdout, /Issue 3/);
});

test('sprints need GITHUB_PROJECT, and say so', () => {
  const dir = installation(withIssues());
  const r = run(dir, [], ['sprints']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /set GITHUB_PROJECT/);
  assert.deepEqual(r.calls, []);
});

// == comment: dry run, public repositories, write ==============================================

test('comment: the dry run reads, a public repository needs GITHUB_PUBLIC_REPOS, the write posts the body', () => {
  const routes = (visibility) => [repo(visibility), issueRoute(12), { method: 'POST', url: `${API}/repos/acme-corp/tools/issues/12/comments`, status: 201, body: { html_url: 'https://github.com/acme-corp/tools/issues/12#c1' } }];
  const args = ['comment', '--task', 'acme-corp/tools#12', '--text', 'Fixed in the last build, @bob.'];
  const unlisted = installation(withIssues());
  assertRefused(run(unlisted, routes('public'), [...args, '--dry-run']), /acme-corp\/tools is a PUBLIC repository .* GITHUB_PUBLIC_REPOS/);
  assertRefused(run(unlisted, routes('public'), args), /GITHUB_PUBLIC_REPOS/);
  const listed = installation(withIssues({ GITHUB_PUBLIC_REPOS: 'ACME-corp/Tools' }));
  const dry = run(listed, routes('public'), [...args, '--dry-run']);
  assertDryRun(dry);
  assert.match(dry.stdout, /^PUBLIC repository acme-corp\/tools — everything written is visible to anyone$/m);
  assert.match(dry.stdout, /^will notify @bob$/m);
  assert.match(dry.stdout, /^Issue: +acme-corp\/tools#12 — Issue 12$/m);
  const privateDry = run(unlisted, routes('private'), [...args, '--dry-run']);
  assertDryRun(privateDry);
  assert.doesNotMatch(privateDry.stdout, /PUBLIC/);
  const write = run(unlisted, routes('private'), args);
  assert.equal(write.status, 0, write.output);
  assert.deepEqual(writesOf(write.calls), [{ method: 'POST', url: `${API}/repos/acme-corp/tools/issues/12/comments`, body: { body: 'Fixed in the last build, @bob.' } }]);
});

test('comment refuses non-Latin text unless --allow-non-english', () => {
  const dir = installation(withIssues());
  const r = run(dir, [], ['comment', '--task', '#12', '--text', 'Готово', '--dry-run']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /--allow-non-english/);
});

// == transition =================================================================================

test('transition with labels: dry run states the order, the write adds then removes', () => {
  const dir = installation(withIssues());
  const routes = [
    repo(), issueRoute(12, { labels: [{ name: 'todo' }, { name: 'bug' }] }), labelsRoute('Todo', 'In Progress', 'In Review', 'bug'),
    { method: 'POST', url: `${API}/repos/acme-corp/tools/issues/12/labels`, body: [] },
    { method: 'DELETE', url: `${API}/repos/acme-corp/tools/issues/12/labels/todo`, body: [] },
  ];
  const dry = run(dir, routes, ['transition', '--task', '#12', '--to', 'in progress', '--dry-run']);
  assertDryRun(dry);
  assert.match(dry.stdout, /^Source: +labels \(no GITHUB_PROJECT\)$/m);
  assert.match(dry.stdout, /^Would move: todo → In Progress$/m);
  assert.match(dry.stdout, /1\. add label 'In Progress'\n {2}2\. remove label 'todo'/);
  const write = run(dir, routes, ['transition', '--task', '#12', '--to', 'in progress']);
  assert.equal(write.status, 0, write.output);
  assert.deepEqual(writesOf(write.calls), [
    { method: 'POST', url: `${API}/repos/acme-corp/tools/issues/12/labels`, body: { labels: ['In Progress'] } },
    { method: 'DELETE', url: `${API}/repos/acme-corp/tools/issues/12/labels/todo`, body: null },
  ]);
});

test('transition refuses review, closing and moves from review on — exit 3 with the link', () => {
  const dir = installation(withIssues());
  const url = /https:\/\/github\.com\/acme-corp\/tools\/issues\/12/;
  for (const to of ['In Review', 'Done', 'Closed', 'reopen']) {
    const r = run(dir, [], ['transition', '--task', '#12', '--to', to, '--dry-run']);
    assertRefused(r, url);
    assert.deepEqual(r.calls, [], `${to}: refused before any request`);
  }
  const fromReview = run(dir, [repo(), issueRoute(12, { labels: [{ name: 'In Review' }] })], ['transition', '--task', '#12', '--to', 'Todo', '--dry-run']);
  assertRefused(fromReview, /'In Review', not a status open to an agent/);
  const closed = run(dir, [repo(), issueRoute(12, { state: 'closed', labels: [{ name: 'Todo' }] })], ['transition', '--task', '#12', '--to', 'In Progress', '--dry-run']);
  assertRefused(closed, /closed — reopening is a person's move/);
});

test('transition with GITHUB_PROJECT sets the Status field; the dry run sends no mutation', () => {
  const dir = installation(withIssues({ GITHUB_PROJECT: 3 }));
  const routes = [repo(), issueRoute(12), PROJECT, itemsRoute(12, [statusValue('Todo')]), MUTATION_OK('OikosSetField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_12' } } })];
  const dry = run(dir, routes, ['transition', '--task', '#12', '--to', 'In Progress', '--dry-run']);
  assertDryRun(dry);
  assert.ok(dry.calls.some((c) => isGraphql(c)), 'the dry run read the project');
  assert.match(dry.stdout, /^Source: +project 3 "Roadmap" field Status$/m);
  assert.match(dry.stdout, /^Would move: Todo → In Progress$/m);
  const write = run(dir, routes, ['transition', '--task', '#12', '--to', 'In Progress']);
  assert.equal(write.status, 0, write.output);
  const [m] = writesOf(write.calls);
  assert.equal(writesOf(write.calls).length, 1);
  assert.deepEqual(m.body.variables, { input: { projectId: 'PVT_1', itemId: 'PVTI_12', fieldId: 'F_status', value: { singleSelectOptionId: 'O_prog' } } });
  const review = run(dir, [repo(), issueRoute(12), PROJECT, itemsRoute(12, [statusValue('In Review')])], ['transition', '--task', '#12', '--to', 'Todo', '--dry-run']);
  assertRefused(review, /'In Review', not a status open to an agent/);
});

// == create =====================================================================================

test('create: unknown labels are refused, --create-labels creates them first; the write posts the issue and the sub-issue', () => {
  const dir = installation(withIssues());
  const routes = [
    repo(), labelsRoute('bug'), { url: `${API}/user`, body: { login: 'ada' } }, issueRoute(1),
    { method: 'POST', url: `${API}/repos/acme-corp/tools/labels`, status: 201, body: { name: 'oikos' } },
    { method: 'POST', url: `${API}/repos/acme-corp/tools/issues`, status: 201, body: issue(77) },
    { method: 'POST', url: `${API}/repos/acme-corp/tools/issues/1/sub_issues`, status: 201, body: {} },
  ];
  const args = ['create', '--summary', 'Add the export', '--description', 'Ask @bob first.', '--labels', 'BUG,oikos', '--assignee', 'me', '--parent', '#1'];
  assertRefused(run(dir, routes, [...args, '--dry-run']), /unknown label\(s\) in acme-corp\/tools: oikos .* --create-labels/);
  const dry = run(dir, routes, [...args, '--create-labels', '--dry-run']);
  assertDryRun(dry);
  assert.match(dry.stdout, /^ {2}labels: bug, oikos {2}\(creates label\(s\) oikos first — --create-labels\)$/m);
  assert.match(dry.stdout, /^ {2}assignees: @ada$/m);
  assert.match(dry.stdout, /then as a sub-issue of acme-corp\/tools#1 — Issue 1/);
  assert.match(dry.stdout, /^will notify @bob$/m);
  const write = run(dir, routes, [...args, '--create-labels']);
  assert.equal(write.status, 0, write.output);
  assert.deepEqual(writesOf(write.calls), [
    { method: 'POST', url: `${API}/repos/acme-corp/tools/labels`, body: { name: 'oikos' } },
    { method: 'POST', url: `${API}/repos/acme-corp/tools/issues`, body: { title: 'Add the export', body: 'Ask @bob first.', labels: ['bug', 'oikos'], assignees: ['ada'] } },
    { method: 'POST', url: `${API}/repos/acme-corp/tools/issues/1/sub_issues`, body: { sub_issue_id: 1077 } },
  ]);
  assert.match(write.stdout, /^Created acme-corp\/tools#77 \(sub-issue of acme-corp\/tools#1\)/m);
});

test('create refuses a review status label and a review --status', () => {
  const dir = installation(withIssues());
  assertRefused(run(dir, [repo()], ['create', '--summary', 'X', '--labels', 'In Review', '--dry-run']), /status label not open to an agent/);
  const project = installation(withIssues({ GITHUB_PROJECT: 3 }));
  assertRefused(run(project, [], ['create', '--summary', 'X', '--add-to-project', '--status', 'Done', '--dry-run']), /starts only in a status open to an agent/);
});

// == edit =======================================================================================

test('edit: --max caps a query, status labels and --state are refused, the write patches each issue', () => {
  const dir = installation(withIssues());
  const search = { match: '^https://api\\.github\\.com/search/issues\\?', body: { total_count: 2, items: [issue(12, { labels: [{ name: 'old' }] }), issue(13)] } };
  const capped = run(dir, [search], ['edit', '--query', 'label:old', '--max', '1', '--add-labels', 'new', '--dry-run']);
  assert.equal(capped.status, 1, capped.output);
  assert.match(capped.stderr, /more than --max 1/);
  assertRefused(run(dir, [repo(), labelsRoute('In Review'), issueRoute(12)], ['edit', '--task', '#12', '--add-labels', 'In Review', '--dry-run']), /status moves through transition/);
  assertRefused(run(dir, [], ['edit', '--task', '#12', '--state', 'closed', '--dry-run']), /never closes or reopens .*issues\/12/);
  const routes = [
    search, repo(), labelsRoute('old', 'new'), issueRoute(12, { labels: [{ name: 'old' }] }), issueRoute(13),
    { method: 'PATCH', match: '/issues/1[23]$', body: {} }, { method: 'POST', match: '/issues/1[23]/labels$', body: [] },
    { method: 'DELETE', url: `${API}/repos/acme-corp/tools/issues/12/labels/old`, body: [] },
  ];
  const args = ['edit', '--query', 'label:old', '--add-labels', 'new', '--remove-labels', 'old', '--assignee', 'none'];
  const dry = run(dir, routes, [...args, '--dry-run']);
  assertDryRun(dry);
  assert.match(dry.stdout, /^Would edit 2 issue\(s\) in acme-corp\/tools:$/m);
  assert.match(dry.stdout, /^ {2}acme-corp\/tools#12 — Issue 12 {2}\{\+new -old\}$/m);
  assert.match(dry.stdout, /^ {2}acme-corp\/tools#13 — Issue 13 {2}\{\+new\}$/m);
  const write = run(dir, routes, args);
  assert.equal(write.status, 0, write.output);
  assert.deepEqual(writesOf(write.calls), [
    { method: 'PATCH', url: `${API}/repos/acme-corp/tools/issues/12`, body: { assignees: [] } },
    { method: 'POST', url: `${API}/repos/acme-corp/tools/issues/12/labels`, body: { labels: ['new'] } },
    { method: 'DELETE', url: `${API}/repos/acme-corp/tools/issues/12/labels/old`, body: null },
    { method: 'PATCH', url: `${API}/repos/acme-corp/tools/issues/13`, body: { assignees: [] } },
    { method: 'POST', url: `${API}/repos/acme-corp/tools/issues/13/labels`, body: { labels: ['new'] } },
  ]);
  assert.match(write.stdout, /^2\/2 edited$/m);
});

// == move-to-sprint =============================================================================

test('move-to-sprint: an issue outside the project needs --add-to-project; the write adds it and sets the iteration', () => {
  const dir = installation(withIssues({ GITHUB_PROJECT: 3 }));
  const routes = [repo(), PROJECT, itemsRoute(12, null),
    MUTATION_OK('OikosAddItem', { addProjectV2ItemById: { item: { id: 'PVTI_new' } } }),
    MUTATION_OK('OikosSetField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_new' } } })];
  assertRefused(run(dir, routes, ['move-to-sprint', '--sprint', 'Sprint 5', '--task', '#12', '--dry-run']), /not in project 3 "Roadmap" — pass --add-to-project/);
  const args = ['move-to-sprint', '--sprint', 'Sprint 5', '--task', '#12', '--add-to-project'];
  const dry = run(dir, routes, [...args, '--dry-run']);
  assertDryRun(dry);
  assert.match(dry.stdout, /^Target: +Iteration "Sprint 5" \(it5, active,/m);
  assert.match(dry.stdout, /acme-corp\/tools#12 — Issue 12 {2}\[not in the project → "Sprint 5"\] — added to the project first \(--add-to-project\)/);
  const write = run(dir, routes, args);
  assert.equal(write.status, 0, write.output);
  const writes = writesOf(write.calls);
  assert.deepEqual(writes.map((c) => c.body.variables), [
    { input: { projectId: 'PVT_1', contentId: 'I_12' } },
    { input: { projectId: 'PVT_1', itemId: 'PVTI_new', fieldId: 'F_iter', value: { iterationId: 'it5' } } },
  ]);
});

test('move-to-sprint --backlog clears the iteration; a closed iteration is refused', () => {
  const dir = installation(withIssues({ GITHUB_PROJECT: 3 }));
  const routes = [repo(), PROJECT, itemsRoute(12, [iterationValue('it5', 'Sprint 5')]), MUTATION_OK('OikosClearField', { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_12' } } })];
  const dry = run(dir, routes, ['move-to-sprint', '--backlog', '--task', '#12', '--dry-run']);
  assertDryRun(dry);
  assert.match(dry.stdout, /\["Sprint 5" → backlog\]/);
  const write = run(dir, routes, ['move-to-sprint', '--backlog', '--task', '#12']);
  assert.equal(write.status, 0, write.output);
  assert.deepEqual(writesOf(write.calls).map((c) => c.body.variables), [{ input: { projectId: 'PVT_1', itemId: 'PVTI_12', fieldId: 'F_iter' } }]);
  const closed = run(dir, routes, ['move-to-sprint', '--sprint', 'Sprint 4', '--task', '#12', '--dry-run']);
  assert.equal(closed.status, 1, closed.output);
  assert.match(closed.stderr, /"Sprint 4" is closed/);
});

// == link =======================================================================================

test('link: blocks is a dependency on the blocked issue by database id; other types say "mention it in a comment"', () => {
  const dir = installation(withIssues());
  const routes = [repo(), issueRoute(15), issueRoute(39), { method: 'POST', url: `${API}/repos/acme-corp/tools/issues/39/dependencies/blocked_by`, status: 201, body: {} }];
  const args = ['link', '--from', '#15', '--type', 'blocks', '--to', '#39'];
  const dry = run(dir, routes, [...args, '--dry-run']);
  assertDryRun(dry);
  assert.match(dry.stdout, /^Would link: acme-corp\/tools#15 —blocks→ acme-corp\/tools#39$/m);
  assert.match(dry.stdout, /^As: acme-corp\/tools#39 is blocked by acme-corp\/tools#15 \(issue dependency\)/m);
  const write = run(dir, routes, args);
  assert.equal(write.status, 0, write.output);
  assert.deepEqual(writesOf(write.calls), [{ method: 'POST', url: `${API}/repos/acme-corp/tools/issues/39/dependencies/blocked_by`, body: { issue_id: 1015 } }]);
  const child = run(dir, [repo(), issueRoute(15), issueRoute(39), { method: 'POST', url: `${API}/repos/acme-corp/tools/issues/39/sub_issues`, status: 201, body: {} }], ['link', '--from', '#15', '--type', 'child', '--to', '#39']);
  assert.equal(child.status, 0, child.output);
  assert.deepEqual(writesOf(child.calls), [{ method: 'POST', url: `${API}/repos/acme-corp/tools/issues/39/sub_issues`, body: { sub_issue_id: 1015 } }]);
  const relates = run(dir, [], ['link', '--from', '#15', '--type', 'relates', '--to', '#39', '--dry-run']);
  assert.equal(relates.status, 1, relates.output);
  assert.match(relates.stderr, /mention it in a comment/);
  assert.deepEqual(relates.calls, []);
});

// == not offered ================================================================================

test('attach and goals are not offered: one line, exit 1, no request', () => {
  const dir = installation(withIssues());
  for (const args of [['attach', '--task', '#12', '--file', 'a.png'], ['goals'], ['goal', '--key', 'GOAL-1'], ['goal-comment', '--key', 'GOAL-1', '--text', 'x']]) {
    const r = run(dir, [], args);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, new RegExp(`^github-issues: ${args[0]} is not offered by this connector — `, 'm'));
    assert.deepEqual(r.calls, []);
  }
  assert.match(run(dir, [], ['attach', '--task', '#12']).stderr, /F2.*https:\/\/github\.com\/acme-corp\/tools\/issues\/12/);
});

test('the help of github-issues lists --dry-run on exactly the write commands', () => {
  const dir = installation(withIssues());
  const writes = ['create', 'edit', 'comment', 'transition', 'move-to-sprint', 'link'];
  const usage = tool(dir, 'github-issues', ['--help']);
  const names = [...usage.stdout.matchAll(/^ {2}([a-z][a-z-]*)\s/gm)].map((m) => m[1]);
  assert.ok(names.length > writes.length, usage.output);
  for (const name of names) {
    const help = tool(dir, 'github-issues', [name, '--help']).stdout;
    assert.equal(/^ {2}--dry-run$/m.test(help), writes.includes(name), name);
  }
});

test('attachment downloads a link the issue carries, and only such a link', () => {
  const dir = installation(withIssues());
  const file = 'https://github.com/user-attachments/assets/a1';
  const routes = [issueRoute(12, { body: `![s](${file})` }), { url: file, headers: { 'content-type': 'image/png' }, body: 'PNGDATA' }];
  const out = join(dir, 'out');
  const r = run(dir, routes, ['attachment', '--task', '#12', '--id', '1', '--dir', out]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /\(image\/png, 7 bytes\) → .*a1\.png$/m);
  const other = run(dir, routes, ['attachment', '--task', '#12', '--url', 'https://example.com/x.png']);
  assert.equal(other.status, 1, other.output);
  assert.match(other.stderr, /has no attachment/);
  assert.ok(!other.calls.some((c) => c.url.startsWith('https://example.com')), 'the credential goes to GitHub only');
});
