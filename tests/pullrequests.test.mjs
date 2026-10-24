// Pull requests of a task (common/pullrequests.mjs, ADR 0001 D05): URL parsing, whole-token key and
// alias matching, de-duplication, the pool search over fake code-host clients (no network), and the
// wording of the dry run's section and of the comment posted with a move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  branchesWithoutPullRequest, briefPullRequestLines, carriesKey, collectPullRequests, foundBySearch, incompleteNotes, mergePullRequests, moveComment, parseBranchUrl,
  numberTokens, parsePullRequestUrl, pullRequestKey, pullRequestLines, pullRequestUrls, reposOutsidePool, searchGaps, searchIncomplete, skipPullRequests, taskKeys,
} from '../tools/common/pullrequests.mjs';
import { markdownToAdf } from '../tools/common/adf.mjs';
import { HttpError } from '../tools/common/http.mjs';
import { UsageError } from '../tools/common/cli.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE, installation, script, tool, withFakeFetch } from './helpers/installation.mjs';

test('taskKeys: the key and the same number under each alias, upper case, each once', () => {
  assert.deepEqual(taskKeys('PROJ-123', ['PJ', 'pj', 'PROJ']), ['PROJ-123', 'PJ-123']);
  assert.deepEqual(taskKeys('proj-7'), ['PROJ-7']);
  assert.throws(() => taskKeys('PROJ'), UsageError);
});

test('carriesKey: a whole token, case-insensitive; never a longer number or a longer prefix', () => {
  const keys = taskKeys('PROJ-123', ['PJ']);
  for (const text of ['PROJ-123', '[PROJ-123] Export', 'feature/proj-123-export', 'PJ-123: fix', 'fix/PJ-123', 'PROJ-123_wip', 'x PROJ-123.']) {
    assert.ok(carriesKey(text, keys), text);
  }
  for (const text of ['PROJ-1234', 'PROJ-12', 'XPROJ-123', 'APJ-123', 'PROJ-123a', 'PROJ 123', 'FEAT[123]', '', null]) {
    assert.ok(!carriesKey(text, keys), String(text));
  }
});

test('parsePullRequestUrl: GitHub pull and GitLab merge request URLs, canonical; anything else null', () => {
  assert.deepEqual(parsePullRequestUrl('https://github.com/acme-corp/web/pull/12/files#diff'), {
    host: 'github', server: 'https://github.com', path: 'acme-corp/web', number: 12, url: 'https://github.com/acme-corp/web/pull/12',
  });
  assert.deepEqual(parsePullRequestUrl('https://gitlab.example.com/acme/platform/backend/-/merge_requests/5?tab=diffs'), {
    host: 'gitlab', server: 'https://gitlab.example.com', path: 'acme/platform/backend', number: 5,
    url: 'https://gitlab.example.com/acme/platform/backend/-/merge_requests/5',
  });
  assert.equal(parsePullRequestUrl('https://github.com/acme-corp/web/pulls'), null);
  assert.equal(parsePullRequestUrl('https://github.com/acme-corp/web/pull/12x'), null);
  assert.equal(parsePullRequestUrl('https://wiki.example.com/design'), null);
  assert.deepEqual(pullRequestUrls([
    'https://github.com/acme-corp/web/pull/12', 'https://GITHUB.com/acme-corp/web/pull/12/commits', 'https://example.com/x',
  ]).map((p) => p.url), ['https://github.com/acme-corp/web/pull/12']);
});

test('parseBranchUrl: GitHub and GitLab tree URLs', () => {
  assert.deepEqual(parseBranchUrl('https://github.com/acme-corp/web/tree/PROJ-7-export'), { repo: 'github:acme-corp/web', branch: 'PROJ-7-export' });
  assert.deepEqual(parseBranchUrl('https://gitlab.example.com/acme/backend/-/tree/feature%2FPROJ-7'), { repo: 'gitlab:acme/backend', branch: 'feature/PROJ-7' });
  assert.equal(parseBranchUrl('https://github.com/acme-corp/web'), null);
});

const pr = (n, extra = {}) => ({
  url: `https://github.com/acme-corp/web/pull/${n}`, repo: 'github:acme-corp/web', number: n, title: `PROJ-7 part ${n}`,
  branch: `PROJ-7-${n}`, state: 'open', source: 'pool', ...extra,
});

test('mergePullRequests: de-duplicated by URL, the first source wins, a later one fills what is missing', () => {
  const attached = { ...pr(1), url: 'https://github.com/ACME-corp/web/pull/1', title: null, branch: null, state: 'unknown', source: 'attached', note: 'no credential' };
  const merged = mergePullRequests([attached], [pr(1, { state: 'merged' }), pr(2)]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].source, 'attached');
  assert.equal(merged[0].state, 'merged');
  assert.equal(merged[0].branch, 'PROJ-7-1');
  assert.equal(merged[0].note, undefined, 'the note on an unknown state goes once the state is known');
  assert.equal(merged[1].source, 'pool');
});

test('branchesWithoutPullRequest and reposOutsidePool', () => {
  const prs = [pr(1)];
  const branches = [{ repo: 'github:acme-corp/web', branch: 'proj-7-1' }, { repo: 'github:acme-corp/web', branch: 'PROJ-7-wip' }, { repo: 'github:acme-corp/web', branch: 'PROJ-7-wip' }];
  assert.deepEqual(branchesWithoutPullRequest(branches, prs), [{ repo: 'github:acme-corp/web', branch: 'PROJ-7-wip' }]);
  assert.deepEqual(reposOutsidePool([pr(1), { ...pr(2), repo: 'github:acme-corp/auth' }], ['github:ACME-corp/web']), ['github:acme-corp/auth']);
});

// Fake code-host clients: GitHub REST and GraphQL answers keyed by repository, GitLab REST by path.
function fakeHosts({ pulls = {}, graphql = {}, gitlab = {}, githubError } = {}) {
  const calls = [];
  const github = {
    serverUrl: 'https://github.com',
    async api(path) {
      calls.push(`GET ${path}`);
      if (!(path in pulls)) throw new UsageError(`not found, or no access (GitHub answers 404 for both): ${path}`);
      if (pulls[path] instanceof Error) throw pulls[path];
      return { data: pulls[path] };
    },
    async graphql(query, variables) {
      const repo = `${variables.owner}/${variables.name}`;
      calls.push(`GRAPHQL ${repo} ${Object.keys(variables).filter((k) => k.startsWith('ref')).map((k) => variables[k]).join(',')}`);
      if (!(repo in graphql)) throw new HttpError(502, 'https://api.github.com/graphql', 'bad gateway');
      if (graphql[repo] instanceof Error) throw graphql[repo];
      return graphql[repo];
    },
  };
  const gl = {
    base: 'https://gitlab.example.com',
    async paged(path) {
      calls.push(`GET ${path}`);
      const hit = Object.keys(gitlab).find((p) => path.startsWith(p));
      if (gitlab[hit] instanceof Error) throw gitlab[hit];
      return hit ? gitlab[hit] : [];
    },
    async get(path) {
      calls.push(`GET ${path}`);
      return gitlab[path];
    },
  };
  return {
    calls,
    hosts: {
      github: () => { if (githubError) throw githubError; return github; },
      gitlab: () => gl,
    },
  };
}

const node = (n, title, branch, state = 'OPEN', isDraft = false) => ({ url: `https://github.com/acme-corp/web/pull/${n}`, number: n, title, state, isDraft, headRefName: branch });

test('collectPullRequests: attached read by URL, then the pool by key and alias as a whole token', async () => {
  const fake = fakeHosts({
    pulls: {
      '/repos/acme-corp/auth/pulls/3': { html_url: 'https://github.com/acme-corp/auth/pull/3', number: 3, title: 'Login', state: 'closed', merged_at: '2026-10-01T00:00:00Z', head: { ref: 'PROJ-7-login' } },
    },
    graphql: {
      'acme-corp/web': {
        repository: {
          ref0: { totalCount: 2, nodes: [
            { name: 'feature/PROJ-7-export', associatedPullRequests: { nodes: [node(12, 'Export CSV', 'feature/PROJ-7-export', 'MERGED')] } },
            { name: 'PROJ-70-other', associatedPullRequests: { nodes: [node(13, 'Other', 'PROJ-70-other')] } },
          ] },
          ref1: { totalCount: 1, nodes: [{ name: 'PJ-7-wip', associatedPullRequests: { nodes: [] } }] },
        },
        search0: { issueCount: 2, nodes: [node(14, 'PROJ-7: docs', 'docs', 'OPEN', true), node(15, 'PROJ-71: unrelated', 'x')] },
        search1: { issueCount: 0, nodes: [] },
      },
    },
    gitlab: {
      '/projects/acme%2Fbackend/merge_requests?state=all&in=title&search=PROJ-7': [
        { web_url: 'https://gitlab.example.com/acme/backend/-/merge_requests/5', iid: 5, title: 'PROJ-7 API', state: 'opened', source_branch: 'proj-7-api' },
      ],
      '/projects/acme%2Fbackend/repository/branches?search=PROJ-7': [{ name: 'proj-7-api' }, { name: 'PROJ-77' }],
      '/projects/acme%2Fbackend/merge_requests?state=all&source_branch=proj-7-api': [
        { web_url: 'https://gitlab.example.com/acme/backend/-/merge_requests/5', iid: 5, title: 'PROJ-7 API', state: 'opened', source_branch: 'proj-7-api' },
      ],
    },
  });
  const found = await collectPullRequests('PROJ-7', {
    urls: ['https://github.com/acme-corp/auth/pull/3', 'https://github.com/acme-corp/web/pull/12', 'https://wiki.example.com/x'],
    aliases: ['PJ'], repos: ['github:acme-corp/web', 'gitlab:acme/backend'], hosts: fake.hosts,
  });
  const brief = found.pullRequests.map((p) => `${p.state} ${p.source} ${p.repo}#${p.number}`);
  assert.deepEqual(brief, [
    'merged attached github:acme-corp/auth#3',
    'merged attached github:acme-corp/web#12',
    'draft pool github:acme-corp/web#14',
    'open pool gitlab:acme/backend#5',
  ], 'the pool answer fills the state of an attached PR its host did not give; it stays attached');
  assert.equal(found.pullRequests[1].note, undefined);
  assert.equal(found.pullRequests[1].branch, 'feature/PROJ-7-export');
  assert.ok(!found.pullRequests.some((p) => [13, 15].includes(p.number)), 'PROJ-70 and PROJ-71 are not PROJ-7');
  assert.deepEqual(found.branches, [{ repo: 'github:acme-corp/web', branch: 'PJ-7-wip' }]);
  assert.deepEqual(found.keys, ['PROJ-7', 'PJ-7']);
  assert.ok(fake.calls.includes('GRAPHQL acme-corp/web PROJ-7,PJ-7'), 'one GraphQL request per GitHub repository, for every key');
  assert.ok(!fake.calls.some((c) => c.includes('source_branch=PROJ-77')), 'a branch that does not carry the key is not followed');
  assert.deepEqual(found.notes, []);
});

