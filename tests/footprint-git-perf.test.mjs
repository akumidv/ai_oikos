// How the git source reads a large repository (ADR 0008 D04, D05, D08): the first tag of each commit
// from one rev-list per tag, the test functions of a commit from patches limited to its test files,
// the decision folders from one walk. A temporary repository with fixed dates; a `git` on PATH that
// logs its arguments and runs the real one shows which commands were run. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitEnvironment } from '../tools/common/gitwiki.mjs';
import { collectGit } from '../tools/footprint/sources/git.mjs';
import { cleanEnv, tempDir } from './helpers/installation.mjs';

const GIT_ENV = gitEnvironment(null, cleanEnv());
const EMPTY_GIT_CONFIG = join(tempDir('gitconfig-'), 'config');
writeFileSync(EMPTY_GIT_CONFIG, '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' });

const ADA = 'ada@acme.example';
const QUERY = { authors: [ADA], since: '2026-03-01', until: '2026-03-07', tz: 'UTC' };
const OPTIONS = { gitVersion: () => 'git version 2.40.0' };

/** A repository with its git helpers; `commit` writes files, commits at `at` as Ada and returns the hash. */
function newRepo() {
  const dir = join(tempDir('work-'), 'app');
  mkdirSync(dir, { recursive: true });
  const as = (at) => ({
    GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: ADA, GIT_AUTHOR_DATE: at, GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: ADA, GIT_COMMITTER_DATE: at,
  });
  const git = (args, extra = {}) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...extra } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commit = (at, files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(['add', '--', ...Object.keys(files)]);
    git(['commit', '-q', '-m', message], as(at));
    return git(['rev-parse', 'HEAD']);
  };
  const tag = (name, at, target = 'HEAD') => git(['tag', '-a', name, '-m', name, target], as(at));
  git(['init', '-q', '-b', 'main']);
  git(['remote', 'add', 'origin', 'https://git.example.com/acme/app.git']);
  return { dir, git, commit, tag };
}

/** Run `collectGit` on `dir` with a `git` on PATH that records its arguments; returns the result and the recorded commands. */
function logged(dir, query = {}) {
  const bin = tempDir('bin-');
  const log = join(bin, 'calls.log');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const result = collectGit([dir], { ...QUERY, ...query }, OPTIONS);
    assert.deepEqual(result.notes.filter((n) => /failed/.test(n)), [], 'no git call failed');
    let calls = [];
    try {
      calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    } catch { /* git was never run */ }
    return { result, calls };
  } finally {
    process.env.PATH = path;
  }
}

const commitEvents = (result) => result.events.filter((e) => e.kind === 'commit');

test('git perf: releasedIn is the oldest tag by creator date containing the commit, as git tag --contains says, with no call per commit', () => {
  const { dir, git, commit, tag } = newRepo();
  commit('2026-02-10T09:00:00+00:00', { 'src/old.js': 'a\n' }, 'base');
  const c1 = commit('2026-03-02T09:00:00+00:00', { 'src/a.js': 'a\n' }, 'one PROJ-1');
  const c2 = commit('2026-03-02T10:00:00+00:00', { 'src/b.js': 'b\n' }, 'two PROJ-2');
  git(['checkout', '-q', '-b', 'side']);
  const s1 = commit('2026-03-03T09:00:00+00:00', { 'src/side.js': 's\n' }, 'side PROJ-5');
  tag('side-1', '2026-03-03T10:00:00+00:00');
  git(['checkout', '-q', 'main']);
  const c3 = commit('2026-03-03T11:00:00+00:00', { 'src/c.js': 'c\n' }, 'three PROJ-3');
  tag('v2', '2026-03-05T09:00:00+00:00');
  tag('v1', '2026-03-06T09:00:00+00:00', c1); // an older commit with a later date: c1 is in side-1, v1 and v2
  const c4 = commit('2026-03-04T09:00:00+00:00', { 'src/d.js': 'd\n' }, 'four PROJ-4');
  tag('tie-b', '2026-03-20T09:00:00+00:00');
  tag('tie-a', '2026-03-20T09:00:00+00:00');
  const c5 = commit('2026-03-05T09:00:00+00:00', { 'src/e.js': 'e\n' }, 'five PROJ-6');
  commit('2026-03-05T10:00:00+00:00', { 'src/f.js': 'f\n' }, 'no key here');
  git(['tag', 'blob-tag', git(['hash-object', '-w', '--stdin'], {})]); // not a commit: ignored, as git tag --contains does

  const { result, calls } = logged(dir);
  const order = git(['for-each-ref', 'refs/tags', '--format=%(creatordate:unix)\t%(refname:lstrip=2)\t%(objecttype)'])
    .split('\n').map((l) => l.split('\t')).filter(([, , type]) => type !== 'blob')
    .sort((a, b) => Number(a[0]) - Number(b[0]) || a[1].localeCompare(b[1])).map(([, name]) => name);
  const oldest = (hash) => {
    const held = new Set(git(['tag', '--contains', hash]).split('\n').filter(Boolean));
    return order.find((name) => held.has(name));
  };
  const released = new Map(commitEvents(result).map((e) => [e.id, e.detail.releasedIn?.tag]));
  for (const hash of [c1, c2, s1, c3, c4]) assert.equal(released.get(hash), oldest(hash), hash);
  assert.deepEqual([c1, c2, s1, c3, c4, c5].map((h) => released.get(h)), ['side-1', 'side-1', 'side-1', 'v2', 'tie-a', undefined]);
  assert.equal(oldest(c5), undefined);
  assert.equal(commitEvents(result).find((e) => e.what.endsWith('no key here')).detail.releasedIn, undefined);
  assert.deepEqual(calls.filter((c) => /\btag\b.*--contains/.test(c)), [], 'no git tag --contains');
  assert.ok(calls.filter((c) => /\brev-list\b/.test(c)).length <= 6, 'one rev-list per tag at most');
});

