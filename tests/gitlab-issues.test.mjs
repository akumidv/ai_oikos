// The gitlab-issues connector (npm test): an installation from the fixture with gitlab-issues listed
// under task-tracking, the tool run as an agent runs it, GitLab answered from canned routes
// (helpers/fake-fetch.mjs) — never the network. Reads and paging, every write's dry run (GET only),
// every guard refusal (exit 3), --max, unknown labels, and one real write per command with its body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE, assertNoCrashNoRequest, installation, tool, withFakeFetch } from './helpers/installation.mjs';

const { parseTask, mentions, statusOf, uploadsIn } = await import(pathToFileURL(join(CORE, 'tools', 'gitlab-issues', 'cli.mjs')).href);

const SITE = 'https://gitlab.example.com';
const API = `${SITE}/api/v4`;
const P = `${API}/projects/acme-corp%2Ftools`;
const TOKEN = { GITLAB_TOKEN: 'glpat-fake-token' };
const SETTINGS = {
  GITLAB_URL: SITE,
  GITLAB_PROJECT: 'acme-corp/tools',
  GITLAB_AGENT_STATUSES: 'To Do, In Progress',
  GITLAB_REVIEW_STATUSES: 'Review',
};

/** An installation listing gitlab-issues, with the settings (a key set to null is left out). */
function gitlabInstall(overrides = {}) {
  const settings = { ...SETTINGS, ...overrides };
  const lines = Object.entries(settings).filter(([, v]) => v !== null).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  return installation((t) => t.replace('task-tracking: [jira]', 'task-tracking: [gitlab-issues]').replace('settings:', `settings:\n${lines}`));
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A GET route for `path` with or without a query string. */
const get = (path, body, extra = {}) => ({ match: `^${esc(path)}(\\?|$)`, body, ...extra });

const issue = (iid, more = {}) => ({
  id: 1000 + iid, iid, project_id: 7, title: `Issue ${iid}`, state: 'opened', labels: [], assignees: [],
  references: { full: `acme-corp/tools#${iid}` }, web_url: `${SITE}/acme-corp/tools/-/issues/${iid}`, ...more,
});

const LABELS = get(`${P}/labels`, [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'Review' }, { name: 'backend' }, { name: 'Bug' }]);

/** Run the tool against `routes`: { r, calls }. */
function run(dir, args, routes, env = TOKEN) {
  const ff = withFakeFetch(dir, routes);
  const r = tool(dir, 'gitlab-issues', args, { ...env, ...ff.env }, { preload: ff.preload });
  return { r, calls: ff.calls() };
}

const onlyGets = (calls) => assert.deepEqual(calls.filter((c) => c.method !== 'GET'), [], 'a dry run makes no non-GET request');
const writes = (calls) => calls.filter((c) => c.method !== 'GET');

// == the parser and other pure pieces ==

test('parseTask reads group/project#12, #12 and 12 with the default project, and issue URLs', () => {
  const base = SITE;
  assert.deepEqual(parseTask('acme-corp/tools#12'), { project: 'acme-corp/tools', iid: 12 });
  assert.deepEqual(parseTask('acme-corp/sub/tools#3'), { project: 'acme-corp/sub/tools', iid: 3 });
  assert.deepEqual(parseTask('#12', { project: 'acme-corp/tools' }), { project: 'acme-corp/tools', iid: 12 });
  assert.deepEqual(parseTask('12', { project: 'acme-corp/tools' }), { project: 'acme-corp/tools', iid: 12 });
  assert.deepEqual(parseTask(`${SITE}/acme-corp/sub/tools/-/issues/12`, { base }), { project: 'acme-corp/sub/tools', iid: 12 });
  assert.deepEqual(parseTask(`${SITE}/acme-corp/tools/-/work_items/5#note_1`, { base }), { project: 'acme-corp/tools', iid: 5 });
  assert.deepEqual(parseTask('https://example.com/gitlab/acme-corp/tools/-/issues/9', { base: 'https://example.com/gitlab' }), { project: 'acme-corp/tools', iid: 9 });
  assert.throws(() => parseTask('#12'), /names no project.*GITLAB_PROJECT/);
  assert.throws(() => parseTask('https://other.example.com/a/b/-/issues/1', { base }), /not on GITLAB_URL/);
  assert.throws(() => parseTask(`${SITE}/acme-corp/tools/-/merge_requests/1`, { base }), /not an issue URL/);
  assert.throws(() => parseTask(`${SITE}/groups/acme-corp/-/work_items/1`, { base }), /group work item/);
  assert.throws(() => parseTask('PROJ-123'), /not a task reference/);
});

