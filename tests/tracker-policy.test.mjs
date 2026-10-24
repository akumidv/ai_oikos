// The organization's tracker policy beside the installation's rules (ADR 0004): `policy.person_only`
// and `policy.source` validated at load; a project's policy adds to the defaults'; a move into or out
// of a person-only status is a person's whatever its rule says (`confirm` included) — the conflicts
// listed by `project-init --dry-run` (`## Policy`) and as warnings by `sync --check`, a conflicting
// move refused (`refused: policy:`, exit 3) and a batch listing it among those that will not move.
// No policy → behaviour unchanged. The shipped example teaches no conflict. Pure functions run
// in-process; the tools run in a copy of examples/installation against canned answers — nothing is
// posted for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  effectiveMode, effectivePolicy, policyConflict, policyConflicts, resolveTransition, taskTrackingConflicts, trackerProblems,
} from '../tools/common/transitions.mjs';
import { policyLines } from '../tools/common/project-setup.mjs';
import { editTrackerProject } from '../tools/common/tracking-config.mjs';
import { FIXTURE, installation, tool, withFakeFetch } from './helpers/installation.mjs';

const SOURCE = 'https://kb.example.com/tracker-rules';
const RULES = [
  { from: ['To Do', 'In Progress', 'Blocked'], to: ['To Do', 'In Progress', 'Blocked', 'Review'], mode: 'agent' },
  { from: 'Review', to: ['Test', 'Done'], mode: 'confirm', requires: 'A result is linked.' },
  { from: '*', to: 'Closed', mode: 'confirm', requires: 'A reason.' },
];
const PART = {
  defaults: { transitions: RULES, policy: { person_only: ['Review'], source: SOURCE } },
  projects: {
    PROJ: { policy: { person_only: ['acceptance', 'REVIEW'] } },
    DOCS: { results: 'A wiki page.' },
  },
};
const moves = (conflicts) => conflicts.map((c) => `${c.from} → ${c.to} by ${c.origin}`);

// == the part and its union ==

test('policy: a well-formed part has no problems; a malformed one names each path', () => {
  assert.deepEqual(trackerProblems(PART, 'task-tracking.jira'), []);
  const bad = {
    defaults: { policy: { person_only: 'Review', source: 3, owner: 'x' } },
    projects: { PROJ: { policy: { person_only: ['*', '', 'Review'] } }, DOCS: { policy: [] } },
  };
  assert.deepEqual(trackerProblems(bad, 'task-tracking.jira'), [
    'task-tracking.jira.defaults.policy.owner: unknown key (expected person_only, source)',
    'task-tracking.jira.defaults.policy.person_only: must be a list of status names, e.g. [Review]',
    'task-tracking.jira.defaults.policy.source: must be text — the knowledge-base page the policy comes from',
    'task-tracking.jira.projects.PROJ.policy.person_only[0]: "*" is not a status — name each person-only status',
    "task-tracking.jira.projects.PROJ.policy.person_only[1]: '' is not a status name",
    'task-tracking.jira.projects.DOCS.policy: must be a mapping with person_only and source',
  ]);
});

test("policy: a project's policy adds to the defaults' — a union, each status once, with the paths naming it", () => {
  assert.deepEqual(effectivePolicy(PART, 'proj'), {
    personOnly: [
      { status: 'Review', origins: ['defaults.policy', 'projects.PROJ.policy'] },
      { status: 'acceptance', origins: ['projects.PROJ.policy'] },
    ],
    sources: [{ origin: 'defaults.policy', source: SOURCE }],
  });
  assert.deepEqual(effectivePolicy(PART, 'DOCS').personOnly.map((p) => p.status), ['Review'], 'a project without its own keeps the defaults\'');
  assert.deepEqual(effectivePolicy(PART, null).personOnly.map((p) => p.status), ['Review']);
  assert.deepEqual(effectivePolicy({ defaults: { transitions: RULES } }, 'PROJ'), { personOnly: [], sources: [] });
});

// == the conflicts ==