test('collectPullRequests: best effort — a host that fails is a note, an unknown state keeps its reason', async () => {
  const noCredential = new UsageError('no GitHub credential\n  GITHUB_TOKEN …');
  const fake = fakeHosts({ githubError: noCredential });
  const found = await collectPullRequests('PROJ-7', {
    urls: ['https://github.com/acme-corp/web/pull/12', 'https://git.other.example/acme/x/-/merge_requests/2'],
    known: [{ url: 'https://github.com/acme-corp/web/pull/12', repo: 'github:acme-corp/web', number: 12, title: 'Export', branch: 'PROJ-7', state: 'merged' }],
    repos: ['github:acme-corp/web'], hosts: fake.hosts,
  });
  assert.deepEqual(found.pullRequests.map((p) => [p.number, p.state, p.title]), [[12, 'merged', 'Export'], [2, 'unknown', null]]);
  assert.match(found.pullRequests[1].note, /^git\.other\.example is not the configured GitLab \(gitlab\.example\.com\)$/);
  assert.deepEqual(found.notes, ['github:acme-corp/web: not searched — no GitHub credential']);
});

test('pullRequestLines: the section, the branches, an empty pool, an attached repository outside the pool', () => {
  const found = {
    pullRequests: [pr(1, { source: 'attached', state: 'merged' }), { ...pr(3), repo: 'github:acme-corp/auth', url: 'https://github.com/acme-corp/auth/pull/3', source: 'attached', state: 'unknown', title: null, branch: null, note: 'HTTP 502' }],
    branches: [{ repo: 'github:acme-corp/web', branch: 'PROJ-7-wip' }],
    notes: ['dev-status unavailable (HTTP 404)'],
  };
  const opts = { projectKey: 'PROJ', configPath: 'task-tracking.jira.projects', tool: 'node oikos/tools/jira/cli.mjs' };
  const text = pullRequestLines(found, { ...opts, repos: ['github:acme-corp/web'] }).join('\n');
  assert.match(text, /^## Pull requests\n {2}merged {2}attached github:acme-corp\/web {2}PROJ-7 part 1\n {10}https:\/\/github\.com\/acme-corp\/web\/pull\/1 {2}\(branch PROJ-7-1\)$/m);
  assert.match(text, /^ {2}unknown attached github:acme-corp\/auth {2}\(title not read\)\n {10}https:\/\/github\.com\/acme-corp\/auth\/pull\/3\n {10}state not read: HTTP 502$/m);
  assert.match(text, /^Branches without a pull request:\n {2}github:acme-corp\/web {2}PROJ-7-wip$/m);
  assert.match(text, /^github:acme-corp\/auth carries a pull request of this task and is not in the pool of PROJ — add it:\n {2}node oikos\/tools\/jira\/cli\.mjs repos add PROJ github:acme-corp\/auth --dry-run/m);
  assert.doesNotMatch(text, /github:acme-corp\/web carries/);
  assert.match(text, /^Notes:\n {2}dev-status unavailable \(HTTP 404\)$/m);
  assert.doesNotMatch(text, /pool of PROJ is empty/);

  const empty = pullRequestLines({ pullRequests: [], branches: [], notes: [] }, opts).join('\n');
  assert.match(empty, /^ {2}\(none found\)$/m);
  assert.match(empty, /^The repository pool of PROJ is empty \(task-tracking\.jira\.projects\.PROJ\.repos\)/m);
  assert.match(empty, /no search across the whole code host/);
  assert.match(empty, /project-init PROJ --dry-run`, or list the repositories there/);
});

test('moveComment: the pool PRs the task does not carry are appended as links; none → the comment as given', () => {
  const prs = [pr(1, { source: 'attached' }), pr(2, { state: 'merged' }), { ...pr(5), repo: 'gitlab:acme/backend', url: 'https://gitlab.example.com/acme/backend/-/merge_requests/5', number: 5 }];
  const text = moveComment('Checked on staging.', prs);
  assert.equal(text, [
    'Checked on staging.',
    '',
    'Pull requests of this task found in the project\'s repositories:',
    '- [acme-corp/web#2](https://github.com/acme-corp/web/pull/2) — PROJ-7 part 2 (merged)',
    '- [acme/backend!5](https://gitlab.example.com/acme/backend/-/merge_requests/5) — PROJ-7 part 5 (open)',
  ].join('\n'));
  assert.match(moveComment(null, prs), /^Pull requests of this task found/);
  assert.equal(moveComment('As given.', [pr(1, { source: 'attached' })]), 'As given.');
  assert.equal(moveComment(undefined, []), null);
  const adf = markdownToAdf(text);
  const list = adf.content.find((n) => n.type === 'bulletList');
  assert.equal(list.content.length, 2, 'posted as a list');
  const link = list.content[0].content[0].content[0];
  assert.deepEqual(link.marks, [{ type: 'link', attrs: { href: 'https://github.com/acme-corp/web/pull/2' } }]);
});

// == the extended set (D08) ==

const legacyNode = (n, title, branch, state = 'OPEN') => ({ url: `https://github.com/acme-corp/legacy/pull/${n}`, number: n, title, state, isDraft: false, headRefName: branch });
const extendedFake = () => fakeHosts({
  graphql: {
    'acme-corp/web': { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } },
    'acme-corp/legacy': {
      repository: { ref0: { totalCount: 1, nodes: [{ name: 'PROJ-7-old', associatedPullRequests: { nodes: [legacyNode(4, 'Old UI', 'PROJ-7-old')] } }] } },
      search0: { issueCount: 1, nodes: [legacyNode(5, 'PROJ-70 not this one', 'x')] },
    },
  },
});

test('collectPullRequests: the extended set is searched only when given, its PRs marked extended', async () => {
  const without = extendedFake();
  const plain = await collectPullRequests('PROJ-7', { repos: ['github:acme-corp/web'], hosts: without.hosts });
  assert.deepEqual(plain.pullRequests, []);
  assert.deepEqual(plain.hits, { pool: 0, extended: 0 });
  assert.ok(!without.calls.some((c) => c.includes('legacy')), 'no extended search without the option');

  const withSet = extendedFake();
  const found = await collectPullRequests('PROJ-7', { repos: ['github:acme-corp/web'], extended: ['github:acme-corp/legacy'], hosts: withSet.hosts });
  assert.deepEqual(found.pullRequests.map((p) => `${p.source} ${p.repo}#${p.number}`), ['extended github:acme-corp/legacy#4'], 'whole-token match: PROJ-70 is not PROJ-7');
  assert.deepEqual(found.hits, { pool: 0, extended: 1 });
  assert.ok(withSet.calls.includes('GRAPHQL acme-corp/legacy PROJ-7'));
});

test('collectPullRequests: a PR attached and found in the extended set stays attached; one in both sets counts as pool', async () => {
  const fake = extendedFake();
  const found = await collectPullRequests('PROJ-7', {
    known: [{ url: 'https://github.com/acme-corp/legacy/pull/4', repo: 'github:acme-corp/legacy', number: 4, title: 'Old UI', branch: 'PROJ-7-old', state: 'open' }],
    repos: [], extended: ['github:acme-corp/legacy'], hosts: fake.hosts,
  });
  assert.deepEqual(found.pullRequests.map((p) => p.source), ['attached']);
  assert.equal(moveComment(null, found.pullRequests), null, 'an attached PR is not written into the comment');
});

// == bare task numbers bound to repositories, and commits (D11) ==

test('numberTokens: each pattern with the task number; matched as a whole token, as a key is', () => {
  const tokens = numberTokens('PROJ-123', ['FIX[{n}]', ' fix/{n} ', 'FIX[{n}]']);
  assert.deepEqual(tokens, ['FIX[123]', 'fix/123']);
  for (const text of ['FIX[123]: export', 'fix/123-export', 'feature fix/123', '[FIX[123]]']) assert.ok(carriesKey(text, tokens), text);
  for (const text of ['FIX[1234]', 'FIX[12]', 'fix/1234-x', 'XFIX[123]', '123']) assert.ok(!carriesKey(text, tokens), text);
  assert.deepEqual(numberTokens('PROJ-7'), []);
});

const commitSearch = (repo, text) => `/search/commits?${new URLSearchParams({ q: `repo:${repo} "${text}"`, per_page: '100' })}`;
const restPull = (n, title) => ({ html_url: `https://github.com/acme-corp/web/pull/${n}`, number: n, title, state: 'closed', merged_at: '2026-10-01T00:00:00Z', head: { ref: `b-${n}` } });

test('collectPullRequests: in a number repository a pattern matches too, searched by the bare number; elsewhere it never does', async () => {
  const fake = fakeHosts({ graphql: {
    'acme-corp/web': {
      repository: { ref0: { totalCount: 0, nodes: [] }, ref1: { totalCount: 2, nodes: [
        { name: 'fix/123-export', associatedPullRequests: { nodes: [] } }, { name: 'fix/1234-other', associatedPullRequests: { nodes: [] } },
      ] } },
      search0: { issueCount: 0, nodes: [] },
      search1: { issueCount: 2, nodes: [node(21, 'FIX[123]: export', 'x'), node(22, 'FIX[1234]: other', 'y')] },
    },
    'acme-corp/plan': {
      repository: { ref0: { totalCount: 0, nodes: [] } },
      search0: { issueCount: 1, nodes: [{ ...node(31, 'FIX[123]: a plan task', 'z'), url: 'https://github.com/acme-corp/plan/pull/31' }] },
    },
  } });
  const found = await collectPullRequests('PROJ-123', {
    repos: ['github:acme-corp/web', 'github:acme-corp/plan'], numberRepos: ['github:ACME-corp/web'], patterns: ['FIX[{n}]', 'fix/{n}'], hosts: fake.hosts,
  });
  assert.deepEqual(found.pullRequests.map((p) => `${p.source} ${p.repo}#${p.number}`), ['pool github:acme-corp/web#21']);
  assert.deepEqual(found.branches, [{ repo: 'github:acme-corp/web', branch: 'fix/123-export' }]);
  assert.ok(fake.calls.includes('GRAPHQL acme-corp/web PROJ-123,123'), 'the bare number is asked of a number repository');
  assert.ok(fake.calls.includes('GRAPHQL acme-corp/plan PROJ-123'), 'and of no other');
  assert.deepEqual(found.hits, { pool: 2, extended: 0 });
  assert.deepEqual(found.commits, [], 'something found: no commit search');
  assert.ok(!fake.calls.some((c) => c.includes('/search/commits')));
});

test('collectPullRequests: nothing found → commits by key, and by pattern in a number repository; a commit\'s PR is found by search', async () => {
  const web = 'acme-corp/web';
  const fake = fakeHosts({
    graphql: { [web]: { repository: { ref0: { totalCount: 0, nodes: [] }, ref1: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] }, search1: { issueCount: 0, nodes: [] } } },
    pulls: {
      [commitSearch(web, 'PROJ-123')]: { total_count: 1, items: [{ sha: 'b2b2b2b2b2', commit: { message: 'PROJ-123 wip\n\nmore' } }] },
      [commitSearch(web, '123')]: { total_count: 3, items: [
        { sha: 'a1a1a1a1a1', commit: { message: 'FIX[123]: export' } }, { sha: 'c3c3c3c3c3', commit: { message: 'FIX[1234]: other' } },
        { sha: 'b2b2b2b2b2', commit: { message: 'PROJ-123 wip\n\nmore' } },
      ] },
      [`/repos/${web}/commits/a1a1a1a1a1/pulls`]: [restPull(20, 'Export')],
      [`/repos/${web}/commits/b2b2b2b2b2/pulls`]: [],
    },
  });
  const found = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], numberRepos: [`github:${web}`], patterns: ['FIX[{n}]'], commits: true, hosts: fake.hosts });
  assert.deepEqual(found.pullRequests.map((p) => `${p.state} ${p.source} ${p.repo}#${p.number}`), ['merged pool github:acme-corp/web#20']);
  assert.deepEqual(found.commits, [{ repo: 'github:acme-corp/web', sha: 'b2b2b2b2b2', message: 'PROJ-123 wip\n\nmore', url: null, source: 'pool' }]);
  assert.ok(!fake.calls.some((c) => c.includes('c3c3c3c3c3')), 'FIX[1234] is not FIX[123]: not followed');
  assert.deepEqual(found.hits, { pool: 2, extended: 0 });
  assert.equal(moveComment(null, found.pullRequests),
    'Pull requests of this task found in the project\'s repositories:\n- [acme-corp/web#20](https://github.com/acme-corp/web/pull/20) — Export (merged) — via commit a1a1a1a FIX[123]: export');
  const lines = pullRequestLines(found, { projectKey: 'PROJ', repos: [`github:${web}`], configPath: 'x', tool: 'jira' });
  assert.ok(lines.includes('Commits without a pull request (evidence, not posted):') && lines.includes('  github:acme-corp/web@b2b2b2b PROJ-123 wip'), lines.join('\n'));
  assert.deepEqual(briefPullRequestLines(found, { projectKey: 'PROJ' }).slice(-2), ['Commits:', '  github:acme-corp/web@b2b2b2b PROJ-123 wip']);

  const without = fakeHosts({ graphql: { [web]: { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } } } });
  await collectPullRequests('PROJ-123', { repos: [`github:${web}`], hosts: without.hosts });
  assert.ok(!without.calls.some((c) => c.includes('/search/commits')), 'commits only when asked for');
});

