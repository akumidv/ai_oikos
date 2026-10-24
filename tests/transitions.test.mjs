// Tracker transition rules (tools/common/transitions.mjs, ADR 0001 D01/D02): the structure check of
// the `task-tracking` part — every problem named with its path — and the rule a move falls under:
// first match, "*", case-insensitive statuses, a project's own rules, the default. In-process, pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRepo, numberOwner, numberPatterns, resolveTransition, taskTrackingProblems, trackerProblems } from '../tools/common/transitions.mjs';
import { installation, script } from './helpers/installation.mjs';

const PART = {
  defaults: {
    default: 'confirm',
    transitions: [
      { from: ['To Do', 'In Progress'], to: ['To Do', 'In Progress', 'Review'], mode: 'agent' },
      { from: 'Review', to: ['Test', 'Done'], mode: 'confirm', requires: 'A result is linked.' },
      { from: 'Review', to: 'Done', mode: 'person' },
      { from: '*', to: 'Closed', mode: 'confirm', requires: 'A reason.' },
    ],
  },
  projects: {
    PROJ: { key_aliases: ['PJ'], repos: ['github:acme/web-ui', 'gitlab:acme/group/backend'], results: 'PRs.', epics: 'By area.' },
    DOCS: { results: 'A wiki page.', transitions: [{ from: 'Review', to: 'Done', mode: 'agent' }] },
  },
};

test('a well-formed part has no problems; an absent one neither', () => {
  assert.deepEqual(trackerProblems(PART, 'task-tracking.jira'), []);
  assert.deepEqual(taskTrackingProblems({ jira: PART }), []);
  assert.deepEqual(taskTrackingProblems(undefined), []);
  assert.deepEqual(trackerProblems(null, 'task-tracking.jira'), []);
});

test('every structure problem is named with its path', () => {
  const problems = taskTrackingProblems({
    jira: {
      defaults: { default: 'nobody', transitions: [{ from: [], to: 'Done', mode: 'agent' }, { to: 'Done', mode: 'confirm', requires: 3 }] },
      projects: {
        PROJ: {
          key_aliases: 'PJ',
          repos: ['github:acme/web-ui', 'bitbucket:acme/x', 'github:acme', 'github:acme/*'],
          results: ['x'],
          transitions: [{ from: 'A', to: 'B', mode: 'agent' }, { from: 'A', to: 'B', mode: 'agent' }, { from: 'A', to: 'B', mode: 'auto', when: 'x' }],
        },
      },
      extra: 1,
    },
    trello: {},
  });
  assert.deepEqual(problems, [
    'task-tracking.jira.extra: unknown key (expected defaults, projects)',
    "task-tracking.jira.defaults.default: 'nobody' is not one of agent, confirm, person",
    'task-tracking.jira.defaults.transitions[0].from: an empty list matches nothing',
    'task-tracking.jira.defaults.transitions[1].from: missing (a status, a list of statuses, or "*")',
    'task-tracking.jira.defaults.transitions[1].requires: must be text',
    'task-tracking.jira.projects.PROJ.key_aliases: must be a list',
    "task-tracking.jira.projects.PROJ.repos[1]: 'bitbucket:acme/x' is not <host>:<owner>/<name> with host github or gitlab",
    "task-tracking.jira.projects.PROJ.repos[2]: 'github:acme' is not <host>:<owner>/<name> with host github or gitlab",
    "task-tracking.jira.projects.PROJ.repos[3]: 'github:acme/*' is not <host>:<owner>/<name> with host github or gitlab",
    'task-tracking.jira.projects.PROJ.results: must be text',
    'task-tracking.jira.projects.PROJ.transitions[2].when: unknown key (expected from, to, mode, requires)',
    "task-tracking.jira.projects.PROJ.transitions[2].mode: 'auto' is not one of agent, confirm, person",
    'task-tracking.trello: not a tracker connector (one of jira, github-issues, gitlab-issues)',
  ]);
});

