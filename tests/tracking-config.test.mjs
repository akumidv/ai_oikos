// The editor of one tracker project in oikos.yaml (tools/common/tracking-config.mjs, ADR 0001 D05,
// D07): lists grow (flow and block), prose is replaced, a missing block is created at every level,
// and every byte outside the touched nodes stays — comments, key order, other parts. A pattern or a
// malformed repository is refused; an edit that would leave task-tracking with problems is refused.
// In-process, pure; the atomic write goes to a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { editTrackerProject, poolRepoArgs, trackerProjectText, writeFileAtomic } from '../tools/common/tracking-config.mjs';
import { tempDir } from './helpers/installation.mjs';

const TOOL = 'node oikos/tools/jira/cli.mjs';

const FILE = `# ACME Corp
organization: { name: ACME Corp }   # flow map, padded

task-tracking:
  jira:
    defaults:
      default: person
      transitions:
        - { from: [To Do], to: [Review], mode: agent }
    projects:
      PROJ:
        key_aliases: [PJ]   # PJ-123 is PROJ-123
        repos:
          - github:acme/web-ui   # the UI
          - gitlab:acme/backend
        # the result lives in pull requests
        results: >
          Pull requests; UI changes also
          as screenshots.
      DOCS: { results: A wiki page. }

settings:
  JIRA_BASE_URL: https://acme.atlassian.net
`;

/** `after` is `before` with exactly `inserted` put in at one place. */
function onlyInserted(before, after, inserted) {
  assert.equal(after.length, before.length + inserted.length);
  let at = after.indexOf(inserted);
  while (at >= 0 && `${after.slice(0, at)}${after.slice(at + inserted.length)}` !== before) at = after.indexOf(inserted, at + 1);
  assert.ok(at >= 0, `only ${JSON.stringify(inserted)} was inserted`);
}