test('collectPullRequests: a host that limits the rate stops the commit search there for the run, said in the notes', async () => {
  const limit = new HttpError(429, 'https://gitlab.example.com/api/v4/projects/acme%2Fa/search', 'Retry later');
  const fake = fakeHosts({ gitlab: { '/projects/acme%2Fa/search?': limit } });
  const hosts = { ...fake.hosts, limited: new Map() };
  const first = await collectPullRequests('PROJ-7', { repos: ['gitlab:acme/a', 'gitlab:acme/b'], commits: true, hosts });
  assert.deepEqual(first.notes, [
    'gitlab:acme/a: commits not searched — gitlab limits the rate of requests (HTTP 429); no more commit search there in this run',
    'gitlab:acme/b: commits not searched — gitlab limited the rate of requests earlier in this run',
  ]);
  const second = await collectPullRequests('PROJ-8', { repos: ['gitlab:acme/b'], commits: true, hosts });
  assert.deepEqual(second.notes, ['gitlab:acme/b: not searched — gitlab limited the rate of requests earlier in this run'], 'a later task: not even the pool search');
  assert.equal(fake.calls.filter((c) => c.includes('scope=commits')).length, 1, 'asked once');
  const forbidden = new HttpError(403, 'https://api.github.com/search/commits', '{"message":"API rate limit exceeded"}');
  const gh = fakeHosts({ graphql: { 'acme-corp/web': { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } } },
    pulls: { [commitSearch('acme-corp/web', 'PROJ-7')]: forbidden } });
  const r = await collectPullRequests('PROJ-7', { repos: ['github:acme-corp/web'], commits: true, hosts: gh.hosts });
  assert.match(r.notes[0], /^github:acme-corp\/web: commits not searched — github limits the rate of requests \(HTTP 403\)/);
});

test('collectPullRequests: a PR found through a commit names it — the first commit when several lead to it — in both dry runs and the comment', async () => {
  const web = 'acme-corp/web';
  const fake = fakeHosts({
    graphql: { [web]: { repository: { ref0: { totalCount: 0, nodes: [] }, ref1: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] }, search1: { issueCount: 0, nodes: [] } } },
    pulls: {
      [commitSearch(web, 'PROJ-123')]: { total_count: 0, items: [] },
      [commitSearch(web, '123')]: { total_count: 2, items: [
        { sha: '5f8f19a0b1c2', commit: { message: '\nFIX[123]: bump charts\n\nthe chart package' } }, { sha: '6e6e6e6e6e', commit: { message: 'FIX[123]: pin charts' } },
      ] },
      [`/repos/${web}/commits/5f8f19a0b1c2/pulls`]: [restPull(187, 'FEAT[143]: Update charts package version')],
      [`/repos/${web}/commits/6e6e6e6e6e/pulls`]: [restPull(187, 'FEAT[143]: Update charts package version')],
    },
  });
  const found = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], numberRepos: [`github:${web}`], patterns: ['FIX[{n}]'], commits: true, hosts: fake.hosts });
  assert.equal(found.pullRequests.length, 1);
  assert.deepEqual(found.pullRequests[0].viaCommit, { sha: '5f8f19a0b1c2', message: '\nFIX[123]: bump charts\n\nthe chart package' });
  const via = ' — via commit 5f8f19a FIX[123]: bump charts';
  const lines = pullRequestLines(found, { projectKey: 'PROJ', repos: [`github:${web}`], configPath: 'x', tool: 'jira' });
  assert.ok(lines.includes(`  merged  pool     github:acme-corp/web  FEAT[143]: Update charts package version${via}`), lines.join('\n'));
  assert.equal(briefPullRequestLines(found, { projectKey: 'PROJ' })[1], `  acme-corp/web#187 merged [pool] FEAT[143]: Update charts package version${via}`);
  assert.equal(moveComment(null, found.pullRequests).split('\n')[1],
    `- [acme-corp/web#187](https://github.com/acme-corp/web/pull/187) — FEAT[143]: Update charts package version (merged)${via}`);
  const long = { ...found.pullRequests[0], viaCommit: { sha: '5f8f19a0b1c2', message: `FIX[123]: ${'x'.repeat(80)}` } };
  assert.match(briefPullRequestLines({ ...found, pullRequests: [long] }, { projectKey: 'PROJ' })[1], / — via commit 5f8f19a FIX\[123\]: x{49}…$/, 'cut to 60 in the brief');
});

test('collectPullRequests: a PR the search found by its title and again through a commit names no commit', async () => {
  const web = 'acme-corp/web';
  const fake = fakeHosts({
    graphql: { [web]: { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 1, nodes: [node(14, 'PROJ-123 not this one', 'x')] } } },
    pulls: {
      [commitSearch(web, 'PROJ-123')]: { total_count: 1, items: [{ sha: 'd4d4d4d4d4', commit: { message: 'PROJ-123 export' } }] },
      [`/repos/${web}/commits/d4d4d4d4d4/pulls`]: [restPull(14, 'PROJ-123 not this one'), restPull(40, 'Export')],
    },
  });
  const found = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, skip: ['https://github.com/acme-corp/web/pull/14'], hosts: fake.hosts });
  assert.deepEqual(found.skipped.map((p) => [p.number, p.viaCommit]), [[14, undefined]], 'the direct finding wins');
  assert.deepEqual(found.pullRequests.map((p) => [p.number, p.viaCommit?.sha]), [[40, 'd4d4d4d4d4']]);
  const lines = pullRequestLines(found, { projectKey: 'PROJ', repos: [`github:${web}`], configPath: 'x', tool: 'jira' });
  assert.ok(lines.includes('  open    pool     github:acme-corp/web  PROJ-123 not this one'), lines.join('\n'));
  assert.ok(lines.includes('  merged  pool     github:acme-corp/web  Export — via commit d4d4d4d PROJ-123 export'), lines.join('\n'));
});

test('collectPullRequests: a commit whose pull requests cannot be read is a note that makes the search incomplete; the next commits are followed', async () => {
  const web = 'acme-corp/web';
  const graphql = { [web]: { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } } };
  const items = [{ sha: 'a1a1a1a1a1', commit: { message: 'Merge PROJ-123 into main\n\nbody' } }, { sha: 'b2b2b2b2b2', commit: { message: 'PROJ-123 export' } },
    { sha: 'c3c3c3c3c3', commit: { message: 'PROJ-123 wip' } }];
  const fake = fakeHosts({
    graphql,
    pulls: {
      [commitSearch(web, 'PROJ-123')]: { total_count: 3, items },
      [`/repos/${web}/commits/a1a1a1a1a1/pulls`]: new HttpError(500, `https://api.github.com/repos/${web}/commits/a1a1a1a1a1/pulls`, 'server error'),
      [`/repos/${web}/commits/b2b2b2b2b2/pulls`]: [restPull(20, 'Export')],
      [`/repos/${web}/commits/c3c3c3c3c3/pulls`]: [],
    },
  });
  const found = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts: fake.hosts });
  assert.deepEqual(found.pullRequests.map((p) => p.number), [20]);
  assert.deepEqual(found.commits.map((c) => c.sha), ['c3c3c3c3c3'], 'the unread commit is not a commit without a pull request');
  assert.deepEqual(found.notes, [`github:acme-corp/web: the pull requests of commit a1a1a1a were not read — HTTP 500 from https://api.github.com/repos/${web}/commits/a1a1a1a1a1/pulls: server error`]);
  assert.equal(searchIncomplete(found), true, 'an HTTP error is an incomplete search (D13)');
  assert.match(briefPullRequestLines(found, { projectKey: 'PROJ' }).at(-1), /^Notes: github:acme-corp\/web: the pull requests of commit a1a1a1a were not read — HTTP 500/);

  const limit = new HttpError(429, `https://api.github.com/repos/${web}/commits/a1a1a1a1a1/pulls`, 'slow down');
  const limited = fakeHosts({ graphql, pulls: { [commitSearch(web, 'PROJ-123')]: { total_count: 3, items }, [`/repos/${web}/commits/a1a1a1a1a1/pulls`]: limit } });
  const hosts = { ...limited.hosts, limited: new Map() };
  const stopped = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts });
  assert.deepEqual(stopped.notes, ['github:acme-corp/web: commits not searched — github limits the rate of requests (HTTP 429); no more commit search there in this run'],
    'a rate limit on the first commit followed: nothing was found, not searched');
  assert.deepEqual([...hosts.limited.keys()], ['github:core'], 'a rate limit on a commit\'s pull requests stops its quota, REST core');
  assert.ok(!limited.calls.some((c) => c.includes('b2b2b2b2b2')), 'and no further commit is followed');
  assert.equal(searchIncomplete(stopped), true);
});