test('policy: a move into or out of a person-only status is a person\'s, an agent and a confirm rule alike', () => {
  const into = policyConflict(PART, 'PROJ', 'In Progress', 'review');
  assert.equal(into.mode, 'agent');
  assert.equal(into.origin, 'defaults.transitions[0]');
  const out = policyConflict(PART, 'PROJ', 'Review', 'Done');
  assert.equal(out.mode, 'confirm', 'confirm does not satisfy person_only');
  assert.equal(effectiveMode(PART, 'PROJ', 'Review', 'Done'), 'person');
  assert.equal(effectiveMode(PART, 'PROJ', 'To Do', 'In Progress'), 'agent', 'a move outside the policy keeps its rule');
  assert.equal(policyConflict(PART, 'PROJ', 'Test', 'Review'), null, 'a person move conflicts with nothing');
});

test('policy: a "*" rule and defaults.default are caught, with or without the workflow\'s statuses', () => {
  const byDefault = { ...PART, defaults: { ...PART.defaults, default: 'agent' } };
  const derived = moves(policyConflicts(byDefault, 'PROJ'));
  assert.ok(derived.includes('Review → Closed by defaults.transitions[2]'), derived.join('\n'));
  assert.ok(derived.includes('acceptance → Closed by defaults.transitions[2]'), 'the project\'s own person-only status too');
  assert.ok(derived.includes('* → Review by defaults.default'), 'any other status into Review takes the default');
  assert.ok(derived.includes('Review → Test by defaults.transitions[1]'));
  assert.ok(!derived.some((m) => m.startsWith('To Do → In Progress')), 'a move outside the policy is no conflict');

  const workflow = moves(policyConflicts(byDefault, 'DOCS', ['To Do', 'Review', 'Fixing', 'Closed']));
  assert.deepEqual(workflow, [
    'To Do → Review by defaults.transitions[0]', 'Review → To Do by defaults.default', 'Review → Fixing by defaults.default',
    'Review → Closed by defaults.transitions[2]', 'Fixing → Review by defaults.default', 'Closed → Review by defaults.default',
  ]);
});

test('policy: no policy → no conflict, and every mode is the rule\'s', () => {
  const plain = { defaults: { transitions: RULES }, projects: { PROJ: {} } };
  assert.deepEqual(policyConflicts(plain, 'PROJ'), []);
  assert.deepEqual(taskTrackingConflicts({ jira: plain }), []);
  for (const [from, to] of [['In Progress', 'Review'], ['Review', 'Done'], ['Review', 'Closed'], ['Test', 'Done']]) {
    assert.equal(effectiveMode(plain, 'PROJ', from, to), resolveTransition(plain, 'PROJ', from, to).mode);
  }
});

test('policy: sync\'s warnings name each rule once per scope, a project only for what it adds', () => {
  const warnings = taskTrackingConflicts({ jira: PART });
  assert.equal(warnings.length, 4, warnings.join('\n'));
  assert.match(warnings[0], /^task-tracking\.jira\.defaults\.transitions\[0\]: mode agent lets To Do → Review, In Progress → Review, Blocked → Review run, but Review is person-only by task-tracking\.jira\.defaults\.policy \(source: https:\/\/kb\.example\.com\/tracker-rules\) — such a move is refused as person/);
  assert.match(warnings[2], /^task-tracking\.jira\.defaults\.transitions\[2\]: mode confirm lets Review → Closed run/);
  assert.match(warnings[3], /^task-tracking\.jira\.defaults\.transitions\[2\] \(for PROJ\): mode confirm lets acceptance → Closed run, but acceptance is person-only by task-tracking\.jira\.projects\.PROJ\.policy/);
  assert.deepEqual(taskTrackingConflicts({ jira: { defaults: { policy: { person_only: 'Review' } } } }), [], 'a part with problems is left to them');
});

