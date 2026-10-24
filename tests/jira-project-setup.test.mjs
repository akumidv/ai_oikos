// Jira `repos add` and `project-init` (npm test, ADR 0001 D05, D07): both write only the
// installation's oikos.yaml, as the confirmed command after a dry run. The tool runs in a copy of
// examples/installation (ACME Corp); `repos add` and a real `project-init` make no request at all
// (no-fetch), the `project-init` dry run reads canned answers (fake-fetch.mjs): the workflow, the
// project's task numbers, the GitHub search under an owner, an owner's repositories and a
// repository's recent names. A failed step is said in its section and does not stop the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { installation, tool, withFakeFetch, assertNoCrashNoRequest } from './helpers/installation.mjs';
import { WRITES } from '../tools/hooks/writes.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token', GITHUB_TOKEN: 'fake-gh-token' };

const RULES = `
# Who may move a task (ADR 0001).
task-tracking:
  jira:
    defaults:
      transitions:
        - { from: [To Do, In Progress, Blocked], to: [To Do, In Progress, Blocked, Review], mode: agent }
        - { from: Review, to: [Test, Done], mode: confirm, requires: The task shows its result. }
    projects:
      PROJ:
        key_aliases: [PJ]   # PJ-7 is PROJ-7
        repos:
          - github:acme-corp/web   # the UI
        results: Pull requests.
# the end
`;

const withRules = (t) => `${t}${RULES}`;
const configOf = (dir) => readFileSync(join(dir, 'oikos.yaml'), 'utf8');
const jira = (dir, args, env = {}) => tool(dir, 'jira', args, { ...CREDS, ...env });

function run(dir, routes, args) {
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...CREDS, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}

// == repos add ==