test('collectPullRequests: a rate limit part way through the commits keeps what was found, partly searched; the host stops for the run', async () => {
  const web = 'acme-corp/web';
  const graphql = { [web]: { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } },
    'acme-corp/api': { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } } };
  const items = ['a1a1a1a1a1', 'b2b2b2b2b2', 'c3c3c3c3c3', 'd4d4d4d4d4'].map((sha, i) => ({ sha, commit: { message: `PROJ-123 step ${i + 1}` } }));
  const limit = new HttpError(429, `https://api.github.com/repos/${web}/commits/c3c3c3c3c3/pulls`, 'slow down');
  const fake = fakeHosts({
    graphql,
    pulls: {
      [commitSearch(web, 'PROJ-123')]: { total_count: 4, items },
      [`/repos/${web}/commits/a1a1a1a1a1/pulls`]: [restPull(20, 'Export')],
      [`/repos/${web}/commits/b2b2b2b2b2/pulls`]: [],
      [`/repos/${web}/commits/c3c3c3c3c3/pulls`]: limit,
    },
  });
  const hosts = { ...fake.hosts, limited: new Map() };
  const found = await collectPullRequests('PROJ-123', { repos: [`github:${web}`, 'github:acme-corp/api'], commits: true, hosts });
  assert.deepEqual(found.pullRequests.map((p) => [p.number, p.source, p.viaCommit?.sha]), [[20, 'pool', 'a1a1a1a1a1']], 'the PR found before the limit is kept');
  assert.deepEqual(found.commits.map((c) => c.sha), ['b2b2b2b2b2'], 'and the commit without one');
  const partly = 'github:acme-corp/web: commits partly searched — github limits the rate of requests (HTTP 429) after 2 of 4 commits; no more commit search there in this run';
  assert.deepEqual(found.notes, [partly, 'github:acme-corp/api: commits not searched — github limited the rate of requests earlier in this run']);
  assert.deepEqual([...hosts.limited.keys()], ['github:core']);
  assert.ok(!fake.calls.some((c) => c.includes('d4d4d4d4d4')), 'no commit is followed after the limit');
  assert.equal(fake.calls.filter((c) => c.includes('/search/commits')).length, 1, 'and no other repository is searched on that host: no look-ahead');
  assert.equal(searchIncomplete(found), true, 'partly searched is a search that stopped');
  assert.deepEqual(found.hits, { pool: 2, extended: 0 });
  const brief = briefPullRequestLines(found, { projectKey: 'PROJ' });
  assert.equal(brief[1], '  acme-corp/web#20 merged [pool] Export — via commit a1a1a1a PROJ-123 step 1');
  assert.match(brief.at(-1), /^Notes: github:acme-corp\/web: commits partly searched — github limits the rate of requests \(HTTP 429\) after 2 of 4/, 'a rate limit first');
});

test('collectPullRequests: the same failure on several commits of a repository is one note naming their count, the reason, then three shas', async () => {
  const web = 'acme-corp/web';
  const graphql = { [web]: { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } } };
  const shas = ['5f8f19a0b1', '1a2b3c4d5e', '9d8e7f6a5b', 'e1e1e1e1e1', 'f2f2f2f2f2', 'abcdef0123'];
  const items = shas.map((sha, i) => ({ sha, commit: { message: `PROJ-123 step ${i + 1}` } }));
  const scope = (sha) => new HttpError(403, `https://api.github.com/repos/${web}/commits/${sha}/pulls`, 'Resource not accessible by personal access token');
  const pulls = { [commitSearch(web, 'PROJ-123')]: { total_count: shas.length, items } };
  for (const sha of shas.slice(0, 5)) pulls[`/repos/${web}/commits/${sha}/pulls`] = scope(sha);
  pulls[`/repos/${web}/commits/abcdef0123/pulls`] = new HttpError(500, `https://api.github.com/repos/${web}/commits/abcdef0123/pulls`, 'server error');
  const fake = fakeHosts({ graphql, pulls });
  const found = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts: fake.hosts });
  assert.deepEqual(found.notes, [
    'github:acme-corp/web: the pull requests of 5 commits were not read — HTTP 403: Resource not accessible by personal access token (5f8f19a, 1a2b3c4, 9d8e7f6 +2 more)',
    `github:acme-corp/web: the pull requests of commit abcdef0 were not read — HTTP 500 from https://api.github.com/repos/${web}/commits/abcdef0123/pulls: server error`,
  ], 'one note per reason; a single commit keeps its own wording');
  assert.equal(searchIncomplete(found), true);
  assert.equal(searchIncomplete({ notes: [found.notes[0]] }), true, 'the collapsed note sets the flag too');
  assert.match(briefPullRequestLines(found, { projectKey: 'PROJ' }).at(-1), /^Notes: github:acme-corp\/web: the pull requests of 5 commits were not read — HTTP 403: Resource not accessible by/,
    'the reason comes before the shas, so the cut note keeps it');

  const three = fakeHosts({ graphql, pulls: { [commitSearch(web, 'PROJ-123')]: { total_count: 3, items: items.slice(0, 3) },
    ...Object.fromEntries(shas.slice(0, 3).map((sha) => [`/repos/${web}/commits/${sha}/pulls`, scope(sha)])) } });
  const r = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts: three.hosts });
  assert.deepEqual(r.notes, ['github:acme-corp/web: the pull requests of 3 commits were not read — HTTP 403: Resource not accessible by personal access token (5f8f19a, 1a2b3c4, 9d8e7f6)']);
});

test('collectPullRequests: a 404 on several commits, each naming its sha in the path, is one note with the sha as <sha>', async () => {
  const web = 'acme-corp/web';
  const graphql = { [web]: { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } } };
  const shas = ['a1a1a1a', 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', 'c3c3c3c3c3', 'd4d4d4d4d4d4d4d4'];
  const items = shas.map((sha, i) => ({ sha, commit: { message: `PROJ-123 step ${i + 1}` } }));
  // No answer for a commit's pulls: the fake raises the 404 usage error the client does, its path naming the sha.
  const fake = fakeHosts({ graphql, pulls: { [commitSearch(web, 'PROJ-123')]: { total_count: shas.length, items } } });
  const found = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts: fake.hosts });
  assert.deepEqual(found.notes, [
    `github:acme-corp/web: the pull requests of 4 commits were not read — not found, or no access (GitHub answers 404 for both): /repos/${web}/commits/<sha>/pulls (a1a1a1a, b2b2b2b, c3c3c3c +1 more)`,
  ]);
  assert.equal(searchIncomplete(found), true);

  const one = fakeHosts({ graphql, pulls: { [commitSearch(web, 'PROJ-123')]: { total_count: 1, items: items.slice(2, 3) } } });
  const single = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts: one.hosts });
  assert.deepEqual(single.notes, [`github:acme-corp/web: the pull requests of commit c3c3c3c were not read — not found, or no access (GitHub answers 404 for both): /repos/${web}/commits/c3c3c3c3c3/pulls`],
    'a single commit keeps its own error, sha and all');
});

test('collectPullRequests: the repositories of a host limited earlier in the run share one note naming them, capped; the search stays incomplete', async () => {
  const names = ['a', 'b', 'c', 'd'].map((n) => `acme-corp/${n}`);
  const graphql = Object.fromEntries(names.map((name) => [name, { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } }]));
  const fake = fakeHosts({ graphql });
  const hosts = { ...fake.hosts, limited: new Map([['github:graphql', null], ['github:search', null]]) };
  const found = await collectPullRequests('PROJ-123', { repos: [...names.map((n) => `github:${n}`), 'gitlab:acme/backend'], commits: true, hosts });
  assert.deepEqual(found.notes, [
    'github: 4 repositories not searched — github limited the rate of requests earlier in this run (github:acme-corp/a, github:acme-corp/b, github:acme-corp/c +1 more)',
  ]);
  assert.ok(!fake.calls.some((c) => c.startsWith('GRAPHQL') || c.includes('/search/commits')), 'the limited host is not asked');
  assert.ok(fake.calls.some((c) => c.includes('scope=commits')), 'another host still is');
  assert.equal(searchIncomplete(found), true);
  assert.match(briefPullRequestLines(found, { projectKey: 'PROJ' }).at(-1), /^Notes: github: 4 repositories not searched — github limited the rate/);

  const limit = new HttpError(429, 'https://api.github.com/search/commits', 'slow down');
  const now = fakeHosts({ graphql, pulls: { [commitSearch(names[0], 'PROJ-123')]: limit } });
  const run = { ...now.hosts, limited: new Map() };
  const stopped = await collectPullRequests('PROJ-123', { repos: names.slice(0, 3).map((n) => `github:${n}`), commits: true, hosts: run });
  assert.deepEqual(stopped.notes, [
    'github:acme-corp/a: commits not searched — github limits the rate of requests (HTTP 429); no more commit search there in this run',
    'github: commits of 2 repositories not searched — github limited the rate of requests earlier in this run (github:acme-corp/b, github:acme-corp/c)',
  ], 'limited in this collection: the repository it stopped at, then the rest in one note');
});

