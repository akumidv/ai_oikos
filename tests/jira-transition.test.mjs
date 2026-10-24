// Jira `transition` (npm test): the tool runs in a copy of examples/installation (ACME Corp) against
// canned answers (fake-fetch.mjs). With a `task-tracking.jira` part the rule decides — agent moves
// as before, person is refused (exit 3) with the link, confirm prints the evidence in its dry run
// (comments since the last entry into the status, links, the epic or the open epics); without the
// part the JIRA_AGENT_STATUSES allowlist holds as before. The confirm dry run also lists the pull
// requests (ADR 0001 D05): attached (dev-status by the summary's applicationType, URLs, remote links)
// and found in the project's pool; those only in the pool go into the comment posted with the move.
// No dry run makes a non-GET call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installation, tool, withFakeFetch } from './helpers/installation.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = {
  JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token', GITHUB_TOKEN: 'fake-gh-token',
  GITLAB_URL: 'https://gitlab.example.com', GITLAB_TOKEN: 'fake-gl-token',
};
const GH = 'https://api.github.com';
const GL = 'https://gitlab.example.com/api/v4';
const ADA = { accountId: '5b10ac8d82e05b22cc7d4ef5', displayName: 'Ada Lovelace' };

const RULES = `
task-tracking:
  jira:
    defaults:
      transitions:
        - { from: [To Do, In Progress], to: [To Do, In Progress, Review], mode: agent }
        - from: Review
          to: [Test, Done]
          mode: confirm
          requires: >
            The task shows where its result is. The task belongs to an epic.
        - { from: "*", to: Closed, mode: confirm, requires: A comment giving the reason. }
    projects:
      PROJ:
        results: Pull requests; UI changes also as screenshots.
        epics: One epic per product area.
`;

const withRules = (t) => `${t}${RULES}`;

const doc = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function issueRoute(status, extra = {}) {
  return {
    match: `^${API}/issue/PROJ-7\\?fields=`,
    body: {
      id: '10007',
      key: 'PROJ-7',
      fields: {
        summary: 'Export the report', status: { name: status }, issuetype: { name: 'Story' }, assignee: ADA,
        description: doc('Export as CSV. Spec: https://docs.example.com/spec.'), attachment: [{ id: '1', filename: 'screen.png' }],
        ...extra,
      },
    },
  };
}

const transitionsRoute = {
  url: `${API}/issue/PROJ-7/transitions`,
  body: { transitions: [{ id: '21', to: { name: 'In Progress' } }, { id: '31', to: { name: 'Review' } }, { id: '41', to: { name: 'Done' } }, { id: '51', to: { name: 'Closed' } }] },
};

// Review entered twice: the comments count from the last entry (2026-10-10).
const changelogRoute = {
  match: `^${API}/issue/PROJ-7/changelog`,
  body: {
    startAt: 0, maxResults: 50, total: 3, isLast: true,
    values: [
      { created: '2026-10-01T10:00:00.000+0200', items: [{ field: 'status', fieldId: 'status', fromString: 'In Progress', toString: 'Review' }] },
      { created: '2026-10-03T10:00:00.000+0200', items: [{ field: 'status', fieldId: 'status', fromString: 'Review', toString: 'In Progress' }] },
      { created: '2026-10-10T10:00:00.000+0200', items: [{ field: 'status', fieldId: 'status', fromString: 'In Progress', toString: 'Review' }] },
    ],
  },
};

const commentsRoute = {
  match: `^${API}/issue/PROJ-7/comment\\?orderBy=created`,
  body: {
    startAt: 0, maxResults: 50, total: 2,
    comments: [
      { created: '2026-10-02T09:00:00.000+0200', author: { displayName: 'Ben' }, body: doc('An old note before the second review.') },
      { created: '2026-10-11T09:00:00.000+0200', author: ADA, body: doc('PR merged: https://github.com/acme-corp/web/pull/12') },
    ],
  },
};

const remoteRoute = { url: `${API}/issue/PROJ-7/remotelink`, body: [{ object: { title: 'Design doc', url: 'https://wiki.example.com/design' } }] };

const epicsRoute = {
  match: `^${API}/search/jql\\?jql=${encodeURIComponent('project = "PROJ" AND issuetype = Epic')}`,
  body: { issues: [
    { key: 'PROJ-1', fields: { summary: 'Reporting', description: doc('Everything about reports and exports.') } },
    { key: 'PROJ-2', fields: { summary: 'Platform' } },
  ] },
};

const DEV = `${SITE}/rest/dev-status/latest/issue`;
const devStatusNone = { url: `${DEV}/summary?issueId=10007`, body: { summary: { pullrequest: { overall: { count: 0 }, byInstanceType: {} } } } };
const pull12 = {
  url: `${GH}/repos/acme-corp/web/pulls/12`,
  body: { html_url: 'https://github.com/acme-corp/web/pull/12', number: 12, title: 'PROJ-7 Export CSV', state: 'closed', merged_at: '2026-10-11T08:00:00Z', head: { ref: 'PROJ-7-export' } },
};

const EVIDENCE = [changelogRoute, commentsRoute, remoteRoute, epicsRoute, devStatusNone, pull12];

function run(dir, routes, args) {
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...CREDS, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}

const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');

test('rules: an agent move dry-runs as before, then moves and posts the comment', () => {
  const dir = installation(withRules);
  const routes = [issueRoute('In Progress'), transitionsRoute];
  const dry = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'review', '--comment', 'Ready for review.', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /^DRY RUN — would move PROJ-7: In Progress → Review \(transition 31; mode agent by task-tracking\.jira\.defaults\.transitions\[0\]\)$/m);
  assert.match(dry.stdout, /^Ready for review\.$/m);
  assert.deepEqual(writesOf(dry.calls), []);

  const posted = [...routes, { method: 'POST', url: `${API}/issue/PROJ-7/transitions`, status: 204 }, { method: 'POST', url: `${API}/issue/PROJ-7/comment`, status: 201, body: { id: '9' } }];
  const real = run(dir, posted, ['transition', '--task', 'PROJ-7', '--to', 'review', '--comment', 'Ready, [~accountid:5b10ac8d82e05b22cc7d4ef5].']);
  assert.equal(real.status, 0, real.output);
  const writes = writesOf(real.calls);
  assert.deepEqual(writes.map((c) => c.url), [`${API}/issue/PROJ-7/transitions`, `${API}/issue/PROJ-7/comment`], 'the move first, then the comment');
  assert.deepEqual(writes[0].body, { transition: { id: '31' } });
  const inline = writes[1].body.body.content[0].content;
  assert.deepEqual(inline[1], { type: 'mention', attrs: { id: ADA.accountId, text: `@${ADA.accountId}` } });
});

test('rules: a person move is refused (exit 3) with the link and the rule that refused, nothing written', () => {
  const dir = installation(withRules);
  const r = run(dir, [issueRoute('Test'), transitionsRoute], ['transition', '--task', 'PROJ-7', '--to', 'In Progress', '--dry-run']);
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, /^refused: Test → In Progress in PROJ is a person's move by task-tracking\.jira\.defaults\.default \(unset, so person\) — no rule covers it — move PROJ-7 to 'In Progress' yourself: https:\/\/acme\.atlassian\.net\/browse\/PROJ-7$/m);
  assert.deepEqual(writesOf(r.calls), []);
});