test('git perf: test functions are read from the test files only, a rename into the tests keeps its rename, a lock file is never read', () => {
  const { dir, commit, git } = newRepo();
  const lines = (n) => Array.from({ length: n }, (_, i) => `entry ${i} def test_in_lock():\n`).join('');
  commit('2026-02-10T09:00:00+00:00', { 'src/helper.js': "test('old one', () => {});\ntest('old two', () => {});\nconst x = 1;\nconst y = 2;\n" }, 'base');
  commit('2026-03-02T09:00:00+00:00', {
    'tests/a.test.mjs': "it('does a', () => {});\ntest('does b', () => {});\n", 'package-lock.json': lines(2000), 'src/app.py': 'def test_code():\n    pass\n',
  }, 'tests with a lock');
  git(['mv', 'src/helper.js', 'tests/helper.test.mjs']);
  commit('2026-03-03T09:00:00+00:00', {
    'tests/helper.test.mjs': "test('old one', () => {});\ntest('old two', () => {});\nconst x = 1;\nconst y = 2;\ntest('new one', () => {});\n",
  }, 'rename into tests');

  const { result, calls } = logged(dir);
  const added = Object.fromEntries(commitEvents(result).map((e) => [e.what.replace('acme/app: ', ''), e.detail.testsAdded]));
  assert.equal(added['tests with a lock'], 2);
  assert.equal(added['rename into tests'], 1, 'only the line added to the renamed file counts');
  const patches = calls.filter((c) => /\blog\b.* -p /.test(c));
  assert.ok(patches.length >= 1);
  for (const call of patches) {
    const pathspec = call.split(' -- ')[1].split(' ');
    assert.ok(pathspec.every((p) => /^:\(literal\)(tests\/|src\/helper\.js$)/.test(p)), pathspec.join(' '));
    assert.doesNotMatch(call, /package-lock|src\/app\.py/);
  }
  assert.ok(patches.some((c) => c.includes(':(literal)src/helper.js')), 'the old path of a rename into the tests is in the pathspec');
});

test('git perf: decision documents of several folders are one walk, split by folder, a path once', () => {
  const { dir, commit } = newRepo();
  commit('2026-03-02T09:00:00+00:00', {
    'docs/adr/0001-first.md': '# ADR 1\n\nStatus: Accepted 2026-03-02\n', 'docs/adr/README.md': '# Index\n',
    'docs/design/plan.md': '# Plan\n\nStatus: draft\n', 'notes/loose.md': 'no\n',
  }, 'decide first');
  commit('2026-03-03T09:00:00+00:00', { 'decisions/0002-second.md': '# D2\n\nStatus: Proposed\n', 'docs/adr/0003-third.md': '# ADR 3\n\nStatus: Accepted 2026-03-03\n' }, 'decide more');

  const { result, calls } = logged(dir, { decisionDirs: ['docs/adr', 'docs/design', 'decisions'] });
  const documents = result.events.filter((e) => e.kind === 'decision document')
    .map((e) => [e.detail.dir, e.detail.path]).sort((a, b) => a[1].localeCompare(b[1]));
  assert.deepEqual(documents, [
    ['decisions', 'decisions/0002-second.md'], ['docs/adr', 'docs/adr/0001-first.md'], ['docs/adr', 'docs/adr/0003-third.md'],
    ['docs/design', 'docs/design/plan.md'],
  ]);
  const walks = calls.filter((c) => /\blog\b.*--name-status.*--reverse|--reverse.*--name-status/.test(c));
  assert.equal(walks.length, 1, 'one history walk for all the folders');
  assert.match(walks[0], / -- docs\/adr docs\/design decisions$/);
});
