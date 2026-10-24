// Repository governance reads (tools/github/governance.mjs, tools/gitlab/governance.mjs,
// tools/common/governance.mjs) against canned answers (npm test): what guards a branch or project,
// the CODEOWNERS file found in the host's order, and the merged pull or merge requests of a period
// with their totals. The tools run in a copy of examples/installation (ACME Corp) under the
// fake-fetch preload; the pure helpers are called in-process. No real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeownersRules, isDate, mergeTotals, totalsLine } from '../tools/common/governance.mjs';
import { NETWORK, installation, tool, withFakeFetch, withGitlab } from './helpers/installation.mjs';

const GITHUB = { GITHUB_TOKEN: 'ghp_fake_token' };
const GITLAB = { GITLAB_TOKEN: 'glpat-fake-token' };
const API = 'https://api.github.com/repos/acme/app';
const GL = 'https://gitlab.example.com/api/v4/projects/acme%2Fapp';
const withSetting = (key, value) => (t) => t.replace('settings:', `settings:\n  ${key}: ${value}`);
const gitlabInstallation = () => installation((t) => withSetting('GITLAB_URL', 'https://gitlab.example.com')(withGitlab(t)));

test('codeownersRules, isDate and mergeTotals', () => {
  assert.deepEqual(codeownersRules('# owners\n\n* @acme/core\n[Docs]\n^[Optional][2] @ada\n  /docs/ @ada  \n'), ['* @acme/core', '/docs/ @ada']);
  assert.ok(isDate('2026-10-01'));
  for (const bad of ['2026-02-31', '2026-10-1', 'yesterday', '', undefined]) assert.ok(!isDate(bad), String(bad));
  const totals = mergeTotals([
    { createdAt: '2026-10-01T00:00:00Z', mergedAt: '2026-10-01T10:00:00Z', author: 'ada', mergedBy: 'bob', approvers: ['carol'] },
    { createdAt: '2026-10-02T00:00:00Z', mergedAt: '2026-10-03T00:00:00Z', author: 'bob', mergedBy: 'bob', approvers: [] },
    { createdAt: '2026-10-03T00:00:00Z', mergedAt: '2026-10-03T02:00:00Z', author: 'ada', mergedBy: 'ada', approvers: null },
  ]);
  assert.deepEqual(totals, { count: 3, medianHours: 10, meanHours: 12, approvedShare: 0.5, approvalsKnown: 2, selfMergedShare: 2 / 3 });
  assert.equal(totalsLine(totals), '3 merged · open→merge median 10.0h, mean 12.0h · approved 50% (of 2 with known approvals) · self-merged 67%');
  assert.deepEqual(mergeTotals([]), { count: 0, medianHours: null, meanHours: null, approvedShare: null, approvalsKnown: 0, selfMergedShare: null });
});

// == GitHub governance ==

const protection = {
  enforce_admins: { enabled: true },
  required_status_checks: { strict: true, contexts: ['ci/test'], checks: [{ context: 'ci/test' }, { context: 'lint' }] },
  required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true, dismiss_stale_reviews: true, require_last_push_approval: false },
  required_linear_history: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  required_conversation_resolution: { enabled: true },
};

const environments = {
  total_count: 2,
  environments: [
    {
      name: 'production',
      protection_rules: [
        { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { login: 'ada' } }, { type: 'Team', reviewer: { slug: 'ops' } }] },
        { type: 'wait_timer', wait_timer: 30 },
        { type: 'branch_policy' },
      ],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    { name: 'staging', protection_rules: [], deployment_branch_policy: null },
  ],
};