test('collectPullRequests: a rate limit that names retry-after or x-ratelimit-reset ends its note with when to retry; without either the wording stays', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_500 });
  const web = 'acme-corp/web';
  const graphql = { [web]: { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } } };
  const limitedBy = async (headers, status = 429) => {
    const error = new HttpError(status, 'https://api.github.com/search/commits', status === 403 ? 'API rate limit exceeded' : 'slow down', new Headers(headers));
    const fake = fakeHosts({ graphql, pulls: { [commitSearch(web, 'PROJ-123')]: error } });
    return (await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts: { ...fake.hosts, limited: new Map() } })).notes[0];
  };
  const base = (status) => `github:acme-corp/web: commits not searched — github limits the rate of requests (HTTP ${status}); no more commit search there in this run`;
  assert.equal(await limitedBy({ 'retry-after': '30' }), `${base(429)}; retry after ~30s`);
  assert.equal(await limitedBy({ 'x-ratelimit-reset': '1700000090' }, 403), `${base(403)}; retry after ~90s`, 'the reset epoch less now, rounded up');
  assert.equal(await limitedBy({ 'retry-after': '30', 'x-ratelimit-reset': '1700000090' }), `${base(429)}; retry after ~30s`, 'retry-after first');
  assert.equal(await limitedBy({ 'x-ratelimit-reset': '1699999990' }), `${base(429)}; retry after ~1s`, 'a reset already past: at least 1');
  assert.equal(await limitedBy({}), base(429), 'neither header: as before');

  const items = ['a1a1a1a1a1', 'b2b2b2b2b2'].map((sha, i) => ({ sha, commit: { message: `PROJ-123 step ${i + 1}` } }));
  const fake = fakeHosts({ graphql, pulls: {
    [commitSearch(web, 'PROJ-123')]: { total_count: 2, items },
    [`/repos/${web}/commits/a1a1a1a1a1/pulls`]: [],
    [`/repos/${web}/commits/b2b2b2b2b2/pulls`]: new HttpError(429, 'https://api.github.com/x', 'slow down', new Headers({ 'retry-after': '45' })),
  } });
  const partly = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts: { ...fake.hosts, limited: new Map() } });
  assert.deepEqual(partly.notes, ['github:acme-corp/web: commits partly searched — github limits the rate of requests (HTTP 429) after 1 of 2 commits; no more commit search there in this run; retry after ~45s']);
});

test('collectPullRequests: retry-after as an HTTP date; a malformed one falls back to the reset; a NaN reset or a huge value gives no time', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_500 });
  const web = 'acme-corp/web';
  const graphql = { [web]: { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } } };
  const limitedBy = async (headers) => {
    const error = new HttpError(429, 'https://api.github.com/search/commits', 'slow down', new Headers(headers));
    const fake = fakeHosts({ graphql, pulls: { [commitSearch(web, 'PROJ-123')]: error } });
    return (await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts: { ...fake.hosts, limited: new Map() } })).notes[0];
  };
  const base = 'github:acme-corp/web: commits not searched — github limits the rate of requests (HTTP 429); no more commit search there in this run';
  assert.equal(await limitedBy({ 'retry-after': 'Tue, 14 Nov 2023 22:15:00 GMT' }), `${base}; retry after ~100s`, 'an IMF-fixdate, less now, rounded up');
  for (const junk of ['-5', '1.5', '2023-11-14', 'soon']) {
    assert.equal(await limitedBy({ 'retry-after': junk, 'x-ratelimit-reset': '1700000090' }), `${base}; retry after ~90s`, `retry-after ${junk}: the reset`);
  }
  assert.equal(await limitedBy({ 'x-ratelimit-reset': 'NaN' }), base, 'a reset that is no number: no time');
  assert.equal(await limitedBy({ 'retry-after': '9'.repeat(26) }), base, 'a value too large to be exact: no time, not 1e+25s');
  assert.equal(await limitedBy({ 'retry-after': '9'.repeat(26), 'x-ratelimit-reset': '1700000090' }), `${base}; retry after ~90s`, 'and the reset is used');
});

test('collectPullRequests: a GitLab rate limit with Retry-After ends its note with when to retry', async () => {
  const limit = new HttpError(429, 'https://gitlab.example.com/api/v4/projects/acme%2Fbackend/search', 'Retry later', new Headers({ 'Retry-After': '12' }));
  const fake = fakeHosts({ gitlab: { '/projects/acme%2Fbackend/search?scope=commits': limit } });
  const hosts = { ...fake.hosts, limited: new Map() };
  const found = await collectPullRequests('PROJ-123', { repos: ['gitlab:acme/backend'], commits: true, hosts });
  assert.deepEqual(found.notes, ['gitlab:acme/backend: commits not searched — gitlab limits the rate of requests (HTTP 429); no more commit search there in this run; retry after ~12s']);
  assert.ok(hosts.limited.has('gitlab'));
});

test('collectPullRequests: a host limited earlier keeps when it said to retry; the later notes give the time left', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const names = ['a', 'b', 'c'].map((n) => `acme-corp/${n}`);
  const graphql = Object.fromEntries(names.map((name) => [name, { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } }]));
  const limit = new HttpError(429, 'https://api.github.com/search/commits', 'slow down', new Headers({ 'retry-after': '30' }));
  const fake = fakeHosts({ graphql, pulls: { [commitSearch(names[0], 'PROJ-123')]: limit } });
  const hosts = { ...fake.hosts, limited: new Map() };
  await collectPullRequests('PROJ-123', { repos: [`github:${names[0]}`], commits: true, hosts });
  assert.deepEqual([...hosts.limited], [['github:search', 1_700_000_030_000]], 'the REST search quota, with the deadline from the first limit');
  t.mock.timers.tick(10_500);
  const later = await collectPullRequests('PROJ-124', { repos: [`github:${names[1]}`], commits: true, hosts });
  assert.deepEqual(later.notes, ['github:acme-corp/b: commits not searched — github limited the rate of requests earlier in this run; retry after ~20s']);
  assert.ok(fake.calls.includes('GRAPHQL acme-corp/b PROJ-124'), 'a REST search limit leaves the GraphQL pool search of a later task');
  t.mock.timers.tick(60_000);
  const past = await collectPullRequests('PROJ-125', { repos: [`github:${names[2]}`], commits: true, hosts });
  assert.match(past.notes[0], /earlier in this run; retry after ~1s$/, 'a deadline already past: at least 1');
});

test('collectPullRequests: exactly three repositories limited earlier are named without "+0 more"; each of two hosts has its own note', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const names = ['a', 'b', 'c'].map((n) => `acme-corp/${n}`);
  const graphql = Object.fromEntries(names.map((name) => [name, { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } }]));
  const fake = fakeHosts({ graphql });
  const hosts = { ...fake.hosts, limited: new Map([['github:graphql', 1_700_000_060_000], ['github:search', 1_700_000_060_000], ['gitlab', null]]) };
  const repos = [...names.map((n) => `github:${n}`), 'gitlab:acme/x', 'gitlab:acme/y'];
  const found = await collectPullRequests('PROJ-123', { repos, commits: true, hosts });
  assert.deepEqual(found.notes, [
    'github: 3 repositories not searched — github limited the rate of requests earlier in this run (github:acme-corp/a, github:acme-corp/b, github:acme-corp/c); retry after ~60s',
    'gitlab: 2 repositories not searched — gitlab limited the rate of requests earlier in this run (gitlab:acme/x, gitlab:acme/y)',
  ], 'a deadline not known: no time');
  assert.deepEqual(fake.calls, [], 'neither host is asked');
  assert.equal(searchIncomplete(found), true);
});

const emptyPool = { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 0, nodes: [] } };

test('collectPullRequests: a GitLab pool search limited by the rate records the host with when to retry; the commit search of the same task skips it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const limit = new HttpError(429, 'https://gitlab.example.com/api/v4/projects/acme%2Fa/merge_requests', 'Retry later', new Headers({ 'Retry-After': '30' }));
  const fake = fakeHosts({ gitlab: { '/projects/acme%2Fa/merge_requests': limit }, graphql: { 'acme-corp/web': emptyPool },
    pulls: { [commitSearch('acme-corp/web', 'PROJ-123')]: { total_count: 0, items: [] } } });
  const hosts = { ...fake.hosts, limited: new Map() };
  const found = await collectPullRequests('PROJ-123', { repos: ['gitlab:acme/a', 'gitlab:acme/b', 'github:acme-corp/web'], commits: true, hosts });
  assert.deepEqual(found.notes, [
    'gitlab:acme/a: not searched — HTTP 429 from https://gitlab.example.com/api/v4/projects/acme%2Fa/merge_requests: Retry later; retry after ~30s',
    'gitlab:acme/b: commits not searched — gitlab limited the rate of requests earlier in this run; retry after ~30s',
  ], 'GitLab has one quota: the repository searched side by side keeps its result, its commits are not asked');
  assert.deepEqual([...hosts.limited], [['gitlab', 1_700_000_030_000]]);
  assert.ok(fake.calls.some((c) => c.startsWith('GET /projects/acme%2Fb/merge_requests')), 'a repository already in flight is not un-asked');
  assert.ok(!fake.calls.some((c) => c.includes('scope=commits')), 'no commit search on the limited host');
  assert.ok(fake.calls.includes(`GET ${commitSearch('acme-corp/web', 'PROJ-123')}`), 'another host is still searched');
  assert.equal(searchIncomplete(found), true);
});

test('collectPullRequests: a GitHub GraphQL limit stops a later task\'s pool search, pool and extended alike, but not its REST commit search', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const limit = new HttpError(429, 'https://api.github.com/graphql', 'slow down', new Headers({ 'retry-after': '30' }));
  const empty = { total_count: 0, items: [] };
  const fake = fakeHosts({ graphql: { 'acme-corp/web': limit, 'acme-corp/api': emptyPool },
    pulls: { [commitSearch('acme-corp/web', 'PROJ-123')]: empty, [commitSearch('acme-corp/api', 'PROJ-123')]: empty, [commitSearch('acme-corp/web', 'PROJ-124')]: empty,
      [commitSearch('acme-corp/legacy', 'PROJ-124')]: empty } });
  const hosts = { ...fake.hosts, limited: new Map() };
  const first = await collectPullRequests('PROJ-123', { repos: ['github:acme-corp/web', 'github:acme-corp/api'], commits: true, hosts });
  assert.deepEqual(first.notes, ['github:acme-corp/web: not searched — HTTP 429 from https://api.github.com/graphql: slow down; retry after ~30s']);
  assert.deepEqual([...hosts.limited], [['github:graphql', 1_700_000_030_000]], 'the GraphQL quota alone');
  assert.ok(fake.calls.includes(`GET ${commitSearch('acme-corp/web', 'PROJ-123')}`), 'the repository its pull request quota stopped is still searched for commits');
  t.mock.timers.tick(10_000);
  const later = await collectPullRequests('PROJ-124', { repos: ['github:acme-corp/web'], extended: ['github:acme-corp/legacy'], commits: true, hosts });
  assert.deepEqual(later.notes, [
    'github: 2 repositories not searched — github limited the rate of requests earlier in this run (github:acme-corp/web, github:acme-corp/legacy); retry after ~20s',
  ]);
  assert.equal(fake.calls.filter((c) => c.startsWith('GRAPHQL')).length, 2, 'GraphQL asked in the first task only');
  assert.ok(fake.calls.includes(`GET ${commitSearch('acme-corp/legacy', 'PROJ-124')}`), 'the later task\'s commit search still runs');
  assert.equal(searchIncomplete(later), true);
});