test('a rule that is not a mapping, and a part that is not one, are named', () => {
  assert.deepEqual(trackerProblems({ defaults: { transitions: ['Review>Done'] } }, 'task-tracking.jira'),
    ['task-tracking.jira.defaults.transitions[0]: must be a mapping with from, to, mode']);
  assert.deepEqual(trackerProblems({ defaults: { transitions: [{ from: 'A', to: 'B' }] } }, 'task-tracking.jira'),
    ['task-tracking.jira.defaults.transitions[0].mode: missing (one of agent, confirm, person)']);
  assert.deepEqual(taskTrackingProblems(['jira']), ['task-tracking: must be a mapping keyed by connector']);
  assert.deepEqual(trackerProblems('agent', 'task-tracking.jira'), ['task-tracking.jira: must be a mapping with defaults and projects']);
});

test('repos are <host>:<owner>/<name>, a GitLab path may have subgroups', () => {
  for (const ok of ['github:acme/web-ui', 'gitlab:acme/group/backend']) assert.ok(isRepo(ok), ok);
  for (const bad of ['acme/web-ui', 'github:acme', 'github:/acme/x', 'github:acme/x/', 'svn:acme/x', 'github:acme//x', 'github:acme/d3-*']) assert.ok(!isRepo(bad), bad);
});

test('extended_repos: the form of repos; a repository in both lists is a problem', () => {
  const part = (project) => ({ projects: { PROJ: project } });
  assert.deepEqual(trackerProblems(part({ repos: ['github:acme/web-ui'], extended_repos: ['github:acme/legacy', 'gitlab:acme/platform/old'] }), 'task-tracking.jira'), []);
  assert.deepEqual(trackerProblems(part({ repos: ['github:acme/web-ui'], extended_repos: ['github:acme/*', 'GitHub:ACME/web-ui ', 'acme/x'] }), 'task-tracking.jira'), [
    "task-tracking.jira.projects.PROJ.extended_repos[0]: 'github:acme/*' is not <host>:<owner>/<name> with host github or gitlab",
    "task-tracking.jira.projects.PROJ.extended_repos[1]: 'GitHub:ACME/web-ui ' is not <host>:<owner>/<name> with host github or gitlab",
    "task-tracking.jira.projects.PROJ.extended_repos[2]: 'acme/x' is not <host>:<owner>/<name> with host github or gitlab",
    "task-tracking.jira.projects.PROJ.extended_repos[1]: 'GitHub:ACME/web-ui ' is also in task-tracking.jira.projects.PROJ.repos — a repository belongs to one list",
  ]);
  assert.deepEqual(taskTrackingProblems({ jira: part({ repos: ['github:acme/web-ui'], extended_repos: ['github:Acme/Web-UI'] }) }), [
    "task-tracking.jira.projects.PROJ.extended_repos[0]: 'github:Acme/Web-UI' is also in task-tracking.jira.projects.PROJ.repos — a repository belongs to one list",
  ]);
  assert.deepEqual(trackerProblems(part({ extended_repos: 'github:acme/x' }), 'task-tracking.jira'), ['task-tracking.jira.projects.PROJ.extended_repos: must be a list']);
});

test('epic_roles and epic_projects: well formed passes; every problem is named with its path', () => {
  const part = (project) => ({ projects: { PROJ: project } });
  assert.deepEqual(trackerProblems(part({ epic_roles: { fixes: 'PROJ-10', 'tech-debt': 'proj-12' }, epic_projects: ['PLAN', 'docs'] }), 'task-tracking.jira'), []);
  assert.deepEqual(trackerProblems(part({
    epic_roles: { Fixes: 'PROJ-10', features: 'PLAN-11', support: 12, docs: 'PROJ' },
    epic_projects: ['PLAN', 'proj', 'PLAN-5', 7],
  }), 'task-tracking.jira'), [
    "task-tracking.jira.projects.PROJ.epic_roles.Fixes: 'Fixes' is not a lowercase role name",
    "task-tracking.jira.projects.PROJ.epic_roles.features: 'PLAN-11' is not an epic of PROJ — a role epic is the project's own; another project's epics come through epic_projects",
    'task-tracking.jira.projects.PROJ.epic_roles.support: 12 is not an issue key like PROJ-10',
    "task-tracking.jira.projects.PROJ.epic_roles.docs: 'PROJ' is not an issue key like PROJ-10",
    "task-tracking.jira.projects.PROJ.epic_projects[1]: 'proj' is the project itself — its own open epics are candidates already",
    "task-tracking.jira.projects.PROJ.epic_projects[2]: 'PLAN-5' is not a project key like PLAN",
    'task-tracking.jira.projects.PROJ.epic_projects[3]: 7 is not a project key like PLAN',
  ]);
  assert.deepEqual(trackerProblems(part({ epic_roles: ['PROJ-10'], epic_projects: 'PLAN' }), 'task-tracking.jira'), [
    'task-tracking.jira.projects.PROJ.epic_roles: must be a mapping of a role name to an epic of the project (fixes: PROJ-10)',
    'task-tracking.jira.projects.PROJ.epic_projects: must be a list',
  ]);
  assert.deepEqual(trackerProblems(part({ epic_projects: ['PLAN', 'docs', ' plan '] }), 'task-tracking.jira'), [
    "task-tracking.jira.projects.PROJ.epic_projects[2]: ' plan ' is listed already at [0] — its open epics would be read twice",
  ], 'a project listed twice, case and blanks aside');
});