test('repos add: a missing task-tracking part and project are created; the rest of the file is kept', () => {
  const dir = installation((t) => t);
  const before = configOf(dir);
  const dry = jira(dir, ['repos', 'add', 'PROJ', 'github:acme-corp/web', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assertNoCrashNoRequest(dry);
  assert.match(dry.stdout, /^--- DRY RUN \(requested --dry-run\) ---\nWould change task-tracking\.jira\.projects\.PROJ in oikos\.yaml:\n {2}repos \+ github:acme-corp\/web\nThe block after the change:\n {6}PROJ:\n {8}repos: \[github:acme-corp\/web\]\nDRY RUN — nothing written to oikos\.yaml\.$/m);
  assert.equal(configOf(dir), before, 'the dry run writes nothing');

  const real = jira(dir, ['repos', 'add', 'PROJ', 'github:acme-corp/web']);
  assert.equal(real.status, 0, real.output);
  assertNoCrashNoRequest(real);
  assert.match(real.stdout, /^Wrote task-tracking\.jira\.projects\.PROJ in oikos\.yaml:\n {2}repos \+ github:acme-corp\/web$/m);
  assert.equal(configOf(dir), `${before}task-tracking:\n  jira:\n    projects:\n      PROJ:\n        repos: [github:acme-corp/web]\n`);
});

test('repos add: appends to a block list and a flow list, de-duplicates, keeps every comment', () => {
  const dir = installation(withRules);
  const before = configOf(dir);
  const r = jira(dir, ['repos', 'add', 'proj', 'github:ACME-CORP/web', 'github:acme-corp/api']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}repos \+ github:acme-corp\/api\n {2}repos: already there — github:ACME-CORP\/web$/m);
  const after = configOf(dir);
  assert.equal(after, before.replace('- github:acme-corp/web   # the UI', '- github:acme-corp/web   # the UI\n          - github:acme-corp/api'));
  assert.deepEqual(YAML.parse(after)['task-tracking'].jira.projects.PROJ.repos, ['github:acme-corp/web', 'github:acme-corp/api']);

  const flow = installation((t) => withRules(t).replace('repos:\n          - github:acme-corp/web   # the UI', 'repos: [github:acme-corp/web]   # the UI'));
  const flowBefore = configOf(flow);
  assert.equal(jira(flow, ['repos', 'add', 'PROJ', 'github:acme-corp/api']).status, 0);
  assert.equal(configOf(flow), flowBefore.replace('repos: [github:acme-corp/web]', 'repos: [github:acme-corp/web, github:acme-corp/api]'));
});

test('repos add: nothing to add says so and writes nothing', () => {
  const dir = installation(withRules);
  const before = configOf(dir);
  const r = jira(dir, ['repos', 'add', 'PROJ', 'github:acme-corp/web']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Nothing to add: github:acme-corp\/web already in task-tracking\.jira\.projects\.PROJ\.repos$/m);
  assert.equal(configOf(dir), before);
});

test('repos add: a pattern, a malformed repository, a missing verb or key is refused, nothing written', () => {
  const dir = installation(withRules);
  const before = configOf(dir);
  const pattern = jira(dir, ['repos', 'add', 'PROJ', 'github:acme-corp/d3-*', '--dry-run']);
  assert.equal(pattern.status, 1);
  assert.match(pattern.stderr, /is a pattern: the pool stores explicit names only\. A pattern is a search aid of `node oikos\/tools\/jira\/cli\.mjs project-init <KEY> --pattern <glob> --dry-run`/);
  const bad = jira(dir, ['repos', 'add', 'PROJ', 'acme-corp/web']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /'acme-corp\/web' is not <host>:<owner>\/<name>/);
  assert.match(jira(dir, ['repos', 'remove', 'PROJ', 'github:acme-corp/web']).stderr, /usage: node oikos\/tools\/jira\/cli\.mjs repos add \[--extended\] <KEY>/);
  assert.match(jira(dir, ['repos', 'add', 'PROJ']).stderr, /at least one repository is required/);
  assert.match(jira(dir, ['repos', 'add', 'PROJ-1', 'github:acme-corp/x']).stderr, /a project key like PROJ is required/);
  assert.equal(configOf(dir), before);
});

test('repos add: a task-tracking part with problems refuses the write, naming them', () => {
  const dir = installation((t) => `${t}${RULES.replace('mode: agent', 'mode: always')}`);
  const before = configOf(dir);
  const r = jira(dir, ['repos', 'add', 'PROJ', 'github:acme-corp/api']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /nothing written — task-tracking would have problems: task-tracking\.jira\.defaults\.transitions\[0\]\.mode: 'always' is not one of agent, confirm, person/);
  assert.equal(configOf(dir), before);
});

test('repos add --extended: the flag anywhere adds to extended_repos; nothing to add names that list', () => {
  const dir = installation(withRules);
  const before = configOf(dir);
  const dry = jira(dir, ['repos', 'add', '--extended', 'PROJ', 'github:acme-corp/legacy', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assertNoCrashNoRequest(dry);
  assert.match(dry.stdout, /^ {2}extended_repos \+ github:acme-corp\/legacy$/m);
  assert.match(dry.stdout, /^ {8}extended_repos: \[github:acme-corp\/legacy\]$/m);
  assert.equal(configOf(dir), before, 'the dry run writes nothing');

  const real = jira(dir, ['repos', 'add', 'PROJ', 'github:acme-corp/legacy', 'gitlab:acme/old', '--extended']);
  assert.equal(real.status, 0, real.output);
  const project = YAML.parse(configOf(dir))['task-tracking'].jira.projects.PROJ;
  assert.deepEqual(project.extended_repos, ['github:acme-corp/legacy', 'gitlab:acme/old']);
  assert.deepEqual(project.repos, ['github:acme-corp/web'], 'the pool is untouched');
  assert.match(configOf(dir), /# the UI\n {8}results: Pull requests\.\n {8}extended_repos: \[github:acme-corp\/legacy, gitlab:acme\/old\]\n# the end/);

  const again = jira(dir, ['repos', 'add', 'PROJ', 'github:acme-corp/legacy', '--extended']);
  assert.match(again.stdout, /^Nothing to add: github:acme-corp\/legacy already in task-tracking\.jira\.projects\.PROJ\.extended_repos$/m);
});

test('repos add --numbers: a pool repository joins number_repos; one outside both lists or held by another project is refused in the dry run', () => {
  const plan = '      PLAN:\n        repos: [github:acme-corp/plan]\n        number_repos: [github:acme-corp/plan]\n';
  const numbered = RULES.replace('# the end', `${plan}# the end`).replace('    defaults:\n', '    defaults:\n      number_patterns: ["FIX[{n}]"]\n');
  const dir = installation((t) => `${t}${numbered}`);
  const before = configOf(dir);
  const dry = jira(dir, ['repos', 'add', '--numbers', 'PROJ', 'github:acme-corp/web', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assertNoCrashNoRequest(dry);
  assert.match(dry.stdout, /^ {2}number_repos \+ github:acme-corp\/web$/m);
  assert.equal(configOf(dir), before);
  const real = jira(dir, ['repos', 'add', '--numbers', 'PROJ', 'github:acme-corp/web']);
  assert.equal(real.status, 0, real.output);
  assert.deepEqual(YAML.parse(configOf(dir))['task-tracking'].jira.projects.PROJ.number_repos, ['github:acme-corp/web']);

  const outside = jira(dir, ['repos', 'add', '--numbers', 'PROJ', 'github:acme-corp/api', '--dry-run']);
  assert.equal(outside.status, 1, outside.output);
  assert.match(outside.stderr, /'github:acme-corp\/api' is in neither task-tracking\.jira\.projects\.PROJ\.repos nor task-tracking\.jira\.projects\.PROJ\.extended_repos — add it to one of them first/);
  const held = installation((t) => `${t}${numbered}`
    .replace('          - github:acme-corp/web   # the UI', '          - github:acme-corp/web   # the UI\n          - github:acme-corp/plan'));
  const taken = jira(held, ['repos', 'add', '--numbers', 'PROJ', 'github:acme-corp/plan', '--dry-run']);
  assert.equal(taken.status, 1, taken.output);
  assert.match(taken.stderr, /'github:acme-corp\/plan' carries the bare numbers of PLAN \(task-tracking\.jira\.projects\.PLAN\.number_repos\)/);
  const both = jira(dir, ['repos', 'add', '--numbers', '--extended', 'PROJ', 'github:acme-corp/web', '--dry-run']);
  assert.equal(both.status, 1, both.output);
  assert.match(both.stderr, /--extended and --numbers are two lists/);
});

test('project-init: --number-pattern, --epic-role and --epic-project write their keys; a malformed one is refused before anything', () => {
  const dir = installation(withRules);
  const args = ['project-init', 'PROJ', '--number-pattern', 'FIX[{n}]', '--epic-role', 'Fixes=proj-10', '--epic-role', 'features=PROJ-11', '--epic-project', 'plan'];
  const r = jira(dir, args);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.match(r.stdout, /^ {2}number_patterns \+ FIX\[\{n\}\]\n {2}epic_projects \+ PLAN\n {2}epic_roles \+ fixes: PROJ-10, features: PROJ-11$/m);
  const project = YAML.parse(configOf(dir))['task-tracking'].jira.projects.PROJ;
  assert.deepEqual([project.number_patterns, project.epic_projects, project.epic_roles], [['FIX[{n}]'], ['PLAN'], { fixes: 'PROJ-10', features: 'PROJ-11' }]);
  for (const [flag, value, message] of [
    ['--number-pattern', 'FIX[]', /--number-pattern 'FIX\[\]' must hold \{n\} exactly once/],
    ['--epic-role', 'fixes:PROJ-10', /--epic-role 'fixes:PROJ-10' is not <role>=<KEY-n>/],
    ['--epic-role', 'support=PLAN-3', /'PLAN-3' is not an epic of PROJ/],
    ['--epic-project', 'PROJ', /epic_projects\[1\]: 'PROJ' is the project itself/],
  ]) {
    const bad = jira(dir, ['project-init', 'PROJ', flag, value]);
    assert.equal(bad.status, 1, `${flag} ${value}: ${bad.output}`);
    assert.match(bad.stderr, message);
  }
});

test('repos add: a repository the other list holds is refused, naming the list; nothing written', () => {
  const dir = installation((t) => withRules(t).replace('        results: Pull requests.\n', '        results: Pull requests.\n        extended_repos: [github:acme-corp/legacy]\n'));
  const before = configOf(dir);
  const toPool = jira(dir, ['repos', 'add', 'PROJ', 'github:acme-corp/legacy', '--dry-run']);
  assert.equal(toPool.status, 1, toPool.output);
  assert.match(toPool.stderr, /'github:acme-corp\/legacy' is already in task-tracking\.jira\.projects\.PROJ\.extended_repos — a repository belongs to one list, so it is not added to repos\. Moving a repository between the lists is not done here: edit oikos\.yaml by hand\./);
  const toSet = jira(dir, ['repos', 'add', '--extended', 'PROJ', 'github:acme-corp/web']);
  assert.equal(toSet.status, 1, toSet.output);
  assert.match(toSet.stderr, /'github:acme-corp\/web' is already in task-tracking\.jira\.projects\.PROJ\.repos — .*not added to extended_repos/);
  assert.equal(configOf(dir), before);
});

// == project-init ==

const statusesRoute = {
  url: `${API}/project/PROJ/statuses`,
  body: [
    { name: 'Story', statuses: [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'Review' }, { name: 'Done' }] },
    { name: 'Bug', statuses: [{ name: 'To Do' }, { name: 'Fixing' }, { name: 'Done' }] },
  ],
};
const numbersRoute = {
  match: `^${API}/search/jql\\?jql=${encodeURIComponent('project = "PROJ" ORDER BY created DESC')}`,
  body: { issues: [{ key: 'PROJ-12' }, { key: 'PROJ-8' }, { key: 'PROJ-7' }] },
};
const pr = (repo, n, title, branch) => ({ url: `https://github.com/${repo}/pull/${n}`, title, headRefName: branch, repository: { nameWithOwner: repo } });
const ownerPullsRoute = {
  graphql: 'OikosOwnerPulls',
  body: { data: { search: { issueCount: 4, nodes: [
    pr('acme-corp/api', 1, 'PROJ-7 export endpoint', 'PROJ-7-export'),
    pr('acme-corp/api', 2, 'Fix', 'feature/pj-8-fix'),
    pr('acme-corp/web', 3, 'PROJ-12 report UI', 'PROJ-12-ui'),
    pr('acme-corp/misc', 4, 'Mentions PROJ in the body only', 'cleanup'),
  ] } } },
};
const ownerReposRoute = {
  graphql: 'OikosOwnerRepos',
  body: { data: { repositoryOwner: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
    { nameWithOwner: 'acme-corp/d3-web', isArchived: false }, { nameWithOwner: 'acme-corp/d3-old', isArchived: true },
    { nameWithOwner: 'acme-corp/api', isArchived: false }, { nameWithOwner: 'acme-corp/web', isArchived: false },
  ] } } } },
};
// The first repository read (the pool's first) carries the names; the others none.
const recentRoute = {
  graphql: 'OikosRecentNames',
  times: 1,
  body: { data: { repository: {
    pullRequests: { nodes: [{ title: 'AP-7 export', headRefName: 'AP-7-export' }, { title: 'UTF-8 fix', headRefName: 'utf' }] },
    refs: { nodes: [{ name: 'AP-12-ui' }, { name: 'main' }] },
  } } },
};
const recentEmpty = { graphql: 'OikosRecentNames', body: { data: { repository: { pullRequests: { nodes: [] }, refs: { nodes: [] } } } } };
const ROUTES = [statusesRoute, numbersRoute, ownerPullsRoute, ownerReposRoute, recentRoute, recentEmpty];
const sectionOf = (out, title) => out.split(`## ${title}\n`)[1].split('\n## ')[0];

test('project-init --dry-run: workflow, aliases, pool candidates, prose and the proposed block; nothing written', () => {
  const dir = installation(withRules);
  const before = configOf(dir);
  const r = run(dir, ROUTES, ['project-init', 'PROJ', '--alias', 'ap', '--repo', 'github:acme-corp/api', '--results', 'Pull requests; screenshots for UI.', '--pattern', 'd3-*', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.equal(configOf(dir), before, 'the dry run writes nothing');
  assert.deepEqual(r.calls.filter((c) => c.method !== 'GET').map((c) => c.url).filter((u) => !u.endsWith('/graphql')), [], 'only reads');

  const workflow = sectionOf(r.stdout, 'Workflow');
  assert.match(workflow, /^ {2}Statuses \(5\): To Do, In Progress, Review, Done, Fixing$/m);
  assert.match(workflow, /^ {2}defaults\.transitions\[0\]: To Do, In Progress, Blocked → To Do, In Progress, Blocked, Review, agent — 4 move\(s\)$/m);
  assert.match(workflow, /^ {6}not in the workflow: Blocked$/m);
  assert.match(workflow, /^ {6}not in the workflow: Test$/m);
  assert.match(workflow, /^ {2}No rule covers: Fixing — moves into and out of them stay a person's$/m);

  const aliases = sectionOf(r.stdout, 'Key aliases');
  assert.match(aliases, /^ {2}Configured: PJ$/m);
  assert.match(aliases, /^ {2}AP {11}2× {2}e\.g\. github:acme-corp\/web: AP-7 export$/m, 'a pull request and a branch name task numbers of PROJ');
  assert.doesNotMatch(aliases, /UTF/, 'seen once: below the threshold');

  const pool = sectionOf(r.stdout, 'Repository pool');
  assert.match(pool, /^ {2}In the pool: github:acme-corp\/web$/m);
  assert.match(pool, /^ {2}Searched: github:acme-corp; pull requests updated since \d{4}-\d{2}-\d{2}; name patterns d3-\* \(a search aid, never stored\)$/m);
  assert.match(pool, /^ {4}github:acme-corp\/api {2}— 2 pull request\(s\)$/m);
  assert.match(pool, /^ {2}\* github:acme-corp\/web {2}— 1 pull request\(s\)$/m);
  assert.match(pool, /^ {4}github:acme-corp\/d3-web {2}— matches d3-\*$/m);
  assert.doesNotMatch(pool, /misc|d3-old/, 'a body-only match and an archived repository are not candidates');

  assert.match(sectionOf(r.stdout, 'Results and epics'), /^ {2}results:\n {4}Pull requests\.\n {2}epics: not set — ask the user/m);
  const block = sectionOf(r.stdout, 'Proposed block');
  assert.match(block, /^ {2}key_aliases \+ AP\n {2}repos \+ github:acme-corp\/api\n {2}results: replaced\n {6}PROJ:\n {8}key_aliases: \[PJ, AP\] {3}# PJ-7 is PROJ-7\n {8}repos:\n {10}- github:acme-corp\/web {3}# the UI\n {10}- github:acme-corp\/api\n {8}results: Pull requests; screenshots for UI\.$/m);
  assert.match(r.stdout, /^DRY RUN — nothing written to oikos\.yaml\.$/m);

  const search = r.calls.find((c) => c.body?.query?.includes('OikosOwnerPulls'));
  assert.match(search.body.variables.q, /^is:pr user:acme-corp updated:>=\d{4}-\d{2}-\d{2} sort:updated-desc "PROJ"$/);
  assert.ok(r.calls.some((c) => c.body?.variables?.q?.endsWith('"AP"')), 'the aliases given are searched too');
});

test('project-init --dry-run: a failed step is said there and the others go on; an empty pool asks for --owner', () => {
  const dir = installation((t) => `${t}${RULES.replace(/ {8}repos:\n {10}- github:acme-corp\/web {3}# the UI\n/, '')}`);
  const routes = [{ url: `${API}/project/PROJ/statuses`, status: 404, body: { errorMessages: ['no project'] } }, numbersRoute];
  const r = run(dir, routes, ['project-init', 'PROJ', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(sectionOf(r.stdout, 'Workflow'), /^ {2}not read — /m);
  assert.match(sectionOf(r.stdout, 'Key aliases'), /No other prefix names a task number/);
  assert.match(sectionOf(r.stdout, 'Repository pool'), /No owner to search: pass --owner github:<owner>/);
  assert.match(sectionOf(r.stdout, 'Proposed block'), /nothing to write — the flags change nothing in task-tracking\.jira\.projects\.PROJ/);

  const gitlab = run(dir, [statusesRoute, numbersRoute, { graphql: 'OikosOwnerPulls', status: 502, body: 'bad gateway' }],
    ['project-init', 'PROJ', '--owner', 'github:acme-corp', '--owner', 'gitlab:acme', '--dry-run']);
  assert.equal(gitlab.status, 0, gitlab.output);
  const pool = sectionOf(gitlab.stdout, 'Repository pool');
  assert.match(pool, /github:acme-corp pull requests carrying PROJ: not searched — /);
  assert.match(pool, /gitlab:acme: GitLab: not searched/);
  assert.match(sectionOf(gitlab.stdout, 'Workflow'), /Statuses \(5\)/, 'the workflow is read although the pool search failed');
});

test('project-init --dry-run: the extended set is listed and marked +; a candidate outside both lists gets both commands', () => {
  const dir = installation((t) => withRules(t).replace('        results: Pull requests.\n', '        results: Pull requests.\n        extended_repos: [github:acme-corp/api]\n'));
  const r = run(dir, ROUTES, ['project-init', 'PROJ', '--pattern', 'd3-*', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  const pool = sectionOf(r.stdout, 'Repository pool');
  assert.match(pool, /^ {2}In the pool: github:acme-corp\/web\n {2}In the extended set \(searched only with --extended\): github:acme-corp\/api$/m);
  assert.match(pool, /^ {2}\+ github:acme-corp\/api {2}— 2 pull request\(s\)\n {2}\* github:acme-corp\/web/m, 'marked, and no command under either');
  assert.match(pool, /^ {4}github:acme-corp\/d3-web {2}— matches d3-\*\n {6}pool: {5}node oikos\/tools\/jira\/cli\.mjs repos add PROJ github:acme-corp\/d3-web --dry-run\n {6}extended: node oikos\/tools\/jira\/cli\.mjs repos add --extended PROJ github:acme-corp\/d3-web --dry-run$/m);
  assert.match(pool, /^ {2}\* = already in the pool\n {2}\+ = already in the extended set$/m);
  assert.match(r.stdout, /--alias, --repo, --extended-repo, --results, --epics, --number-pattern, --epic-role,\n {2}--epic-project and --dry-run \(and repos add --numbers for the number repositories\)/);
});

test('project-init --dry-run: a project\'s first own number_patterns says it replaces defaults.number_patterns, once', () => {
  const withDefaults = (t) => withRules(t).replace('    projects:\n', '      number_patterns: ["FIX[{n}]"]\n    projects:\n');
  const note = /^ {2}number_patterns for PROJ replace defaults\.number_patterns \(FIX\[\{n\}\]\)$/m;
  const r = run(installation(withDefaults), ROUTES, ['project-init', 'PROJ', '--number-pattern', 'BUG-{n}', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  const block = sectionOf(r.stdout, 'Proposed block');
  assert.match(block, /^ {2}number_patterns \+ BUG-\{n\}\n {2}number_patterns for PROJ replace defaults\.number_patterns \(FIX\[\{n\}\]\)$/m);
  assert.equal((r.stdout.match(/replace defaults\.number_patterns/g) || []).length, 1);

  const noDefaults = run(installation(withRules), ROUTES, ['project-init', 'PROJ', '--number-pattern', 'BUG-{n}', '--dry-run']);
  assert.doesNotMatch(noDefaults.stdout, note, 'no defaults: nothing is replaced');
  const own = (t) => withDefaults(t).replace('        results: Pull requests.\n', '        results: Pull requests.\n        number_patterns: ["PJ#{n}"]\n');
  const grown = run(installation(own), ROUTES, ['project-init', 'PROJ', '--number-pattern', 'BUG-{n}', '--dry-run']);
  assert.equal(grown.status, 0, grown.output);
  assert.doesNotMatch(grown.stdout, /replace defaults\.number_patterns/, 'the project\'s own list replaced the defaults already');
});

test('project-init: the owners of the extended set are searched by default; --extended-repo writes extended_repos', () => {
  const dir = installation((t) => `${t}${RULES.replace(/ {8}repos:\n {10}- github:acme-corp\/web {3}# the UI\n/, '')}`);
  const dry = run(dir, ROUTES, ['project-init', 'PROJ', '--extended-repo', 'github:acme-corp/legacy', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.match(sectionOf(dry.stdout, 'Repository pool'), /^ {2}Searched: github:acme-corp; /m, 'the owner comes from the extended set');
  assert.match(sectionOf(dry.stdout, 'Proposed block'), /^ {2}extended_repos \+ github:acme-corp\/legacy$/m);

  const before = configOf(dir);
  const real = jira(dir, ['project-init', 'PROJ', '--extended-repo', 'github:acme-corp/legacy']);
  assert.equal(real.status, 0, real.output);
  assertNoCrashNoRequest(real);
  assert.equal(configOf(dir), before.replace('        results: Pull requests.\n', '        results: Pull requests.\n        extended_repos: [github:acme-corp/legacy]\n'));
  const both = jira(dir, ['project-init', 'PROJ', '--repo', 'github:acme-corp/legacy']);
  assert.equal(both.status, 1, both.output);
  assert.match(both.stderr, /already in task-tracking\.jira\.projects\.PROJ\.extended_repos/);
});

test('project-init: without --dry-run it writes only the block, with no request; nothing to write says so', () => {
  const dir = installation(withRules);
  const before = configOf(dir);
  const args = ['project-init', 'NEW', '--alias', 'nw', '--repo', 'github:acme-corp/new', '--results', 'A report on the wiki.', '--epics', 'One per quarter.'];
  const r = jira(dir, args);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.match(r.stdout, /^Wrote task-tracking\.jira\.projects\.NEW in oikos\.yaml:/m);
  const block = '      NEW:\n        key_aliases: [NW]\n        repos: [github:acme-corp/new]\n        results: A report on the wiki.\n        epics: One per quarter.';
  assert.equal(configOf(dir), before.replace('        results: Pull requests.\n', `        results: Pull requests.\n${block}\n`));

  const again = jira(dir, args);
  assert.equal(again.status, 0, again.output);
  assert.match(again.stdout, /^Nothing to write: task-tracking\.jira\.projects\.NEW already has what the flags give\.$/m);
  const none = jira(dir, ['project-init', 'OTHER']);
  assert.match(none.stdout, /^Nothing to write/m);
  assert.doesNotMatch(configOf(dir), /OTHER/);
});

test('writes.mjs: project-init and repos are guarded writes of jira; its reads are not', () => {
  assert.ok(WRITES.jira.includes('project-init'));
  assert.ok(WRITES.jira.includes('repos'));
  for (const read of ['info', 'context', 'search', 'boards', 'sprint', 'goals', 'mine']) assert.ok(!WRITES.jira.includes(read), read);
});