test('policy: the ## Policy lines give each conflicting rule its path, moves and fix', () => {
  const part = { ...PART, defaults: { ...PART.defaults, default: 'agent' } };
  const lines = policyLines(policyConflicts(part, 'DOCS', ['To Do', 'Review', 'Closed']), effectivePolicy(part, 'DOCS'),
    { configPath: 'task-tracking.jira', projectKey: 'DOCS', workflow: true }).join('\n');
  assert.match(lines, /^## Policy\n {2}Person-only: Review \(defaults\.policy\) — only a person moves a task into or out of them\n {2}Source: https:\/\/kb\.example\.com\/tracker-rules \(defaults\.policy\)/);
  assert.match(lines, /^ {2}task-tracking\.jira\.defaults\.transitions\[0\]: To Do, In Progress, Blocked → To Do, In Progress, Blocked, Review, agent\n {6}To Do → Review\n {6}fix: take Review out of its to — or put \{ from: "\*", to: Review, mode: person \} before it$/m);
  assert.match(lines, /^ {2}task-tracking\.jira\.defaults\.transitions\[2\]: \* → Closed, confirm\n {6}Review → Closed\n {6}fix: put \{ from: Review, to: "\*", mode: person \} before it$/m);
  assert.match(lines, /^ {2}task-tracking\.jira\.defaults\.default \(agent\)\n {6}Review → To Do, Closed → Review\n {6}fix: set defaults\.default to person — or put \{ from: Review, to: "\*", mode: person \} into the rules\n {6}fix: set defaults\.default to person — or put \{ from: "\*", to: Review, mode: person \} into the rules$/m);
  const none = policyLines([], { personOnly: [], sources: [] }, { configPath: 'task-tracking.jira', projectKey: 'DOCS', workflow: true });
  assert.deepEqual(none, ['## Policy', '  No policy in task-tracking.jira (defaults.policy, projects.DOCS.policy): the rules alone decide who moves.']);
});

test('policy: project-init\'s edit grows person_only and replaces source, keeping the file\'s layout', () => {
  const file = 'task-tracking:\n  jira:\n    projects:\n      PROJ:\n        results: PRs.   # where\n';
  const first = editTrackerProject(file, 'jira', 'PROJ', { policy: { person_only: ['Review'], source: SOURCE } });
  assert.equal(first.text, `${file}        policy:\n          person_only: [Review]\n          source: ${SOURCE}\n`);
  const again = editTrackerProject(first.text, 'jira', 'PROJ', { policy: { person_only: ['review', 'Acceptance'], source: 'https://kb.example.com/v2' } });
  assert.match(again.text, /person_only: \[Review, Acceptance\]\n {10}source: https:\/\/kb\.example\.com\/v2\n$/);
  assert.deepEqual([again.added.policy, again.present.policy, again.replaced], [['Acceptance'], ['review'], ['policy.source']]);
  assert.throws(() => editTrackerProject(file, 'jira', 'PROJ', { policy: { person_only: ['*'] } }), /nothing written — .*"\*" is not a status/);
});

// == the shipped example ==

/** The example's commented `task-tracking` block, uncommented once (its own comments stay comments). */
function exampleTracking() {
  const text = readFileSync(join(FIXTURE, 'oikos.yaml'), 'utf8');
  const block = text.slice(text.indexOf('# task-tracking:')).split('\n').filter((l) => l.startsWith('#'));
  return YAML.parse(block.map((l) => l.replace(/^# ?/, '')).join('\n'))['task-tracking'];
}

test('policy: the shipped example has no conflict — and the policy it shows turns exactly its Review rules to person', () => {
  const part = exampleTracking();
  assert.deepEqual(trackerProblems(part.jira, 'task-tracking.jira'), []);
  assert.equal(effectiveMode(part.jira, 'PROJ', 'In Progress', 'Blocked'), 'agent', 'the agent moves among the working statuses');
  assert.equal(effectiveMode(part.jira, 'PROJ', 'In Progress', 'Review'), 'confirm', 'into Review is confirm');
  assert.deepEqual(taskTrackingConflicts(part), [], 'no policy set: nothing conflicts');

  // The commented policy, set: every rule into or out of Review conflicts, "*" → Closed included.
  const withPolicy = { ...part.jira, defaults: { ...part.jira.defaults, policy: { person_only: ['Review'], source: SOURCE } } };
  assert.deepEqual([...new Set(policyConflicts(withPolicy, 'PROJ').map((c) => c.origin))],
    ['defaults.transitions[1]', 'defaults.transitions[2]', 'defaults.transitions[3]']);
  // As the comment says: the Review rules as person, a person rule for Review before "*" → Closed.
  const [working, , , close] = part.jira.defaults.transitions;
  const fixed = { ...withPolicy, defaults: { ...withPolicy.defaults, transitions: [
    working, { from: 'In Progress', to: 'Review', mode: 'person' }, { from: 'Review', to: '*', mode: 'person' }, close,
  ] } };
  assert.deepEqual(taskTrackingConflicts({ jira: fixed }), []);
});

// == the tools ==

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
const POLICY_RULES = `
task-tracking:
  jira:
    defaults:
      transitions:
        - { from: [To Do, In Progress], to: [To Do, In Progress, Review], mode: agent }
        - { from: Review, to: Done, mode: confirm, requires: A result is linked. }
      policy: { person_only: [Review], source: ${SOURCE} }
    projects:
      PROJ:
        results: Pull requests.
        policy: { person_only: [Acceptance] }
`;
const withPolicy = (t) => `${t}${POLICY_RULES}`;

function issueRoutes(key, status) {
  return [
    { match: `^${API}/issue/${key}\\?fields=`, body: { id: '1', key, fields: { summary: `Task ${key}`, status: { name: status }, issuetype: { name: 'Story' }, description: null, attachment: [] } } },
    { url: `${API}/issue/${key}/transitions`, body: { transitions: [{ id: '21', to: { name: 'In Progress' } }, { id: '31', to: { name: 'Review' } }, { id: '41', to: { name: 'Done' } }] } },
  ];
}

function run(dir, routes, args) {
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...CREDS, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}
const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');

test('move: an agent rule into a person-only status is refused as person — exit 3, the policy, its source, the rule, the link', () => {
  const dir = installation(withPolicy);
  for (const args of [['--dry-run'], []]) {
    const r = run(dir, [...issueRoutes('PROJ-7', 'In Progress'), { method: 'POST', url: `${API}/issue/PROJ-7/transitions`, status: 204 }],
      ['transition', '--task', 'PROJ-7', '--to', 'Review', ...args]);
    assert.equal(r.status, 3, r.output);
    assert.match(r.stderr, /^refused: policy: In Progress → Review in PROJ is a person's move — Review is person-only by task-tracking\.jira\.defaults\.policy \(source: https:\/\/kb\.example\.com\/tracker-rules\); it falls under task-tracking\.jira\.defaults\.transitions\[0\] \(agent\), which the policy overrides — move PROJ-7 to 'Review' yourself: https:\/\/acme\.atlassian\.net\/browse\/PROJ-7$/m);
    assert.deepEqual(writesOf(r.calls), [], 'nothing written, the real run included');
  }
});

test('move: a confirm rule out of a person-only status is refused too, before any evidence is read', () => {
  const dir = installation(withPolicy);
  const r = run(dir, issueRoutes('PROJ-7', 'Review'), ['transition', '--task', 'PROJ-7', '--to', 'Done', '--dry-run']);
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, /^refused: policy: Review → Done in PROJ is a person's move — .*defaults\.transitions\[1\] \(confirm\), which the policy overrides/m);
  assert.deepEqual(r.calls.map((c) => c.url).filter((u) => /changelog|comment|remotelink|dev-status/.test(u)), []);
});

test('move: no policy → the same rules move as before', () => {
  const dir = installation((t) => withPolicy(t).replace(/^ {6}policy: .*\n/m, '').replace(/^ {8}policy: .*\n/m, ''));
  const r = run(dir, issueRoutes('PROJ-7', 'In Progress'), ['transition', '--task', 'PROJ-7', '--to', 'Review', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^DRY RUN — would move PROJ-7: In Progress → Review \(transition 31; mode agent by task-tracking\.jira\.defaults\.transitions\[0\]\)$/m);
});

test('batch: a task the policy keeps back is listed among those that will not move; the real run fails it', () => {
  const dir = installation(withPolicy);
  const routes = [...issueRoutes('PROJ-7', 'In Progress'), ...issueRoutes('PROJ-8', 'To Do')];
  const review = run(dir, routes, ['transition', '--task', 'PROJ-7,PROJ-8', '--to', 'Review', '--dry-run']);
  assert.equal(review.status, 3, review.output);
  assert.match(review.stdout, /^Would move 0 of 2 tasks to Review/m);
  assert.match(review.stdout, /^Will not move \(2\):\n {2}PROJ-7: policy: In Progress → Review in PROJ is a person's move — Review is person-only .*yourself: https:\/\/acme\.atlassian\.net\/browse\/PROJ-7\n {2}PROJ-8: policy: To Do → Review/m);

  const real = run(dir, [...routes, { method: 'POST', url: `${API}/issue/PROJ-7/transitions`, status: 204 }], ['transition', '--task', 'PROJ-7,PROJ-8', '--to', 'Review']);
  assert.equal(real.status, 2, real.output);
  assert.match(real.stderr, /^PROJ-7: policy: In Progress → Review in PROJ is a person's move/m);
  assert.match(real.stdout, /^0\/2 moved$/m);
  assert.deepEqual(writesOf(real.calls), []);
});

const statusesRoute = {
  url: `${API}/project/PROJ/statuses`,
  body: [{ name: 'Story', statuses: [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'Review' }, { name: 'Acceptance' }, { name: 'Done' }] }],
};
const numbersRoute = { match: `^${API}/search/jql\\?jql=`, body: { issues: [] } };
const sectionOf = (out, title) => out.split(`## ${title}\n`)[1].split('\n## ')[0];

test('project-init --dry-run: ## Policy lists the conflicts among the workflow\'s statuses; --person-only adds to the proposed block', () => {
  const dir = installation(withPolicy);
  const r = run(dir, [statusesRoute, numbersRoute], ['project-init', 'PROJ', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  const policy = sectionOf(r.stdout, 'Policy');
  assert.match(policy, /^ {2}Person-only: Review \(defaults\.policy\), Acceptance \(projects\.PROJ\.policy\)/m);
  assert.match(policy, /^ {2}Checked: every move between the workflow's statuses$/m);
  assert.match(policy, /^ {2}task-tracking\.jira\.defaults\.transitions\[0\]: To Do, In Progress → To Do, In Progress, Review, agent\n {6}To Do → Review, In Progress → Review\n {6}fix: take Review out of its to/m);
  assert.match(policy, /^ {2}task-tracking\.jira\.defaults\.transitions\[1\]: Review → Done, confirm\n {6}Review → Done\n {6}fix: take Review out of its from/m);
  assert.doesNotMatch(policy, /Acceptance →|→ Acceptance/, 'moves into or out of Acceptance are no rule\'s: a person\'s already');

  const added = run(dir, [statusesRoute, numbersRoute], ['project-init', 'PROJ', '--person-only', 'Done', '--policy-source', 'https://kb.example.com/v2', '--dry-run']);
  assert.equal(added.status, 0, added.output);
  assert.match(sectionOf(added.stdout, 'Policy'), /^ {2}Person-only, with the proposed block: Review \(defaults\.policy\), Acceptance \(projects\.PROJ\.policy\), Done \(projects\.PROJ\.policy\)/m);
  assert.match(sectionOf(added.stdout, 'Proposed block'), /^ {2}policy\.person_only \+ Done\n {2}policy\.source: set$/m);
  assert.match(sectionOf(added.stdout, 'Proposed block'), /policy: \{ person_only: \[Acceptance, Done\], source: https:\/\/kb\.example\.com\/v2 \}/);
  assert.equal(run(dir, [], ['project-init', 'PROJ', '--person-only', '*', '--dry-run']).status, 1);
});

test('sync --check: a conflict is a warning, not a problem', () => {
  const dir = installation(withPolicy);
  assert.equal(tool(dir, 'sync', []).status, 0);
  const check = tool(dir, 'sync', ['--check']);
  assert.equal(check.status, 0, check.output);
  assert.match(check.stdout, /^warning: oikos\.yaml: task-tracking\.jira\.defaults\.transitions\[0\]: mode agent lets .* run, but Review is person-only/m);
  assert.doesNotMatch(check.stdout, /^problem: .*policy/m);
});