test('number_patterns: one {n} and other text, in defaults or per project', () => {
  const patterns = (list) => ({ defaults: { number_patterns: list } });
  assert.deepEqual(trackerProblems(patterns(['FIX[{n}]', 'fix/{n}']), 'task-tracking.jira'), []);
  assert.deepEqual(trackerProblems(patterns(['FIX[{n}]-{n}', 'FIX', '{n}', ' {n} ', 'FIX[{N}]']), 'task-tracking.jira'), [
    "task-tracking.jira.defaults.number_patterns[0]: 'FIX[{n}]-{n}' must hold {n} exactly once",
    "task-tracking.jira.defaults.number_patterns[1]: 'FIX' must hold {n} exactly once",
    "task-tracking.jira.defaults.number_patterns[2]: '{n}' needs literal text beside {n} — a bare number is not matched",
    "task-tracking.jira.defaults.number_patterns[3]: ' {n} ' needs literal text beside {n} — a bare number is not matched",
    "task-tracking.jira.defaults.number_patterns[4]: 'FIX[{N}]' must hold {n} exactly once",
  ]);
  assert.deepEqual(trackerProblems({ projects: { PROJ: { number_patterns: 'FIX[{n}]' } } }, 'task-tracking.jira'),
    ['task-tracking.jira.projects.PROJ.number_patterns: must be a list']);
});

test('number_repos: in one of the two lists, a pattern in reach, one project per repository', () => {
  const web = 'github:acme/web-ui';
  const ok = {
    defaults: { number_patterns: ['FIX[{n}]'] },
    projects: { PROJ: { repos: [web], number_repos: [web] }, PLAN: { extended_repos: ['github:acme/plan'], number_repos: ['github:acme/plan'], number_patterns: ['PL{n}'] } },
  };
  assert.deepEqual(trackerProblems(ok, 'task-tracking.jira'), []);
  assert.deepEqual(trackerProblems({
    projects: {
      PROJ: { repos: [web], number_repos: [web, 'github:acme/api', 'acme/x'] },
      PLAN: { repos: ['github:Acme/Web-UI'], number_repos: ['github:Acme/Web-UI'], number_patterns: [] },
      DOCS: { repos: [web], number_repos: [web], number_patterns: ['D{n}'] },
    },
  }, 'task-tracking.jira'), [
    "task-tracking.jira.projects.PROJ.number_repos[2]: 'acme/x' is not <host>:<owner>/<name> with host github or gitlab",
    "task-tracking.jira.projects.PROJ.number_repos[1]: 'github:acme/api' is in neither task-tracking.jira.projects.PROJ.repos nor task-tracking.jira.projects.PROJ.extended_repos — those say when it is searched",
    'task-tracking.jira.projects.PROJ.number_repos: no number pattern in reach — set task-tracking.jira.projects.PROJ.number_patterns or defaults.number_patterns',
    'task-tracking.jira.projects.PLAN.number_repos: no number pattern in reach — set task-tracking.jira.projects.PLAN.number_patterns',
    "task-tracking.jira.projects.PLAN.number_repos[0]: 'github:Acme/Web-UI' is also in task-tracking.jira.projects.PROJ.number_repos — a repository's bare numbers belong to one project",
    "task-tracking.jira.projects.DOCS.number_repos[0]: 'github:acme/web-ui' is also in task-tracking.jira.projects.PROJ.number_repos — a repository's bare numbers belong to one project",
  ]);
  // Uniqueness is per connector: Jira and github-issues may bind the same repository.
  assert.deepEqual(taskTrackingProblems({ jira: ok, 'github-issues': ok }), []);
});