test('a block list grows by a line; the file is otherwise byte-identical', () => {
  const r = editTrackerProject(FILE, 'jira', 'PROJ', { repos: ['github:acme/api'] });
  assert.deepEqual(r.added.repos, ['github:acme/api']);
  assert.ok(r.changed);
  onlyInserted(FILE, r.text, '\n          - github:acme/api');
  assert.match(r.text, /- gitlab:acme\/backend\n {10}- github:acme\/api\n {8}# the result lives in pull requests/);
});

test('a flow list takes the new entry inside its brackets, keeping its comment', () => {
  const r = editTrackerProject(FILE, 'jira', 'proj', { key_aliases: ['PX'] });
  assert.equal(r.key, 'PROJ', 'an existing key matches case-insensitively');
  onlyInserted(FILE, r.text, ', PX');
  assert.match(r.text, /key_aliases: \[PJ, PX\] {3}# PJ-123 is PROJ-123/);
  const padded = FILE.replace('repos:\n          - github:acme/web-ui   # the UI\n          - gitlab:acme/backend', 'repos: [ github:acme/web-ui ]');
  assert.match(editTrackerProject(padded, 'jira', 'PROJ', { repos: ['github:acme/api'] }).text, /repos: \[ github:acme\/web-ui, github:acme\/api \]/);
  const empty = FILE.replace('key_aliases: [PJ]', 'key_aliases: []');
  assert.match(editTrackerProject(empty, 'jira', 'PROJ', { key_aliases: ['PJ'] }).text, /key_aliases: \[PJ\] {3}#/);
});

test('values already there (any case) or given twice are not added again', () => {
  const r = editTrackerProject(FILE, 'jira', 'PROJ', { repos: ['GitHub:ACME/web-ui', 'github:acme/api', 'github:acme/api'], key_aliases: ['pj'] });
  const lists = ({ key_aliases: aliases, repos, extended_repos: extended }) => ({ key_aliases: aliases, repos, extended_repos: extended });
  assert.deepEqual(lists(r.added), { key_aliases: [], repos: ['github:acme/api'], extended_repos: [] });
  assert.deepEqual(lists(r.present), { key_aliases: ['pj'], repos: ['GitHub:ACME/web-ui'], extended_repos: [] });
  const none = editTrackerProject(FILE, 'jira', 'PROJ', { repos: ['github:acme/web-ui'] });
  assert.equal(none.changed, false);
  assert.equal(none.text, FILE);
});

test('prose is replaced in place; a missing key is added after the last one', () => {
  const r = editTrackerProject(FILE, 'jira', 'PROJ', { results: 'Pull requests.', epics: 'One epic per area: UI, API.' });
  assert.deepEqual(r.replaced, ['results', 'epics']);
  assert.match(r.text, /# the result lives in pull requests\n {8}results: Pull requests\.\n {8}epics: "One epic per area: UI, API\."\n {6}DOCS:/);
  assert.equal(YAML.parse(r.text)['task-tracking'].jira.projects.PROJ.repos.length, 2);
  const flow = editTrackerProject(FILE, 'jira', 'DOCS', { results: 'A report.', repos: ['github:acme/docs'] });
  assert.match(flow.text, /DOCS: \{ results: A report\., repos: \[github:acme\/docs\] \}/);
});

test('a missing project, projects part, connector or task-tracking part is created', () => {
  const change = { key_aliases: ['NP'], repos: ['github:acme/new'], results: 'PRs.' };
  const block = '      NEW:\n        key_aliases: [NP]\n        repos: [github:acme/new]\n        results: PRs.';
  const project = editTrackerProject(FILE, 'jira', 'new', change);
  onlyInserted(FILE, project.text, `\n${block}`);
  assert.equal(trackerProjectText(project.text, 'jira', 'NEW'), block);

  const noPart = '# ACME Corp\norganization: { name: ACME Corp }\n# the end\n';
  const created = editTrackerProject(noPart, 'jira', 'PROJ', { repos: ['github:acme/web'] });
  assert.equal(created.text, `${noPart}task-tracking:\n  jira:\n    projects:\n      PROJ:\n        repos: [github:acme/web]\n`);

  const nullParts = 'task-tracking:   # set up below\n  jira:\n    projects: ~\nother: 1\n';
  const filled = editTrackerProject(nullParts, 'jira', 'PROJ', { repos: ['github:acme/web'] });
  assert.equal(filled.text, 'task-tracking:   # set up below\n  jira:\n    projects:\n      PROJ:\n        repos: [github:acme/web]\nother: 1\n');

  const noConnector = 'task-tracking:\n  github-issues:\n    defaults: { default: person }\n';
  assert.deepEqual(YAML.parse(editTrackerProject(noConnector, 'jira', 'PROJ', { repos: ['github:acme/web'] }).text)['task-tracking'],
    { 'github-issues': { defaults: { default: 'person' } }, jira: { projects: { PROJ: { repos: ['github:acme/web'] } } } });
  assert.equal(editTrackerProject('', 'jira', 'PROJ', { repos: ['github:acme/web'] }).text,
    'task-tracking:\n  jira:\n    projects:\n      PROJ:\n        repos: [github:acme/web]\n');
});

test('an edit that would leave task-tracking with problems is refused, naming them', () => {
  const broken = FILE.replace('mode: agent', 'mode: sometimes');
  assert.throws(() => editTrackerProject(broken, 'jira', 'PROJ', { repos: ['github:acme/api'] }),
    /nothing written — task-tracking would have problems: task-tracking\.jira\.defaults\.transitions\[0\]\.mode: 'sometimes' is not one of agent, confirm, person/);
  assert.throws(() => editTrackerProject('a: [', 'jira', 'PROJ', { repos: ['github:acme/api'] }), /oikos\.yaml does not parse/);
  assert.throws(() => editTrackerProject(FILE.replace('DOCS: { results: A wiki page. }', 'DOCS: just text'), 'jira', 'DOCS', { repos: ['github:acme/x'] }),
    /task-tracking\.jira\.projects\.DOCS must be a mapping/);
});

test('extended_repos grows like repos: a new key after the last one, then appended to', () => {
  const r = editTrackerProject(FILE, 'jira', 'PROJ', { extended_repos: ['github:acme/legacy'] });
  assert.deepEqual(r.added.extended_repos, ['github:acme/legacy']);
  assert.deepEqual(YAML.parse(r.text)['task-tracking'].jira.projects.PROJ.extended_repos, ['github:acme/legacy']);
  assert.match(r.text, /as screenshots\.\n {8}extended_repos: \[github:acme\/legacy\]\n {6}DOCS:/);
  const again = editTrackerProject(r.text, 'jira', 'PROJ', { extended_repos: ['gitlab:acme/old', 'GitHub:ACME/legacy'] });
  assert.deepEqual([again.added.extended_repos, again.present.extended_repos], [['gitlab:acme/old'], ['GitHub:ACME/legacy']]);
  assert.match(again.text, /extended_repos: \[github:acme\/legacy, gitlab:acme\/old\]/);
  assert.equal(editTrackerProject('', 'jira', 'PROJ', { repos: ['github:acme/web'], extended_repos: ['github:acme/legacy'] }).text,
    'task-tracking:\n  jira:\n    projects:\n      PROJ:\n        repos: [github:acme/web]\n        extended_repos: [github:acme/legacy]\n');
});

test('a repository the other list holds, or given for both, is refused, naming the list; nothing is moved', () => {
  const withSet = editTrackerProject(FILE, 'jira', 'PROJ', { extended_repos: ['github:acme/legacy'] }).text;
  assert.throws(() => editTrackerProject(withSet, 'jira', 'PROJ', { repos: ['GitHub:acme/LEGACY'] }),
    /'GitHub:acme\/LEGACY' is already in task-tracking\.jira\.projects\.PROJ\.extended_repos — a repository belongs to one list, so it is not added to repos\. Moving a repository between the lists is not done here: edit oikos\.yaml by hand\./);
  assert.throws(() => editTrackerProject(FILE, 'jira', 'PROJ', { extended_repos: ['gitlab:acme/backend'] }),
    /'gitlab:acme\/backend' is already in task-tracking\.jira\.projects\.PROJ\.repos — .* not added to extended_repos/);
  assert.throws(() => editTrackerProject(FILE, 'jira', 'PROJ', { repos: ['github:acme/x'], extended_repos: ['github:acme/x'] }),
    /'github:acme\/x' is given for repos too — a repository belongs to one list/);
});

test('number_repos, number_patterns, epic_projects grow as lists; epic_roles grows by new roles, flow or block', () => {
  const r = editTrackerProject(FILE, 'jira', 'PROJ', {
    number_repos: ['github:acme/web-ui'], number_patterns: ['FIX[{n}]'], epic_projects: ['PLAN'], epic_roles: { fixes: 'PROJ-10', features: 'PROJ-11' },
  });
  assert.match(r.text, /as screenshots\.\n {8}number_repos: \[github:acme\/web-ui\]\n {8}number_patterns: \["FIX\[\{n\}\]"\]\n {8}epic_projects: \[PLAN\]\n {8}epic_roles:\n {10}fixes: PROJ-10\n {10}features: PROJ-11\n {6}DOCS:/);
  assert.deepEqual(r.added.epic_roles, ['fixes: PROJ-10', 'features: PROJ-11']);
  const again = editTrackerProject(r.text, 'jira', 'PROJ', { epic_roles: { fixes: 'proj-10', support: 'PROJ-12' }, number_patterns: ['fix[{n}]', 'FEAT[{n}]'] });
  assert.deepEqual([again.added.epic_roles, again.present.epic_roles], [['support: PROJ-12'], ['fixes: PROJ-10']]);
  assert.deepEqual(again.added.number_patterns, ['FEAT[{n}]'], 'a pattern compares case-insensitively, as it matches');
  assert.match(again.text, /features: PROJ-11\n {10}support: PROJ-12\n {6}DOCS:/);
  const flow = FILE.replace('key_aliases: [PJ]   # PJ-123 is PROJ-123', 'key_aliases: [PJ]   # PJ-123 is PROJ-123\n        epic_roles: { fixes: PROJ-10 }   # general epics');
  assert.match(editTrackerProject(flow, 'jira', 'PROJ', { epic_roles: { support: 'PROJ-12' } }).text, /epic_roles: \{ fixes: PROJ-10, support: PROJ-12 \} {3}# general epics/);
  assert.throws(() => editTrackerProject(r.text, 'jira', 'PROJ', { epic_roles: { fixes: 'PROJ-13' } }),
    /epic_roles\.fixes is PROJ-10 already, not PROJ-13 — an edit here only adds; change it in oikos\.yaml by hand\./);
  assert.throws(() => editTrackerProject(FILE, 'jira', 'PROJ', { epic_roles: { fixes: 'PLAN-10' } }), /nothing written — .*'PLAN-10' is not an epic of PROJ/);
});

test('number_repos: a repository outside both lists, one another project holds, or one with no pattern in reach is refused', () => {
  assert.throws(() => editTrackerProject(FILE, 'jira', 'PROJ', { number_repos: ['github:acme/api'], number_patterns: ['FIX[{n}]'] }),
    /'github:acme\/api' is in neither task-tracking\.jira\.projects\.PROJ\.repos nor task-tracking\.jira\.projects\.PROJ\.extended_repos — add it to one of them first \(repos add PROJ github:acme\/api/);
  const held = editTrackerProject(FILE, 'jira', 'DOCS', { repos: ['github:acme/web-ui'], number_repos: ['github:acme/web-ui'], number_patterns: ['D{n}'] }).text;
  assert.throws(() => editTrackerProject(held, 'jira', 'PROJ', { number_repos: ['github:acme/web-ui'], number_patterns: ['FIX[{n}]'] }),
    /'github:acme\/web-ui' carries the bare numbers of DOCS \(task-tracking\.jira\.projects\.DOCS\.number_repos\) — a repository's numbers belong to one project/);
  assert.throws(() => editTrackerProject(FILE, 'jira', 'PROJ', { number_repos: ['github:acme/web-ui'] }), /no number pattern in reach/);
});

test('poolRepoArgs: explicit names pass, a pattern or a malformed name is refused', () => {
  assert.deepEqual(poolRepoArgs([' github:acme/web ', 'gitlab:acme/group/api'], TOOL), ['github:acme/web', 'gitlab:acme/group/api']);
  assert.throws(() => poolRepoArgs(['github:acme/d3-*'], TOOL), /is a pattern: the pool stores explicit names only\. A pattern is a search aid of `node oikos\/tools\/jira\/cli\.mjs project-init <KEY> --pattern <glob> --dry-run`/);
  assert.throws(() => poolRepoArgs(['acme/web'], TOOL), /'acme\/web' is not <host>:<owner>\/<name>/);
  assert.throws(() => poolRepoArgs(['bitbucket:acme/web'], TOOL), /is not <host>:<owner>\/<name> with host github or gitlab/);
});

test('writeFileAtomic replaces the file and leaves no temporary file', () => {
  const dir = tempDir('atomic-');
  const file = join(dir, 'oikos.yaml');
  writeFileAtomic('a: 1\n', file);
  writeFileAtomic('a: 2\n', file);
  assert.equal(readFileSync(file, 'utf8'), 'a: 2\n');
  assert.deepEqual(readdirSync(dir), ['oikos.yaml']);
});
