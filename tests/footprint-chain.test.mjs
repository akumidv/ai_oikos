// The decision chain from the git side to the fact side (ADR 0008 D08, D-FP3-CHAIN-CODES) and the
// partial result of a git collection (D-FP3-PARTIAL-RECRAWL): a temporary repository with fixed dates
// holds an ADR that names a code, added in a commit whose message names none, then a commit that
// names the code, with two tags between and after; a commit event carries the decision documents it
// touched, the chain links commits by message and by those documents and reads the release as the first
// tag that holds all of them. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitEnvironment } from '../tools/common/gitwiki.mjs';
import { collectGit } from '../tools/footprint/sources/git.mjs';
import { summarizeFacts } from '../tools/footprint/facts.mjs';
import { cleanEnv, tempDir } from './helpers/installation.mjs';

const GIT_ENV = gitEnvironment(null, cleanEnv());
const EMPTY_GIT_CONFIG = join(tempDir('gitconfig-'), 'config');
writeFileSync(EMPTY_GIT_CONFIG, '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' });

const ADA = 'ada@acme.example';
const QUERY = { authors: [ADA], since: '2026-03-01', until: '2026-03-12', tz: 'UTC' };
const OPTIONS = { gitVersion: () => 'git version 2.40.0' };
const ADR = 'docs/adr/0001-order.md';

/** A repository whose history is described in the file's header; returns its path and its git helpers. */
function chainRepo() {
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
  };
  const tag = (name, at) => git(['tag', '-a', name, '-m', name], as(at));
  git(['init', '-q', '-b', 'main']);
  git(['remote', 'add', 'origin', 'https://git.example.com/acme/app.git']);
  commit('2026-02-10T09:00:00+00:00', { 'src/old.js': 'a\n' }, 'base');
  commit('2026-03-02T09:00:00+00:00', { [ADR]: '# ADR 1\n\nStatus: Accepted (2026-03-02)\n\nThe order is D-X.\n', 'docs/adr/README.md': '# ADRs\n' }, 'write the order down');
  tag('v1.0.0', '2026-03-03T09:00:00+00:00');
  commit('2026-03-05T09:00:00+00:00', { 'src/order.js': 'b\n' }, 'implement D-X PROJ-7');
  tag('v1.1.0', '2026-03-06T09:00:00+00:00');
  return { dir, commit, tag };
}

const run = (dir, extra = {}, repos = [dir]) => collectGit(repos, { ...QUERY, ...extra }, OPTIONS);
const commitOf = (result, subject) => result.events.find((e) => e.kind === 'commit' && e.what === `acme/app: ${subject}`);
const asSource = (events) => events.map((e) => ({ ...e, source: 'git' }));
const asked = (at) => ({
  source: 'sessions', at, kind: 'final', what: 'app: claude session', where: 'x', action: false,
  detail: { host: 'claude', session: 's1', words: 10, request: true, questions: 1, none: false, codes: ['D-X'], answered: true },
});
const FACTS_WINDOW = { since: '2026-03-02', until: '2026-03-12', tz: 'UTC' };
const chainRow = (events, options = FACTS_WINDOW) => summarizeFacts(events, options).chain.rows[0];

test('git chain: a commit carries the decision documents it touched, in the form of the document event path; the ADR event carries the code its text names', () => {
  const { dir } = chainRepo();
  const result = run(dir);
  const written = commitOf(result, 'write the order down');
  // README.md in docs/adr is no ADR, so it is no decision document.
  assert.deepEqual([written.detail.decisionDirs, written.detail.decisionPaths, written.detail.codes], [['docs/adr'], [ADR], []]);
  assert.deepEqual(commitOf(result, 'implement D-X PROJ-7').detail.decisionPaths, []);
  const doc = result.events.find((e) => e.kind === 'decision document');
  assert.equal(doc.detail.path, ADR);
  assert.deepEqual(doc.detail.codes, ['D-X']);
  assert.equal(written.detail.releasedIn.tag, 'v1.0.0', 'a commit touching a decision folder gets its release');
});

test('git chain: a decision path is claimed once by the first folder, and ADR names apply only in an adr folder', () => {
  const { dir } = chainRepo();
  const both = run(dir, { decisionDirs: ['docs', 'docs/adr'] });
  // The first folder, `docs`, holds README.md too and has no ADR-name rule.
  assert.deepEqual(commitOf(both, 'write the order down').detail.decisionPaths, [ADR, 'docs/adr/README.md']);
  const none = run(dir, { decisionDirs: [] });
  assert.deepEqual(commitOf(none, 'write the order down').detail.decisionPaths, []);
});

