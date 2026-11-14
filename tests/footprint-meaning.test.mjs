// The meaning of changes in the git source (ADR 0008 D04, D05 and D06, git part): a temporary
// repository with fixed author and committer dates — decision documents on two branches (one merged
// back), a rename, a deletion, Proposed and Accepted ADRs with a decided date, an ADR decided after it
// was added, a non-ADR file in docs/adr, a design document; tags, a CHANGELOG with a breaking entry,
// test functions in .py and .test.mjs files, a config file counted as other, codes and keys in a
// commit body, releasedIn, uncommitted and untracked files, the first commit. Nothing depends on the
// machine's time zone or git configuration; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitEnvironment } from '../tools/common/gitwiki.mjs';
import { collectGit, fileKind, statusOf } from '../tools/footprint/sources/git.mjs';
import { cleanEnv, tempDir } from './helpers/installation.mjs';

const GIT_ENV = gitEnvironment(null, cleanEnv());
const EMPTY_GIT_CONFIG = join(tempDir('gitconfig-'), 'config');
writeFileSync(EMPTY_GIT_CONFIG, '');
// collectGit called in-process runs git with this process's environment.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' });

const ADA = 'ada@acme.example';
const BOB = 'bob@acme.example';
const QUERY = { authors: [ADA], since: '2026-03-01', until: '2026-03-07', tz: 'UTC' };
const OPTIONS = { gitVersion: () => 'git version 2.40.0' };

/** A repository with `origin` acme/app and the history described in the file's header; returns its path and the first commit's hash. */
function meaningRepo() {
  const dir = join(tempDir('work-'), 'app');
  mkdirSync(dir, { recursive: true });
  const as = (who, email, at) => ({
    GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: at, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: at,
  });
  const git = (args, extra = {}) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...extra } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  const commit = (who, email, at, files, message = `change by ${who}`) => {
    write(files);
    git(['add', '--', ...Object.keys(files)]);
    git(['commit', '-q', '-m', message], as(who, email, at));
    return git(['rev-parse', 'HEAD']);
  };
  const tag = (name, at, target = 'HEAD') => git(['tag', '-a', name, '-m', name, target], as('Ada', ADA, at));
  git(['init', '-q', '-b', 'main']);
  git(['remote', 'add', 'origin', 'https://git.example.com/acme/app.git']);
  const first = commit('Ada', ADA, '2026-02-10T09:00:00+00:00', {
    'src/old.js': 'a\n', 'docs/adr/0001-old.md': '# ADR 1\n\n**Status:** Accepted on 2026-03-03\n',
  });
  tag('v0.9.0', '2026-02-15T09:00:00+00:00');
  commit('Ada', ADA, '2026-03-02T09:00:00+00:00', {
    'tests/test_a.py': 'def test_one():\n    pass\n\nasync def test_two():\n    pass\n\ndef helper():\n    pass\n',
    'tests/app.test.mjs': "it('does a', () => {});\ntest('does b', () => {});\n",
    'src/app.py': 'def test_not_counted():\n    pass\n',
    'config/app.yaml': 'a: 1\nb: 2\nc: 3\n',
  }, 'tests and config');
  commit('Ada', ADA, '2026-03-02T10:00:00+00:00', {
    'docs/adr/0002-queue.md': '# ADR 2\n\nStatus: Proposed\n',
    'docs/adr/README.md': '# The decisions\n',
    'docs/design/footprint.md': '# Design\n\nStatus: draft\n\nThe order is D-ORDER, as asked.\n',
  }, 'decide the queue (D-ORDER)\n\nCloses PROJ-123. See Q-C1-TOPIC too.');
  tag('v1.0.0', '2026-03-04T08:00:00+00:00');
  commit('Ada', ADA, '2026-03-02T11:00:00+00:00', {
    'docs/design/old-name.md': 'one\ntwo\nthree\nfour\nfive\n', 'docs/design/gone.md': 'g\nh\n',
  });
  git(['checkout', '-q', '-b', 'feature']);
  commit('Ada', ADA, '2026-03-03T09:00:00+00:00', { 'docs/adr/0003-feature.md': '# ADR 3\n\nStatus: Accepted (2026-03-04)\n' });
  git(['checkout', '-q', 'main']);
  git(['checkout', '-q', '-b', 'release/1']);
  commit('Bob', BOB, '2026-03-04T09:00:00+00:00', { 'docs/adr/0004-bob.md': '# ADR 4\n\nStatus: Superseded by 0005\n' });
  git(['checkout', '-q', 'main']);
  git(['mv', 'docs/design/old-name.md', 'docs/design/new-name.md']);
  commit('Ada', ADA, '2026-03-05T09:00:00+00:00', {
    'docs/design/new-name.md': 'one\ntwo\nTHREE\nfour\nfive\n',
    'CHANGELOG.md': '# Changelog\n\n## [2.0.0] - 2026-03-05\n\n### Breaking\n- removed x\n\n## [1.1.0] - 2026-03-03\n\n### Added\n- y\n\n## [1.0.0] - 2026-02-01\n',
  });
  git(['merge', '--no-ff', '-q', '-m', 'merge feature', 'feature'], as('Ada', ADA, '2026-03-05T12:00:00+00:00'));
  git(['rm', '-q', 'docs/design/gone.md']);
  git(['commit', '-q', '-m', 'drop gone'], as('Ada', ADA, '2026-03-06T09:00:00+00:00'));
  tag('v1.1.0', '2026-03-10T09:00:00+00:00');
  return { dir, first, write };
}