test('collectPullRequests: a rate limit names its GitHub resource: that quota is recorded, whatever the search; an unknown one is not', async () => {
  const limitOf = (resource) => new HttpError(403, 'https://api.github.com/graphql', 'API rate limit exceeded', new Headers({ 'x-ratelimit-resource': resource }));
  const fake = fakeHosts({ graphql: { 'acme-corp/web': limitOf('core') } });
  const hosts = { ...fake.hosts, limited: new Map() };
  const found = await collectPullRequests('PROJ-123', { repos: ['github:acme-corp/web'], commits: true, hosts });
  assert.deepEqual([...hosts.limited.keys()], ['github:core']);
  assert.ok(!fake.calls.some((c) => c.includes('/search/commits')), 'core is a quota of the commit search: not asked');
  assert.deepEqual(found.notes, ['github:acme-corp/web: not searched — HTTP 403 from https://api.github.com/graphql: API rate limit exceeded']);
  const other = fakeHosts({ graphql: { 'acme-corp/web': limitOf('code_search') } });
  const run = { ...other.hosts, limited: new Map() };
  await collectPullRequests('PROJ-123', { repos: ['github:acme-corp/web'], hosts: run });
  assert.deepEqual([...run.limited.keys()], ['github:graphql'], 'a resource not searched here: the quota of the search itself');
});

const PULLREQUESTS_MODULE = pathToFileURL(join(CORE, 'tools', 'common', 'pullrequests.mjs')).href;

test('collectPullRequests: GitHub\'s GraphQL RATE_LIMITED answer (HTTP 200) through the client is a rate limit: when to retry, its quota, ranked first', () => {
  const dir = installation((t) => t);
  const reset = Math.floor(Date.now() / 1000) + 300;
  const fake = withFakeFetch(dir, [
    { graphql: 'refs(refPrefix', body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'graphql' } },
    { match: '^https://api\\.github\\.com/search/commits', body: { total_count: 0, items: [] } },
  ]);
  const code = `import { codeHosts, collectPullRequests, searchGaps } from ${JSON.stringify(PULLREQUESTS_MODULE)};
const hosts = codeHosts('test');
const found = await collectPullRequests('PROJ-123', { repos: ['github:acme-corp/web'], commits: true, hosts });
console.log(JSON.stringify({ notes: found.notes, gaps: searchGaps(found), limited: [...hosts.limited.keys()] }));`;
  const r = script(dir, code, { GITHUB_TOKEN: 'ghp_fake_token', ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  const { notes, gaps, limited } = JSON.parse(r.stdout);
  assert.equal(notes.length, 1, notes.join('\n'));
  assert.match(notes[0], /^github:acme-corp\/web: not searched — HTTP 200 from https:\/\/api\.github\.com\/graphql: GitHub limits the rate of requests \(RATE_LIMITED\): API rate limit exceeded for user ID 1\.; retry after ~(?:29\d|300)s$/);
  assert.deepEqual(limited, ['github:graphql']);
  assert.deepEqual(gaps, notes, 'ranked as a rate limit');
  assert.ok(fake.calls().some((c) => c.url.startsWith('https://api.github.com/search/commits')), 'its commits are still searched: another quota');
});

test('collectPullRequests: a GitHub secondary limit — requests remaining, no retry-after — waits a minute, not until the primary reset', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const web = 'acme-corp/web';
  const limitBy = (headers) => new HttpError(403, 'https://api.github.com/search/commits', 'You have exceeded a secondary rate limit', new Headers(headers));
  const noteOf = async (headers) => {
    const fake = fakeHosts({ graphql: { [web]: emptyPool }, pulls: { [commitSearch(web, 'PROJ-123')]: limitBy(headers) } });
    return (await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts: { ...fake.hosts, limited: new Map() } })).notes[0];
  };
  assert.match(await noteOf({ 'x-ratelimit-remaining': '25', 'x-ratelimit-reset': '1700003600' }), /; retry after ~60s$/);
  assert.match(await noteOf({ 'x-ratelimit-remaining': '25', 'retry-after': '15' }), /; retry after ~15s$/, 'retry-after first');
  assert.match(await noteOf({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000090' }), /; retry after ~90s$/, 'none left: the primary reset');
});

test('collectPullRequests: a repository both limited GitHub commit quotas stop gives the later deadline, or none when one has none', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const fake = fakeHosts({ graphql: { 'acme-corp/web': emptyPool } });
  const noteWith = async (search, core) => {
    const hosts = { ...fake.hosts, limited: new Map([['github:search', search], ['github:core', core]]) };
    return (await collectPullRequests('PROJ-123', { repos: ['github:acme-corp/web'], commits: true, hosts })).notes;
  };
  assert.deepEqual(await noteWith(1_700_000_090_000, 1_700_000_030_000), ['github:acme-corp/web: commits not searched — github limited the rate of requests earlier in this run; retry after ~90s']);
  assert.deepEqual(await noteWith(1_700_000_030_000, 1_700_000_090_000), ['github:acme-corp/web: commits not searched — github limited the rate of requests earlier in this run; retry after ~90s']);
  assert.deepEqual(await noteWith(1_700_000_030_000, null), ['github:acme-corp/web: commits not searched — github limited the rate of requests earlier in this run']);
  assert.ok(fake.calls.every((c) => c.startsWith('GRAPHQL')), 'the pool search still runs; the commit search does not');
});

test('collectPullRequests: GitLab\'s RateLimit-Reset gives when to retry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const limit = new HttpError(429, 'https://gitlab.example.com/api/v4/projects/acme%2Fbackend/search', 'Retry later', new Headers({ 'RateLimit-Reset': '1700000045' }));
  const fake = fakeHosts({ gitlab: { '/projects/acme%2Fbackend/search?scope=commits': limit } });
  const found = await collectPullRequests('PROJ-123', { repos: ['gitlab:acme/backend'], commits: true, hosts: { ...fake.hosts, limited: new Map() } });
  assert.deepEqual(found.notes, ['gitlab:acme/backend: commits not searched — gitlab limits the rate of requests (HTTP 429); no more commit search there in this run; retry after ~45s']);
});

test('collectPullRequests: a GitHub REST core limit in one task leaves a later task\'s pool search; only its commit search is not asked', async () => {
  const names = ['acme-corp/a', 'acme-corp/b'];
  const fake = fakeHosts({ graphql: { [names[0]]: emptyPool, [names[1]]: emptyPool }, pulls: {
    [commitSearch(names[0], 'PROJ-123')]: { total_count: 1, items: [{ sha: 'a1a1a1a1a1', commit: { message: 'PROJ-123 step' } }] },
    [`/repos/${names[0]}/commits/a1a1a1a1a1/pulls`]: new HttpError(429, 'https://api.github.com/x', 'slow down'),
  } });
  const hosts = { ...fake.hosts, limited: new Map() };
  await collectPullRequests('PROJ-123', { repos: [`github:${names[0]}`], commits: true, hosts });
  assert.deepEqual([...hosts.limited.keys()], ['github:core']);
  const later = await collectPullRequests('PROJ-124', { repos: [`github:${names[1]}`], commits: true, hosts });
  assert.deepEqual(later.notes, ['github:acme-corp/b: commits not searched — github limited the rate of requests earlier in this run']);
  assert.ok(fake.calls.includes('GRAPHQL acme-corp/b PROJ-124'), 'the pool search runs');
  assert.ok(!fake.calls.some((c) => c.includes('repo%3Aacme-corp%2Fb')), 'the commit search does not');
});

test('collectPullRequests: a pool search error that is no rate limit is noted as before and does not limit the host', async () => {
  const forbidden = new HttpError(403, 'https://api.github.com/graphql', 'Resource not accessible');
  const fake = fakeHosts({ graphql: { 'acme-corp/web': forbidden, 'acme-corp/api': emptyPool },
    pulls: { [commitSearch('acme-corp/api', 'PROJ-123')]: { total_count: 0, items: [] } } });
  const hosts = { ...fake.hosts, limited: new Map() };
  const found = await collectPullRequests('PROJ-123', { repos: ['github:acme-corp/web', 'github:acme-corp/api'], commits: true, hosts });
  assert.deepEqual(found.notes, ['github:acme-corp/web: not searched — HTTP 403 from https://api.github.com/graphql: Resource not accessible']);
  assert.equal(hosts.limited.size, 0);
  assert.ok(fake.calls.includes(`GET ${commitSearch('acme-corp/api', 'PROJ-123')}`), 'the host is still asked');
  assert.ok(!fake.calls.some((c) => c.includes('repo%3Aacme-corp%2Fweb')), 'a repository not searched is not commit-searched either');
  assert.equal(searchIncomplete(found), true);
});

test('collectPullRequests: hosts without a limited record still share one between the pool and the commit search of a task', async () => {
  const limit = new HttpError(403, 'https://gitlab.example.com/api/v4/projects/acme%2Fa/merge_requests', '{"message":"API rate limit exceeded"}');
  const fake = fakeHosts({ gitlab: { '/projects/acme%2Fa/merge_requests': limit } });
  const found = await collectPullRequests('PROJ-123', { repos: ['gitlab:acme/a', 'gitlab:acme/b'], commits: true, hosts: fake.hosts });
  assert.deepEqual(found.notes, [
    'gitlab:acme/a: not searched — HTTP 403 from https://gitlab.example.com/api/v4/projects/acme%2Fa/merge_requests: {"message":"API rate limit exceeded"}',
    'gitlab:acme/b: commits not searched — gitlab limited the rate of requests earlier in this run',
  ]);
  assert.ok(!fake.calls.some((c) => c.includes('scope=commits')));
  assert.equal('limited' in fake.hosts, false, 'the caller\'s hosts are left as they were');
});