test('numberPatterns and numberOwner: a project\'s list replaces the defaults\'; who holds a repository\'s numbers', () => {
  const part = {
    defaults: { number_patterns: ['FIX[{n}]', '{n}'] },
    projects: { PROJ: { number_repos: ['github:acme/web'] }, PLAN: { number_patterns: [' PL{n} '] }, DOCS: { number_patterns: [] } },
  };
  assert.deepEqual(numberPatterns(part, part.projects.PROJ), ['FIX[{n}]'], 'the defaults, well-formed ones only');
  assert.deepEqual(numberPatterns(part, part.projects.PLAN), ['PL{n}']);
  assert.deepEqual(numberPatterns(part, part.projects.DOCS), [], 'an empty list of its own replaces the defaults too');
  assert.deepEqual(numberPatterns({}, null), []);
  assert.equal(numberOwner(part, 'GitHub:ACME/web'), 'PROJ');
  assert.equal(numberOwner(part, 'github:acme/web', 'proj'), null);
  assert.equal(numberOwner(part, 'github:acme/other'), null);
});

test('the first matching rule wins', () => {
  const r = resolveTransition(PART, 'PROJ', 'Review', 'Done');
  assert.equal(r.mode, 'confirm');
  assert.equal(r.rule.requires, 'A result is linked.');
  assert.equal(r.origin, 'defaults.transitions[1]');
  assert.equal(r.project.results, 'PRs.');
});

test('"*" covers any status', () => {
  const r = resolveTransition(PART, 'PROJ', 'Some Odd Status', 'Closed');
  assert.equal(r.mode, 'confirm');
  assert.equal(r.origin, 'defaults.transitions[3]');
});

test('statuses compare case-insensitively by trimmed name', () => {
  const r = resolveTransition(PART, 'PROJ', '  in progress', 'REVIEW ');
  assert.equal(r.mode, 'agent');
  assert.equal(r.origin, 'defaults.transitions[0]');
});

test("a project's own transitions replace the defaults wholesale", () => {
  const done = resolveTransition(PART, 'DOCS', 'Review', 'Done');
  assert.equal(done.mode, 'agent');
  assert.equal(done.origin, 'projects.DOCS.transitions[0]');
  // The defaults' agent rule does not reach DOCS: no rule of its own covers the move.
  const early = resolveTransition(PART, 'docs', 'To Do', 'In Progress');
  assert.deepEqual({ mode: early.mode, rule: early.rule, origin: early.origin }, { mode: 'confirm', rule: null, origin: 'defaults.default' });
  assert.equal(early.project.results, 'A wiki page.');
});

test('a move no rule covers takes defaults.default, else person; an unlisted project has none', () => {
  assert.equal(resolveTransition(PART, 'PROJ', 'Test', 'Done').mode, 'confirm');
  const bare = { defaults: { transitions: PART.defaults.transitions } };
  const r = resolveTransition(bare, 'OTHER', 'Test', 'Done');
  assert.deepEqual(r, { mode: 'person', rule: null, project: null, origin: 'defaults.default' });
  assert.equal(resolveTransition({}, 'PROJ', 'To Do', 'In Progress').mode, 'person');
});

test("config() exposes task-tracking and lists its problems with oikos.yaml's paths", () => {
  const dir = installation((t) => `${t}\ntask-tracking:\n  jira:\n    defaults:\n      transitions:\n        - { from: Review, to: Done, mode: auto }\n`);
  const r = script(dir, `import { config } from './oikos/tools/common/config.mjs';
    const c = config(); console.log(JSON.stringify({ part: c['task-tracking'], problems: c.problems }));`);
  assert.equal(r.status, 0, r.output);
  const { part, problems } = JSON.parse(r.stdout);
  assert.equal(part.jira.defaults.transitions[0].mode, 'auto');
  assert.deepEqual(problems, ["oikos.yaml: task-tracking.jira.defaults.transitions[0].mode: 'auto' is not one of agent, confirm, person"]);
});