test('github governance: rules, rulesets, protection, environments (an object), CODEOWNERS in GitHub\'s order', () => {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, [
    { url: API, body: { default_branch: 'main' } },
    {
      url: `${API}/rules/branches/main?per_page=100`,
      body: [
        { type: 'pull_request', ruleset_id: 7, ruleset_source_type: 'Repository', ruleset_source: 'acme/app', parameters: { required_approving_review_count: 1, require_code_owner_review: true } },
        { type: 'non_fast_forward', ruleset_id: 7, ruleset_source_type: 'Repository', ruleset_source: 'acme/app' },
      ],
    },
    { url: `${API}/rulesets?includes_parents=true&per_page=100`, body: [{ id: 7, name: 'Protect main', target: 'branch', enforcement: 'active', source_type: 'Repository', source: 'acme/app' }] },
    { url: `${API}/branches/main/protection`, body: protection },
    { url: `${API}/environments?per_page=100`, body: environments },
    { url: `${API}/environments/production/deployment-branch-policies?per_page=100`, body: { total_count: 1, branch_policies: [{ name: 'release/*', type: 'branch' }] } },
    { url: `${API}/contents/.github/CODEOWNERS?ref=main`, status: 404, body: { message: 'Not Found' } },
    { url: `${API}/contents/CODEOWNERS?ref=main`, body: '# owners\n* @acme/core\n/docs/ @ada\n' },
  ]);
  const r = tool(dir, 'github', ['governance', '--repo', 'acme/app'], { ...GITHUB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^github:acme\/app · branch main \(default\)$/m);
  assert.match(r.stdout, /^rules on main: 2$/m);
  assert.match(r.stdout, /^ {2}- pull_request \[ruleset "Protect main" #7\]: required_approving_review_count 1, require_code_owner_review yes$/m);
  assert.match(r.stdout, /^ {2}#7 Protect main · branch · active · Repository acme\/app$/m);
  assert.match(r.stdout, /^protection of main: enforce admins yes · status checks \(strict yes\): ci\/test, lint · reviews: 2 approval\(s\), code owners yes, dismiss stale yes, last push approval no · linear history yes · force push no · deletions no · conversation resolution yes$/m);
  assert.match(r.stdout, /^environments: 2$/m);
  assert.match(r.stdout, /^ {2}production: reviewers @ada, team ops \(no self-review\) · wait 30 min · branches: release\/\*$/m);
  assert.match(r.stdout, /^ {2}staging: no protection rules · branches: any$/m);
  assert.match(r.stdout, /^CODEOWNERS: CODEOWNERS — 2 rule\(s\)$/m);
  assert.match(r.stdout, /^ {2}\* @acme\/core$/m);
  const urls = fake.calls().map((c) => c.url);
  assert.ok(urls.indexOf(`${API}/contents/.github/CODEOWNERS?ref=main`) < urls.indexOf(`${API}/contents/CODEOWNERS?ref=main`));
  assert.ok(!urls.includes(`${API}/contents/docs/CODEOWNERS?ref=main`), 'the first found ends the search');
  assert.ok(fake.calls().every((c) => c.method === 'GET'), 'governance only reads');
});

test('github governance: protection 404 is reported absent, 403 as needing admin; no CODEOWNERS anywhere', () => {
  const dir = installation((t) => t);
  const routes = (protectionAnswer) => [
    { url: API, body: { default_branch: 'main' } },
    { url: `${API}/rules/branches/dev?per_page=100`, body: [] },
    { url: `${API}/rulesets?includes_parents=true&per_page=100`, body: [] },
    { url: `${API}/branches/dev/protection`, ...protectionAnswer },
    { url: `${API}/environments?per_page=100`, status: 404, body: { message: 'Not Found' } },
    { match: '/contents/', status: 404, body: { message: 'Not Found' } },
  ];
  let fake = withFakeFetch(dir, routes({ status: 404, body: { message: 'Branch not protected' } }));
  let r = tool(dir, 'github', ['governance', '--repo', 'acme/app', '--branch', 'dev'], { ...GITHUB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^github:acme\/app · branch dev \(default main\)$/m);
  assert.match(r.stdout, /^protection of dev: not protected, or needs admin \(Administration read\)/m);
  assert.match(r.stdout, /^environments: none, or not available$/m);
  assert.match(r.stdout, /^CODEOWNERS: none \(looked in \.github\/CODEOWNERS, CODEOWNERS, docs\/CODEOWNERS\)$/m);
  assert.equal(fake.calls().filter((c) => c.url.includes('/contents/')).length, 3);

  fake = withFakeFetch(dir, routes({ status: 403, body: { message: 'Resource not accessible by personal access token' } }));
  r = tool(dir, 'github', ['governance', '--repo', 'acme/app', '--branch', 'dev', '--json'], { ...GITHUB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  const gov = JSON.parse(r.stdout);
  assert.deepEqual(gov.protection, { state: 'refused', status: 403, message: 'Resource not accessible by personal access token' });
  assert.equal(gov.environments.state, 'absent');
});

// == GitHub merged ==

const pull = (number, createdAt, mergedAt, author, mergedBy, approvers, reviews) => ({
  number, title: `Change ${number}`, url: `https://github.com/acme/app/pull/${number}`, createdAt, mergedAt,
  author: { login: author }, mergedBy: { login: mergedBy },
  approvals: { totalCount: approvers.length, nodes: approvers.map((login) => ({ author: { login } })) },
  reviews: { totalCount: reviews },
});

test('github merged: one search query page by page, a line per pull request and the totals', () => {
  const dir = installation((t) => t);
  const page = (nodes, hasNextPage, endCursor) => ({ data: { search: { issueCount: 3, pageInfo: { hasNextPage, endCursor }, nodes } } });
  const fake = withFakeFetch(dir, [
    {
      graphql: 'query OikosMerged', variables: { after: 'c1' },
      body: page([pull(3, '2026-10-03T00:00:00Z', '2026-10-03T02:00:00Z', 'ada', 'ada', ['bob', 'bob'], 3)], false, null),
    },
    {
      graphql: 'query OikosMerged', times: 1,
      body: page([
        pull(2, '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z', 'bob', 'bob', [], 0),
        pull(1, '2026-10-01T00:00:00Z', '2026-10-01T10:00:00Z', 'ada', 'bob', ['carol'], 2),
      ], true, 'c1'),
    },
  ]);
  const r = tool(dir, 'github', ['merged', '--repo', 'acme/app', '--since', '2026-10-01'], { ...GITHUB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  const lines = r.stdout.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 3).map((l) => l.trim().split(' ')[0]), ['#1', '#2', '#3'], 'oldest merge first');
  assert.equal(lines[0], '    #1  2026-10-01 → 2026-10-01 (10.0h)  @ada merged by @bob  approved: carol (2 review(s))  Change 1');
  assert.match(lines[2], /@ada merged by @ada {2}approved: bob \(3 review\(s\)\)/);
  assert.equal(lines[3], 'github:acme/app since 2026-10-01: 3 merged · open→merge median 10.0h, mean 12.0h · approved 67% · self-merged 67%');
  const calls = fake.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.variables.q, 'repo:acme/app is:pr is:merged merged:>=2026-10-01');
});

test('github merged: --since must be a date, and --dry-run is not an option', () => {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, []);
  const bad = tool(dir, 'github', ['merged', '--repo', 'acme/app', '--since', 'last week'], { ...GITHUB, ...fake.env }, fake);
  assert.equal(bad.status, 1, bad.output);
  assert.match(bad.stderr, /--since is not a date YYYY-MM-DD: last week/);
  for (const verb of [['merged', '--since', '2026-10-01'], ['governance']]) {
    const dry = tool(dir, 'github', [...verb, '--repo', 'acme/app', '--dry-run'], { ...GITHUB, ...fake.env }, fake);
    assert.equal(dry.status, 1, dry.output);
    assert.match(dry.stderr, /Unknown option '--dry-run'/);
    assert.doesNotMatch(dry.output, new RegExp(NETWORK));
  }
  assert.equal(fake.calls().length, 0);
});

// == GitLab governance ==

test('gitlab governance: merge checks, protected branches, approvals refused (403), CODEOWNERS fallback', () => {
  const dir = gitlabInstallation();
  const fake = withFakeFetch(dir, [
    {
      url: GL,
      body: {
        default_branch: 'main', name: 'app', merge_method: 'ff', only_allow_merge_if_pipeline_succeeds: true,
        only_allow_merge_if_all_discussions_are_resolved: false, remove_source_branch_after_merge: true,
      },
    },
    {
      url: `${GL}/protected_branches?per_page=100&page=1`,
      body: [{
        name: 'main', push_access_levels: [{ access_level: 40, access_level_description: 'Maintainers' }],
        merge_access_levels: [{ access_level: 30, access_level_description: 'Developers + Maintainers' }], allow_force_push: false, code_owner_approval_required: true,
      }],
    },
    { url: `${GL}/approvals`, status: 403, body: { message: '403 Forbidden' } },
    { url: `${GL}/approval_rules?per_page=100`, status: 404, body: { message: '404 Not found' } },
    { url: `${GL}/repository/files/CODEOWNERS/raw?ref=main`, status: 404, body: { message: '404 File Not Found' } },
    { url: `${GL}/repository/files/docs%2FCODEOWNERS/raw?ref=main`, status: 404, body: { message: '404 File Not Found' } },
    { url: `${GL}/repository/files/.gitlab%2FCODEOWNERS/raw?ref=main`, body: '[Backend]\n*.rb @ada\n' },
  ]);
  const r = tool(dir, 'gitlab', ['governance', '--project', 'acme/app'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^gitlab:acme\/app · default branch main$/m);
  assert.match(r.stdout, /^merge checks: merge_method ff, only_allow_merge_if_pipeline_succeeds yes, only_allow_merge_if_all_discussions_are_resolved no, remove_source_branch_after_merge yes$/m);
  assert.match(r.stdout, /^protected branches: 1 visible to this token$/m);
  assert.match(r.stdout, /^ {2}main: push Maintainers · merge Developers \+ Maintainers · force push no · code owner approval yes$/m);
  assert.match(r.stdout, /^approval settings: not available: needs Premium or Maintainer — refused \(403\) — 403 Forbidden$/m);
  assert.match(r.stdout, /^approval rules: not available: needs Premium or Maintainer — GitLab answered 404$/m);
  assert.match(r.stdout, /^CODEOWNERS: \.gitlab\/CODEOWNERS — 1 rule\(s\)$/m);
  assert.match(r.stdout, /^ {2}\*\.rb @ada$/m);
  assert.ok(fake.calls().every((c) => c.method === 'GET'), 'governance only reads');
  const json = tool(dir, 'gitlab', ['governance', '--project', 'acme/app', '--json'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(json.status, 0, json.output);
  const gov = JSON.parse(json.stdout);
  assert.equal(gov.protectedBranches.state, 'ok');
  assert.deepEqual(gov.approvals, { state: 'unreadable', why: 'refused (403) — 403 Forbidden' });
  assert.deepEqual(gov.approvalRules, { state: 'unreadable', why: 'GitLab answered 404' }, 'a tier or role 404 is never absent');
  assert.deepEqual(gov.codeowners, { state: 'ok', path: '.gitlab/CODEOWNERS', rules: ['*.rb @ada'] });
});

test('gitlab governance: protected branches unreadable (404, 403) is reported and the other parts still read', () => {
  const dir = gitlabInstallation();
  const routes = (protectedAnswer) => [
    { url: GL, body: { default_branch: 'main', merge_method: 'merge' } },
    { url: `${GL}/protected_branches?per_page=100&page=1`, ...protectedAnswer },
    { url: `${GL}/approvals`, body: { approvals_before_merge: 1, reset_approvals_on_push: true } },
    { url: `${GL}/approval_rules?per_page=100`, body: [] },
    { match: '/repository/files/', status: 404, body: { message: '404 File Not Found' } },
  ];
  for (const [answer, why] of [
    [{ status: 404, body: { message: '404 Not found' } }, 'GitLab answered 404'],
    [{ status: 403, body: { message: '403 Forbidden' } }, 'refused \\(403\\) — 403 Forbidden'],
  ]) {
    const fake = withFakeFetch(dir, routes(answer));
    const r = tool(dir, 'gitlab', ['governance', '--project', 'acme/app'], { ...GITLAB, ...fake.env }, fake);
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, new RegExp(`^protected branches: not readable with this token \\(needs Maintainer\\) — ${why}$`, 'm'));
    assert.doesNotMatch(r.stdout, /^protected branches: (0|none)/m, 'an unreadable part is never reported as no protection');
    assert.match(r.stdout, /^approval settings: approvals_before_merge 1, reset_approvals_on_push yes$/m);
    assert.match(r.stdout, /^approval rules: 0$/m);
    assert.match(r.stdout, /^CODEOWNERS: none \(looked in CODEOWNERS, docs\/CODEOWNERS, \.gitlab\/CODEOWNERS\)$/m);
  }
  // --json: both answers are `unreadable` (never `absent`, which would read as no protection);
  // CODEOWNERS found at no path is the one genuine `absent`.
  for (const [answer, why] of [
    [{ status: 404, body: { message: '404 Not found' } }, 'GitLab answered 404'],
    [{ status: 403, body: { message: '403 Forbidden' } }, 'refused (403) — 403 Forbidden'],
  ]) {
    const fake = withFakeFetch(dir, routes(answer));
    const r = tool(dir, 'gitlab', ['governance', '--project', 'acme/app', '--json'], { ...GITLAB, ...fake.env }, fake);
    assert.equal(r.status, 0, r.output);
    const gov = JSON.parse(r.stdout);
    assert.deepEqual(gov.protectedBranches, { state: 'unreadable', why });
    assert.deepEqual(gov.codeowners, { state: 'absent', looked: ['CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'] });
  }
});

test('gitlab governance: CODEOWNERS refused (403) is unreadable and ends the search', () => {
  const dir = gitlabInstallation();
  const fake = withFakeFetch(dir, [
    { url: GL, body: { default_branch: 'main' } },
    { url: `${GL}/protected_branches?per_page=100&page=1`, body: [] },
    { url: `${GL}/approvals`, body: {} },
    { url: `${GL}/approval_rules?per_page=100`, body: [] },
    { url: `${GL}/repository/files/CODEOWNERS/raw?ref=main`, status: 403, body: { message: '403 Forbidden' } },
  ]);
  const r = tool(dir, 'gitlab', ['governance', '--project', 'acme/app'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^CODEOWNERS: refused \(403\) — 403 Forbidden$/m);
  const json = tool(dir, 'gitlab', ['governance', '--project', 'acme/app', '--json'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(json.status, 0, json.output);
  assert.deepEqual(JSON.parse(json.stdout).codeowners, { state: 'unreadable', why: 'refused (403) — 403 Forbidden' });
  assert.ok(!fake.calls().some((c) => c.url.includes('docs%2FCODEOWNERS')), 'a refusal ends the search');
});

test('gitlab governance: an empty protected-branch list is "0 visible to this token", and --json keeps the raw list', () => {
  const dir = gitlabInstallation();
  const fake = withFakeFetch(dir, [
    { url: GL, body: { default_branch: 'main' } },
    { url: `${GL}/protected_branches?per_page=100&page=1`, body: [] },
    { url: `${GL}/approvals`, status: 404, body: { message: '404 Not found' } },
    { url: `${GL}/approval_rules?per_page=100`, status: 404, body: { message: '404 Not found' } },
    { match: '/repository/files/', status: 404, body: { message: '404 File Not Found' } },
  ]);
  const r = tool(dir, 'gitlab', ['governance', '--project', 'acme/app'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^protected branches: 0 visible to this token$/m);
  assert.doesNotMatch(r.stdout, /protected branches: none/);
  const json = tool(dir, 'gitlab', ['governance', '--project', 'acme/app', '--json'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(json.status, 0, json.output);
  assert.deepEqual(JSON.parse(json.stdout).protectedBranches, { state: 'ok', data: [] });
});

// == GitLab merged and mrs --since ==

test('gitlab merged: merged since the date, per-MR approvals (one refused), --notes, totals', () => {
  const dir = gitlabInstallation();
  const mr = (iid, createdAt, mergedAt, author, merger) => ({
    iid, title: `Change ${iid}`, created_at: createdAt, merged_at: mergedAt, author: { username: author }, merge_user: { username: merger },
  });
  const fake = withFakeFetch(dir, [
    {
      match: '/projects/acme%2Fapp/merge_requests\\?state=merged&updated_after=2026-10-01T00%3A00%3A00Z&order_by=updated_at&sort=desc&per_page=100&page=1$',
      body: [
        mr(6, '2026-10-02T00:00:00Z', '2026-10-02T02:00:00Z', 'bob', 'bob'),
        mr(5, '2026-10-01T00:00:00Z', '2026-10-01T06:00:00Z', 'ada', 'bob'),
        mr(4, '2026-09-20T00:00:00Z', '2026-09-30T00:00:00Z', 'ada', 'ada'),
      ],
    },
    { url: `${GL}/merge_requests/5/approvals`, body: { approved_by: [{ user: { username: 'carol' } }] } },
    { url: `${GL}/merge_requests/6/approvals`, status: 403, body: { message: '403 Forbidden' } },
    { url: `${GL}/merge_requests/5/notes?sort=asc&per_page=100&page=1`, body: [{ system: false }, { system: true }, { system: false }] },
    { url: `${GL}/merge_requests/6/notes?sort=asc&per_page=100&page=1`, body: [] },
  ]);
  const r = tool(dir, 'gitlab', ['merged', '--project', 'acme/app', '--since', '2026-10-01', '--notes'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3, r.stdout);
  assert.equal(lines[0], '    !5  2026-10-01 → 2026-10-01 (6.0h)  @ada merged by @bob  approved: carol (2 note(s))  Change 5');
  assert.equal(lines[1], '    !6  2026-10-02 → 2026-10-02 (2.0h)  @bob merged by @bob  approvals ? (0 note(s))  Change 6');
  assert.equal(lines[2], 'gitlab:acme/app since 2026-10-01: 2 merged · open→merge median 4.0h, mean 4.0h · approved 100% (of 1 with known approvals) · self-merged 50%');
  assert.ok(!fake.calls().some((c) => c.url.includes('/merge_requests/4/')), 'a merge before the date is not read further');
});

test('gitlab mrs --since asks for merge requests updated after the date', () => {
  const dir = gitlabInstallation();
  const fake = withFakeFetch(dir, [{ match: '/projects/acme%2Fapp/merge_requests\\?', body: [] }]);
  const r = tool(dir, 'gitlab', ['mrs', '--project', 'acme/app', '--since', '2026-10-01'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.match(fake.calls()[0].url, /[?&]updated_after=2026-10-01T00%3A00%3A00Z(&|$)/);
  const bad = tool(dir, 'gitlab', ['mrs', '--since', '10/01'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(bad.status, 1, bad.output);
  assert.match(bad.stderr, /--since is not a date YYYY-MM-DD: 10\/01/);
});