test('searchGaps and the brief Notes line: a pool search stopped by a rate limit ranks with the rate limits, ahead of the notes it causes', async () => {
  const limit = new HttpError(429, 'https://gitlab.example.com/api/v4/projects/acme%2Fa/merge_requests', 'Retry later');
  const fake = fakeHosts({ gitlab: { '/projects/acme%2Fa/merge_requests': limit } });
  const found = await collectPullRequests('PROJ-123', { repos: ['github:acme-corp/web', 'gitlab:acme/a', 'gitlab:acme/b'], commits: true, hosts: fake.hosts });
  const stopped = 'gitlab:acme/a: not searched — HTTP 429 from https://gitlab.example.com/api/v4/projects/acme%2Fa/merge_requests: Retry later';
  const earlier = 'gitlab:acme/b: commits not searched — gitlab limited the rate of requests earlier in this run';
  const failed = 'github:acme-corp/web: not searched — HTTP 502 from https://api.github.com/graphql: bad gateway';
  assert.deepEqual(found.notes, [failed, stopped, earlier]);
  assert.deepEqual(searchGaps(found), [stopped, earlier, failed]);
  assert.match(briefPullRequestLines(found, { projectKey: 'PROJ' }).at(-1), /^Notes: gitlab:acme\/a: not searched — HTTP 429 /);
  const forbidden = 'github:acme-corp/web: not searched — HTTP 403 from https://api.github.com/graphql: API rate limit exceeded';
  assert.deepEqual(searchGaps({ notes: [failed, forbidden] }), [forbidden, failed], 'a 403 naming a rate limit too');
});

test('briefPullRequestLines: a note cut to 120 keeps its retry-after end whole, the text before it cut instead', () => {
  const limit = 'github:acme-corp/web: commits not searched — github limits the rate of requests (HTTP 429); no more commit search there in this run; retry after ~30s';
  const line = briefPullRequestLines({ pullRequests: [], hits: { pool: 0 }, notes: [limit] }, { projectKey: 'PROJ' }).at(-1);
  const note = line.slice('Notes: '.length);
  assert.equal(note, `${limit.slice(0, 120 - '; retry after ~30s'.length - 1).trimEnd()}…; retry after ~30s`);
  assert.ok(note.length <= 120, `${note.length} characters`);
  const short = 'gitlab:acme/b: commits not searched — gitlab limits the rate of requests (HTTP 429); retry after ~5s';
  assert.equal(briefPullRequestLines({ pullRequests: [], hits: { pool: 0 }, notes: [short] }, { projectKey: 'PROJ' }).at(-1), `Notes: ${short}`, 'a note that fits is not cut');
  const plain = limit.replace('; retry after ~30s', `${'; more'.repeat(4)}`);
  assert.equal(briefPullRequestLines({ pullRequests: [], hits: { pool: 0 }, notes: [plain] }, { projectKey: 'PROJ' }).at(-1), `Notes: ${plain.slice(0, 119).trimEnd()}…`, 'without the end: cut as before');
});

test('searchGaps: the notes that make the search incomplete, ranked as the brief Notes line shows them', () => {
  const page = 'only the first page of pull requests of github:acme-corp/web titled PROJ-7 was read';
  const unread = 'github:acme-corp/web: the pull requests of commit a1a1a1a were not read — HTTP 500';
  const failed = 'gitlab:acme/a: not searched — HTTP 502';
  const limit = 'github:acme-corp/web: commits not searched — github limits the rate of requests (HTTP 429); no more commit search there in this run';
  assert.deepEqual(searchGaps({ notes: [page, unread, failed, limit] }), [limit, failed, unread]);
  assert.deepEqual(searchGaps({ notes: [page, 'dev-status unavailable (HTTP 503)'] }), []);
  assert.deepEqual(searchGaps({ notes: [failed], incomplete: [] }), [], 'the caller\'s own set of gaps is read');
});

test('reposOutsidePool: a repository in the extended set is not outside', () => {
  const prs = [pr(1, { repo: 'github:acme-corp/legacy' }), pr(2, { repo: 'github:acme-corp/auth' })];
  assert.deepEqual(reposOutsidePool(prs, ['github:acme-corp/web'], ['github:ACME-corp/legacy']), ['github:acme-corp/auth']);
});

test('pullRequestLines: the hint of an unsearched extended set, only when the pool found nothing; the note of an empty one', () => {
  const opts = {
    projectKey: 'PROJ', configPath: 'task-tracking.jira.projects', tool: 'node oikos/tools/jira/cli.mjs',
    repos: ['github:acme-corp/web'], extended: ['github:acme-corp/legacy', 'gitlab:acme/old'],
    extendedCommand: 'node oikos/tools/jira/cli.mjs transition --task PROJ-7 --to Done --dry-run --extended',
  };
  const nothing = { pullRequests: [], branches: [], notes: [], hits: { pool: 0, extended: 0 } };
  const hint = pullRequestLines(nothing, opts).join('\n');
  assert.match(hint, /^Nothing found in the pool; the extended set of PROJ has 2 repositories, searched only on request: node oikos\/tools\/jira\/cli\.mjs transition --task PROJ-7 --to Done --dry-run --extended$/m);
  assert.equal((hint.match(/extended set/g) || []).length, 1, 'one hint line');

  const poolHit = { ...nothing, pullRequests: [pr(1)], hits: { pool: 1, extended: 0 } };
  assert.doesNotMatch(pullRequestLines(poolHit, opts).join('\n'), /extended/, 'the pool found something: no hint');
  assert.doesNotMatch(pullRequestLines(nothing, { ...opts, extended: [] }).join('\n'), /extended/, 'no extended set: no hint');
  assert.doesNotMatch(pullRequestLines(nothing, { ...opts, searchedExtended: true }).join('\n'), /Nothing found in the pool/, 'searched: no hint');

  const searchedEmpty = pullRequestLines(nothing, { ...opts, extended: [], searchedExtended: true }).join('\n');
  assert.match(searchedEmpty, /^--extended: the extended set of PROJ is empty \(task-tracking\.jira\.projects\.PROJ\.extended_repos\) — nothing more was searched\.$/m);

  const attachedInSet = { ...nothing, pullRequests: [pr(4, { source: 'attached', repo: 'github:acme-corp/legacy' })] };
  assert.doesNotMatch(pullRequestLines(attachedInSet, opts).join('\n'), /carries a pull request of this task and is not in the pool/,
    'a repository of the extended set is not proposed for the pool');
});

test('briefPullRequestLines: one line each, titles cut to 60, at most five, the extended hint as pullRequestLines gives it', () => {
  const opts = { projectKey: 'PROJ', extended: ['github:acme-corp/legacy'], extendedCommand: 'node oikos/tools/jira/cli.mjs transition --task PROJ-7 --to Done --dry-run --brief --extended' };
  const nothing = { pullRequests: [], branches: [], notes: [], hits: { pool: 0, extended: 0 } };
  assert.deepEqual(briefPullRequestLines(nothing, opts), ['PRs: none',
    '  Nothing found in the pool; the extended set of PROJ has 1 repository, searched only on request: node oikos/tools/jira/cli.mjs transition --task PROJ-7 --to Done --dry-run --brief --extended']);
  assert.deepEqual(briefPullRequestLines(nothing, { ...opts, extended: [] }), ['PRs: none']);

  const long = pr(9, { source: 'attached', state: 'merged', repo: 'gitlab:acme/backend', title: 'x'.repeat(70) });
  const many = { ...nothing, pullRequests: [long, ...[1, 2, 3, 4, 5].map((n) => pr(n))], hits: { pool: 5, extended: 0 } };
  const lines = briefPullRequestLines(many, opts);
  assert.equal(lines[0], 'PRs:');
  assert.equal(lines[1], `  acme/backend!9 merged [attached] ${'x'.repeat(59)}…`);
  assert.equal(lines[2], '  acme-corp/web#1 open [pool] PROJ-7 part 1');
  assert.deepEqual(lines.slice(6), ['  … 1 more'], 'five shown, then the count; the pool found something: no hint');
  assert.deepEqual(foundBySearch(many.pullRequests).map((p) => p.number), [1, 2, 3, 4, 5]);
});

test('briefPullRequestLines: one Notes line with what the search could not read, three cut to 120, then how many more', () => {
  const failed = 'github:acme-corp/web: not searched — no GitHub credential';
  const page = 'only the first page of pull requests of gitlab:acme/backend matching PROJ-7 was read';
  const found = { pullRequests: [pr(1)], hits: { pool: 1 }, notes: [failed, page] };
  assert.deepEqual(briefPullRequestLines(found, { projectKey: 'PROJ' }).slice(-1), [`Notes: ${failed}; ${page}`]);
  assert.deepEqual(incompleteNotes(found), [failed, page], 'every note of collectPullRequests says what was not done');
  const long = `gitlab:acme/a: not searched — x${'y'.repeat(130)}`;
  const many = { ...found, notes: [page, failed, long, 'gitlab:acme/b: not searched — HTTP 502', 'dev-status unavailable (HTTP 404)'] };
  const line = briefPullRequestLines(many, { projectKey: 'PROJ' }).at(-1);
  assert.equal(line, `Notes: ${failed}; ${long.slice(0, 119)}…; gitlab:acme/b: not searched — HTTP 502 (+2 more)`, 'a first page only comes after what stopped');
  const apart = { ...found, notes: ['dev-status: 1 pull request(s) via Example Git App', failed], incomplete: [failed] };
  assert.deepEqual(briefPullRequestLines(apart, { projectKey: 'PROJ' }).slice(-1), [`Notes: ${failed}`], 'an informing note is left out when the caller sets the gaps apart');
  assert.ok(!briefPullRequestLines({ ...found, notes: [] }, { projectKey: 'PROJ' }).some((l) => l.startsWith('Notes')), 'nothing missed: no line');
});

