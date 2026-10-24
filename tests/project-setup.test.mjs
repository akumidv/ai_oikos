// Tracker project setup (tools/common/project-setup.mjs, ADR 0001 D05, D07): the workflow laid
// against the rules, key alias candidates from titles and branch names, owners and name patterns,
// and the pool candidates. In-process, pure — the code-host search runs in jira-project-setup.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aliasCandidates, carriesPrefix, monthsAgo, poolCandidates, repoMatches, searchOwners, workflowCoverage, workflowLines,
} from '../tools/common/project-setup.mjs';

const PART = {
  defaults: {
    transitions: [
      { from: ['To Do', 'In Progress', 'Blocked'], to: ['To Do', 'In Progress', 'Blocked', 'Review'], mode: 'agent' },
      { from: 'Review', to: ['Test', 'Done'], mode: 'confirm', requires: 'A result.' },
    ],
  },
  projects: { DOCS: { transitions: [{ from: '*', to: 'Done', mode: 'confirm' }] } },
};
const STATUSES = ['To Do', 'In Progress', 'Review', 'Done', 'Fixing'];

test('workflowCoverage: the moves each rule decides, the statuses it names that the workflow lacks, the uncovered ones', () => {
  const c = workflowCoverage(STATUSES, PART, 'PROJ');
  assert.equal(c.own, false);
  assert.equal(c.defaultMode, 'person');
  assert.equal(c.rules[0].origin, 'defaults.transitions[0]');
  assert.deepEqual(c.rules[0].moves, [['To Do', 'In Progress'], ['To Do', 'Review'], ['In Progress', 'To Do'], ['In Progress', 'Review']]);
  assert.deepEqual(c.rules[0].missing, ['Blocked']);
  assert.deepEqual(c.rules[1].moves, [['Review', 'Done']]);
  assert.deepEqual(c.rules[1].missing, ['Test']);
  assert.deepEqual(c.uncovered, ['Fixing']);

  const own = workflowCoverage(STATUSES, PART, 'docs');
  assert.equal(own.own, true);
  assert.equal(own.rules[0].origin, 'projects.DOCS.transitions[0]');
  assert.deepEqual(own.rules[0].moves.map(([from]) => from), ['To Do', 'In Progress', 'Review', 'Fixing']);

  const lines = workflowLines(STATUSES, c, { configPath: 'task-tracking.jira', projectKey: 'PROJ' }).join('\n');
  assert.match(lines, /^ {2}defaults\.transitions\[0\]: To Do, In Progress, Blocked → To Do, In Progress, Blocked, Review, agent — 4 move\(s\)\n {6}To Do → In Progress, Review\n {6}In Progress → To Do, Review\n {6}not in the workflow: Blocked$/m);
  assert.match(lines, /^ {2}No rule covers: Fixing — moves into and out of them stay a person's$/m);
  assert.match(workflowLines(STATUSES, workflowCoverage(STATUSES, undefined, 'PROJ'), { configPath: 'task-tracking.jira', projectKey: 'PROJ' }).join('\n'),
    /No rules in task-tracking\.jira for PROJ: every move takes the default \(person\)/);
  assert.match(workflowLines([], c, { configPath: 'task-tracking.jira', projectKey: 'PROJ', error: 'HTTP 404' }).join('\n'), /^ {2}not read — HTTP 404$/m);
});

test('aliasCandidates: other prefixes on task numbers of the project, once per pull request or branch', () => {
  const items = [
    { repo: 'github:acme/web', title: 'PJ-7 export', branch: 'feature/pj-7-export' },
    { repo: 'github:acme/web', title: 'Fix', branch: 'PJ-12-fix' },
    { repo: 'github:acme/api', title: 'PROJ-7 and UTF-8 handling', branch: null },
    { repo: 'github:acme/api', title: 'PJ-999 is not a task of the project', branch: 'XPJ-7' },
    { repo: 'github:acme/api', title: 'Report CRUD', branch: 'feature/report-crud-12' },
    { repo: 'github:acme/api', title: 'More', branch: 'feature/export-crud-8' },
  ];
  assert.deepEqual(aliasCandidates(items, 'PROJ', [7, 8, 12]), [
    { prefix: 'PJ', count: 2, example: 'github:acme/web: PJ-7 export' },
    { prefix: 'UTF', count: 1, example: 'github:acme/api: PROJ-7 and UTF-8 handling' },
    { prefix: 'XPJ', count: 1, example: 'github:acme/api: PJ-999 is not a task of the project' },
  ]);
  assert.ok(carriesPrefix('feature/PJ-7-x', ['pj']));
  assert.ok(!carriesPrefix('PJ7', ['PJ']));
});

test('searchOwners: given ones, else the pool owners, each once; a malformed one is refused', () => {
  assert.deepEqual(searchOwners([], ['github:acme/web', 'github:ACME/api', 'gitlab:acme/group/back']).map((o) => o.id), ['github:acme', 'gitlab:acme']);
  assert.deepEqual(searchOwners(['github:other'], ['github:acme/web']).map((o) => o.id), ['github:other']);
  assert.deepEqual(searchOwners([], []), []);
  assert.throws(() => searchOwners(['acme'], []), /--owner 'acme' is not <host>:<owner>/);
});

test('repoMatches: a glob on the name, or on owner/name when it has a slash; monthsAgo', () => {
  assert.ok(repoMatches('github:acme/d3-web', 'd3-*'));
  assert.ok(repoMatches('github:acme/D3-web', 'd3-?eb'));
  assert.ok(!repoMatches('github:acme/web-d3', 'd3-*'));
  assert.ok(repoMatches('github:acme/d3-web', 'acme/d3-*'));
  assert.ok(!repoMatches('github:other/d3-web', 'acme/*'));
  assert.equal(monthsAgo(6, new Date('2026-10-19T12:00:00Z')), '2026-04-19');
});

test('poolCandidates: hits and patterns per repository, the pool marked, most hits first', () => {
  const hits = [{ repo: 'github:acme/api' }, { repo: 'github:acme/web' }, { repo: 'github:acme/api' }];
  const matched = [{ repo: 'github:acme/d3-web', pattern: 'd3-*' }, { repo: 'github:acme/web', pattern: '*web' }];
  assert.deepEqual(poolCandidates(hits, matched, ['github:ACME/web']), [
    { repo: 'github:acme/api', hits: 2, patterns: [], inPool: false, inExtended: false },
    { repo: 'github:acme/web', hits: 1, patterns: ['*web'], inPool: true, inExtended: false },
    { repo: 'github:acme/d3-web', hits: 0, patterns: ['d3-*'], inPool: false, inExtended: false },
  ]);
  const marked = poolCandidates(hits, matched, ['github:acme/web'], ['GitHub:acme/API']);
  assert.deepEqual(marked.map((c) => [c.repo, c.inPool, c.inExtended]), [
    ['github:acme/api', false, true], ['github:acme/web', true, false], ['github:acme/d3-web', false, false],
  ]);
});