const run = (dir, extra = {}) => {
  const result = collectGit([dir], { ...QUERY, ...extra }, OPTIONS);
  assert.deepEqual(result.notes.filter((n) => /failed/.test(n)), [], 'no git call failed');
  return result;
};
const byKind = (result, kind) => result.events.filter((e) => e.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
const commit = (result, subject) => result.events.find((e) => e.kind === 'commit' && e.what === `acme/app: ${subject}`);

test('git meaning: config and data are the kind other, after generated and tests, before docs', () => {
  assert.deepEqual(['config/app.yaml', 'a.json', 'x.jsonc', 'x.yml', 'x.toml', 'x.ini', 'x.cfg', 'x.conf', 'x.csv', 'x.tsv', 'x.xml', 'x.properties', '.env.example',
    'src/data/seed.dat', 'fixtures/seed.bin'].map((p) => fileKind(p)), Array(15).fill('other'));
  assert.equal(fileKind('tests/fixtures/x.json'), 'tests');
  assert.equal(fileKind('package-lock.json'), 'generated');
  assert.equal(fileKind('docs/guide.md'), 'docs');
  assert.equal(fileKind('src/app.py'), 'code');
});

test('git meaning: a doc or code extension decides wherever the file lies; a file with no known extension is other', () => {
  // A data-style folder makes only files without a code or doc extension other.
  assert.deepEqual(['skills/data/SKILL.md', 'fixtures/x.md', 'src/data/notes.txt'].map((p) => fileKind(p)), ['docs', 'docs', 'docs']);
  assert.deepEqual(['src/app/data/loader.py', 'src/data/index.mjs', 'data/build.sh', 'fixtures/seed.ts'].map((p) => fileKind(p)), Array(4).fill('code'));
  assert.deepEqual(['.gitignore', 'rules/app.rules', 'Dockerfile', '.editorconfig', 'src/data/seed.dat'].map((p) => fileKind(p)), Array(5).fill('other'));
});

test('git meaning: a .yaml change is other lines, test functions added are counted in test files only, the totals and the breakdown say so', () => {
  const { dir } = meaningRepo();
  const result = run(dir);
  const config = commit(result, 'tests and config');
  assert.deepEqual(config.lines.other, [3, 0]);
  assert.deepEqual(Object.keys(config.lines), ['code', 'tests', 'docs', 'other']);
  // test_one, test_two (a .py file), it( and test( (a .test.mjs file); `def test_not_counted` is in a code file.
  assert.equal(config.detail.testsAdded, 4);
  assert.equal(commit(result, 'drop gone').detail.testsAdded, 0);
  const totals = Object.fromEntries(result.totals);
  assert.equal(totals['tests added'], 4);
  assert.equal(totals['other lines'], '+3 −0');
  assert.deepEqual(result.breakdown.header.slice(6, 10), ['Docs +', 'Docs −', 'Other +', 'Other −']);
  assert.deepEqual(result.breakdown.rows[0].slice(8, 10), [3, 0]);
});

test('git meaning: codes and task keys come from the subject and the body, the decision folders the commit touched; every commit has its hash as id', () => {
  const { dir } = meaningRepo();
  const decided = commit(run(dir), 'decide the queue (D-ORDER)');
  assert.match(decided.id, /^[0-9a-f]{40}$/);
  assert.deepEqual(decided.detail, {
    repo: 'acme/app', testsAdded: 0, codes: ['D-ORDER', 'Q-C1-TOPIC'], keys: ['PROJ-123'], decisionDirs: ['docs/adr', 'docs/design'],
    decisionPaths: ['docs/adr/0002-queue.md', 'docs/design/footprint.md'], // README.md is no ADR: not a decision document
    releasedIn: decided.detail.releasedIn,
  });
  assert.equal(commit(run(dir), 'tests and config').detail.releasedIn, undefined, 'no code, key or folder: no releasedIn');
  const own = run(dir, { codes: '\\bZZ-\\d+\\b', decisionDirs: ['docs/design'] });
  const again = commit(own, 'decide the queue (D-ORDER)');
  assert.deepEqual([again.detail.codes, again.detail.decisionDirs, again.detail.decisionPaths], [[], ['docs/design'], ['docs/design/footprint.md']]);
});

test('git meaning: releasedIn is the oldest tag containing the commit — not an older tag, not a later one', () => {
  const { dir } = meaningRepo();
  const result = run(dir);
  const decided = commit(result, 'decide the queue (D-ORDER)').detail.releasedIn;
  assert.equal(decided.tag, 'v1.0.0'); // v1.1.0 contains it too, v0.9.0 does not
  assert.match(decided.at, /^2026-03-04T08:00:00/);
  // The feature branch's commit reached main by the merge: the first tag after it is v1.1.0.
  const feature = result.events.filter((e) => e.kind === 'commit' && e.detail.decisionDirs.includes('docs/adr') && e.detail.codes.length === 0);
  assert.equal(feature.length, 1);
  assert.equal(feature[0].detail.releasedIn.tag, 'v1.1.0');
});

test('git meaning: decision documents — a path once however many branches carry it, a rename under its new name, a deletion dropped, ADR status and decided date', () => {
  const { dir } = meaningRepo();
  const result = run(dir);
  const docs = byKind(result, 'decision document');
  assert.deepEqual(docs.map((e) => e.id), [
    'doc:acme/app:docs/adr/0001-old.md', 'doc:acme/app:docs/adr/0002-queue.md', 'doc:acme/app:docs/adr/0003-feature.md', 'doc:acme/app:docs/adr/0004-bob.md',
    'doc:acme/app:docs/design/footprint.md', 'doc:acme/app:docs/design/new-name.md',
  ]);
  assert.ok(docs.every((e) => e.action === false && e.what === `acme/app: ${e.detail.path}` && e.where.endsWith('https://git.example.com/acme/app.git')));
  const detail = (path) => docs.find((e) => e.detail.path === path).detail;
  const ada = { name: 'Ada', email: ADA };
  // Added before the period, decided in it.
  assert.deepEqual(detail('docs/adr/0001-old.md'), {
    repo: 'acme/app', path: 'docs/adr/0001-old.md', dir: 'docs/adr', status: 'accepted', added: '2026-02-10', decided: '2026-03-03',
    firstAuthor: ada, byPerson: true, codes: [], words: detail('docs/adr/0001-old.md').words,
  });
  assert.match(docs[0].at, /^2026-02-10T09:00:00/);
  assert.ok(detail('docs/adr/0001-old.md').words > 0);
  // Proposed: decided is the day it was added.
  assert.deepEqual([detail('docs/adr/0002-queue.md').status, detail('docs/adr/0002-queue.md').decided], ['proposed', '2026-03-02']);
  // On a branch merged back: one path; the decided date is on its Status line.
  assert.deepEqual([detail('docs/adr/0003-feature.md').status, detail('docs/adr/0003-feature.md').decided, detail('docs/adr/0003-feature.md').added], ['accepted', '2026-03-04', '2026-03-03']);
  // On a branch not merged, by another author.
  assert.deepEqual([detail('docs/adr/0004-bob.md').status, detail('docs/adr/0004-bob.md').byPerson, detail('docs/adr/0004-bob.md').firstAuthor], ['superseded', false, { name: 'Bob', email: BOB }]);
  // A design document: draft is proposed, its text names a code.
  assert.deepEqual([detail('docs/design/footprint.md').dir, detail('docs/design/footprint.md').status, detail('docs/design/footprint.md').codes],
    ['docs/design', 'proposed', ['D-ORDER']]);
  // Renamed: counted under the new name, added when the old one was; the old name and the deleted file are not there.
  assert.equal(detail('docs/design/new-name.md').added, '2026-03-02');
  assert.ok(!docs.some((e) => /old-name|gone|README/.test(e.detail.path)));
});

test('git meaning: an ADR status is read from the line that starts with the word, never from a title that contains it', () => {
  const title = '# ADR 0012 — Tracker status transitions, proposed by the team\n\n';
  assert.deepEqual(statusOf(`${title}Status: accepted on 2026-03-04\n`), { status: 'accepted', date: '2026-03-04' });
  assert.deepEqual(statusOf(`${title}Context only, nothing decided yet.\n`), { status: 'other', date: null });
  assert.deepEqual(statusOf(`${title}**Status: superseded** by ADR 0013, 2026-03-05\n`), { status: 'superseded', date: '2026-03-05' });
  assert.deepEqual(statusOf('## Status: Draft 2026-03-01\n'), { status: 'proposed', date: '2026-03-01' });
  assert.deepEqual(statusOf('> _Status_ — Proposed\n'), { status: 'proposed', date: null });
  assert.deepEqual(statusOf('The status of this is accepted\n'), { status: 'other', date: null });
  assert.deepEqual(statusOf('Statuses: accepted\n'), { status: 'other', date: null });
});

test('git meaning: a document added and decided outside the period is no event; decision_dirs set what is read', () => {
  const { dir } = meaningRepo();
  const later = run(dir, { since: '2026-03-08', until: '2026-03-20' });
  assert.deepEqual(byKind(later, 'decision document'), []);
  const onlyDesign = run(dir, { decisionDirs: ['docs/design'] });
  assert.deepEqual(byKind(onlyDesign, 'decision document').map((e) => e.detail.path), ['docs/design/footprint.md', 'docs/design/new-name.md']);
  assert.match(onlyDesign.notes.join('\n'), /decision documents: \.md files ever under docs\/design on any branch, tag or remote-tracking branch/);
});

test('git meaning: tags created in the period are facts; those outside it are not', () => {
  const { dir } = meaningRepo();
  const tags = byKind(run(dir), 'tag');
  assert.deepEqual(tags.map((e) => e.id), ['tag:acme/app:v1.0.0']);
  assert.match(tags[0].at, /^2026-03-04T08:00:00/);
  assert.deepEqual([tags[0].action, tags[0].what, tags[0].detail], [false, 'acme/app: v1.0.0', { repo: 'acme/app', tag: 'v1.0.0' }]);
});

test('git meaning: CHANGELOG entries dated in the period, a breaking one marked', () => {
  const { dir } = meaningRepo();
  const entries = byKind(run(dir), 'changelog entry').sort((a, b) => a.date.localeCompare(b.date));
  assert.deepEqual(entries.map((e) => [e.id, e.date, e.action, e.detail]), [
    ['changelog:acme/app:1.1.0', '2026-03-03', false, { repo: 'acme/app', version: '1.1.0', breaking: false }],
    ['changelog:acme/app:2.0.0', '2026-03-05', false, { repo: 'acme/app', version: '2.0.0', breaking: true }],
  ]);
});

test('git meaning: the first commit of the person over every ref is a snapshot fact', () => {
  const { dir, first } = meaningRepo();
  const [event] = byKind(run(dir), 'first commit');
  assert.deepEqual([event.id, event.action, event.snapshot, event.detail], ['first-commit:acme/app', false, true, { repo: 'acme/app', hash: first }]);
  assert.match(event.at, /^2026-02-10T09:00:00/);
  assert.equal(event.what, 'acme/app: change by Ada');
  // Another person's first commit is theirs, on a branch not merged.
  const [bobs] = byKind(collectGit([dir], { ...QUERY, authors: [BOB] }, OPTIONS), 'first commit');
  assert.match(bobs.at, /^2026-03-04T09:00:00/);
  assert.notEqual(bobs.detail.hash, first);
});

test('git meaning: uncommitted changes and untracked files are snapshot facts by kind, dated by file modification, generated files left out; off by default', () => {
  const { dir, write } = meaningRepo();
  assert.deepEqual(byKind(run(dir), 'uncommitted'), []);
  write({ 'src/app.py': 'def changed():\n    pass\n', 'notes/new.txt': 'x\ny\n', 'yarn.lock': 'z\n', 'config/new.yaml': 'k: v\n' });
  const result = run(dir, { uncommitted: true });
  const work = byKind(result, 'uncommitted');
  assert.deepEqual(work.map((e) => e.id), [
    'uncommitted:acme/app:config/new.yaml', 'uncommitted:acme/app:notes/new.txt', 'uncommitted:acme/app:src/app.py',
  ]);
  assert.ok(work.every((e) => e.action === false && e.snapshot === true && !Number.isNaN(Date.parse(e.at))));
  const [yaml, notes, tracked] = work;
  assert.deepEqual([yaml.lines.other, yaml.detail.untracked], [[1, 0], true]);
  assert.deepEqual([notes.lines.docs, notes.lines.code, notes.detail.untracked], [[2, 0], [0, 0], true]); // .txt is docs here
  assert.deepEqual([tracked.lines.code, tracked.detail], [[1, 1], { repo: 'acme/app', path: 'src/app.py', untracked: false }]);
  assert.match(result.notes.join('\n'), /uncommitted work: tracked changes against HEAD and untracked files not ignored, dated by file modification/);
  // The commits are what they were.
  assert.equal(Object.fromEntries(result.totals).commits, Object.fromEntries(run(dir).totals).commits);
});