test('searchIncomplete: a search that did not run, stopped part way or left commits unread is a gap; a first page only and dev-status unavailable only inform', () => {
  const stopped = [
    'github:acme-corp/web: not searched — no GitHub credential',
    'gitlab:acme/a: not searched — HTTP 502',
    'github:acme-corp/web: commits not searched — github limits the rate of requests (HTTP 429); no more commit search there in this run',
    'github:acme-corp/web: commits not searched — github limits the rate of requests (HTTP 403); no more commit search there in this run',
    'gitlab:acme/b: commits not searched — gitlab limited the rate of requests earlier in this run',
    'github:acme-corp/web: commits partly searched — github limits the rate of requests (HTTP 429) after 2 of 4 commits; no more commit search there in this run',
    'github:acme-corp/web: the pull requests of commit a1a1a1a were not read — HTTP 500 from https://api.github.com/x: server error',
    'github:acme-corp/web: the pull requests of 3 commits were not read — HTTP 403: forbidden (5f8f19a, 1a2b3c4, 9d8e7f6)',
  ];
  const informing = [
    'only the first page of pull requests of github:acme-corp/web titled PROJ-7 was read',
    'only the first page of the pull requests of 25 commits of github:acme-corp/web (the first 20 followed) was read',
    'dev-status unavailable (HTTP 503)',
    'dev-status detail of Example Git App unavailable (HTTP 500)',
  ];
  for (const note of stopped) assert.equal(searchIncomplete({ notes: [...informing, note] }), true, note);
  assert.equal(searchIncomplete({ notes: informing }), false, 'the notes stay, the search is whole');
  assert.equal(searchIncomplete({ notes: [stopped[0]], incomplete: [] }), false, 'the caller\'s own set of gaps is read');
  assert.equal(searchIncomplete({ notes: [] }), false);
});

/** A note as the brief Notes line cuts it. */
const cut = (text) => (text.length <= 120 ? text : `${text.slice(0, 119).trimEnd()}…`);

test('briefPullRequestLines: a rate limit is shown first, a stopped search before a first page only, else in collection order', () => {
  const page = (n) => `only the first page of pull requests of github:acme-corp/web${n} matching PROJ-7 was read`;
  const limit = 'github:acme-corp/web: commits not searched — github limits the rate of requests (HTTP 429); no more commit search there in this run';
  const earlier = 'gitlab:acme/b: commits not searched — gitlab limited the rate of requests earlier in this run';
  const failed = 'gitlab:acme/a: not searched — HTTP 502';
  const found = { pullRequests: [], hits: { pool: 0 }, notes: [page(1), page(2), failed, page(3), earlier, limit] };
  assert.equal(briefPullRequestLines(found, { projectKey: 'PROJ' }).at(-1), `Notes: ${cut(earlier)}; ${cut(limit)}; ${failed} (+3 more)`);
  const unread = 'github:acme-corp/web: the pull requests of commit a1a1a1a were not read — HTTP 500';
  const partly = 'github:acme-corp/web: commits partly searched — github limits the rate of requests (HTTP 429) after 2 of 4 commits; no more commit search there in this run';
  const mixed = { ...found, notes: [page(1), unread, failed, partly] };
  assert.equal(briefPullRequestLines(mixed, { projectKey: 'PROJ' }).at(-1), `Notes: ${cut(partly)}; ${failed}; ${unread} (+1 more)`,
    'unread commits after the searches that stopped, before what only informs');
});

test('collectPullRequests: a set whose only hit is skipped found nothing — the unsearched extended set keeps its hint', async () => {
  const web = 'acme-corp/web';
  const fake = fakeHosts({
    graphql: { [web]: { repository: { ref0: { totalCount: 1, nodes: [{ name: 'PROJ-123-x', associatedPullRequests: { nodes: [node(14, 'PROJ-123 not this one', 'PROJ-123-x')] } }] } },
      search0: { issueCount: 1, nodes: [node(14, 'PROJ-123 not this one', 'PROJ-123-x')] } } },
    pulls: { [commitSearch(web, 'PROJ-123')]: { total_count: 0, items: [] } },
  });
  const skip = ['https://github.com/acme-corp/web/pull/14'];
  const found = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, skip, hosts: fake.hosts });
  assert.deepEqual(found.skipped.map((p) => p.number), [14]);
  assert.deepEqual(found.hits, { pool: 0, extended: 0 }, 'found twice, by its branch and its title, skipped: no hit');
  const opts = { projectKey: 'PROJ', extended: ['github:acme-corp/legacy'], extendedCommand: 'jira transition --task PROJ-123 --to Done --dry-run --brief --extended' };
  assert.match(briefPullRequestLines(found, opts)[1], /^ {2}Nothing found in the pool; the extended set of PROJ has 1 repository/);
  const kept = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, hosts: fake.hosts });
  assert.deepEqual(kept.hits, { pool: 2, extended: 0 }, 'without the skip the hits count as before');
  assert.ok(!briefPullRequestLines(kept, opts).some((l) => l.includes('Nothing found in the pool')));
});

test('collectPullRequests: --skip-pr is applied before the commit search, so a task whose only found PR is skipped still gets it', async () => {
  const web = 'acme-corp/web';
  const fake = fakeHosts({
    graphql: { [web]: { repository: { ref0: { totalCount: 0, nodes: [] } }, search0: { issueCount: 1, nodes: [node(14, 'PROJ-123 not this one', 'x')] } } },
    pulls: {
      [commitSearch(web, 'PROJ-123')]: { total_count: 1, items: [{ sha: 'd4d4d4d4d4', commit: { message: 'PROJ-123 export' } }] },
      [`/repos/${web}/commits/d4d4d4d4d4/pulls`]: [restPull(40, 'Export')],
    },
  });
  const skip = ['https://github.com/acme-corp/web/pull/14', 'https://github.com/acme-corp/web/pull/99'];
  const found = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, skip, hosts: fake.hosts });
  assert.deepEqual(found.pullRequests.map((p) => p.number), [40]);
  assert.deepEqual(found.skipped.map((p) => p.number), [14]);
  assert.deepEqual(found.skip, { attached: [], unmatched: ['https://github.com/acme-corp/web/pull/99'] });

  const viaSkip = ['https://github.com/acme-corp/web/pull/14', 'https://github.com/acme-corp/web/pull/40'];
  const both = await collectPullRequests('PROJ-123', { repos: [`github:${web}`], commits: true, skip: viaSkip, hosts: fake.hosts });
  assert.deepEqual(both.skipped.map((p) => [p.number, p.viaCommit?.sha]), [[14, undefined], [40, 'd4d4d4d4d4']]);
  assert.ok(briefPullRequestLines(both, { projectKey: 'PROJ' }).includes(
    'Skipped (--skip-pr): acme-corp/web#14 PROJ-123 not this one; acme-corp/web#40 Export — via commit d4d4d4d PROJ-123 export'),
  'a skipped PR found through a commit names it in the brief line too');
});

test('skipPullRequests: URLs compared as de-duplication compares them; attached and unmatched URLs named', () => {
  assert.equal(pullRequestKey('https://GitHub.com/Acme-Corp/web/pull/14/files/'), 'https://github.com/acme-corp/web/pull/14');
  assert.equal(pullRequestKey('https://wiki.example.com/x/'), 'https://wiki.example.com/x');
  const prs = [pr(1, { source: 'attached' }), pr(2), pr(3, { source: 'extended' })];
  const r = skipPullRequests(prs, ['https://github.com/acme-corp/web/pull/2/', 'HTTPS://github.com/acme-corp/web/pull/3/files',
    'https://github.com/acme-corp/web/pull/1', 'https://github.com/acme-corp/web/pull/9']);
  assert.deepEqual(r.kept.map((p) => p.number), [1]);
  assert.deepEqual(r.skipped.map((p) => p.number), [2, 3]);
  assert.deepEqual(r.attached, ['https://github.com/acme-corp/web/pull/1']);
  assert.deepEqual(r.unmatched, ['https://github.com/acme-corp/web/pull/9']);
  assert.deepEqual(skipPullRequests(prs).kept, prs);
  assert.equal(moveComment(null, r.kept), null, 'a skipped PR is not posted');
  const lines = pullRequestLines({ pullRequests: r.kept, skipped: r.skipped, branches: [], notes: [] }, { projectKey: 'PROJ', repos: ['github:acme-corp/web'], configPath: 'x', tool: 'jira' });
  assert.equal(lines[3], 'Skipped (--skip-pr) — not the task\'s result, left out of the comment:');
  assert.deepEqual(briefPullRequestLines({ pullRequests: r.kept, skipped: r.skipped, hits: { pool: 2 } }, { projectKey: 'PROJ' }).slice(-1),
    ['Skipped (--skip-pr): acme-corp/web#2 PROJ-7 part 2; acme-corp/web#3 PROJ-7 part 3']);
});

test('moveComment: the extended set\'s PRs join the comment like the pool\'s', () => {
  const text = moveComment('Checked.', [pr(1, { source: 'attached' }), pr(4, { source: 'extended', repo: 'github:acme-corp/legacy', url: 'https://github.com/acme-corp/legacy/pull/4', title: 'Old UI' })]);
  assert.equal(text, ['Checked.', '', 'Pull requests of this task found in the project\'s repositories:',
    '- [acme-corp/legacy#4](https://github.com/acme-corp/legacy/pull/4) — Old UI (open)'].join('\n'));
});

test('github pr / prs: one pull request by URL; a key in named repositories, read-only', () => {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, [
    { url: 'https://api.github.com/repos/acme-corp/web/pulls/12', body: { html_url: 'https://github.com/acme-corp/web/pull/12', number: 12, title: 'Export', state: 'open', draft: true, head: { ref: 'PROJ-7-export' } } },
    { graphql: 'refs(refPrefix', body: { data: {
      repository: { ref0: { totalCount: 1, nodes: [{ name: 'PROJ-7-export', associatedPullRequests: { nodes: [node(12, 'Export', 'PROJ-7-export')] } }] } },
      search0: { issueCount: 0, nodes: [] },
    } } },
  ]);
  const env = { GITHUB_TOKEN: 'fake-gh-token', ...fake.env };
  const one = tool(dir, 'github', ['pr', '--url', 'https://github.com/acme-corp/web/pull/12/files'], env, fake);
  assert.equal(one.status, 0, one.output);
  assert.match(one.stdout, /^draft {3}github:acme-corp\/web#12 {2}Export\n {8}https:\/\/github\.com\/acme-corp\/web\/pull\/12 {2}\(branch PROJ-7-export\)$/m);
  const bad = tool(dir, 'github', ['pr', '--url', 'https://gitlab.example.com/a/b/-/merge_requests/1'], env, fake);
  assert.equal(bad.status, 1, bad.output);
  assert.match(bad.stderr, /not a GitHub pull request URL/);
  const many = tool(dir, 'github', ['prs', '--key', 'PROJ-7', '--repo', 'web'], env, fake);
  assert.equal(many.status, 0, many.output);
  assert.match(many.stdout, /^open {4}github:acme-corp\/web#12 {2}Export$/m);
  assert.match(many.stdout, /^1 pull request\(s\), 0 branch\(es\) without one, for PROJ-7 in 1 repository$/m);
  assert.ok(fake.calls().every((c) => c.method === 'GET' || c.url.endsWith('/graphql')), 'reads only');
});