test('mentions, status labels and uploads', () => {
  assert.deepEqual(mentions('Thanks @ada and @bob.smith. Mail ada@example.com, `@code` is not one'), ['ada', 'bob.smith']);
  const policy = { agent: ['To Do', 'In Progress'], review: ['Review'] };
  assert.equal(statusOf(issue(1, { labels: ['backend', 'in progress'] }), policy), 'in progress');
  assert.equal(statusOf(issue(1, { labels: ['backend'] }), policy), 'open');
  assert.equal(statusOf(issue(1, { state: 'closed', labels: ['Review'] }), policy), 'closed');
  assert.deepEqual(uploadsIn('see ![shot](/uploads/0123456789abcdef0123456789abcdef/screen%20one.png)', 'again /uploads/0123456789abcdef0123456789abcdef/screen%20one.png')
    .map((u) => u.name), ['screen one.png']);
});

// == the connector and credential checks ==

test('gitlab-issues not listed in the installation is a usage error, before any request', () => {
  const dir = installation((t) => t.replace('settings:', `settings:\n  GITLAB_URL: ${SITE}`));
  const r = tool(dir, 'gitlab-issues', ['whoami'], TOKEN);
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /^gitlab-issues: gitlab-issues is not a connector of this installation/m);
});

test('without GITLAB_TOKEN reads, writes and their dry runs are usage errors naming the key, before any request', () => {
  const dir = gitlabInstall();
  for (const args of [
    ['whoami'], ['search', '--labels', 'bug'], ['info', '--task', '#12'],
    ['comment', '--task', '#12', '--text', 'Done.'],
    ['transition', '--task', '#12', '--to', 'In Progress', '--dry-run'],
    ['create', '--summary', 'A task', '--dry-run'],
    ['edit', '--task', '#12', '--add-labels', 'backend', '--dry-run'],
    ['move-to-sprint', '--sprint', '5', '--task', '#12', '--dry-run'],
    ['link', '--from', '#12', '--type', 'blocks', '--to', '#13', '--dry-run'],
  ]) {
    const r = tool(dir, 'gitlab-issues', args, {});
    assertNoCrashNoRequest(r);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.output}`);
    assert.match(r.stderr, /^gitlab-issues: no GITLAB_TOKEN$/m, args.join(' '));
    assert.match(r.stderr, /GITLAB_TOKEN\s+missing/);
    assert.match(r.stderr, /scope api for the writes/);
    assert.doesNotMatch(r.stdout, /DRY RUN/, 'never a dry run in place of the command');
  }
  const noSite = gitlabInstall({ GITLAB_URL: null });
  const r = tool(noSite, 'gitlab-issues', ['search'], TOKEN);
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /^gitlab-issues: no GITLAB_URL$/m);
});

test('comment --dry-run previews without credentials and says the write needs them', () => {
  const dir = gitlabInstall();
  const r = tool(dir, 'gitlab-issues', ['comment', '--task', '#12', '--text', 'Done, @ada please check.', '--dry-run'], {});
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^--- DRY RUN \(requested --dry-run\) ---$/m);
  assert.match(r.stdout, /^Task: {4}acme-corp\/tools#12$/m);
  assert.match(r.stdout, /^will notify @ada$/m);
  assert.match(r.stdout, /^DRY RUN — nothing written to GitLab\.$/m);
  assert.match(r.stdout, /no GitLab credentials — the write itself needs them/);
});

// == reads ==

test('whoami reports the scopes and warns when writes lack scope api; says when scopes are not reported', () => {
  const dir = gitlabInstall();
  const me = get(`${API}/user`, { id: 1, username: 'ada', name: 'Ada' });
  const { r } = run(dir, ['whoami'], [me, get(`${API}/personal_access_tokens/self`, { scopes: ['read_api'] })]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^@ada \(Ada\) on https:\/\/gitlab\.example\.com$/m);
  assert.match(r.stdout, /^Token scopes: read_api/m);
  assert.match(r.stdout, /WARNING: writes need scope api/);
  const api = run(dir, ['whoami'], [me, get(`${API}/personal_access_tokens/self`, { scopes: ['api'] })]).r;
  assert.doesNotMatch(api.stdout, /WARNING/);
  const none = run(dir, ['whoami'], [me, get(`${API}/personal_access_tokens/self`, { message: '404 Not Found' }, { status: 404 })]).r;
  assert.equal(none.status, 0, none.output);
  assert.match(none.stdout, /Token scopes: not reported/);
});

test('search follows X-Next-Page, applies the filter flags in the project, and says what was cut', () => {
  const dir = gitlabInstall();
  const routes = [
    { match: `^${esc(`${P}/issues?`)}.*&page=1$`, body: [issue(1, { labels: ['To Do'] }), issue(2)], headers: { 'x-next-page': '2' } },
    { match: `^${esc(`${P}/issues?`)}.*&page=2$`, body: [issue(3, { labels: ['In Progress'], assignees: [{ username: 'ada' }] })], headers: { 'x-next-page': '' } },
  ];
  const { r, calls } = run(dir, ['search', '--labels', 'bug', '--milestone', 'Sprint 3', '--search', 'login', '--iteration', '9'], routes);
  assert.equal(r.status, 0, r.output);
  assert.equal(calls.length, 2, 'two pages');
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('labels'), 'bug');
  assert.equal(url.searchParams.get('milestone'), 'Sprint 3');
  assert.equal(url.searchParams.get('search'), 'login');
  assert.equal(url.searchParams.get('iteration_id'), '9');
  assert.equal(url.searchParams.get('state'), 'opened');
  assert.match(r.stdout, /^acme-corp\/tools#1 \[To Do\] Issue 1$/m);
  assert.match(r.stdout, /^acme-corp\/tools#3 \[In Progress\] Issue 3 @ada$/m);
  assert.match(r.stdout, /^3 issue\(s\) in project acme-corp\/tools$/m);

  const cut = run(dir, ['search', '--limit', '2'], [{ match: `^${esc(`${P}/issues?`)}`, body: [issue(1), issue(2), issue(3)] }]).r;
  assert.match(cut.stdout, /^2 issue\(s\) in project acme-corp\/tools … more \(raise --limit\)$/m);
});

test('search is group-scoped with --group, and over every visible project without a default', () => {
  const group = run(gitlabInstall(), ['search', '--group', 'acme-corp'], [{ match: `^${esc(`${API}/groups/acme-corp/issues?`)}`, body: [] }]);
  assert.equal(group.r.status, 0, group.r.output);
  assert.match(group.r.stdout, /in group acme-corp/);
  const all = run(gitlabInstall({ GITLAB_PROJECT: null }), ['search', '--assignee', 'me'], [
    get(`${API}/user`, { id: 1, username: 'ada' }),
    { match: `^${esc(`${API}/issues?`)}`, body: [] },
  ]);
  assert.equal(all.r.status, 0, all.r.output);
  const url = new URL(all.calls.at(-1).url);
  assert.equal(url.searchParams.get('scope'), 'all');
  assert.equal(url.searchParams.get('assignee_username'), 'ada');
});

test('info prints labels, links, comments without system notes, and the attachments to fetch', () => {
  const dir = gitlabInstall();
  const body = issue(12, {
    labels: ['In Progress', 'backend'], description: 'See ![shot](/uploads/0123456789abcdef0123456789abcdef/shot.png)',
    milestone: { id: 5, title: 'Sprint 3', state: 'active', start_date: '2026-10-01', due_date: '2026-10-14' },
  });
  const { r } = run(dir, ['info', '--task', '#12'], [
    get(`${P}/issues/12`, body),
    get(`${P}/issues/12/notes`, [{ body: 'Narrowed: only the API.', author: { username: 'bob' }, created_at: '2026-10-02T10:00:00Z' }, { system: true, body: 'added label' }]),
    get(`${P}/issues/12/links`, [{ ...issue(13), link_type: 'blocks' }]),
  ]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Status: In Progress/);
  assert.match(r.stdout, /^Milestone: milestone 5 "Sprint 3" \[active\] 2026-10-01 → 2026-10-14$/m);
  assert.match(r.stdout, /^ {2}blocks acme-corp\/tools#13 \[open\] Issue 13$/m);
  assert.match(r.stdout, /^Comments \(1; 1 system notes not shown\):$/m);
  assert.match(r.stdout, /Narrowed: only the API\./);
  assert.match(r.stdout, /^ {2}\[1\] shot\.png — NOT READ$/m);
});

test('sprint groups the milestone issues by status label and counts the load per assignee', () => {
  const dir = gitlabInstall();
  const { r } = run(dir, ['sprint', '--id', '5'], [
    get(`${P}/milestones/5`, { id: 5, title: 'Sprint 3', state: 'active', start_date: '2026-10-01', due_date: '2026-10-14' }),
    get(`${P}/milestones/5/issues`, [
      issue(1, { labels: ['To Do'], assignees: [{ username: 'ada' }] }),
      issue(2, { labels: ['In Progress'], assignees: [{ username: 'ada' }] }),
      issue(3, { state: 'closed', assignees: [{ username: 'bob' }] }),
    ]),
  ]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^milestone 5 "Sprint 3" \[active\]/m);
  assert.match(r.stdout, /^## To Do \(1\)$/m);
  assert.match(r.stdout, /^## closed \(1\)$/m);
  assert.match(r.stdout, /^ {2}@ada\s+0\/2 closed$/m);
  assert.match(r.stdout, /^3 issue\(s\), 1 closed$/m);
});

test('boards lists each board and its label lists', () => {
  const { r } = run(gitlabInstall(), ['boards'], [get(`${P}/boards`, [{ id: 3, name: 'Development', lists: [{ position: 0, label: { name: 'To Do' } }, { position: 1, label: { name: 'In Progress' } }] }])]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^\s+3 {2}Development$/m);
  assert.match(r.stdout, /^\s+1\. label In Progress$/m);
});

// == transition: labels, one atomic PUT ==

test('transition is refused without GITLAB_AGENT_STATUSES, naming the key, before any request', () => {
  const dir = gitlabInstall({ GITLAB_AGENT_STATUSES: null });
  const r = tool(dir, 'gitlab-issues', ['transition', '--task', '#12', '--to', 'In Progress', '--dry-run'], TOKEN);
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, /^refused: GITLAB_AGENT_STATUSES is not set/m);
  assert.match(r.stderr, /https:\/\/gitlab\.example\.com\/acme-corp\/tools\/-\/issues\/12/);
});

test('transition refuses a status outside the agent list, closing, a review status and a closed issue', () => {
  const dir = gitlabInstall();
  for (const to of ['Review', 'closed', 'Reopen']) {
    const r = tool(dir, 'gitlab-issues', ['transition', '--task', '#12', '--to', to], TOKEN);
    assertNoCrashNoRequest(r);
    assert.equal(r.status, 3, `${to}: ${r.output}`);
    assert.match(r.stderr, /^refused: /m);
  }
  const review = run(dir, ['transition', '--task', '#12', '--to', 'In Progress'], [get(`${P}/issues/12`, issue(12, { labels: ['Review'] }))]);
  assert.equal(review.r.status, 3, review.r.output);
  assert.match(review.r.stderr, /from review on only a person moves it/);
  const closed = run(dir, ['transition', '--task', '#12', '--to', 'In Progress'], [get(`${P}/issues/12`, issue(12, { state: 'closed' }))]);
  assert.equal(closed.r.status, 3, closed.r.output);
  assert.match(closed.r.stderr, /is closed; reopening is a person's/);
  assert.deepEqual(writes([...review.calls, ...closed.calls]), []);
});

test('transition --dry-run shows from → to and the labels, with GET requests only', () => {
  const dir = gitlabInstall();
  const { r, calls } = run(dir, ['transition', '--task', '#12', '--to', 'in progress', '--dry-run'], [get(`${P}/issues/12`, issue(12, { labels: ['To Do', 'backend'] })), LABELS]);
  assert.equal(r.status, 0, r.output);
  onlyGets(calls);
  assert.match(r.stdout, /^--- DRY RUN \(requested --dry-run\) ---$/m);
  assert.match(r.stdout, /^Project: acme-corp\/tools$/m);
  assert.match(r.stdout, /^Would move: To Do → In Progress {3}\(source: labels, GITLAB_AGENT_STATUSES\)$/m);
  assert.match(r.stdout, /^ {2}labels: \+In Progress -To Do \(one PUT, atomic\)$/m);
  assert.match(r.stdout, /^DRY RUN — nothing written to GitLab\.$/m);
});

test('transition moves the status as one PUT with add_labels and remove_labels', () => {
  const dir = gitlabInstall();
  const { r, calls } = run(dir, ['transition', '--task', `${SITE}/acme-corp/tools/-/issues/12`, '--to', 'In Progress'], [
    get(`${P}/issues/12`, issue(12, { labels: ['To Do', 'backend'] })), LABELS,
    { method: 'PUT', url: `${P}/issues/12`, body: issue(12, { labels: ['In Progress', 'backend'] }) },
  ]);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(writes(calls), [{ method: 'PUT', url: `${P}/issues/12`, body: { add_labels: 'In Progress', remove_labels: 'To Do' } }]);
  assert.match(r.stdout, /^acme-corp\/tools#12: To Do → In Progress$/m);
});

// == edit: bulk, --max, labels, never the state ==

test('edit --query is capped by --max, and unknown labels are refused unless --create-labels', () => {
  const dir = gitlabInstall();
  const three = { match: `^${esc(`${P}/issues?`)}`, body: [issue(1), issue(2), issue(3)] };
  const max = run(dir, ['edit', '--query', 'labels=old', '--max', '2', '--add-labels', 'backend', '--dry-run'], [three, LABELS]);
  assert.equal(max.r.status, 1, max.r.output);
  assert.match(max.r.stderr, /selects more than --max 2 issues/);
  assert.equal(new URL(max.calls[0].url).searchParams.get('per_page'), '3', 'asks for one more than --max');

  const unknown = run(dir, ['edit', '--task', '#1', '--add-labels', 'bug', '--dry-run'], [get(`${P}/issues/1`, issue(1)), LABELS]);
  assert.equal(unknown.r.status, 3, unknown.r.output);
  assert.match(unknown.r.stderr, /^refused: unknown label\(s\) in acme-corp\/tools: bug — GitLab would create them\. Did you mean Bug\?/m);

  const created = run(dir, ['edit', '--task', '#1', '--add-labels', 'brand-new', '--create-labels', '--dry-run'], [get(`${P}/issues/1`, issue(1)), LABELS]);
  assert.equal(created.r.status, 0, created.r.output);
  assert.match(created.r.stdout, /will create label\(s\): brand-new/);
});

test('edit --dry-run lists every selected issue and the changes, GET only; the write is one PUT each', () => {
  const dir = gitlabInstall();
  const routes = [
    { match: `^${esc(`${P}/issues?`)}`, body: [issue(1, { labels: ['old'] }), issue(2, { labels: ['old'] })] }, LABELS,
    { method: 'PUT', match: `^${esc(`${P}/issues/`)}\\d+$`, body: {} },
  ];
  const args = ['edit', '--query', 'labels=old', '--add-labels', 'backend', '--remove-labels', 'old', '--summary', 'Renamed'];
  const dry = run(dir, [...args, '--dry-run'], routes);
  assert.equal(dry.r.status, 0, dry.r.output);
  onlyGets(dry.calls);
  assert.match(dry.r.stdout, /^Would edit 2 issue\(s\):$/m);
  assert.match(dry.r.stdout, /^ {2}acme-corp\/tools#2 \[open\] Issue 2$/m);
  assert.match(dry.r.stdout, /^ {2}labels: \+backend -old/m);
  assert.match(dry.r.stdout, /^ {2}title: "Renamed"$/m);

  const real = run(dir, args, routes);
  assert.equal(real.r.status, 0, real.r.output);
  assert.deepEqual(writes(real.calls).map((c) => c.url), [`${P}/issues/1`, `${P}/issues/2`]);
  assert.deepEqual(writes(real.calls)[0].body, { title: 'Renamed', add_labels: 'backend', remove_labels: 'old' });
});

test('edit --state is refused: an agent never closes or reopens', () => {
  const r = tool(gitlabInstall(), 'gitlab-issues', ['edit', '--task', '#12', '--state', 'close', '--dry-run'], TOKEN);
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, /^refused: an agent never closes or reopens an issue — a person does it: https:\/\/gitlab\.example\.com\/acme-corp\/tools\/-\/issues\/12$/m);
});

// == create, comment ==

test('create: dry run GET only; the write posts title, labels, milestone; non-English refused', () => {
  const dir = gitlabInstall();
  const routes = [LABELS, get(`${P}/milestones/5`, { id: 5, title: 'Sprint 3', state: 'active' }),
    { method: 'POST', url: `${P}/issues`, body: issue(40) }];
  const args = ['create', '--summary', 'Add export', '--description', 'Ping @ada.', '--labels', 'backend', '--sprint', '5'];
  const dry = run(dir, [...args, '--dry-run'], routes);
  assert.equal(dry.r.status, 0, dry.r.output);
  onlyGets(dry.calls);
  assert.match(dry.r.stdout, /^Project: acme-corp\/tools$/m);
  assert.match(dry.r.stdout, /^ {2}into milestone 5 "Sprint 3" \[active\]/m);
  assert.match(dry.r.stdout, /^will notify @ada$/m);
  const real = run(dir, args, routes);
  assert.equal(real.r.status, 0, real.r.output);
  assert.deepEqual(writes(real.calls), [{ method: 'POST', url: `${P}/issues`, body: { title: 'Add export', labels: 'backend', description: 'Ping @ada.', milestone_id: 5 } }]);
  assert.match(real.r.stdout, /^Created acme-corp\/tools#40/m);

  const foreign = run(dir, ['create', '--summary', 'Добавить экспорт', '--dry-run'], routes);
  assert.equal(foreign.r.status, 3, foreign.r.output);
  assert.match(foreign.r.stderr, /^flagged: content check: language/);
  assert.match(foreign.r.stdout, /summary line 1: language/);
  const refused = run(dir, ['create', '--summary', 'Добавить экспорт'], routes);
  assert.equal(refused.r.status, 3, refused.r.output);
  assert.match(refused.r.stderr, /^refused: content check: language/);
  assert.deepEqual(writes(refused.calls), []);
  const unknown = run(dir, ['create', '--summary', 'Add export', '--labels', 'nope'], routes);
  assert.equal(unknown.r.status, 3, unknown.r.output);
  assert.deepEqual(writes(unknown.calls), []);
});

test('comment posts the markdown note; the dry run with credentials reads the issue only', () => {
  const dir = gitlabInstall();
  const routes = [get(`${P}/issues/12`, issue(12)), { method: 'POST', url: `${P}/issues/12/notes`, body: { id: 77 } }];
  const dry = run(dir, ['comment', '--task', '#12', '--text', 'Done.', '--dry-run'], routes);
  assert.equal(dry.r.status, 0, dry.r.output);
  onlyGets(dry.calls);
  assert.match(dry.r.stdout, /^Task: {4}acme-corp\/tools#12 \[open\] Issue 12$/m);
  const real = run(dir, ['comment', '--task', '#12', '--text', 'Done.'], routes);
  assert.equal(real.r.status, 0, real.r.output);
  assert.deepEqual(writes(real.calls), [{ method: 'POST', url: `${P}/issues/12/notes`, body: { body: 'Done.' } }]);
  assert.match(real.r.stdout, /#note_77$/m);
});

// == move-to-sprint: milestones and iterations ==

test('move-to-sprint sets milestone_id; --backlog sets 0; dry run GET only', () => {
  const dir = gitlabInstall();
  const routes = [get(`${P}/issues/12`, issue(12)), get(`${P}/milestones/5`, { id: 5, title: 'Sprint 3', state: 'active' }),
    { method: 'PUT', url: `${P}/issues/12`, body: {} }];
  const dry = run(dir, ['move-to-sprint', '--sprint', '5', '--task', '#12', '--dry-run'], routes);
  assert.equal(dry.r.status, 0, dry.r.output);
  onlyGets(dry.calls);
  assert.match(dry.r.stdout, /^Target: milestone 5 "Sprint 3" \[active\]/m);
  assert.match(dry.r.stdout, /\(none\) → milestone 5$/m);
  const real = run(dir, ['move-to-sprint', '--sprint', '5', '--task', '#12'], routes);
  assert.equal(real.r.status, 0, real.r.output);
  assert.deepEqual(writes(real.calls).map((c) => c.body), [{ milestone_id: 5 }]);
  const back = run(dir, ['move-to-sprint', '--backlog', '--task', '#12'], routes);
  assert.equal(back.r.status, 0, back.r.output);
  assert.deepEqual(writes(back.calls).map((c) => c.body), [{ milestone_id: 0 }]);
  const closed = run(dir, ['move-to-sprint', '--sprint', '5', '--task', '#12'], [routes[0], get(`${P}/milestones/5`, { id: 5, title: 'Sprint 2', state: 'closed' })]);
  assert.equal(closed.r.status, 1, closed.r.output);
  assert.match(closed.r.stderr, /milestone Sprint 2 is closed/);
});

test('move-to-sprint with GITLAB_SPRINTS iterations sets iteration_id and says it is unverified', () => {
  const dir = gitlabInstall({ GITLAB_SPRINTS: 'iterations', GITLAB_GROUP: 'acme-corp' });
  const routes = [get(`${P}/issues/12`, issue(12)),
    get(`${API}/groups/acme-corp/iterations`, [{ id: 31, iid: 4, title: 'Week 42', state: 2, start_date: '2026-10-12', due_date: '2026-10-18' }]),
    { method: 'PUT', url: `${P}/issues/12`, body: {} }];
  const dry = run(dir, ['move-to-sprint', '--sprint', '31', '--task', '#12', '--dry-run'], routes);
  assert.equal(dry.r.status, 0, dry.r.output);
  onlyGets(dry.calls);
  assert.match(dry.r.stdout, /^Target: iteration 31 "Week 42" \[current\]/m);
  assert.match(dry.r.stdout, /unverified until checked live/);
  const real = run(dir, ['move-to-sprint', '--sprint', '31', '--task', '#12'], routes);
  assert.equal(real.r.status, 0, real.r.output);
  assert.deepEqual(writes(real.calls).map((c) => c.body), [{ iteration_id: 31 }]);
});

// == link ==

test('link: dry run shows A —blocks→ B with GET only; the write posts the target; a tier refusal is named', () => {
  const dir = gitlabInstall();
  const target = issue(39, { project_id: 8, references: { full: 'acme-corp/web#39' } });
  const reads = [get(`${P}/issues/15`, issue(15)), get(`${API}/projects/acme-corp%2Fweb/issues/39`, target)];
  const args = ['link', '--from', '#15', '--type', 'blocks', '--to', 'acme-corp/web#39'];
  const dry = run(dir, [...args, '--dry-run'], reads);
  assert.equal(dry.r.status, 0, dry.r.output);
  onlyGets(dry.calls);
  assert.match(dry.r.stdout, /^Would link: acme-corp\/tools#15 —blocks→ acme-corp\/web#39$/m);
  const real = run(dir, args, [...reads, { method: 'POST', url: `${P}/issues/15/links`, status: 201, body: {} }]);
  assert.equal(real.r.status, 0, real.r.output);
  assert.deepEqual(writes(real.calls), [{ method: 'POST', url: `${P}/issues/15/links`, body: { target_project_id: 8, target_issue_iid: 39, link_type: 'blocks' } }]);
  const tier = run(dir, args, [...reads, { method: 'POST', url: `${P}/issues/15/links`, status: 403, body: { message: '403 Forbidden' } }]);
  assert.equal(tier.r.status, 2, tier.r.output);
  assert.match(tier.r.stderr, /this GitLab tier may not offer blocking links/);
  const bad = run(dir, ['link', '--from', '#15', '--type', 'duplicates', '--to', '#16', '--dry-run'], reads);
  assert.equal(bad.r.status, 1, bad.r.output);
  assert.match(bad.r.stderr, /--type is one of relates_to, blocks, is_blocked_by/);
});

// == not offered ==

test('attach and goals are not offered: one line with the route, no request, no --dry-run', () => {
  const dir = gitlabInstall({ GITLAB_GROUP: 'acme-corp' });
  const attach = tool(dir, 'gitlab-issues', ['attach', '--task', '#12', '--file', 'a.png'], TOKEN);
  assertNoCrashNoRequest(attach);
  assert.equal(attach.status, 1, attach.output);
  assert.match(attach.stderr, /^gitlab-issues: attach is not offered by this connector .* attach the file in GitLab: https:\/\/gitlab\.example\.com\/acme-corp\/tools\/-\/issues\/12$/m);
  for (const name of ['goals', 'goal', 'goal-comment']) {
    const r = tool(dir, 'gitlab-issues', [name], TOKEN);
    assertNoCrashNoRequest(r);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, /is not offered by the gitlab-issues connector .* https:\/\/gitlab\.example\.com\/groups\/acme-corp\/-\/epics$/m);
    const help = tool(dir, 'gitlab-issues', [name, '--help']);
    assert.doesNotMatch(help.stdout, /--dry-run/);
  }
  assert.equal(tool(dir, 'gitlab-issues', ['attach', '--task', '#12', '--dry-run'], TOKEN).status, 1, '--dry-run is not an option of attach');
});