test('rules: a confirm dry run prints the rule, the hints and what the task records since its last entry into the status', () => {
  const dir = installation(withRules);
  const parent = { parent: { key: 'PROJ-1', fields: { summary: 'Reporting', issuetype: { name: 'Epic' } } } };
  const r = run(dir, [issueRoute('Review', parent), transitionsRoute, ...EVIDENCE],
    ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Done: [PR 12](https://github.com/acme-corp/web/pull/12).', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  const out = r.stdout;
  assert.match(out, /^--- DRY RUN \(requested --dry-run\) ---$/m);
  assert.match(out, /^Would move PROJ-7: Review → Done \(transition 41\)$/m);
  assert.match(out, /^Rule: task-tracking\.jira\.defaults\.transitions\[1\] — Review → Test, Done, mode confirm$/m);
  assert.match(out, /^ {2}The task shows where its result is\. The task belongs to an epic\.$/m);
  assert.match(out, /^ {2}Pull requests; UI changes also as screenshots\.$/m);
  assert.match(out, /^ {2}One epic per product area\.$/m);
  assert.match(out, /^Assignee: Ada Lovelace \(account id 5b10ac8d82e05b22cc7d4ef5\) — mention as \[~accountid:5b10ac8d82e05b22cc7d4ef5\]$/m);
  assert.match(out, /^Export as CSV\./m);
  assert.match(out, /^ {2}screen\.png$/m);
  assert.match(out, /^## Comments since the task entered Review on 2026-10-10T10:00:00\.000\+0200 \(1 of 2\)$/m);
  assert.match(out, /PR merged: https:\/\/github\.com\/acme-corp\/web\/pull\/12/);
  assert.doesNotMatch(out, /An old note/, 'a comment before the last entry into Review is not evidence');
  assert.match(out, /^ {2}Design doc — https:\/\/wiki\.example\.com\/design$/m);
  assert.match(out, /^ {2}https:\/\/docs\.example\.com\/spec$/m, 'a URL in the description, without the closing period');
  assert.match(out, /^ {2}https:\/\/github\.com\/acme-corp\/web\/pull\/12$/m);
  assert.match(out, /^## Epic\n {2}PROJ-1 — Reporting$/m);
  assert.match(out, /^Done: \[PR 12\]\(https:\/\/github\.com\/acme-corp\/web\/pull\/12\)\.$/m);
  assert.match(out, /^- Ask the user in this chat \(not through a question tool/m);
  assert.match(out, /prepare a comment that mentions \[~accountid:5b10ac8d82e05b22cc7d4ef5\]/);
  assert.doesNotMatch(out, /The task has no epic/);
  assert.match(out, /^DRY RUN — nothing written to Jira\.$/m);
  assert.ok(!r.calls.some((c) => c.url.includes('/search/jql')), 'no epic search when the task has an epic');
  assert.deepEqual(writesOf(r.calls), []);
});

test('rules: a confirm dry run of a task without an epic lists the open epics of its project', () => {
  const dir = installation(withRules);
  const r = run(dir, [issueRoute('Review'), transitionsRoute, ...EVIDENCE], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}None: the task has no epic\.\n {2}Open epics of PROJ \(2\) — the candidates:\n {4}PROJ-1 — Reporting\n {8}Everything about reports and exports\.\n {4}PROJ-2 — Platform$/m);
  assert.match(r.stdout, /edit --task PROJ-7 --parent <EPIC> --dry-run, then this move\./);
  assert.match(r.stdout, /\(none — pass --comment "…" to post one after the move\)/);
  const jql = decodeURIComponent(r.calls.find((c) => c.url.includes('/search/jql')).url);
  assert.match(jql, /project = "PROJ" AND issuetype = Epic AND statusCategory != Done/);
  assert.deepEqual(writesOf(r.calls), []);
});

test('rules: a task created in its status counts every comment', () => {
  const dir = installation(withRules);
  const routes = [issueRoute('Review'), transitionsRoute, { ...changelogRoute, body: { startAt: 0, total: 0, isLast: true, values: [] } }, commentsRoute, remoteRoute, epicsRoute];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Closed', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Rule: task-tracking\.jira\.defaults\.transitions\[2\] — \* → Closed, mode confirm$/m);
  assert.match(r.stdout, /^## Comments since the task was created in Review \(no move into it in the changelog\) \(2 of 2\)$/m);
  assert.match(r.stdout, /An old note/);
});

test('rules: a confirm move decided by defaults.default prints the evidence without a rule', () => {
  const dir = installation((t) => `${t}${RULES.replace('    defaults:\n', '    defaults:\n      default: confirm\n')}`);
  const r = run(dir, [issueRoute('Test'), transitionsRoute, ...EVIDENCE], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Rule: none covers the move; task-tracking\.jira\.defaults\.default is confirm$/m);
  assert.match(r.stdout, /^ {2}\(no requirement stated — judge by the project's results\)$/m);
  assert.deepEqual(writesOf(r.calls), []);
});

test('rules: a malformed part stops the transition before any request, naming the path', () => {
  const dir = installation((t) => `${t}\ntask-tracking:\n  jira:\n    defaults:\n      transitions:\n        - { from: Review, to: Done, mode: auto }\n`);
  const r = run(dir, [], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /task-tracking\.jira\.defaults\.transitions\[0\]\.mode: 'auto' is not one of agent, confirm, person/);
  assert.deepEqual(r.calls, []);
});

test('without the part: the JIRA_AGENT_STATUSES allowlist holds, refusal before any request', () => {
  const dir = installation((t) => t);
  const refused = run(dir, [], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(refused.status, 3, refused.output);
  assert.match(refused.stderr, /^refused: an agent moves a task only among to do, in progress, blocked — move PROJ-7 to 'Done' yourself: https:\/\/acme\.atlassian\.net\/browse\/PROJ-7$/m);
  assert.deepEqual(refused.calls, []);

  const moved = run(dir, [issueRoute('To Do'), transitionsRoute], ['transition', '--task', 'PROJ-7', '--to', 'In Progress', '--dry-run']);
  assert.equal(moved.status, 0, moved.output);
  assert.match(moved.stdout, /^DRY RUN — would move PROJ-7: To Do → In Progress \(transition 21\)$/m);
  assert.deepEqual(writesOf(moved.calls), []);
});

// == pull requests (D05) ==

const POOL = RULES.replace('        results: Pull requests;', '        key_aliases: [PJ]\n        repos: [github:acme-corp/web, gitlab:acme/backend]\n        results: Pull requests;');
const withPool = (t) => `${t}${POOL}`;
const APP = 'oAuth-com.example.git-app';

const devStatusRoutes = [
  {
    url: `${DEV}/summary?issueId=10007`,
    body: { summary: {
      pullrequest: { overall: { count: 1 }, byInstanceType: { [APP]: { count: 1, name: 'Example Git App' } } },
      branch: { overall: { count: 1 }, byInstanceType: { [APP]: { count: 1, name: 'Example Git App' } } },
    } },
  },
  {
    match: `^${DEV}/detail\\?issueId=10007&applicationType=${encodeURIComponent(APP)}&dataType=pullrequest$`,
    body: { errors: [], detail: [{
      pullRequests: [{ id: '3', name: 'PROJ-7 login', status: 'OPEN', url: 'https://github.com/acme-corp/auth/pull/3', source: { branch: 'PROJ-7-login' }, repositoryName: 'acme-corp/auth' }],
      branches: [{ name: 'PROJ-7-login', url: 'https://github.com/acme-corp/auth/tree/PROJ-7-login' }],
    }] },
  },
];

const pull3 = {
  url: `${GH}/repos/acme-corp/auth/pulls/3`,
  body: { html_url: 'https://github.com/acme-corp/auth/pull/3', number: 3, title: 'PROJ-7 login', state: 'open', draft: true, merged_at: null, head: { ref: 'PROJ-7-login' } },
};

const ghNode = (n, title, branch, state) => ({ url: `https://github.com/acme-corp/web/pull/${n}`, number: n, title, state, isDraft: false, headRefName: branch });
const graphqlRoute = {
  graphql: 'refs(refPrefix',
  url: `${GH}/graphql`,
  body: { data: {
    repository: {
      ref0: { totalCount: 1, nodes: [{ name: 'PROJ-7-export', associatedPullRequests: { nodes: [ghNode(12, 'PROJ-7 Export CSV', 'PROJ-7-export', 'MERGED')] } }] },
      ref1: { totalCount: 2, nodes: [
        { name: 'feature/PJ-7-ui', associatedPullRequests: { nodes: [ghNode(14, 'Report UI', 'feature/PJ-7-ui', 'OPEN')] } },
        { name: 'PJ-70-other', associatedPullRequests: { nodes: [ghNode(15, 'Other', 'PJ-70-other', 'OPEN')] } },
      ] },
    },
    search0: { issueCount: 1, nodes: [ghNode(12, 'PROJ-7 Export CSV', 'PROJ-7-export', 'MERGED')] },
    search1: { issueCount: 0, nodes: [] },
  } },
};

const backend = `${GL}/projects/acme%2Fbackend`;
const gitlabRoutes = [
  { match: `^${backend}/merge_requests\\?state=all&in=title&search=`, body: [] },
  { match: `^${backend}/repository/branches\\?search=PROJ-7&`, body: [{ name: 'PROJ-7-api' }] },
  { match: `^${backend}/repository/branches\\?search=PJ-7&`, body: [] },
  { match: `^${backend}/merge_requests\\?state=all&source_branch=PROJ-7-api&`, body: [] },
];

const POOL_ROUTES = [changelogRoute, commentsRoute, remoteRoute, epicsRoute, ...devStatusRoutes, pull12, pull3, graphqlRoute, ...gitlabRoutes];
const epicParent = { parent: { key: 'PROJ-1', fields: { summary: 'Reporting', issuetype: { name: 'Epic' } } } };

test('pull requests: the confirm dry run lists attached and pool PRs, branches without one, and what to add to the pool', () => {
  const dir = installation(withPool);
  const r = run(dir, [issueRoute('Review', epicParent), transitionsRoute, ...POOL_ROUTES],
    ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Checked on staging.', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  const out = r.stdout;
  const section = out.slice(out.indexOf('## Pull requests'), out.indexOf('## Epic'));
  assert.match(section, /^ {2}merged {2}attached github:acme-corp\/web {2}PROJ-7 Export CSV\n {10}https:\/\/github\.com\/acme-corp\/web\/pull\/12 {2}\(branch PROJ-7-export\)$/m);
  assert.match(section, /^ {2}draft {3}attached github:acme-corp\/auth {2}PROJ-7 login\n {10}https:\/\/github\.com\/acme-corp\/auth\/pull\/3 {2}\(branch PROJ-7-login\)$/m);
  assert.match(section, /^ {2}open {4}pool {5}github:acme-corp\/web {2}Report UI\n {10}https:\/\/github\.com\/acme-corp\/web\/pull\/14 {2}\(branch feature\/PJ-7-ui\)$/m);
  assert.doesNotMatch(section, /pull\/15/, 'PJ-70 is not PJ-7');
  assert.equal((section.match(/pull\/12/g) || []).length, 1, 'attached and found in the pool: listed once');
  assert.match(section, /^Branches without a pull request:\n {2}gitlab:acme\/backend {2}PROJ-7-api$/m);
  assert.doesNotMatch(section, /PROJ-7-login$/m, 'a branch whose PR is listed is not a branch without one');
  assert.match(section, /^github:acme-corp\/auth carries a pull request of this task and is not in the pool of PROJ — add it:\n {2}node oikos\/tools\/jira\/cli\.mjs repos add PROJ github:acme-corp\/auth --dry-run/m);
  assert.match(section, /^ {2}dev-status: 1 pull request\(s\) via Example Git App$/m);
  assert.match(out, /^Checked on staging\.\n\nPull requests of this task found in the project's repositories:\n- \[acme-corp\/web#14\]\(https:\/\/github\.com\/acme-corp\/web\/pull\/14\) — Report UI \(open\)\n-{40}$/m);
  const detail = r.calls.find((c) => c.url.includes('/dev-status/latest/issue/detail'));
  assert.match(detail.url, new RegExp(`applicationType=${encodeURIComponent(APP)}`), 'the detail is read by the applicationType the summary names');
  assert.ok(!r.calls.some((c) => /search\/issues|\/merge_requests\?scope=all/.test(c.url)), 'no instance-wide search');
  assert.deepEqual(r.calls.filter((c) => c.method !== 'GET').map((c) => c.url), [`${GH}/graphql`], 'the only POST is the GraphQL read');
});

test('pull requests: dev-status unavailable and an empty pool are said, not fatal', () => {
  const dir = installation(withRules);
  const routes = [issueRoute('Review', epicParent), transitionsRoute, changelogRoute, commentsRoute, remoteRoute,
    { url: `${DEV}/summary?issueId=10007`, status: 404, body: { errorMessages: ['not found'] } }, pull12];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}merged {2}attached github:acme-corp\/web {2}PROJ-7 Export CSV$/m);
  assert.match(r.stdout, /^ {2}dev-status unavailable \(HTTP 404\)$/m);
  assert.match(r.stdout, /^The repository pool of PROJ is empty \(task-tracking\.jira\.projects\.PROJ\.repos\)/m);
  assert.match(r.stdout, /project-init PROJ --dry-run`, or list the repositories there/);
  assert.match(r.stdout, /^github:acme-corp\/web carries a pull request of this task and is not in the pool of PROJ/m);
  assert.match(r.stdout, /\(none — pass --comment "…" to post one after the move\)/, 'nothing found in a pool: no comment');
  assert.deepEqual(writesOf(r.calls), []);
});

test('pull requests: a confirm move without --comment still posts the pool PRs as a comment', () => {
  const dir = installation(withPool);
  const posted = [issueRoute('Review', epicParent), transitionsRoute, ...POOL_ROUTES,
    { method: 'POST', url: `${API}/issue/PROJ-7/transitions`, status: 204 },
    { method: 'POST', url: `${API}/issue/PROJ-7/comment`, status: 201, body: { id: '9' } }];
  const r = run(dir, posted, ['transition', '--task', 'PROJ-7', '--to', 'Done']);
  assert.equal(r.status, 0, r.output);
  const writes = r.calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/graphql'));
  assert.deepEqual(writes.map((c) => c.url), [`${API}/issue/PROJ-7/transitions`, `${API}/issue/PROJ-7/comment`]);
  const blocks = writes[1].body.body.content;
  assert.equal(blocks[0].content[0].text, 'Pull requests of this task found in the project\'s repositories:');
  const item = blocks[1].content[0].content[0].content;
  assert.deepEqual(item[0], { type: 'text', text: 'acme-corp/web#14', marks: [{ type: 'link', attrs: { href: 'https://github.com/acme-corp/web/pull/14' } }] });
});

// == the extended set (D08) ==

const EXTENDED = RULES.replace('        results: Pull requests;', '        repos: [gitlab:acme/backend]\n        extended_repos: [gitlab:acme/legacy]\n        results: Pull requests;');
const withExtended = (t) => `${t}${EXTENDED}`;
const legacy = `${GL}/projects/acme%2Flegacy`;
const legacyMr = { web_url: 'https://gitlab.example.com/acme/legacy/-/merge_requests/9', iid: 9, title: 'PROJ-7 old export', state: 'merged', source_branch: 'PROJ-7-old' };
const emptyBackend = [
  { match: `^${backend}/merge_requests\\?state=all&in=title&search=`, body: [] },
  { match: `^${backend}/repository/branches\\?search=`, body: [] },
];
const backendCommits = { match: `^${backend}/search\\?scope=commits&search=`, body: [] };
const legacyRoutes = [
  { match: `^${legacy}/merge_requests\\?state=all&in=title&search=PROJ-7`, body: [legacyMr] },
  { match: `^${legacy}/repository/branches\\?search=`, body: [] },
];
const EXTENDED_ROUTES = [changelogRoute, commentsRoute, remoteRoute, devStatusNone, pull12, ...emptyBackend, ...legacyRoutes];
const touchesLegacy = (calls) => calls.some((c) => c.url.includes('acme%2Flegacy'));
const HINT = /^Nothing found in the pool; the extended set of PROJ has 1 repository, searched only on request: (.+)$/m;

test('extended: without --extended the set is not searched; the pool found nothing, so one hint gives the command', () => {
  const dir = installation(withExtended);
  const r = run(dir, [issueRoute('Review', epicParent), transitionsRoute, ...EXTENDED_ROUTES],
    ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', "Checked on staging, it's fine.", '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.ok(!touchesLegacy(r.calls), 'D05 holds without the flag');
  assert.ok(r.calls.some((c) => c.url.includes('acme%2Fbackend')), 'the pool is searched');
  const hint = HINT.exec(r.stdout);
  assert.ok(hint, r.stdout);
  assert.equal(hint[1], "node oikos/tools/jira/cli.mjs transition --task PROJ-7 --to Done --comment 'Checked on staging, it'\\''s fine.' --dry-run --extended");
  assert.equal((r.stdout.match(/extended set/g) || []).length, 1, 'one hint line');
  assert.doesNotMatch(r.stdout, /legacy/);
  assert.deepEqual(writesOf(r.calls), []);
});

test('extended: no hint when the pool found something, or the set is empty', () => {
  const found = installation((t) => `${t}${EXTENDED.replace('repos: [gitlab:acme/backend]', 'repos: [github:acme-corp/web]')}`);
  const r = run(found, [issueRoute('Review', epicParent), transitionsRoute, ...EXTENDED_ROUTES, graphqlRoute], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}merged {2}attached github:acme-corp\/web/m);
  assert.doesNotMatch(r.stdout, /extended/, 'the pool found the task\'s pull request: no hint');

  const none = installation(withPool);
  const p = run(none, [issueRoute('Review', epicParent), transitionsRoute, ...POOL_ROUTES], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(p.status, 0, p.output);
  assert.doesNotMatch(p.stdout, /extended/);
});

test('extended: --extended searches the set; its PR is listed as extended and joins the comment, as on the real move', () => {
  const dir = installation(withExtended);
  const routes = [issueRoute('Review', epicParent), transitionsRoute, ...EXTENDED_ROUTES];
  const dry = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Checked on staging.', '--dry-run', '--extended']);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /^ {2}merged {2}extended gitlab:acme\/legacy {2}PROJ-7 old export\n {10}https:\/\/gitlab\.example\.com\/acme\/legacy\/-\/merge_requests\/9 {2}\(branch PROJ-7-old\)$/m);
  assert.doesNotMatch(dry.stdout, HINT);
  assert.doesNotMatch(dry.stdout, /gitlab:acme\/legacy carries a pull request/);
  assert.match(dry.stdout, /^Checked on staging\.\n\nPull requests of this task found in the project's repositories:\n- \[acme\/legacy!9\]\(https:\/\/gitlab\.example\.com\/acme\/legacy\/-\/merge_requests\/9\) — PROJ-7 old export \(merged\)$/m);
  assert.match(dry.stdout, /Those found only in the pool or the extended set are written into the task/);
  assert.deepEqual(writesOf(dry.calls), []);

  const posted = [...routes, { method: 'POST', url: `${API}/issue/PROJ-7/transitions`, status: 204 }, { method: 'POST', url: `${API}/issue/PROJ-7/comment`, status: 201, body: { id: '9' } }];
  const real = run(dir, posted, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Checked on staging.', '--extended']);
  assert.equal(real.status, 0, real.output);
  const comment = writesOf(real.calls).find((c) => c.url.endsWith('/comment'));
  assert.match(JSON.stringify(comment.body), /acme\/legacy!9/);
  const plain = run(dir, posted, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Checked on staging.']);
  assert.equal(plain.status, 0, plain.output);
  assert.doesNotMatch(JSON.stringify(writesOf(plain.calls).find((c) => c.url.endsWith('/comment')).body), /legacy/, 'without the flag the move searches no extended set');
});

test('extended: --extended with no extended set is a note, not an error', () => {
  const dir = installation(withPool);
  const r = run(dir, [issueRoute('Review', epicParent), transitionsRoute, ...POOL_ROUTES], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run', '--extended']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^--extended: the extended set of PROJ is empty \(task-tracking\.jira\.projects\.PROJ\.extended_repos\) — nothing more was searched\.$/m);
});

test('extended: info reads no code host without --extended; with it, adds the pull requests of every set', () => {
  const dir = installation(withExtended);
  const routes = [issueRoute('Review'), ...EXTENDED_ROUTES];
  const plain = run(dir, routes, ['info', '--task', 'PROJ-7']);
  assert.equal(plain.status, 0, plain.output);
  assert.doesNotMatch(plain.stdout, /## Pull requests/);
  assert.ok(!plain.calls.some((c) => c.url.startsWith(GL) || c.url.startsWith(GH)), 'info alone reads only Jira');

  const r = run(dir, routes, ['info', '--task', 'PROJ-7', '--extended']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^## Pull requests$/m);
  assert.match(r.stdout, /^ {2}merged {2}attached github:acme-corp\/web {2}PROJ-7 Export CSV$/m);
  assert.match(r.stdout, /^ {2}merged {2}extended gitlab:acme\/legacy {2}PROJ-7 old export$/m);
  assert.deepEqual(writesOf(r.calls), []);
});

// == --brief: the confirm dry run as one short block ==

test('brief: a confirm dry run with a pool PR and no epic is one short block', () => {
  const dir = installation(withPool);
  const r = run(dir, [issueRoute('Review'), transitionsRoute, ...POOL_ROUTES],
    ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Checked on staging.', '--dry-run', '--brief']);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.stdout, [
    'PROJ-7 · Export the report · Review → Done (mode confirm, rule task-tracking.jira.defaults.transitions[1])',
    'Requires: The task shows where its result is. The task belongs to an epic.',
    'Results: Pull requests; UI changes also as screenshots.',
    'PRs:',
    '  acme-corp/web#12 merged [attached] PROJ-7 Export CSV',
    '  acme-corp/auth#3 draft [attached] PROJ-7 login',
    '  acme-corp/web#14 open [pool] Report UI',
    'Links: https://docs.example.com/spec',
    'Attachments: screen.png',
    'Comments since entry: 1',
    'Epic: none — open epics (2): PROJ-1 Reporting; PROJ-2 Platform',
    'Comment: Checked on staging. (+1 PR line)',
    'Flags: no epic, and Requires names one',
    'Full evidence: same command without --brief.',
    '',
  ].join('\n'));
  assert.deepEqual(writesOf(r.calls).map((c) => c.url), [`${GH}/graphql`], 'the only POST is the GraphQL read');
});

test('brief: the flags name what the task lacks, and an unsearched extended set keeps its hint with --brief', () => {
  const dir = installation(withExtended);
  const files = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: String(n), filename: `shot-${n}.png` }));
  const bare = { ...issueRoute('Review'), body: { ...issueRoute('Review').body, fields: { ...issueRoute('Review').body.fields, description: null, attachment: files } } };
  const silent = { ...commentsRoute, body: { startAt: 0, total: 0, comments: [] } };
  const routes = [bare, transitionsRoute, changelogRoute, silent, { ...remoteRoute, body: [] }, epicsRoute, devStatusNone, ...emptyBackend, backendCommits];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run', '--brief']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^PRs: none\n {2}Nothing found in the pool; the extended set of PROJ has 1 repository, searched only on request: node oikos\/tools\/jira\/cli\.mjs transition --task PROJ-7 --to Done --dry-run --brief --extended$/m);
  assert.match(r.stdout, /^Links: none\nAttachments: shot-1\.png, shot-2\.png, shot-3\.png, shot-4\.png, shot-5\.png \(\+2 more\)\nComments since entry: 0$/m);
  assert.match(r.stdout, /^Comment: none$/m);
  assert.match(r.stdout, /^Flags: no pull request; no link in the description, the comments or the remote links; no epic, and Requires names one$/m);
  assert.ok(r.stdout.trimEnd().split('\n').length <= 15, r.stdout);
});

test('brief: the real move with --brief does exactly what it does without', () => {
  const dir = installation(withPool);
  const posted = [issueRoute('Review'), transitionsRoute, ...POOL_ROUTES,
    { method: 'POST', url: `${API}/issue/PROJ-7/transitions`, status: 204 },
    { method: 'POST', url: `${API}/issue/PROJ-7/comment`, status: 201, body: { id: '9' } }];
  const move = ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Checked on staging.'];
  const brief = run(dir, posted, [...move, '--brief']);
  const plain = run(dir, posted, move);
  assert.equal(brief.status, 0, brief.output);
  assert.equal(brief.stdout, plain.stdout);
  assert.deepEqual(writesOf(brief.calls), writesOf(plain.calls));
  assert.ok(writesOf(brief.calls).some((c) => c.url.endsWith('/comment')), brief.output);
});

// == bare task numbers bound to repositories, commits (D11) ==

const NUMBERED = POOL.replace('        results: Pull requests;', '        number_repos: [github:acme-corp/web]\n        number_patterns: ["FIX[{n}]"]\n        results: Pull requests;');
const withNumbers = (t) => `${t}${NUMBERED}`;
const quiet = { ...commentsRoute, body: { startAt: 0, total: 1, comments: [{ created: '2026-10-11T09:00:00.000+0200', author: ADA, body: doc('Done, see the branch.') }] } };
const emptyGraphql = { graphql: 'refs(refPrefix', url: `${GH}/graphql`, body: { data: { repository: {} } } };
const ghCommits = (text, items) => ({ url: `${GH}/search/commits?${new URLSearchParams({ q: `repo:acme-corp/web "${text}"`, per_page: '100' })}`, body: { total_count: items.length, items } });
const NUMBER_ROUTES = [changelogRoute, quiet, { ...remoteRoute, body: [] }, devStatusNone, emptyGraphql, ...emptyBackend,
  { match: `^${backend}/search\\?scope=commits&search=`, body: [] },
  ghCommits('PROJ-7', []), ghCommits('PJ-7', []),
  ghCommits('7', [{ sha: 'a1a1a1a1a1', commit: { message: 'FIX[7]: export the report' } }, { sha: 'b2b2b2b2b2', commit: { message: 'FIX[7] tidy up' } }, { sha: 'c3c3c3c3c3', commit: { message: 'FIX[77]: other' } }]),
  { url: `${GH}/repos/acme-corp/web/commits/a1a1a1a1a1/pulls`, body: [{ html_url: 'https://github.com/acme-corp/web/pull/30', number: 30, title: 'FIX[7]: export', state: 'closed', merged_at: '2026-10-11T08:00:00Z', head: { ref: 'fix-export' } }] },
  { url: `${GH}/repos/acme-corp/web/commits/b2b2b2b2b2/pulls`, body: [] },
];

test('numbers: nothing found by key, the commits carry FIX[7] — the commit\'s PR is posted, a commit without one is listed', () => {
  const dir = installation(withNumbers);
  const routes = [{ ...issueRoute('Review', epicParent), body: { ...issueRoute('Review').body, fields: { ...issueRoute('Review', epicParent).body.fields, description: null } } },
    transitionsRoute, ...NUMBER_ROUTES];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  const section = r.stdout.slice(r.stdout.indexOf('## Pull requests'), r.stdout.indexOf('## Epic'));
  assert.match(section, /^ {2}merged {2}pool {5}github:acme-corp\/web {2}FIX\[7\]: export — via commit a1a1a1a FIX\[7\]: export the report\n {10}https:\/\/github\.com\/acme-corp\/web\/pull\/30 {2}\(branch fix-export\)$/m);
  assert.match(section, /^Commits without a pull request \(evidence, not posted\):\n {2}github:acme-corp\/web@b2b2b2b FIX\[7\] tidy up$/m);
  assert.doesNotMatch(section, /c3c3c3c|FIX\[77\]/);
  assert.match(r.stdout, /^- \[acme-corp\/web#30\]\(https:\/\/github\.com\/acme-corp\/web\/pull\/30\) — FIX\[7\]: export \(merged\) — via commit a1a1a1a FIX\[7\]: export the report$/m);
  const brief = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run', '--brief']);
  assert.equal(brief.status, 0, brief.output);
  assert.match(brief.stdout, /^PRs:\n {2}acme-corp\/web#30 merged \[pool\] FIX\[7\]: export — via commit a1a1a1a FIX\[7\]: export the report$/m, 'the brief PR line names the commit too');
  const searches = r.calls.filter((c) => c.url.includes('/search/commits')).map((c) => new URL(c.url).searchParams.get('q'));
  assert.deepEqual(searches, ['repo:acme-corp/web "PROJ-7"', 'repo:acme-corp/web "PJ-7"', 'repo:acme-corp/web "7"']);
  const gitlabSearches = r.calls.filter((c) => c.url.includes('scope=commits')).map((c) => new URL(c.url).searchParams.get('search'));
  assert.deepEqual(gitlabSearches, ['PROJ-7', 'PJ-7'], 'gitlab:acme/backend is not a number repository: no bare number there');
  const graphql = r.calls.find((c) => c.url.endsWith('/graphql'));
  assert.deepEqual([graphql.body.variables.ref2, graphql.body.variables.search2], ['7', 'is:pr repo:acme-corp/web in:title "7"'], 'the bare number in the pool search of a number repository');
  assert.deepEqual(writesOf(r.calls).map((c) => c.url), [`${GH}/graphql`]);
});

test('numbers: commits whose PRs were not read, or a rate limit part way through them, flag the search incomplete; what was found stays', () => {
  const dir = installation(withNumbers);
  const issue = { ...issueRoute('Review', epicParent), body: { ...issueRoute('Review').body, fields: { ...issueRoute('Review', epicParent).body.fields, description: null } } };
  const args = ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run', '--brief'];
  const unread = { url: `${GH}/repos/acme-corp/web/commits/b2b2b2b2b2/pulls`, status: 500, body: 'server error' };
  const r = run(dir, [issue, transitionsRoute, unread, ...NUMBER_ROUTES], args);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^PRs:\n {2}acme-corp\/web#30 merged \[pool\]/m);
  assert.match(r.stdout, /^Notes: github:acme-corp\/web: the pull requests of commit b2b2b2b were not read — HTTP 500/m);
  assert.match(r.stdout, /^Flags: .*pull request search incomplete/m, 'an HTTP error on a commit is an incomplete search (D13)');

  const limit = { url: `${GH}/repos/acme-corp/web/commits/b2b2b2b2b2/pulls`, status: 429, body: 'rate limited' };
  const partly = run(dir, [issue, transitionsRoute, limit, ...NUMBER_ROUTES], args);
  assert.equal(partly.status, 0, partly.output);
  assert.match(partly.stdout, /^PRs:\n {2}acme-corp\/web#30 merged \[pool\] FIX\[7\]: export — via commit a1a1a1a/m, 'the PR found before the limit is kept');
  assert.match(partly.stdout, /^Notes: github:acme-corp\/web: commits partly searched — github limits the rate of requests \(HTTP 429\) after 1 of 2 commits/m);
  assert.match(partly.stdout, /^Flags: .*pull request search incomplete/m);
});

// == leaving a found PR out (D12) ==

const POSTED = [{ method: 'POST', url: `${API}/issue/PROJ-7/transitions`, status: 204 }, { method: 'POST', url: `${API}/issue/PROJ-7/comment`, status: 201, body: { id: '9' } }];
const commentOf = (calls) => JSON.stringify(writesOf(calls).find((c) => c.url.endsWith('/comment'))?.body ?? null);

test('numbers: the real move whose evidence collected again is incomplete notes it on stderr with the first gap; it still moves and comments', () => {
  const dir = installation(withNumbers);
  const issue = { ...issueRoute('Review', epicParent), body: { ...issueRoute('Review').body, fields: { ...issueRoute('Review', epicParent).body.fields, description: null } } };
  const args = ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Checked on staging.'];
  const limit = { url: `${GH}/repos/acme-corp/web/commits/b2b2b2b2b2/pulls`, status: 429, body: 'rate limited', headers: { 'retry-after': '30' } };
  const r = run(dir, [issue, transitionsRoute, limit, ...NUMBER_ROUTES, ...POSTED], args);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stderr, /^PROJ-7: note — the pull request search was incomplete now \(github:acme-corp\/web: commits partly searched — github limits the rate of requests \(HTTP 429\) after 1 of 2 commits; no more commit search there in this run; retry after ~30s\); the comment lists only what was found$/m);
  assert.deepEqual(writesOf(r.calls).filter((c) => !c.url.endsWith('/graphql')).map((c) => c.url), [`${API}/issue/PROJ-7/transitions`, `${API}/issue/PROJ-7/comment`]);
  assert.match(commentOf(r.calls), /pull\/30/, 'the comment lists what was found');
  const brief = run(dir, [issue, transitionsRoute, limit, ...NUMBER_ROUTES], [...args, '--dry-run', '--brief']);
  assert.equal(brief.status, 0, brief.output);
  assert.match(brief.stdout, /^Notes: github:acme-corp\/web: commits partly searched — github limits the rate of requests[^\n]*…; retry after ~30s$/m,
    'the brief Notes line keeps the retry-after the move-task scenario reads');
  const whole = run(dir, [issue, transitionsRoute, ...NUMBER_ROUTES, ...POSTED], args);
  assert.equal(whole.status, 0, whole.output);
  assert.doesNotMatch(whole.stderr, /search was incomplete/, 'a whole search: no note');
  const refused = run(dir, [issue, transitionsRoute, limit, ...NUMBER_ROUTES, { method: 'POST', url: `${API}/issue/PROJ-7/transitions`, status: 500, body: 'server error' }], args);
  assert.notEqual(refused.status, 0, refused.output);
  assert.doesNotMatch(refused.stderr, /search was incomplete/, 'a move that failed lists nothing: no note');
  assert.ok(!writesOf(refused.calls).some((c) => c.url.endsWith('/comment')));
});

test('skip-pr: a PR found by search is listed as skipped and left out of the comment, in the full and the brief dry run', () => {
  const dir = installation(withPool);
  const routes = [issueRoute('Review', epicParent), transitionsRoute, ...POOL_ROUTES];
  const args = ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Checked on staging.', '--skip-pr', 'https://GitHub.com/acme-corp/web/pull/14/files/', '--dry-run'];
  const full = run(dir, routes, args);
  assert.equal(full.status, 0, full.output);
  const section = full.stdout.slice(full.stdout.indexOf('## Pull requests'), full.stdout.indexOf('## Epic'));
  assert.match(section, /^Skipped \(--skip-pr\) — not the task's result, left out of the comment:\n {2}open {4}pool {5}github:acme-corp\/web {2}Report UI\n {10}https:\/\/github\.com\/acme-corp\/web\/pull\/14 {2}\(branch feature\/PJ-7-ui\)$/m);
  assert.equal((section.match(/pull\/14/g) || []).length, 1, 'listed under Skipped only');
  assert.match(full.stdout, /^## Comment posted with the move\n-{40}\nChecked on staging\.\n-{40}$/m, 'the comment carries no PR list');

  const brief = run(dir, routes, [...args, '--brief']);
  assert.equal(brief.status, 0, brief.output);
  assert.match(brief.stdout, /^ {2}acme-corp\/auth#3 draft \[attached\] PROJ-7 login\nSkipped \(--skip-pr\): acme-corp\/web#14 Report UI\n/m);
  assert.match(brief.stdout, /^Comment: Checked on staging\.$/m);
  assert.deepEqual(writesOf(brief.calls).map((c) => c.url), [`${GH}/graphql`]);
});

test('skip-pr: a URL no search found, or an attached PR, is a usage error in the dry run; nothing written', () => {
  const dir = installation(withPool);
  const routes = [issueRoute('Review', epicParent), transitionsRoute, ...POOL_ROUTES];
  const base = ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run'];
  const typo = run(dir, routes, [...base, '--skip-pr', 'https://github.com/acme-corp/web/pull/41']);
  assert.equal(typo.status, 1, typo.output);
  assert.match(typo.stderr, /--skip-pr https:\/\/github\.com\/acme-corp\/web\/pull\/41: no pull request found by search has this URL — found: https:\/\/github\.com\/acme-corp\/web\/pull\/14\./);
  const attached = run(dir, routes, [...base, '--skip-pr', 'https://github.com/acme-corp/web/pull/12']);
  assert.equal(attached.status, 1, attached.output);
  assert.match(attached.stderr, /--skip-pr https:\/\/github\.com\/acme-corp\/web\/pull\/12: attached to the task — an attached pull request is not posted with the move/);
  assert.deepEqual(writesOf([...typo.calls, ...attached.calls]).map((c) => c.url), [`${GH}/graphql`, `${GH}/graphql`]);
  const agent = run(dir, [issueRoute('In Progress'), transitionsRoute], ['transition', '--task', 'PROJ-7', '--to', 'Review', '--skip-pr', 'https://github.com/acme-corp/web/pull/14', '--dry-run']);
  assert.equal(agent.status, 1, agent.output);
  assert.match(agent.stderr, /is an agent move, which looks for no pull request and posts none/);
});

test('skip-pr: the real move leaves the skipped PR out of the comment; a URL no longer found is a note, not an error', () => {
  const dir = installation(withPool);
  const routes = [issueRoute('Review', epicParent), transitionsRoute, ...POOL_ROUTES, ...POSTED];
  const skipped = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Checked on staging.', '--skip-pr', 'https://github.com/acme-corp/web/pull/14']);
  assert.equal(skipped.status, 0, skipped.output);
  assert.doesNotMatch(commentOf(skipped.calls), /pull\/14|found in the project/);
  assert.match(commentOf(skipped.calls), /Checked on staging\./);

  const gone = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--skip-pr', 'https://github.com/acme-corp/web/pull/41']);
  assert.equal(gone.status, 0, gone.output);
  assert.match(gone.stderr, /^PROJ-7: note — --skip-pr https:\/\/github\.com\/acme-corp\/web\/pull\/41 names no pull request found by search now; nothing to leave out\.$/m);
  assert.match(commentOf(gone.calls), /pull\/14/);
});

test('brief: a pool search that failed is a Notes line and flags the search incomplete; dev-status\'s own count is not', () => {
  const dir = installation(withPool);
  const failed = { graphql: 'refs(refPrefix', url: `${GH}/graphql`, status: 502, body: 'bad gateway' };
  const routes = [issueRoute('Review', epicParent), transitionsRoute, changelogRoute, commentsRoute, remoteRoute, epicsRoute, devStatusNone, pull12, failed, ...emptyBackend];
  const brief = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run', '--brief']);
  assert.equal(brief.status, 0, brief.output);
  const notes = brief.stdout.split('\n').filter((l) => l.startsWith('Notes: '));
  assert.equal(notes.length, 1, brief.stdout);
  assert.match(notes[0], /^Notes: github:acme-corp\/web: not searched — HTTP 502/);
  assert.doesNotMatch(notes[0], /dev-status: 0 pull request/, 'dev-status\'s own count is not a gap');
  assert.match(brief.stdout, /^Flags: pull request search incomplete$/m, 'a PR was found, but the search was not whole');

  const full = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.match(full.stdout, /^Notes:\n {2}dev-status: 0 pull request\(s\) via no integration app\n {2}github:acme-corp\/web: not searched — HTTP 502/m);
  const devDown = run(dir, [{ url: `${DEV}/summary?issueId=10007`, status: 503, body: 'down' }, ...routes], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run', '--brief']);
  assert.match(devDown.stdout, /^Notes: github:acme-corp\/web: not searched — HTTP 502 .*; dev-status unavailable \(HTTP 503\)$/m, 'a search that did not run comes first');
  assert.deepEqual(writesOf([...brief.calls, ...full.calls, ...devDown.calls]).filter((c) => !c.url.endsWith('/graphql')), []);
});

test('brief: only a first page read and dev-status unavailable are Notes, not the incomplete flag', () => {
  const dir = installation(withPool);
  const export12 = ghNode(12, 'PROJ-7 Export CSV', 'PROJ-7-export', 'MERGED');
  const firstPage = { graphql: 'refs(refPrefix', url: `${GH}/graphql`, body: { data: {
    repository: { ref0: { totalCount: 1, nodes: [{ name: 'PROJ-7-export', associatedPullRequests: { nodes: [export12] } }] }, ref1: { totalCount: 0, nodes: [] } },
    search0: { issueCount: 51, nodes: [export12] }, search1: { issueCount: 0, nodes: [] },
  } } };
  const devDown = { url: `${DEV}/summary?issueId=10007`, status: 503, body: 'down' };
  const routes = [issueRoute('Review', epicParent), transitionsRoute, changelogRoute, commentsRoute, remoteRoute, epicsRoute, devDown, pull12, firstPage, ...emptyBackend];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run', '--brief']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Notes: dev-status unavailable \(HTTP 503\); only the first page of pull requests of github:acme-corp\/web titled PROJ-7 was read$/m);
  assert.match(r.stdout, /^Flags: none$/m, 'the searches all ran');
  assert.deepEqual(writesOf(r.calls).filter((c) => !c.url.endsWith('/graphql')), []);
});

test('skip-pr: a task whose only found PR is skipped still gets the commit search; its PR is posted, the skipped one listed', () => {
  const dir = installation(withPool);
  const onlyPool = { graphql: 'refs(refPrefix', url: `${GH}/graphql`, body: { data: {
    repository: { ref0: { totalCount: 0, nodes: [] }, ref1: { totalCount: 1, nodes: [{ name: 'feature/PJ-7-ui', associatedPullRequests: { nodes: [ghNode(14, 'Report UI', 'feature/PJ-7-ui', 'OPEN')] } }] } },
    search0: { issueCount: 0, nodes: [] }, search1: { issueCount: 0, nodes: [] },
  } } };
  const bare = { ...issueRoute('Review', epicParent), body: { ...issueRoute('Review').body, fields: { ...issueRoute('Review', epicParent).body.fields, description: null } } };
  const routes = [bare, transitionsRoute, changelogRoute, quiet, { ...remoteRoute, body: [] }, devStatusNone, onlyPool, ...emptyBackend, backendCommits,
    ghCommits('PROJ-7', [{ sha: 'd4d4d4d4d4', commit: { message: 'PROJ-7 export fix' } }]), ghCommits('PJ-7', []),
    { url: `${GH}/repos/acme-corp/web/commits/d4d4d4d4d4/pulls`, body: [{ html_url: 'https://github.com/acme-corp/web/pull/40', number: 40, title: 'Export fix', state: 'closed', merged_at: '2026-10-11T08:00:00Z', head: { ref: 'fix' } }] }];
  const args = ['transition', '--task', 'PROJ-7', '--to', 'Done', '--skip-pr', 'https://github.com/acme-corp/web/pull/14', '--dry-run'];
  const r = run(dir, routes, args);
  assert.equal(r.status, 0, r.output);
  const section = r.stdout.slice(r.stdout.indexOf('## Pull requests'), r.stdout.indexOf('## Epic'));
  assert.match(section, /^ {2}merged {2}pool {5}github:acme-corp\/web {2}Export fix — via commit d4d4d4d PROJ-7 export fix$/m, 'found through its commit');
  assert.match(section, /^Skipped \(--skip-pr\) — not the task's result, left out of the comment:\n {2}open {4}pool {5}github:acme-corp\/web {2}Report UI$/m);
  assert.match(r.stdout, /^- \[acme-corp\/web#40\]\(https:\/\/github\.com\/acme-corp\/web\/pull\/40\) — Export fix \(merged\) — via commit d4d4d4d PROJ-7 export fix$/m);
  assert.ok(r.calls.some((c) => c.url.includes('/search/commits')), 'the commit search ran');

  const both = run(dir, routes, [...args, '--skip-pr', 'https://github.com/acme-corp/web/pull/40', '--brief']);
  assert.equal(both.status, 0, both.output);
  assert.match(both.stdout, /^PRs: none$/m);
  assert.match(both.stdout, /^Skipped \(--skip-pr\): acme-corp\/web#14 Report UI; acme-corp\/web#40 Export fix — via commit d4d4d4d PROJ-7 export fix$/m,
    'a PR found through a commit is skippable too, and its brief line names the commit');
  assert.match(both.stdout, /^Comment: none$/m);
  const typo = run(dir, routes, [...args, '--skip-pr', 'https://github.com/acme-corp/web/pull/41']);
  assert.equal(typo.status, 1, typo.output);
  assert.match(typo.stderr, /--skip-pr https:\/\/github\.com\/acme-corp\/web\/pull\/41: no pull request found by search has this URL — found: https:\/\/github\.com\/acme-corp\/web\/pull\/40\./);
});

// == many tasks in one move (D13) ==

const DOCS = '      DOCS:\n        transitions:\n          - { from: Review, to: Done, mode: agent }\n';
const withBatchRules = (t) => `${t}${RULES}${DOCS}`;
const toDone = { transitions: [{ id: '21', to: { name: 'In Progress' } }, { id: '41', to: { name: 'Done' } }] };
/** The routes of one more task: its issue, transitions, changelog, comments, remote links and dev-status. */
function taskRoutes(key, id, status, { summary = `Task ${key}`, transitions = toDone, comments = [] } = {}) {
  return [
    { match: `^${API}/issue/${key}\\?fields=`, body: { id, key, fields: { summary, status: { name: status }, issuetype: { name: 'Story' }, assignee: ADA, description: null, attachment: [] } } },
    { url: `${API}/issue/${key}/transitions`, body: transitions },
    { match: `^${API}/issue/${key}/changelog`, body: { startAt: 0, total: 0, isLast: true, values: [] } },
    { match: `^${API}/issue/${key}/comment\\?orderBy=created`, body: { startAt: 0, total: comments.length, comments } },
    { url: `${API}/issue/${key}/remotelink`, body: [] },
    { url: `${DEV}/summary?issueId=${id}`, body: devStatusNone.body },
  ];
}
const BATCH_ROUTES = [
  issueRoute('Review', epicParent), transitionsRoute, changelogRoute, commentsRoute, remoteRoute, devStatusNone, pull12,
  ...taskRoutes('PROJ-8', '10008', 'Review', { summary: 'Write the guide' }), epicsRoute,
  ...taskRoutes('PROJ-9', '10009', 'Test'),
  ...taskRoutes('PROJ-11', '10011', 'Review', { transitions: { transitions: [{ id: '21', to: { name: 'In Progress' } }] } }),
  ...taskRoutes('DOCS-3', '20003', 'Review', { summary: 'Publish the report' }),
];
const BATCH = ['transition', '--task', 'PROJ-7,PROJ-8,proj-7,PROJ-9,PROJ-11,DOCS-3', '--to', 'Done', '--comment', 'Checked on staging.'];
const postedFor = (...keys) => keys.flatMap((key) => [
  { method: 'POST', url: `${API}/issue/${key}/transitions`, status: 204 }, { method: 'POST', url: `${API}/issue/${key}/comment`, status: 201, body: { id: '9' } }]);

test('batch: one brief dry run — a block per task, the results once per project, then the tasks that will not move', () => {
  const dir = installation(withBatchRules);
  const r = run(dir, BATCH_ROUTES, [...BATCH, '--dry-run']);
  assert.equal(r.status, 0, r.output);
  const out = r.stdout;
  assert.match(out, /^--- DRY RUN \(requested --dry-run\) ---\nWould move 3 of 5 tasks to Done, each by its own rule:\nResults of PROJ: Pull requests; UI changes also as screenshots\.\n\nPROJ-7 · Export the report · Review → Done \(mode confirm, rule task-tracking\.jira\.defaults\.transitions\[1\]\)$/m);
  assert.equal((out.match(/Results/g) || []).length, 1, 'results once for PROJ, none in the blocks');
  assert.equal((out.match(/^PROJ-7 · /gm) || []).length, 1, 'a key given twice is one task');
  assert.match(out, /^ {2}acme-corp\/web#12 merged \[attached\] PROJ-7 Export CSV$/m);
  assert.match(out, /^Full evidence: node oikos\/tools\/jira\/cli\.mjs transition --task PROJ-7 --to Done --comment 'Checked on staging\.' --dry-run$/m);
  assert.match(out, /^PROJ-8 · Write the guide · Review → Done \(mode confirm, rule task-tracking\.jira\.defaults\.transitions\[1\]\)\nRequires: .*\nPRs: none\n/m);
  assert.match(out, /^Flags: no pull request; no link in the description, the comments or the remote links; no epic, and Requires names one; the repository pool is empty/m);
  assert.match(out, /^DOCS-3 · Publish the report · Review → Done \(mode agent, rule task-tracking\.jira\.projects\.DOCS\.transitions\[0\]\)\nComment: Checked on staging\.$/m);
  assert.match(out, /^Will not move \(2\):\n {2}PROJ-9: Test → Done in PROJ is a person's move by task-tracking\.jira\.defaults\.default \(unset, so person\) — no rule covers it — move PROJ-9 to 'Done' yourself: https:\/\/acme\.atlassian\.net\/browse\/PROJ-9\n {2}PROJ-11: no transition to 'Done' from Review\. Reachable: none$/m);
  assert.match(out, /^- Take out of --task every task that will not or should not move/m);
  assert.ok(out.trimEnd().endsWith('DRY RUN — nothing written to Jira.'));
  assert.deepEqual(writesOf(r.calls), []);
});

test('batch: the real run collects again, moves and reports each; a task that will not move fails; exit 2', () => {
  const dir = installation(withBatchRules);
  const r = run(dir, [...BATCH_ROUTES, ...postedFor('PROJ-7', 'PROJ-8', 'DOCS-3')], BATCH);
  assert.equal(r.status, 2, r.output);
  assert.deepEqual(writesOf(r.calls).map((c) => c.url.slice(API.length)), [
    '/issue/PROJ-7/transitions', '/issue/PROJ-7/comment', '/issue/PROJ-8/transitions', '/issue/PROJ-8/comment', '/issue/DOCS-3/transitions', '/issue/DOCS-3/comment',
  ]);
  assert.match(r.stdout, /^moved PROJ-7$/m);
  assert.match(r.stdout, /^moved DOCS-3$/m);
  assert.match(r.stderr, /^PROJ-9: Test → Done in PROJ is a person's move/m);
  assert.match(r.stderr, /^PROJ-11: no transition to 'Done' from Review\. Reachable: none$/m);
  assert.match(r.stdout, /^3\/5 moved$/m);
  assert.ok(writesOf(r.calls).filter((c) => c.url.endsWith('/comment')).every((c) => JSON.stringify(c.body).includes('Checked on staging.')), '--comment goes to every task');

  const changed = run(dir, [...taskRoutes('PROJ-8', '10008', 'Done'), ...BATCH_ROUTES, ...postedFor('PROJ-7', 'PROJ-8')], ['transition', '--task', 'PROJ-7,PROJ-8', '--to', 'Done']);
  assert.equal(changed.status, 2, changed.output);
  assert.match(changed.stderr, /^PROJ-8: Done → Done in PROJ is a person's move/m, 'no longer movable: failed');
  assert.match(changed.stdout, /^1\/2 moved$/m);
});

test('batch: --skip-pr applies to the tasks that found it and is an error only when none did; the cap, the rules', () => {
  const dir = installation(withPool);
  const quietHosts = [{ match: `^${GH}/search/commits`, body: { total_count: 0, items: [] } }, { match: `^${GL}/projects/acme%2Fbackend/`, body: [] }];
  const routes = [...BATCH_ROUTES, graphqlRoute, pull3, ...devStatusRoutes, ...gitlabRoutes, ...quietHosts];
  const ok = run(dir, routes, ['transition', '--task', 'PROJ-7,PROJ-8', '--to', 'Done', '--skip-pr', 'https://github.com/acme-corp/web/pull/14', '--dry-run']);
  assert.equal(ok.status, 0, ok.output);
  assert.equal((ok.stdout.match(/^Skipped \(--skip-pr\): acme-corp\/web#14 Report UI$/gm) || []).length, 1, 'skipped in the task that found it');
  assert.match(ok.stdout, /^Full evidence: node oikos\/tools\/jira\/cli\.mjs transition --task PROJ-7 --to Done --skip-pr https:\/\/github\.com\/acme-corp\/web\/pull\/14 --dry-run$/m);
  assert.match(ok.stdout, /^Full evidence: node oikos\/tools\/jira\/cli\.mjs transition --task PROJ-8 --to Done --dry-run$/m);
  const none = run(dir, routes, ['transition', '--task', 'PROJ-7,PROJ-8', '--to', 'Done', '--skip-pr', 'https://github.com/acme-corp/web/pull/41', '--dry-run']);
  assert.equal(none.status, 1, none.output);
  assert.match(none.stderr, /--skip-pr https:\/\/github\.com\/acme-corp\/web\/pull\/41: no pull request found by search has this URL in any task\./);

  const many = Array.from({ length: 51 }, (_, i) => `PROJ-${i + 1}`).join(',');
  const capped = run(dir, [], ['transition', '--task', many, '--to', 'Done', '--dry-run']);
  assert.equal(capped.status, 1, capped.output);
  assert.match(capped.stderr, /--task names 51 tasks; a move takes at most 50/);
  assert.deepEqual(capped.calls, []);
  const bad = run(dir, [], ['transition', '--task', 'PROJ-7,PROJ', '--to', 'Done', '--dry-run']);
  assert.match(bad.stderr, /--task: 'PROJ' is not a task key like PROJ-123/);
  const plain = installation((t) => t);
  const noRules = run(plain, [], ['transition', '--task', 'PROJ-7,PROJ-8', '--to', 'Done', '--dry-run']);
  assert.equal(noRules.status, 1, noRules.output);
  assert.match(noRules.stderr, /moving many tasks at once follows the rules of task-tracking\.jira/);
});

test('batch: one key, or the same key twice, is the single move as today', () => {
  const dir = installation(withRules);
  const routes = [issueRoute('Review', epicParent), transitionsRoute, ...EVIDENCE];
  const one = run(dir, routes, ['transition', '--task', 'PROJ-7,PROJ-7', '--to', 'Done', '--dry-run']);
  const single = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(one.status, 0, one.output);
  assert.equal(one.stdout, single.stdout);
});

test('batch: one task whose evidence cannot be read stays back with the reason; the others still dry-run', () => {
  const dir = installation(withBatchRules);
  const broken = { match: `^${API}/issue/PROJ-8/changelog`, status: 500, body: 'server error' };
  const r = run(dir, [broken, ...BATCH_ROUTES], ['transition', '--task', 'PROJ-7,PROJ-8,DOCS-3', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Would move 2 of 3 tasks to Done, each by its own rule:$/m);
  assert.match(r.stdout, /^PROJ-7 · Export the report · Review → Done/m);
  assert.doesNotMatch(r.stdout, /^PROJ-8 · /m);
  assert.match(r.stdout, /^Will not move \(1\):\n {2}PROJ-8: its evidence was not read — HTTP 500 from https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/PROJ-8\/changelog/m);
  assert.deepEqual(writesOf(r.calls), []);
  const epicsDown = run(dir, [{ ...epicsRoute, status: 503, body: 'down' }, ...BATCH_ROUTES], ['transition', '--task', 'PROJ-7,PROJ-8', '--to', 'Done', '--dry-run']);
  assert.equal(epicsDown.status, 0, epicsDown.output);
  assert.match(epicsDown.stdout, /^ {2}PROJ-8: its evidence was not read — HTTP 503/m, 'the open epics of a task without one are read for it alone');
  assert.match(epicsDown.stdout, /^PROJ-7 · /m);
});

test('batch: --skip-pr no task read found is a note, not an error, when a task\'s evidence was not read; the batch still dry-runs', () => {
  const dir = installation(withBatchRules);
  const broken = { match: `^${API}/issue/PROJ-8/changelog`, status: 500, body: 'server error' };
  const args = ['transition', '--task', 'PROJ-7,PROJ-8', '--to', 'Done', '--skip-pr', 'https://github.com/acme-corp/web/pull/41', '--dry-run'];
  const r = run(dir, [broken, ...BATCH_ROUTES], args);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stderr, /^note — --skip-pr https:\/\/github\.com\/acme-corp\/web\/pull\/41 left out no PR found by search among the tasks read; not read: PROJ-8$/m);
  assert.match(r.stdout, /^PROJ-7 · Export the report · Review → Done/m);
  assert.match(r.stdout, /^ {2}PROJ-8: its evidence was not read — HTTP 500/m);
  assert.deepEqual(writesOf(r.calls), []);
  const allRead = run(dir, BATCH_ROUTES, args);
  assert.equal(allRead.status, 1, 'every task read: the usage error holds');
  assert.match(allRead.stderr, /--skip-pr https:\/\/github\.com\/acme-corp\/web\/pull\/41: no pull request found by search has this URL in any task\./);
});

test('batch: a task whose pull request search was incomplete is flagged, and What to do sends it to its full dry run', () => {
  const dir = installation(withPool);
  const failed = { graphql: 'refs(refPrefix', url: `${GH}/graphql`, status: 502, body: 'bad gateway' };
  const routes = [issueRoute('Review', epicParent), transitionsRoute, changelogRoute, commentsRoute, remoteRoute, epicsRoute, devStatusNone, pull12, failed, ...emptyBackend,
    ...taskRoutes('DOCS-3', '20003', 'Review', { summary: 'Publish the report' })];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-7,DOCS-3', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  const block = r.stdout.slice(r.stdout.indexOf('PROJ-7 · '), r.stdout.indexOf('Full evidence:'));
  assert.match(block, /^Notes: github:acme-corp\/web: not searched — HTTP 502/m);
  assert.match(block, /^Flags: pull request search incomplete$/m);
  assert.match(r.stdout, /^- Judge each confirm task as for a single move; a task whose block shows no PR and no link, or flags the pull request\n {2}search incomplete, is judged from its full dry run \(its Full evidence line\) before the question\.$/m);
});

test('batch: a host\'s rate limit on the first task\'s commit search shows in a later task\'s Notes; the host is not asked again', () => {
  const dir = installation(withPool);
  const limited = { match: `^${GH}/search/commits`, status: 429, body: 'rate limited', times: 1 };
  const routes = [...taskRoutes('PROJ-8', '10008', 'Review'), ...taskRoutes('PROJ-10', '10010', 'Review'), epicsRoute, emptyGraphql, ...emptyBackend, backendCommits,
    limited, { match: `^${GH}/search/commits`, body: { total_count: 0, items: [] } }];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-8,PROJ-10', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  const later = r.stdout.slice(r.stdout.indexOf('PROJ-10 · '));
  assert.match(r.stdout.slice(r.stdout.indexOf('PROJ-8 · '), r.stdout.indexOf('PROJ-10 · ')),
    /^Notes: github:acme-corp\/web: commits not searched — github limits the rate of requests \(HTTP 429\)/m);
  assert.match(later, /^Notes: github:acme-corp\/web: commits not searched — github limited the rate of requests earlier in this run/m);
  assert.match(later, /^Flags: .*pull request search incomplete/m);
  assert.equal(r.calls.filter((c) => c.url.startsWith(`${GH}/search/commits`)).length, 1, 'asked once in the run');
  assert.equal(r.calls.filter((c) => c.url === `${GH}/graphql`).length, 2, 'its GraphQL pool search, another quota, is asked for each task');
  assert.deepEqual(writesOf(r.calls).filter((c) => !c.url.endsWith('/graphql')), []);
});

test('batch: the real run notes each task whose evidence collected again is incomplete; the tasks still move and comment, exit 0', () => {
  const dir = installation(withPool);
  const limited = { match: `^${GH}/search/commits`, status: 429, body: 'rate limited', times: 1, headers: { 'retry-after': '600' } };
  const routes = [...taskRoutes('PROJ-8', '10008', 'Review'), ...taskRoutes('PROJ-10', '10010', 'Review'), epicsRoute, emptyGraphql, ...emptyBackend, backendCommits,
    limited, { match: `^${GH}/search/commits`, body: { total_count: 0, items: [] } }, ...postedFor('PROJ-8', 'PROJ-10')];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-8,PROJ-10', '--to', 'Done', '--comment', 'Checked on staging.']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stderr, /^PROJ-8: note — the pull request search was incomplete now \(github:acme-corp\/web: commits not searched — github limits the rate of requests \(HTTP 429\); no more commit search there in this run; retry after ~600s\); the comment lists only what was found$/m);
  assert.match(r.stderr, /^PROJ-10: note — the pull request search was incomplete now \(github:acme-corp\/web: commits not searched — github limited the rate of requests earlier in this run; retry after ~(?:59\d|600)s\); the comment lists only what was found$/m,
    'a later task gets the time left until the first limit\'s deadline');
  assert.match(r.stdout, /^2\/2 moved$/m);
  assert.deepEqual(writesOf(r.calls).filter((c) => !c.url.endsWith('/graphql')).map((c) => c.url.slice(API.length)),
    ['/issue/PROJ-8/transitions', '/issue/PROJ-8/comment', '/issue/PROJ-10/transitions', '/issue/PROJ-10/comment']);
});

test('batch: a task whose evidence cannot be collected again fails with no note; an incomplete one that moved is noted; exit 2', () => {
  const dir = installation(withPool);
  const broken = { match: `^${API}/issue/PROJ-8/comment\\?orderBy=created`, status: 500, body: 'server error' };
  const limited = { match: `^${GH}/search/commits`, status: 429, body: 'rate limited' };
  const tasks = [...taskRoutes('PROJ-8', '10008', 'Review'), ...taskRoutes('PROJ-10', '10010', 'Review'), epicsRoute, emptyGraphql, ...emptyBackend, backendCommits, limited];
  const args = ['transition', '--task', 'PROJ-8,PROJ-10', '--to', 'Done', '--comment', 'Checked on staging.'];
  const r = run(dir, [broken, ...tasks, ...postedFor('PROJ-10')], args);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /^PROJ-8: HTTP 500 from /m);
  assert.doesNotMatch(r.stderr, /^PROJ-8: note/m, 'the failed task gets no note');
  assert.match(r.stderr, /^PROJ-10: note — the pull request search was incomplete now \(github:acme-corp\/web: commits not searched — github limits the rate of requests \(HTTP 429\)/m);
  assert.match(r.stdout, /^1\/2 moved$/m);
  assert.deepEqual(writesOf(r.calls).filter((c) => !c.url.endsWith('/graphql')).map((c) => c.url.slice(API.length)), ['/issue/PROJ-10/transitions', '/issue/PROJ-10/comment']);

  const uncommented = run(dir, [...tasks, ...postedFor('PROJ-8'), { method: 'POST', url: `${API}/issue/PROJ-10/transitions`, status: 204 },
    { method: 'POST', url: `${API}/issue/PROJ-10/comment`, status: 500, body: 'server error' }], args);
  assert.equal(uncommented.status, 2, uncommented.output);
  assert.match(uncommented.stderr, /^PROJ-10: moved, but the comment was not posted/m);
  assert.doesNotMatch(uncommented.stderr, /^PROJ-10: note/m, 'a comment that failed lists nothing: no note');
  assert.match(uncommented.stderr, /^PROJ-8: note — the pull request search was incomplete now/m);
});

// The header of the unposted comment of PROJ-7 moved to Done, naming the command to post it with.
const UNPOSTED_HEADER = String.raw`^PROJ-7: moved to Done; the comment was not posted \(HTTP 500 from [^\n]*: server error\)\. Its text, to post with ` +
  String.raw`node oikos/tools/jira/cli\.mjs comment --task PROJ-7 --file <this text saved> --dry-run first:`;

test('batch: a move that went through and a comment that did not count as moved, the comment failure apart; exit 2', () => {
  const dir = installation(withBatchRules);
  const routes = [...BATCH_ROUTES, { method: 'POST', url: `${API}/issue/PROJ-7/transitions`, status: 204 },
    { method: 'POST', url: `${API}/issue/PROJ-7/comment`, status: 500, body: 'server error' }, ...postedFor('DOCS-3')];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-7,DOCS-3', '--to', 'Done', '--comment', 'Checked on staging.']);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stdout, /^moved PROJ-7$/m);
  assert.match(r.stderr, /^PROJ-7: moved, but the comment was not posted — HTTP 500/m);
  assert.match(r.stdout, /^2\/2 moved, 1 without its comment$/m);
  assert.match(r.stdout, new RegExp(`${UNPOSTED_HEADER}\\n-{40}\\nChecked on staging\\.\\n-{40}$`, 'm'),
    'the comment text is printed: a dry run of a task already moved no longer has it');
  assert.doesNotMatch(r.stdout, /^DOCS-3: moved to Done; the comment was not posted/m);
});

test('a single move that went through and a comment that did not prints the comment text, its pull request lines included; exit 2', () => {
  const dir = installation(withExtended);
  const routes = [issueRoute('Review', epicParent), transitionsRoute, ...EXTENDED_ROUTES, { method: 'POST', url: `${API}/issue/PROJ-7/transitions`, status: 204 },
    { method: 'POST', url: `${API}/issue/PROJ-7/comment`, status: 500, body: 'server error' }];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--comment', 'Checked on staging.', '--extended']);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stdout, /^PROJ-7: Review → Done$/m);
  assert.match(r.stdout, new RegExp(`${UNPOSTED_HEADER}\\n-{40}\\nChecked on staging\\.\\n\\nPull requests of this task found in the project's repositories:\\n` +
    String.raw`- \[acme/legacy!9\]\(https://gitlab\.example\.com/acme/legacy/-/merge_requests/9\) — PROJ-7 old export \(merged\)\n-{40}$`, 'm'));
  assert.match(r.stderr, /^jira: HTTP 500 from /m);
});

test('batch: a task with no direct transition keeps its path hint, indented, in the Will not move list', () => {
  const dir = installation(withPathRules);
  const toChecked = { transitions: [{ id: '61', to: { name: 'Checked' } }] };
  const r = run(dir, [issueRoute('Test'), fromTest, ...taskRoutes('PROJ-8', '10008', 'Test', { transitions: toChecked }), seenInHistory('Checked'), seenInHistory('Fix')],
    ['transition', '--task', 'PROJ-7,PROJ-8', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 3, r.output);
  assert.match(r.stdout, /^Would move 0 of 2 tasks to Done/m);
  assert.match(r.stdout, /^ {2}PROJ-7: no transition to 'Done' from Test\. Reachable: Checked\n {4}A path the rules allow: Test → Checked → Done \(modes: confirm, confirm; the second step is seen in this project's history\)\. Each step is its own move with its own dry run:\n {6}node oikos\/tools\/jira\/cli\.mjs transition --task PROJ-7 --to Checked --dry-run\n {6}node oikos\/tools\/jira\/cli\.mjs transition --task PROJ-7 --to Done --dry-run\n {2}PROJ-8: /m);
  assert.deepEqual(writesOf(r.calls), []);
});

// == a path when the target is not directly reachable ==

const PATH_RULES = `
task-tracking:
  jira:
    defaults:
      transitions:
        - { from: Test, to: [Checked, Done], mode: confirm, requires: Checked on staging. }
        - { from: [Checked, Fix], to: Done, mode: confirm }
`;
const withPathRules = (t) => `${t}${PATH_RULES}`;
const fromTest = { url: `${API}/issue/PROJ-7/transitions`, body: { transitions: [{ id: '61', to: { name: 'Checked' } }, { id: '71', to: { name: 'Fix' } }] } };
const historyJql = (via) => `^${API}/search/jql\\?jql=${encodeURIComponent(`project = "PROJ" AND status CHANGED FROM "${via}" TO "Done"`)}&`;
const seenInHistory = (via) => ({ match: historyJql(via), body: { issues: [{ key: 'PROJ-2', fields: {} }] } });
const historySearches = (calls) => calls.filter((c) => c.url.includes('/search/jql')).map((c) => decodeURIComponent(c.url));

test('path: no direct transition, a reachable status the rules allow and the history shows leading on — the two steps are printed', () => {
  const dir = installation(withPathRules);
  const r = run(dir, [issueRoute('Test'), fromTest, seenInHistory('Checked'), seenInHistory('Fix')], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /^jira: no transition to 'Done' from Test\. Reachable: Checked\nA path the rules allow: Test → Checked → Done \(modes: confirm, confirm; the second step is seen in this project's history\)\. Each step is its own move with its own dry run:\n {2}node oikos\/tools\/jira\/cli\.mjs transition --task PROJ-7 --to Checked --dry-run\n {2}node oikos\/tools\/jira\/cli\.mjs transition --task PROJ-7 --to Done --dry-run$/m);
  assert.doesNotMatch(r.stderr, /→ Fix →/, 'Test → Fix is a person\'s move: not offered');
  assert.deepEqual(historySearches(r.calls).map((u) => /FROM "(\w+)"/.exec(u)[1]), ['Checked'], 'no history search for a step the rules refuse');
  assert.deepEqual(writesOf(r.calls), []);
});

test('path: a batch of two tasks in the same status asks each history query once, in the dry run and the real run', () => {
  const dir = installation(withPathRules);
  const routes = [issueRoute('Test'), fromTest, ...taskRoutes('PROJ-8', '10008', 'Test', { transitions: fromTest.body }), seenInHistory('Checked'), seenInHistory('Fix')];
  for (const args of [['--dry-run'], []]) {
    const r = run(dir, routes, ['transition', '--task', 'PROJ-7,PROJ-8', '--to', 'Done', ...args]);
    // The real run reports each task's first line only; the dry run keeps both hints.
    if (args.length) assert.equal((r.output.match(/A path the rules allow: Test → Checked → Done/g) || []).length, 2, r.output);
    else assert.match(r.output, /^0\/2 moved$/m);
    const searches = historySearches(r.calls);
    assert.deepEqual(searches.map((u) => /FROM "(\w+)"/.exec(u)[1]), ['Checked'], `one search for the two tasks ${args.join(' ')}`);
    assert.deepEqual(writesOf(r.calls), []);
  }
});

test('path: no history of the second step — no path, the old message', () => {
  const dir = installation(withPathRules);
  const none = { match: historyJql('Checked'), body: { issues: [] } };
  const r = run(dir, [issueRoute('Test'), fromTest, none], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /^jira: no transition to 'Done' from Test\. Reachable: Checked$/m);
  assert.doesNotMatch(r.stderr, /A path/);
  assert.deepEqual(writesOf(r.calls), []);
});

// == epics by role and across projects (D09, D10) ==

const EPIC_RULES = RULES.replace('        epics: One epic per product area.', [
  '        epic_roles: { fixes: PROJ-10, features: PROJ-11, support: PROJ-12 }',
  '        epic_projects: [PLAN, OTHER]',
  '        epics: A subject epic first; else bugs to fixes, the rest to features.',
].join('\n'));
const withEpicRules = (t) => `${t}${EPIC_RULES}`;
const epicIssue = (key, summary, status, category, type = 'Epic') => ({
  url: `${API}/issue/${key}?fields=summary,status,issuetype`,
  body: { key, fields: { summary, status: { name: status, statusCategory: { key: category } }, issuetype: { name: type } } },
});
const openEpics = (project, issues, extra = {}) => ({
  match: `^${API}/search/jql\\?jql=${encodeURIComponent(`project = "${project}" AND issuetype = Epic`)}`, body: { issues }, ...extra,
});
const projectRoute = (key, team) => ({ url: `${API}/project/${key}`, body: team ? { key, simplified: true, style: 'next-gen' } : { key, simplified: false, style: 'classic' } });
const EPIC_ROUTES = [
  epicIssue('PROJ-10', 'Fixes', 'In Progress', 'indeterminate'),
  epicIssue('PROJ-11', 'Features', 'Done', 'done'),
  { url: `${API}/issue/PROJ-12?fields=summary,status,issuetype`, status: 404, body: { errorMessages: ['Issue does not exist'] } },
  openEpics('PROJ', [{ key: 'PROJ-1', fields: { summary: 'Reporting' } }, { key: 'PROJ-10', fields: { summary: 'Fixes' } }, { key: 'PROJ-2', fields: { summary: 'Platform' } }]),
  openEpics('PLAN', [{ key: 'PLAN-5', fields: { summary: 'Billing', description: doc('Invoices and exports of the billing area.') } }]),
  openEpics('OTHER', [], { status: 400, body: { errorMessages: ["The value 'OTHER' does not exist for the field 'project'."] } }),
  projectRoute('PROJ', false), projectRoute('PLAN', true),
];
const EPIC_EVIDENCE = [changelogRoute, commentsRoute, remoteRoute, devStatusNone, pull12, ...EPIC_ROUTES];

test('epics: the role epics with their flags, the other open epics, then each epic_projects project marked parent or link only', () => {
  const dir = installation(withEpicRules);
  const r = run(dir, [issueRoute('Review'), transitionsRoute, ...EPIC_EVIDENCE], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  const section = r.stdout.slice(r.stdout.indexOf('## Epic'), r.stdout.indexOf('## Comment posted'));
  assert.equal(section, [
    '## Epic',
    '  None: the task has no epic.',
    '  Role epics of PROJ (task-tracking.jira.projects.PROJ.epic_roles):',
    '    fixes: PROJ-10 — Fixes [In Progress]',
    '    features: PROJ-11 — Features [Done] — closed',
    '    support: PROJ-12 — missing: no such issue, or not visible',
    '  Other open epics of PROJ (2):',
    '    PROJ-1 — Reporting',
    '    PROJ-2 — Platform',
    '  Open epics of PLAN (epic_projects; 1) — link only: PLAN is team-managed, so a parent must be in PROJ:',
    '    PLAN-5 — Billing  [link only]',
    '        Invoices and exports of the billing area.',
    '  Open epics of OTHER (epic_projects): not read (HTTP 400)',
    '', ''].join('\n'));
  assert.match(r.stdout, /^- Rank as the project's epics rule says: a subject epic that fits the task's topic first/m);
  assert.match(r.stdout, /^ {2}node oikos\/tools\/jira\/cli\.mjs edit --task PROJ-7 --parent <EPIC of PROJ> --dry-run\n {2}node oikos\/tools\/jira\/cli\.mjs link --from PROJ-7 --type Relates --to <subject EPIC> --dry-run$/m);
  assert.match(r.stdout, /edit --task PROJ-7 --parent <EPIC> --dry-run, then this move\./, 'the old advice holds');
  const reads = r.calls.filter((c) => c.url.startsWith(`${API}/project/`)).map((c) => c.url.slice(`${API}/project/`.length));
  assert.deepEqual(reads, ['PROJ', 'PLAN'], 'each project read once; a project whose epics were not read is not read');
  assert.deepEqual(writesOf(r.calls), []);
});

test('epics: a cross-project epic of two company-managed projects is a parent; no link-only advice', () => {
  const dir = installation((t) => `${t}${EPIC_RULES.replace('epic_projects: [PLAN, OTHER]', 'epic_projects: [PLAN]')}`);
  const routes = [issueRoute('Review'), transitionsRoute, projectRoute('PLAN', false), ...EPIC_EVIDENCE];
  const r = run(dir, routes, ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}Open epics of PLAN \(epic_projects; 1\) — parent: both projects are company-managed:\n {4}PLAN-5 — Billing {2}\[parent\]$/m);
  assert.doesNotMatch(r.stdout, /A link-only pick/);
  assert.match(r.stdout, /^- Rank as the project's epics rule says/m);
});

test('epics: a project is team-managed by simplified: true alone, or by style next-gen alone', () => {
  const dir = installation((t) => `${t}${EPIC_RULES.replace('epic_projects: [PLAN, OTHER]', 'epic_projects: [PLAN]')}`);
  for (const body of [{ key: 'PLAN', simplified: true }, { key: 'PLAN', style: 'next-gen' }]) {
    const r = run(dir, [issueRoute('Review'), transitionsRoute, { url: `${API}/project/PLAN`, body }, ...EPIC_EVIDENCE], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /^ {2}Open epics of PLAN \(epic_projects; 1\) — link only: PLAN is team-managed, so a parent must be in PROJ:$/m, JSON.stringify(body));
  }
});

test('epics: the brief line names the roles with their flags and each project\'s mark, each group cut', () => {
  const dir = installation(withEpicRules);
  const r = run(dir, [issueRoute('Review'), transitionsRoute, ...EPIC_EVIDENCE], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run', '--brief']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Epic: none — roles: fixes PROJ-10 Fixes; features PROJ-11 Features \[closed\]; support PROJ-12 \[missing: no such issue, or not visible\] \| open epics \(2\): PROJ-1 Reporting; PROJ-2 Platform \| PLAN \[link only\] \(1\): PLAN-5 Billing \| OTHER: not read \(HTTP 400\)$/m);
  const long = Array.from({ length: 30 }, (_, i) => ({ key: `PLAN-${i + 1}`, fields: { summary: `Subject epic number ${i + 1}` } }));
  const many = run(dir, [issueRoute('Review'), transitionsRoute, openEpics('PLAN', long), ...EPIC_EVIDENCE], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run', '--brief']);
  const line = many.stdout.split('\n').find((l) => l.startsWith('Epic:'));
  assert.match(line, /\| PLAN \[link only\] \(30\): PLAN-1 Subject epic number 1; [^|]*… \| OTHER: not read/);
});

test('epics: without roles or epic_projects the section and the brief line are as before, with no extra request', () => {
  const dir = installation(withRules);
  const r = run(dir, [issueRoute('Review'), transitionsRoute, ...EVIDENCE], ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.stdout, /Role epics|epic_projects|Rank as/);
  assert.ok(!r.calls.some((c) => c.url.startsWith(`${API}/project/`) || /issue\/PROJ-1\d\?/.test(c.url)));
});