test('chain: a commit that only added the ADR naming the code links to it, and the release is the first tag holding every linked commit', () => {
  const { dir } = chainRepo();
  const events = [...asSource(run(dir).events), asked('2026-03-02T08:00:00Z')];
  const row = chainRow(events);
  assert.deepEqual(row.documents, [{ repository: 'acme/app', path: ADR }]);
  assert.equal(row.commits, 2, 'the ADR commit (no code in its message) and the code commit');
  // The ADR shipped in v1.0.0 but the implementation only in v1.1.0: the decision shipped whole in v1.1.0.
  assert.deepEqual(row.released, { tag: 'v1.1.0', date: '2026-03-06' });
  assert.deepEqual(row.keys, ['PROJ-7']);
});

test('chain: one linked commit in no tag leaves the decision not released; commits before the code was first asked are not linked', () => {
  const { dir, commit } = chainRepo();
  commit('2026-03-09T09:00:00+00:00', { 'src/more.js': 'c\n' }, 'more of D-X');
  const events = [...asSource(run(dir).events), asked('2026-03-02T08:00:00Z')];
  assert.deepEqual([chainRow(events).commits, chainRow(events).released], [3, null]);
  // Asked on 03-03: the ADR commit of 03-02 comes before the question and is left out; its tag is not read.
  const later = chainRow([...asSource(run(dir).events), asked('2026-03-03T08:00:00Z')]);
  assert.deepEqual([later.commits, later.released], [2, null]);
  assert.deepEqual(later.documents, [{ repository: 'acme/app', path: ADR }], 'the document still names the code');
});

test('chain: the first request over the whole history decides the day, not the first one in the window; tags of one date tie by name', () => {
  const doc = { source: 'git', id: 'doc', at: '2026-03-01T09:00:00Z', kind: 'decision document', action: false, what: 'app: d.md', where: 'x', detail: { repo: 'app', path: 'd.md', codes: ['D-X'] } };
  const commit = (id, at, detail) => ({ source: 'git', id, at, kind: 'commit', what: `app: ${id}`, where: 'x', detail: { repo: 'app', codes: [], keys: [], decisionDirs: [], decisionPaths: [], ...detail } });
  const events = [
    doc, asked('2026-03-05T08:00:00Z'), { ...asked('2026-02-25T08:00:00Z') },
    commit('a', '2026-02-26T09:00:00Z', { decisionPaths: ['d.md'], releasedIn: { tag: 'v1', at: '2026-03-10T00:00:00Z' } }),
    commit('b', '2026-03-02T09:00:00Z', { codes: ['D-X'], releasedIn: { tag: 'v2-a', at: '2026-03-11T00:00:00Z' } }),
    commit('c', '2026-03-03T09:00:00Z', { decisionPaths: ['d.md'], releasedIn: { tag: 'v2-b', at: '2026-03-11T00:00:00Z' } }),
    commit('d', '2026-02-20T09:00:00Z', { codes: ['D-X'] }), // before the first request: not linked
  ];
  const row = chainRow(events, { since: '2026-03-01', until: '2026-03-12', tz: 'UTC', history: events });
  assert.deepEqual([row.asked, row.commits, row.released], ['2026-02-25', 3, { tag: 'v2-b', date: '2026-03-11' }]);
});

test('git partial: a repository whose log fails marks the result partial and keeps the note; a good run is not partial', () => {
  const { dir } = chainRepo();
  assert.equal(run(dir).partial, undefined);
  assert.equal(run(dir).partialReasons, undefined);
  const missing = join(tempDir('missing-'), 'gone');
  const result = run(dir, {}, [dir, missing]);
  assert.equal(result.partial, true);
  assert.equal(result.partialReasons.length, 1);
  assert.match(result.partialReasons[0], /^gone: git log failed \(/);
  assert.ok(result.notes.includes(result.partialReasons[0]), 'the note stays');
  assert.ok(result.events.some((e) => e.kind === 'commit'), 'the other repository still counts');
});

test('git partial: a repository whose meaning cannot be read (tags, tests, documents) marks the result partial, its commits still count', () => {
  const { dir } = chainRepo();
  const bin = tempDir('bin-');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$*" in *for-each-ref*) echo broken >&2; exit 1;; esac\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const result = run(dir);
    assert.equal(result.partial, true);
    assert.match(result.partialReasons[0], /^acme\/app: reading what the commits mean .* failed \(/);
    assert.deepEqual(result.partialReasons, result.notes.filter((n) => /reading what the commits mean/.test(n)));
    assert.equal(result.events.filter((e) => e.kind === 'commit').length, 2);
  } finally {
    process.env.PATH = path;
  }
});
