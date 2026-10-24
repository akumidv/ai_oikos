// The footprint tool (npm test): temporary git repositories with fixed author and committer dates
// (code, docs, a lock file, renames, a binary and a quoted path, a rebased copy, a stash) read by
// the git source; the GitLab, Jira, Confluence and GitHub sources against canned answers
// (fake-fetch.mjs) in a copy of examples/installation; a source whose connector is not listed is not
// collected and makes no request; one failing source leaves the others running; `sources` makes no
// request. GitHub with GITHUB_ORG (repositories listed, probed, read per repository) runs through the
// CLI and in-process against a fake client — request counts, a shrinking page, a rate limit; without
// it, the search windows (monthly, split above 1000 results) run in-process. The user's settings
// (places.mjs) run in an installation; each source's events (kind, what, where, lines, reviewed) are
// checked in-process against fake clients, with the working day (day_starts) deciding the period; a
// remote's credentials never reach the output, a repository is named by its remote and its submodules
// are read; GitHub source output is fed to buildReport as it is (the seam); a 404/403 issue and a 429
// are met in Jira and GitLab. The
// timesheet reader, the bounds of a local day and the day/week placement across a time zone are
// called in-process. Nothing depends on the machine's time zone or git configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UsageError } from '../tools/common/cli.mjs';
import { ChannelError, HttpError } from '../tools/common/http.mjs';
import { gitEnvironment } from '../tools/common/gitwiki.mjs';
import { buildReport, isoDate, readTimesheet, readTimesheets, renderMarkdown, zonedMidnight } from '../tools/footprint/report.mjs';
import { collectConfluence } from '../tools/footprint/sources/confluence.mjs';
import { collectGit, dateLimit, findRepos, remoteIdentity, remoteLocation, withoutCredentials } from '../tools/footprint/sources/git.mjs';
import { collectGithub } from '../tools/footprint/sources/github.mjs';
import { collectGitlab } from '../tools/footprint/sources/gitlab.mjs';
import { collectJira } from '../tools/footprint/sources/jira.mjs';
import { assertNoCrashNoRequest, cleanEnv, installation, script, tempDir, tool, withFakeFetch, withGitlab } from './helpers/installation.mjs';

const SINCE = '2026-03-01';
const UNTIL = '2026-03-07';
const PERIOD = ['--since', SINCE, '--until', UNTIL];
const ACCOUNT = '712020:0a1b2c3d-0000-4000-8000-000000000001';

/** Run `footprint collect … --json` in `dir` against `routes`: the result, the parsed report and the calls. */
function collect(dir, routes, args, env = {}, period = PERIOD) {
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'footprint', ['collect', ...period, ...args, '--json'], { ...fake.env, ...env }, fake);
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* the assertions show the output */ }
  return { ...r, report, calls: fake.calls() };
}

const totals = (report, source) => Object.fromEntries(report.sources.find((s) => s.source === source).totals);
const day = (report, date) => report.days.find((d) => d.date === date);
const notesOf = (report, source) => report.sources.find((s) => s.source === source).notes.join('\n');

// == git ==

/** The test's own git: none of the developer's GIT_* variables (GIT_DIR, GIT_INDEX_FILE, …), no system or global configuration. */
const GIT_ENV = gitEnvironment(null, cleanEnv());
/** An empty global git configuration: the tool reads the user's, so the tests give it this one. */
const EMPTY_GIT_CONFIG = join(tempDir('gitconfig-'), 'config');
writeFileSync(EMPTY_GIT_CONFIG, '');
const NO_USER_GIT_CONFIG = { GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };
// collectGit called in-process runs git with this process's environment.
Object.assign(process.env, NO_USER_GIT_CONFIG);
/** A tool run: the developer's git configuration shut out, TZ fixing the zone git reads a date in. */
const GIT_RUN = { TZ: 'UTC', ...NO_USER_GIT_CONFIG };
const ADA = 'ada@acme.example';

/**
 * A repository at `dir` with commits at fixed author and committer dates. Returns its `git`, a
 * `commit` (its hash) with the committer date apart when given, `write` and the identity `as`.
 */
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (args, extra = {}) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...extra } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const as = (who, email, at, committedAt = at) => ({
    GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: committedAt,
  });
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  const commit = (who, email, at, files, committedAt = at) => {
    write(files);
    git(['add', '--', ...Object.keys(files)]);
    git(['commit', '-q', '-m', `change by ${who}`], as(who, email, at, committedAt));
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '-q', '-b', 'main']);
  commit('Ada', ADA, '2026-02-20T10:00:00+00:00', { 'src/old.js': 'a\n' }); // before the period
  commit('Ada', ADA, '2026-03-02T10:00:00+00:00', {
    'src/app.js': 'one\ntwo\nthree\n', 'README.md': '# App\ntext\n', 'package-lock.json': '{\n"a": 1,\n"b": 2,\n"c": 3\n}\n',
  });
  commit('Bob', 'bob@acme.example', '2026-03-02T12:00:00+00:00', { 'src/other.js': 'b\n' });
  commit('Bada', 'bada@acme.example', '2026-03-02T13:00:00+00:00', { 'src/bada.js': 'c\n' }); // a longer address
  commit('Ada X', 'ada@acmexexample', '2026-03-02T14:00:00+00:00', { 'src/dot.js': 'd\n' }); // `.` read as any character
  commit('Ada', ADA, '2026-03-03T23:30:00+00:00', { 'src/app.js': 'one\n2\nthree\n' });
  return { git, commit, write, as };
}

test('git: commits of the author in the period, code and docs lines, generated lines left out', () => {
  const dir = installation((t) => t);
  const work = tempDir('work-');
  gitRepo(join(work, 'team', 'app')); // two levels below the folder given
  const r = collect(dir, [], ['--email', ADA, '--repos', work, '--source', 'git', '--tz', 'UTC', '--purpose', 'weekly report'], GIT_RUN);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.deepEqual(totals(r.report, 'git'), {
    commits: 2, repositories: 1, 'files changed': 3, 'code lines': '+4 −1', 'tests lines': '+0 −0', 'docs lines': '+2 −0', 'generated lines left out': 5,
    'commits left out by skip_commits': 0, 'pipeline lines': '+0 −0',
  });
  assert.equal(r.report.purpose, 'weekly report');
  assert.equal(day(r.report, '2026-03-02').bySource.git, 1);
  assert.equal(day(r.report, '2026-03-02').first, '10:00');
  assert.equal(day(r.report, '2026-03-03').bySource.git, 1);
  assert.deepEqual(r.report.sources[0].breakdown.header, ['Repository', 'Commits', 'Code +', 'Code −', 'Tests +', 'Tests −', 'Docs +', 'Docs −', 'First', 'Last']);
  assert.deepEqual(r.report.sources[0].breakdown.rows, [['app', 2, 4, 1, 0, 0, 2, 0, '2026-03-02', '2026-03-03']]);
  assert.match(notesOf(r.report, 'git'), /branches, tags and remote-tracking branches are read \(not the stash or notes\); they hold only what was fetched/);
});

test('git: the author date decides the day in --tz (23:30 UTC is the next day in Zurich)', () => {
  const dir = installation((t) => t);
  const repo = join(tempDir('work-'), 'app');
  gitRepo(repo);
  const r = collect(dir, [], ['--email', ADA, '--repos', repo, '--source', 'git', '--tz', 'Europe/Zurich'], GIT_RUN);
  assert.equal(r.status, 0, r.output);
  assert.equal(day(r.report, '2026-03-03').bySource.git, undefined);
  assert.equal(day(r.report, '2026-03-04').bySource.git, 1);
  assert.equal(day(r.report, '2026-03-04').first, '00:30');
});

test('git: the period by author date — rebased after it still counted, old work rebased into it not, the slack before --since, no stash', () => {
  const dir = installation((t) => t);
  const repo = join(tempDir('work-'), 'app');
  const { git, commit, write, as } = gitRepo(repo);
  commit('Ada', ADA, '2026-03-05T09:00:00+00:00', { 'src/late.js': 'l\n' }, '2026-04-20T09:00:00+00:00'); // rebased weeks after the period
  commit('Ada', ADA, '2026-02-25T09:00:00+00:00', { 'src/older.js': 'o\n' }, '2026-03-04T09:00:00+00:00'); // old work rebased into it
  commit('Ada', ADA, '2026-02-28T23:30:00+00:00', { 'src/edge.js': 'e\n' }); // 2026-03-01 00:30 in Zurich
  write({ 'src/app.js': 'stashed\n' });
  git(['stash', '-q'], as('Ada', ADA, '2026-03-06T09:00:00+00:00')); // its index commit is Ada's, in the period
  const r = collect(dir, [], ['--email', ADA, '--repos', repo, '--source', 'git', '--tz', 'Europe/Zurich'], GIT_RUN);
  assert.equal(r.status, 0, r.output);
  assert.equal(totals(r.report, 'git').commits, 4);
  assert.equal(day(r.report, '2026-03-01').bySource.git, 1);
  assert.equal(day(r.report, '2026-03-01').first, '00:30');
  assert.equal(day(r.report, '2026-03-05').bySource.git, 1);
  assert.equal(day(r.report, '2026-03-06').bySource.git, undefined);
});

test('git: a commit rebased or cherry-picked onto another branch counts once, its stale copy too', () => {
  const dir = installation((t) => t);
  const repo = join(tempDir('work-'), 'app');
  const { git, commit } = gitRepo(repo);
  git(['checkout', '-q', '-b', 'stale']);
  const original = commit('Ada', ADA, '2026-03-05T09:00:00+00:00', { 'src/feature.js': 'f\ng\n' });
  git(['checkout', '-q', 'main']);
  git(['cherry-pick', original], { GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: ADA, GIT_COMMITTER_DATE: '2026-03-06T09:00:00+00:00' });
  assert.notEqual(git(['rev-parse', 'HEAD']), original);
  const r = collect(dir, [], ['--email', ADA, '--repos', repo, '--source', 'git', '--tz', 'UTC'], GIT_RUN);
  assert.equal(r.status, 0, r.output);
  assert.equal(totals(r.report, 'git').commits, 3);
  assert.equal(totals(r.report, 'git')['code lines'], '+6 −1');
  assert.equal(day(r.report, '2026-03-05').bySource.git, 1);
});

test('git: a rename counts under its new path, a binary file as a file only, a quoted path by its kind; the caller\'s GIT_* is shut out', () => {
  const dir = installation((t) => t);
  const repo = join(tempDir('work-'), 'app');
  const { git, commit } = gitRepo(repo);
  commit('Ada', ADA, '2026-02-21T09:00:00+00:00', { 'docs/guide.md': '1\n2\n3\n4\n5\n' });
  git(['mv', 'docs/guide.md', 'docs/manual.md']);
  commit('Ada', ADA, '2026-03-04T09:00:00+00:00', {
    'docs/manual.md': '1\n2\nthree\n4\n5\n', 'logo.png': Buffer.from([0x89, 0x50, 0, 1, 2, 0]), 'a"b.md': 'x\ny\n',
  });
  // A user configuration that would change the counts, and a caller's repository and one-call settings.
  const userConfig = join(tempDir('gitconfig-'), 'config');
  writeFileSync(userConfig, '[diff]\n\trenames = false\n[core]\n\tquotePath = true\n[color]\n\tui = always\n[log]\n\tdecorate = full\n\tmailmap = true\n');
  const hostile = {
    GIT_CONFIG_GLOBAL: userConfig, GIT_DIR: join(repo, 'missing'), GIT_INDEX_FILE: join(repo, 'missing', 'index'),
    GIT_CONFIG_PARAMETERS: "'diff.renames'='false'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.renames', GIT_CONFIG_VALUE_0: 'false',
  };
  const r = collect(dir, [], ['--email', ADA, '--repos', repo, '--source', 'git', '--tz', 'UTC'], { ...GIT_RUN, ...hostile });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(totals(r.report, 'git'), {
    commits: 3, repositories: 1, 'files changed': 6, 'code lines': '+4 −1', 'tests lines': '+0 −0', 'docs lines': '+5 −1', 'generated lines left out': 5,
    'commits left out by skip_commits': 0, 'pipeline lines': '+0 −0',
  });
});

/** A history with a commit committed before the window (an import, a rebase keeping the author dates) and the person's commits on both sides of it. */
function importedHistory() {
  const repo = join(tempDir('work-'), 'app');
  const { commit } = gitRepo(repo); // Ada on 2026-03-02 and 2026-03-03
  commit('Ada', ADA, '2026-02-15T09:00:00+00:00', { 'src/imported.js': 'i\n' });
  commit('Ada', ADA, '2026-03-05T09:00:00+00:00', { 'src/new.js': 'n\n' });
  return repo;
}

test('git: a commit committed before the window does not hide the person\'s commits behind it', () => {
  const dir = installation((t) => t);
  const r = collect(dir, [], ['--email', ADA, '--repos', importedHistory(), '--source', 'git', '--tz', 'UTC'], GIT_RUN);
  assert.equal(r.status, 0, r.output);
  assert.equal(totals(r.report, 'git').commits, 3);
  assert.deepEqual(['2026-03-02', '2026-03-03', '2026-03-05'].map((d) => day(r.report, d).bySource.git), [1, 1, 1]);
});

test('git: --since-as-filter from git 2.37, no date limit before it — both count the same', () => {
  assert.deepEqual(dateLimit('git version 2.53.0', SINCE), ['--since-as-filter=2026-02-28T00:00']);
  assert.deepEqual(dateLimit('git version 2.37.0.windows.1', SINCE), ['--since-as-filter=2026-02-28T00:00']);
  assert.deepEqual(dateLimit('git version 3.0.1', SINCE), ['--since-as-filter=2026-02-28T00:00']);
  assert.deepEqual(dateLimit('git version 2.36.6 (Apple Git-143)', SINCE), []);
  assert.deepEqual(dateLimit('git version 1.9.5', SINCE), []);
  assert.deepEqual(dateLimit('', SINCE), []);
  const repo = importedHistory();
  const query = { authors: [ADA], since: SINCE, until: UNTIL, tz: 'UTC' };
  for (const version of ['git version 2.36.6', 'git version 2.37.0']) {
    const result = collectGit([repo], query, { gitVersion: () => version });
    assert.equal(Object.fromEntries(result.totals).commits, 3, version);
    assert.deepEqual(result.events.map((e) => e.at.slice(0, 10)).sort(), ['2026-03-02', '2026-03-03', '2026-03-05'], version);
  }
});

test('git: test files are their own kind, skip_commits left out and counted apart, a pipeline repository\'s lines apart; each event its kind, what, where and lines', () => {
  const work = tempDir('work-');
  const app = gitRepo(join(work, 'app'));
  app.git(['remote', 'add', 'origin', 'https://git.example.com/acme/app.git']);
  app.commit('Ada', ADA, '2026-03-04T09:00:00+00:00', {
    'tests/app.test.js': 't\nu\n', 'src/util_test.go': 'v\n', 'spec/a.rb': 'w\n', 'test_b.py': 'x\n', '.claude/skills/x/SKILL.md': 's\ns\ns\n',
  });
  app.commit('Ada', ADA, '2026-03-05T09:00:00+00:00', { 'src/huge.js': 'a\nb\nc\nd\n' });
  app.git(['commit', '-q', '--amend', '-m', 'Agent host session 12 - turn 3 checkpoint'], app.as('Ada', ADA, '2026-03-05T09:00:00+00:00'));
  const notes = gitRepo(join(work, 'team-notes'));
  notes.commit('Ada', ADA, '2026-03-06T09:00:00+00:00', { 'notes/n1.md': '1\n2\n3\n' });
  const result = collectGit([join(work, 'app'), join(work, 'team-notes')], {
    authors: [ADA], since: SINCE, until: UNTIL, tz: 'UTC',
    skipCommits: [{ pattern: /^agent host session/i, repos: [] }], generated: [/(^|\/)\.claude\//i], pipelineRepos: ['team-notes'],
  }, { gitVersion: () => 'git version 2.40.0' });
  assert.deepEqual(Object.fromEntries(result.totals), {
    commits: 4, repositories: 2, 'files changed': 8, 'code lines': '+4 −1', 'tests lines': '+5 −0', 'docs lines': '+2 −0',
    'generated lines left out': 8, 'commits left out by skip_commits': 1, 'pipeline lines': '+3 −0',
  });
  const tested = result.events.find((e) => e.at.startsWith('2026-03-04'));
  assert.deepEqual(tested, {
    at: '2026-03-04T09:00:00Z', kind: 'commit', what: 'acme/app: change by Ada', where: `${join(work, 'app')} https://git.example.com/acme/app.git`,
    lines: { code: [0, 0], tests: [5, 0], docs: [0, 0] },
  });
  const piped = result.events.filter((e) => e.where.includes('team-notes'));
  // The fixture's commits there are copies of app's (same author, date and subject): the one of the 6th is its own.
  assert.equal(piped.length, 1);
  assert.ok(piped.every((e) => e.kind === 'commit' && e.lines === undefined));
  assert.ok(!result.events.some((e) => e.at.startsWith('2026-03-05')), 'the checkpoint is no event');
  assert.deepEqual(result.breakdown.rows.map((r) => r[0]), ['acme/app', 'team-notes']);
  assert.deepEqual(result.breakdown.wheres, [`${join(work, 'app')} https://git.example.com/acme/app.git`, join(work, 'team-notes')]);
  assert.match(result.notes.join('\n'), /a repository is named by its remote \(owner\/name\), so two clones of one remote are one repository/);
  // The repositories read, by remote identity: team-notes has no remote, so no identity.
  assert.deepEqual(result.remotes, ['git.example.com/acme/app']);
  const said = result.notes.join('\n');
  assert.match(said, /1 commit\(s\) whose subject matches skip_commits \(\^agent host session\) left out of everything: 4 lines in them/);
  assert.match(said, /pipeline_repos — commits counted, their lines only in pipeline lines, their files not in files changed: team-notes \+3 −0/);
});

test('git: a skip_commits rule limited to repositories leaves out the commits there only', () => {
  const work = tempDir('work-');
  const app = gitRepo(join(work, 'app'));
  const lib = gitRepo(join(work, 'lib'));
  lib.commit('Ada', ADA, '2026-03-05T09:00:00+00:00', { 'src/lib.js': 'l\nm\n' });
  lib.git(['commit', '-q', '--amend', '-m', 'Snapshot of the index'], lib.as('Ada', ADA, '2026-03-05T09:00:00+00:00'));
  app.commit('Ada', ADA, '2026-03-06T09:00:00+00:00', { 'src/app2.js': 'a\n' });
  app.git(['commit', '-q', '--amend', '-m', 'Snapshot of the index'], app.as('Ada', ADA, '2026-03-06T09:00:00+00:00'));
  const query = { authors: [ADA], since: SINCE, until: UNTIL, tz: 'UTC' };
  const run = (skipCommits) => collectGit([join(work, 'app'), join(work, 'lib')], { ...query, skipCommits }, { gitVersion: () => 'git version 2.40.0' });
  // A rule's repositories are lowercased substrings of a repository's path and remote (places.mjs gives them so).
  const libPath = join(work, 'lib').toLowerCase();
  const limited = run([{ pattern: /^snapshot/i, repos: [libPath] }]);
  assert.deepEqual(limited.events.filter((e) => /Snapshot/.test(e.what)).map((e) => e.what), ['app: Snapshot of the index']);
  assert.equal(Object.fromEntries(limited.totals)['commits left out by skip_commits'], 1);
  assert.ok(limited.notes.includes(`1 commit(s) whose subject matches skip_commits (^snapshot in ${libPath}) left out of everything: 2 lines in them`), limited.notes.join('\n'));
  const everywhere = run([{ pattern: /^snapshot/i, repos: [] }]);
  assert.equal(Object.fromEntries(everywhere.totals)['commits left out by skip_commits'], 2);
  assert.ok(!everywhere.events.some((e) => /Snapshot/.test(e.what)));
});

test('git: a remote\'s credentials never reach an event, a note or the report; the repository is named by its remote, two clones of it are one', () => {
  const dir = installation((t) => t);
  const work = tempDir('work-');
  const secret = 's3cr3t-remote-password';
  const first = gitRepo(join(work, 'fix-merge-42'));
  first.git(['remote', 'add', 'origin', `https://ada:${secret}@git.example.com/acme/app.git`]);
  // A second clone of the same remote, in a folder of another name, with the same commits and one of its own.
  const second = gitRepo(join(work, 'checkout'));
  second.git(['remote', 'add', 'origin', 'git@git.example.com:acme/app.git']);
  second.commit('Ada', ADA, '2026-03-05T09:00:00+00:00', { 'src/more.js': 'm\n' });
  const args = ['--email', ADA, '--repos', work, '--source', 'git', '--tz', 'UTC'];
  const json = collect(dir, [], args, GIT_RUN);
  assert.equal(json.status, 0, json.output);
  assert.ok(!json.stdout.includes(secret), 'no credential in --json');
  assert.deepEqual(json.report.sources[0].breakdown.rows.map((r) => [r[0], r[1]]), [['acme/app', 3]]);
  assert.equal(json.report.sources[0].breakdown.wheres, undefined);
  assert.deepEqual(json.report.all.changed.repositories.map((r) => r.repository), ['acme/app']);
  const md = tool(dir, 'footprint', ['collect', ...PERIOD, ...args], GIT_RUN);
  assert.equal(md.status, 0, md.output);
  assert.ok(!md.output.includes(secret), 'no credential in the markdown');
  assert.doesNotMatch(md.stdout, /fix-merge-42/);
  const result = collectGit([join(work, 'fix-merge-42')], { authors: [ADA], since: SINCE, until: UNTIL, tz: 'UTC' }, { gitVersion: () => 'git version 2.40.0' });
  assert.ok(!JSON.stringify(result).includes(secret), 'no credential in the source result');
  assert.equal(result.events[0].where, `${join(work, 'fix-merge-42')} https://git.example.com/acme/app.git`);
});

test('git: remote locations — scheme, scp form and local path; credentials dropped', () => {
  assert.equal(withoutCredentials('https://ada:tok@git.example.com/acme/app.git'), 'https://git.example.com/acme/app.git');
  assert.equal(withoutCredentials('ssh://git@git.example.com:2222/acme/app.git'), 'ssh://git.example.com:2222/acme/app.git');
  assert.equal(withoutCredentials('git@git.example.com:acme/app.git'), 'git@git.example.com:acme/app.git');
  // A password with an unencoded `/` or `@`: everything up to the last `@` before the host's path goes.
  assert.equal(withoutCredentials('https://x-access-token:FA/KE@git.example.com/acme/app.git'), 'https://git.example.com/acme/app.git');
  assert.equal(withoutCredentials('https://u:p@ss@git.example.com/acme/app'), 'https://git.example.com/acme/app');
  assert.equal(withoutCredentials('https://u:p@ss@git.example.com'), 'https://git.example.com');
  // An `@` only in the path, after a plain host (with or without a port): no credentials, unchanged.
  assert.equal(withoutCredentials('https://git.example.com/acme/app@v2.git'), 'https://git.example.com/acme/app@v2.git');
  assert.equal(withoutCredentials('https://git.example.com:8443/acme/@scope/app'), 'https://git.example.com:8443/acme/@scope/app');
  assert.deepEqual(remoteLocation('https://x-access-token:FA/KE@git.example.com/acme/app.git'), { host: 'git.example.com', path: 'acme/app' });
  assert.deepEqual(remoteLocation('https://ada:tok@git.example.com/acme/app.git'), { host: 'git.example.com', path: 'acme/app' });
  assert.deepEqual(remoteLocation('git@gitlab.example.com:group/sub/project.git'), { host: 'gitlab.example.com', path: 'group/sub/project' });
  assert.deepEqual(remoteLocation('/srv/git/lib.git'), { host: '', path: 'srv/git/lib' });
  assert.deepEqual(remoteLocation('file:///srv/git/lib.git/'), { host: '', path: 'srv/git/lib' });
  assert.equal(remoteLocation(''), null);
});

test('git: a remote identity is host and path, lowercased, without scheme, credentials, port, .git or a trailing /', () => {
  assert.equal(remoteIdentity('https://ada:tok@GitHub.com/Acme/App.git'), 'github.com/acme/app');
  assert.equal(remoteIdentity('git@gitlab.example.com:group/sub/project.git'), 'gitlab.example.com/group/sub/project');
  assert.equal(remoteIdentity('ssh://git@gitlab.example.com:2222/group/sub/project.git/'), 'gitlab.example.com/group/sub/project');
  assert.equal(remoteIdentity('https://gitlab.example.com:8443/group/project/'), 'gitlab.example.com/group/project');
  assert.equal(remoteIdentity('/srv/git/lib.git'), null);
  assert.equal(remoteIdentity('file:///srv/git/lib.git'), null);
  assert.equal(remoteIdentity(null), null);
});

test('git: findRepos reads the submodules of a repository found, each a repository of its own', () => {
  const work = tempDir('work-');
  const lib = gitRepo(join(tempDir('upstream-'), 'lib'));
  lib.commit('Ada', ADA, '2026-03-05T09:00:00+00:00', { 'src/lib-only.js': 'x\ny\n' });
  const app = gitRepo(join(work, 'app'));
  app.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.git(['rev-parse', '--show-toplevel']), 'modules/lib']);
  const repos = findRepos([join(work, 'app')]);
  assert.deepEqual(repos.map((r) => r.slice(realpathSync(work).length)), ['/app', '/app/modules/lib']);
  const result = collectGit(repos, { authors: [ADA], since: SINCE, until: UNTIL, tz: 'UTC' }, { gitVersion: () => 'git version 2.40.0' });
  // The submodule's own commit, named by its remote (a local path: its folder name); its copies of app's commits count once.
  assert.deepEqual(result.events.filter((e) => e.at.startsWith('2026-03-05')).map((e) => e.what), ['lib: change by Ada']);
  assert.deepEqual(result.breakdown.rows.map((r) => [r[0], r[1]]), [['app', 2], ['lib', 1]]);
});

test('git: with day_starts a commit belongs to its working day — 01:30 after the last day is in, 02:00 on the first day is not', () => {
  const repo = join(tempDir('work-'), 'app');
  const { commit } = gitRepo(repo); // Ada on 2026-03-02 10:00 and 2026-03-03 23:30
  commit('Ada', ADA, '2026-03-08T01:30:00+00:00', { 'src/late.js': 'l\n' });
  commit('Ada', ADA, '2026-03-01T02:00:00+00:00', { 'src/early.js': 'e\n' });
  const query = { authors: [ADA], since: SINCE, until: UNTIL, tz: 'UTC' };
  const at = (result) => result.events.map((e) => e.at.slice(0, 16)).sort();
  const midnight = collectGit([repo], query, { gitVersion: () => 'git version 2.40.0' });
  assert.deepEqual(at(midnight), ['2026-03-01T02:00', '2026-03-02T10:00', '2026-03-03T23:30']);
  const four = collectGit([repo], { ...query, dayStartsMin: 240 }, { gitVersion: () => 'git version 2.40.0' });
  assert.deepEqual(at(four), ['2026-03-02T10:00', '2026-03-03T23:30', '2026-03-08T01:30']);
});

test('git: when git log fails in every repository, the source is not collected and says why', () => {
  const dir = installation((t) => t);
  const repo = join(tempDir('work-'), 'app');
  gitRepo(repo);
  const r = tool(dir, 'footprint', ['collect', ...PERIOD, '--email', ADA, '--repos', repo, '--source', 'git'], { ...GIT_RUN, PATH: tempDir('no-git-') });
  assert.equal(r.status, 1, r.output);
  assert.match(r.stdout, /^- git: not collected — git log failed in every repository searched; app: git log failed \(.*ENOENT.*\)$/m);
  assert.match(r.stderr, /no source ran/);
});

test('git --me: the git email, and the Atlassian email only where jira or confluence is listed', () => {
  const repo = join(tempDir('work-'), 'app');
  gitRepo(repo);
  const gitconfig = join(tempDir('home-'), 'gitconfig');
  writeFileSync(gitconfig, `[user]\n\temail = ${ADA}\n`);
  // The tool's own `git config user.email` reads this file; its git log shuts it out.
  const env = { ...GIT_RUN, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', JIRA_EMAIL: 'bada@acme.example' };
  const args = ['--me', '--repos', repo, '--source', 'git', '--tz', 'UTC'];
  const listed = collect(installation((t) => t), [], args, env);
  assert.equal(listed.status, 0, listed.output);
  assert.match(notesOf(listed.report, 'git'), /authors matched: ada@acme\.example, bada@acme\.example$/m);
  assert.equal(totals(listed.report, 'git').commits, 3);
  const unlisted = collect(installation((t) => t.replace('task-tracking: [jira]', 'task-tracking: []').replace('wiki: [confluence]', 'wiki: []')), [], args, env);
  assert.equal(unlisted.status, 0, unlisted.output);
  assert.match(notesOf(unlisted.report, 'git'), /authors matched: ada@acme\.example$/m);
  assert.equal(totals(unlisted.report, 'git').commits, 2);
});

test('git --me: the installation\'s git email everywhere, and in a repository its own user.email too', () => {
  const work = tempDir('work-');
  gitRepo(join(work, 'app'));
  const lib = gitRepo(join(work, 'lib'));
  lib.git(['config', 'user.email', 'ada.home@example.com']); // the address the user commits with in lib
  lib.commit('Ada', 'ada.home@example.com', '2026-03-05T09:00:00+00:00', { 'src/lib.js': 'l\n' });
  const gitconfig = join(tempDir('home-'), 'gitconfig');
  writeFileSync(gitconfig, `[user]\n\temail = ${ADA}\n`);
  const dir = installation((t) => t.replace('task-tracking: [jira]', 'task-tracking: []').replace('wiki: [confluence]', 'wiki: []'));
  const r = collect(dir, [], ['--me', '--repos', work, '--source', 'git', '--tz', 'UTC'], { ...GIT_RUN, GIT_CONFIG_GLOBAL: gitconfig });
  assert.equal(r.status, 0, r.output);
  // Ada's 2 (lib's copies of them count once) and the 1 by lib's own address.
  assert.equal(totals(r.report, 'git').commits, 3);
  assert.equal(day(r.report, '2026-03-05').bySource.git, 1);
  const notes = notesOf(r.report, 'git');
  assert.match(notes, /authors matched: ada@acme\.example, ada\.home@example\.com$/m);
  assert.match(notes, /the address the user commits with in a repository \(its git user\.email\) is matched there: ada\.home@example\.com in lib$/m);
});

// The report's own sections are tested in footprint-report.test.mjs: here what the sources put in it.
test('git: markdown report with the purpose, the totals, a day with its place and content, the per-repository breakdown and the notes', () => {
  const dir = installation((t) => t);
  const repo = join(tempDir('work-'), 'app');
  gitRepo(repo);
  const r = tool(dir, 'footprint', ['collect', ...PERIOD, '--email', ADA, '--repos', repo, '--source', 'git,jira', '--atlassian', ACCOUNT, '--tz', 'UTC', '--person', 'Ada', '--purpose', 'quarterly review'], GIT_RUN);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^# Footprint — Ada — 2026-03-01 … 2026-03-07\n\nPurpose: quarterly review\n\nCollected /);
  assert.match(r.stdout, /^\| git \| generated lines left out \| 5 \|$/m);
  // The default place is the fixture's organization.name; the content is the commit's repository (`what`) with its lines.
  assert.match(r.stdout, /^\| 2026-03-02 \| Mon \| ACME Corp \| 10:00 \| 10:00 \| 1 \| app \+5 −0 \|$/m);
  assert.match(r.stdout, /^## git — per repository$/m);
  // jira has no credentials: not collected, the git source still ran.
  assert.match(r.stdout, /^- jira: not collected — no Jira credentials .*\(missing: .*JIRA_API_TOKEN\)$/m);
  assertNoCrashNoRequest(r);
});

// == places: the user's settings ==

/** `footprintSettings(...)` of places.mjs run in the installation `dir` for each of `calls`: what each gave, or its error. */
function settingsIn(dir, calls) {
  const places = pathToFileURL(join(dir, 'oikos', 'tools', 'footprint', 'places.mjs')).href;
  const code = `import { footprintSettings } from ${JSON.stringify(places)};
    const where = ['/work/app https://git.example.com/acme/app.git', '/work/side-project', '/work/NOTES', '/work/side-project/app', '/work/other', null];
    const out = ${JSON.stringify(calls)}.map((given) => {
      try {
        const s = footprintSettings(given);
        return { file: s.file, defaultPlace: s.defaultPlace, rules: s.rules, skipCommits: s.skipCommits.map((r) => ({ pattern: r.pattern.source, repos: r.repos })),
          generated: s.generated.map((r) => r.source), pipelineRepos: s.pipelineRepos, dayStartsMin: s.dayStartsMin, places: where.map((w) => s.placeOf(w)) };
      } catch (e) { return { error: e.message }; }
    });
    console.log(JSON.stringify(out));`;
  const r = script(dir, code, {});
  assert.equal(r.status, 0, r.output);
  return JSON.parse(r.stdout);
}

test('places: a --place rule before the file\'s, case-insensitive substrings, what none names is the default (else organization.name); the settings read', () => {
  const dir = installation((t) => t);
  mkdirSync(join(dir, '.local', 'footprint'));
  writeFileSync(join(dir, '.local', 'footprint', 'config.yaml'), [
    'places:', '  personal: [side-project, notes]', 'skip_commits:', '  - "^Agent host session"', '  - { pattern: "^reindex:", repos: [Acme/Knowledge, notes] }',
    'generated: ["(^|/)\\\\.claude/"]', 'pipeline_repos: Team-Notes', 'day_starts: "04:00"', '',
  ].join('\n'));
  const [withFlag, replaced] = settingsIn(dir, [{ places: ['client=app,api'] }, { defaultPlace: 'Elsewhere', dayStarts: '06:30' }]);
  assert.deepEqual(withFlag, {
    file: join(dir, '.local', 'footprint', 'config.yaml'), defaultPlace: 'ACME Corp',
    rules: [{ label: 'client', patterns: ['app', 'api'] }, { label: 'personal', patterns: ['side-project', 'notes'] }],
    skipCommits: [{ pattern: '^Agent host session', repos: [] }, { pattern: '^reindex:', repos: ['acme/knowledge', 'notes'] }],
    generated: ['(^|\\/)\\.claude\\/'], pipelineRepos: ['team-notes'], dayStartsMin: 240,
    places: ['client', 'personal', 'personal', 'client', 'ACME Corp', 'ACME Corp'],
  });
  assert.deepEqual([replaced.defaultPlace, replaced.dayStartsMin, replaced.places[4]], ['Elsewhere', 390, 'Elsewhere']);
  // No settings file: the organization's name, no rules; a --config that does not exist is refused.
  const bare = installation((t) => t);
  const [none, missing, badPlace, badTime] = settingsIn(bare, [{}, { file: join(bare, 'nope.yaml') }, { places: ['personal'] }, { dayStarts: '25:00' }]);
  assert.deepEqual([none.file, none.defaultPlace, none.rules, none.dayStartsMin, none.places[0]], [null, 'ACME Corp', [], 0, 'ACME Corp']);
  assert.match(missing.error, /^--config .*nope\.yaml: no such file$/);
  assert.match(badPlace.error, /^--place takes label=pattern\[,pattern…\]; got: personal$/);
  assert.match(badTime.error, /^--day-starts takes HH:MM; got: 25:00$/);
  // A skip_commits mapping needs its pattern.
  const noPattern = installation((t) => t);
  mkdirSync(join(noPattern, '.local', 'footprint'));
  writeFileSync(join(noPattern, '.local', 'footprint', 'config.yaml'), 'skip_commits:\n  - { repos: [acme/knowledge] }\n');
  const [refused] = settingsIn(noPattern, [{}]);
  assert.match(refused.error, /config\.yaml: skip_commits takes a pattern or \{ pattern: "<regex>", repos: \[<substring>, …\] \}; got: \{"repos":\["acme\/knowledge"\]\}$/);
});

test('places: collect refuses a bad --day-starts or a missing --config before any source runs', () => {
  const dir = installation((t) => t);
  const time = tool(dir, 'footprint', ['collect', ...PERIOD, '--github', 'ada', '--source', 'github', '--day-starts', '7am'], GITHUB_ENV);
  assert.equal(time.status, 1, time.output);
  assert.match(time.stderr, /--day-starts takes HH:MM; got: 7am/);
  const config = tool(dir, 'footprint', ['collect', ...PERIOD, '--github', 'ada', '--source', 'github', '--config', 'missing.yaml'], GITHUB_ENV);
  assert.equal(config.status, 1, config.output);
  assert.match(config.stderr, /--config missing\.yaml: no such file/);
  assertNoCrashNoRequest(time);
  assertNoCrashNoRequest(config);
});

// == gitlab ==

const GL = 'https://gitlab.example.com/api/v4';
const GITLAB_ENV = { GITLAB_URL: 'https://gitlab.example.com', GITLAB_TOKEN: 'glpat-fake' };

test('gitlab: events by kind and day, merge requests from x-total, the breakdown per project, a hidden project by id', () => {
  const dir = installation(withGitlab);
  const r = collect(dir, [
    { url: `${GL}/users?username=ada`, body: [{ id: 7, username: 'ada', name: 'Ada' }] },
    { match: `^${GL}/users/7/events\\?`, body: [
      { action_name: 'pushed to', target_type: null, project_id: 11, created_at: '2026-02-27T10:00:00.000Z', push_data: { commit_count: 9 } },
      { action_name: 'pushed to', target_type: null, project_id: 11, created_at: '2026-03-02T09:00:00.000Z', push_data: { commit_count: 3 } },
      { action_name: 'opened', target_type: 'MergeRequest', project_id: 11, created_at: '2026-03-02T10:00:00.000Z' },
      { action_name: 'approved', target_type: 'MergeRequest', project_id: 12, created_at: '2026-03-03T10:00:00.000Z' },
      { action_name: 'commented on', target_type: 'DiffNote', project_id: 12, created_at: '2026-03-03T11:00:00.000Z' },
      { action_name: 'accepted', target_type: 'MergeRequest', project_id: 13, created_at: '2026-03-04T10:00:00.000Z' },
    ] },
    { match: `^${GL}/merge_requests\\?.*author_username=ada`, body: [], headers: { 'x-total': '4' } },
    { match: `^${GL}/merge_requests\\?.*reviewer_username=ada`, body: [], headers: { 'x-total': '2' } },
    { url: `${GL}/projects/11`, body: { path_with_namespace: 'acme/backend' } },
    { url: `${GL}/projects/12`, status: 404, body: { message: '404 Project Not Found' } },
    { url: `${GL}/projects/13`, status: 403, body: { message: '403 Forbidden' } },
  ], ['--gitlab', 'ada', '--source', 'gitlab', '--tz', 'UTC'], GITLAB_ENV);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  const t = totals(r.report, 'gitlab');
  assert.equal(t.events, 5);
  assert.equal(t['commits pushed'], 3);
  assert.equal(t.pushes, 1);
  assert.equal(t['merge requests opened'], 1);
  assert.equal(t['merge requests merged by them'], 1);
  assert.equal(t['merge requests approved'], 1);
  assert.equal(t.comments, 1);
  assert.equal(t['merge requests authored (created in the period)'], 4);
  assert.equal(t['merge requests as reviewer (created in the period)'], 2);
  assert.equal(day(r.report, '2026-03-02').bySource.gitlab, 2);
  assert.equal(day(r.report, '2026-03-03').bySource.gitlab, 2);
  assert.deepEqual(r.report.sources[0].breakdown.rows, [
    ['acme/backend', 2, 3, 1, 0, 0, 0], ['project 12', 2, 0, 0, 0, 1, 1], ['project 13', 1, 0, 0, 1, 0, 0],
  ]);
  const events = r.calls.find((c) => /\/events\?/.test(c.url));
  assert.match(events.url, /after=2026-02-27&before=2026-03-09&sort=asc/);
  // The API bounds are an hour wider than the period on each side (a daylight-saving change).
  assert.match(r.calls.find((c) => /author_username/.test(c.url)).url, /created_after=2026-02-28T23%3A00%3A00\.000Z&created_before=2026-03-08T01%3A00%3A00\.000Z/);
  assert.match(notesOf(r.report, 'gitlab'), /2 project\(s\) could not be looked up \(deleted, or no access\): shown by id, they fall into the default place/);
});

test('gitlab: a push event that removed a ref is a branch or tag deleted, not "deleted Project"', () => {
  const dir = installation(withGitlab);
  const push = (action, data) => ({ action_name: action, target_type: null, project_id: 11, created_at: '2026-03-02T09:00:00.000Z', push_data: data });
  const r = collect(dir, [
    { url: `${GL}/users?username=ada`, body: [{ id: 7, username: 'ada', name: 'Ada' }] },
    { match: `^${GL}/users/7/events\\?`, body: [
      push('deleted', { action: 'removed', ref_type: 'branch', commit_count: 0 }),
      { ...push('deleted', { action: 'removed', ref_type: 'branch', commit_count: 0 }), target_type: 'Project' },
      push('deleted', { action: 'removed', ref_type: 'tag', commit_count: 0 }),
      push('pushed new', { action: 'created', ref_type: 'branch', commit_count: 2 }),
      { action_name: 'deleted', target_type: 'Project', project_id: 11, created_at: '2026-03-02T10:00:00.000Z' },
    ] },
    { match: `^${GL}/merge_requests\\?`, body: [], headers: { 'x-total': '0' } },
    { url: `${GL}/projects/11`, body: { path_with_namespace: 'acme/backend' } },
  ], ['--gitlab', 'ada', '--source', 'gitlab', '--tz', 'UTC'], GITLAB_ENV);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  const t = totals(r.report, 'gitlab');
  assert.deepEqual([t['branches deleted'], t['tags deleted'], t.pushes, t['commits pushed'], t['deleted Project']], [2, 1, 1, 2, 1]);
});

/** A GitLab client answering `answers` ([regexp of the path, body or an Error]) in-process; every path asked is recorded. */
function fakeGitlab(answers) {
  const calls = [];
  const find = (path) => {
    calls.push(path);
    const hit = answers.find(([pattern]) => pattern.test(path));
    if (!hit) throw new Error(`no answer for ${path}`);
    if (hit[1] instanceof Error) throw hit[1];
    return typeof hit[1] === 'function' ? hit[1](path) : hit[1];
  };
  const g = {
    base: 'https://gitlab.example.com',
    get: async (path) => find(path),
    paged: async (path) => find(path),
    api: async (path) => ({ data: find(path), headers: new Headers({ 'x-total': '0' }) }),
  };
  return { calls, g };
}

test('gitlab: others\' merge requests merged, approved and commented on — their author read once, the lines of those approved or merged once from /diffs (else /changes); a comment alone no review; each event its kind, what, where, pr', async () => {
  const mrEvent = (action, iid, at, extra = {}) => ({ action_name: action, target_type: 'MergeRequest', target_iid: iid, project_id: 12, created_at: at, ...extra });
  const note = (iid, type, at) => ({ action_name: 'commented on', target_type: 'DiffNote', project_id: 12, created_at: at, note: { noteable_type: type, noteable_iid: iid } });
  let limitedOnce = false;
  const { calls, g } = fakeGitlab([
    [/^\/users\?username=ada$/, [{ id: 7, username: 'ada' }]],
    [/^\/users\/7\/events\?/, [
      mrEvent('opened', 6, '2026-03-02T09:00:00.000Z'), mrEvent('approved', 5, '2026-03-02T10:00:00.000Z'), note(5, 'MergeRequest', '2026-03-02T11:00:00.000Z'),
      mrEvent('approved', 6, '2026-03-02T12:00:00.000Z'), mrEvent('accepted', 5, '2026-03-03T10:00:00.000Z'), note(8, 'MergeRequest', '2026-03-04T10:00:00.000Z'),
      note(3, 'Issue', '2026-03-04T11:00:00.000Z'), mrEvent('approved', 8, '2026-03-04T12:00:00.000Z'), note(9, 'MergeRequest', '2026-03-05T10:00:00.000Z'),
    ]],
    [/^\/projects\/12$/, { path_with_namespace: 'acme/backend' }],
    [/^\/projects\/12\/merge_requests\/5$/, { author: { username: 'bob' } }],
    [/^\/projects\/12\/merge_requests\/6$/, { author: { username: 'Ada' } }],
    [/^\/projects\/12\/merge_requests\/8$/, { author: { username: 'carol' } }],
    // carol's, only commented on: read for its author once GitLab's rate limit is waited out; its diff never.
    [/^\/projects\/12\/merge_requests\/9$/, (path) => {
      if (limitedOnce) return { author: { username: 'carol' } };
      limitedOnce = true;
      throw new HttpError(429, path, 'Retry later', new Headers({ 'retry-after': '0' }));
    }],
    [/^\/projects\/12\/merge_requests\/5\/diffs$/, [{ diff: '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n' }, { diff: '', too_large: true }]],
    [/^\/projects\/12\/merge_requests\/8\/diffs$/, new UsageError('not found, or no access (GitLab answers 404 for both)')],
    [/^\/projects\/12\/merge_requests\/8\/changes$/, { overflow: true, changes: [{ diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n' }] }],
    [/^\/merge_requests\?/, []],
  ]);
  const result = await collectGitlab(g, { username: 'ada', since: SINCE, until: UNTIL, tz: 'UTC' }, { rateLimitPauseMs: 0 });
  assert.equal(result.site, 'https://gitlab.example.com');
  const t = Object.fromEntries(result.totals);
  assert.deepEqual([t["others' merge requests merged by them"], t["others' merge requests approved"], t["others' merge requests reviewed or merged"],
    t['reviewed volume (their lines, once per merge request)']], [1, 2, 2, '+3 −2']);
  assert.equal(calls.filter((c) => /merge_requests\/5\/diffs/.test(c)).length, 1);
  assert.ok(!calls.some((c) => /merge_requests\/9\/(diffs|changes)/.test(c)), 'no diff of a merge request only commented on');
  assert.deepEqual(calls.filter((c) => /merge_requests\/\d+$/.test(c)).sort(),
    ['/projects/12/merge_requests/5', '/projects/12/merge_requests/6', '/projects/12/merge_requests/8', '/projects/12/merge_requests/9', '/projects/12/merge_requests/9']);
  const url = (iid) => `https://gitlab.example.com/acme/backend/-/merge_requests/${iid}`;
  const mine = (at, kind, iid) => ({ at, kind, what: `acme/backend!${iid}`, where: 'acme/backend', pr: url(iid) });
  const theirs = (at, kind, iid, reviewed) => ({ ...mine(at, kind, iid), others: true, ...(reviewed ? { reviewed } : {}) });
  assert.deepEqual(result.events, [
    mine('2026-03-02T09:00:00.000Z', 'mr opened', 6),
    theirs('2026-03-02T10:00:00.000Z', 'mr approved', 5, [2, 1]),
    theirs('2026-03-02T11:00:00.000Z', 'comment', 5),
    mine('2026-03-02T12:00:00.000Z', 'mr approved', 6),
    theirs('2026-03-03T10:00:00.000Z', 'mr merged', 5, [2, 1]),
    theirs('2026-03-04T10:00:00.000Z', 'comment', 8),
    { at: '2026-03-04T11:00:00.000Z', kind: 'comment', what: 'acme/backend#3', where: 'acme/backend' },
    theirs('2026-03-04T12:00:00.000Z', 'mr approved', 8, [1, 1]),
    theirs('2026-03-05T10:00:00.000Z', 'comment', 9),
  ]);
  assert.deepEqual(result.breakdown.wheres, ['acme/backend']);
  const notes = result.notes.join('\n');
  assert.match(notes, /1 file\(s\) in 1 merge request\(s\) have a diff GitLab does not show/);
  assert.match(notes, /GitLab cut the diff of 1 merge request\(s\) it gave through \/changes \(overflow\): the reviewed volume is a lower bound/);
  assert.match(notes, /GitLab's rate limit was met 1 time\(s\): waited 0 s in all/);
  assert.match(notes, /a comment alone is no review and carries no lines/);
});

test('a source whose connector is not listed is not collected, and makes no request; --repos is not looked into without git', () => {
  const dir = installation((t) => t); // the fixture lists github, jira and confluence, not gitlab
  const r = tool(dir, 'footprint', ['collect', ...PERIOD, '--gitlab', 'ada', '--source', 'gitlab', '--repos', join(dir, 'no-such-folder')], GITLAB_ENV);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stdout, /^- gitlab: not collected — connector gitlab is not listed in oikos\.yaml/m);
  assert.match(r.stderr, /no source ran/);
  assertNoCrashNoRequest(r);
});

// == jira ==

const SITE = 'https://acme.atlassian.net';
const JIRA = `${SITE}/rest/api/3`;
const JIRA_ENV = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };

/**
 * A client whose `get` answers from `routes` (the fake-fetch routes: `url` or `match` against the
 * site's URL, GET only), for a source called in-process; every path asked is recorded in `calls`.
 */
function fakeClient(site, routes) {
  const calls = [];
  const get = async (path) => {
    const url = path.startsWith('http') ? path : `${site}${path}`;
    calls.push(url);
    const route = routes.find((r) => (r.method || 'GET') === 'GET' && (r.url !== undefined ? r.url === url : new RegExp(r.match).test(url)));
    if (!route) throw new Error(`no route for ${url}`);
    if (route.status >= 400) throw new HttpError(route.status, url, JSON.stringify(route.body));
    return route.body;
  };
  return { calls, client: { get, post: async () => { throw new Error('no POST expected'); } } };
}

const CANDIDATES_JQL = `updated >= "2026-02-28" AND (creator = "${ACCOUNT}" OR reporter = "${ACCOUNT}" OR assignee WAS "${ACCOUNT}" `
  + `OR watcher = "${ACCOUNT}" OR status CHANGED BY "${ACCOUNT}" OR worklogAuthor = "${ACCOUNT}")`;
const issue = (key, summary, created, creator) => ({ key, fields: { summary, project: { key: key.split('-')[0] }, created, creator: { accountId: creator } } });
const change = (author, created, field) => ({ author: { accountId: author }, created, items: [{ field }] });
/**
 * The person's week in Jira: PROJ-1 created by them, moved and edited (and moved by someone else);
 * PROJ-2 edited by them (the changelog over two pages) and resolved by someone else, commented and
 * logged on; OPS-3 a candidate with nothing of theirs.
 */
const JIRA_ROUTES = [
  { match: `^${JIRA}/search/jql\\?jql=updated.*&nextPageToken=tok1$`, body: { issues: [issue('OPS-3', 'Rotate keys', '2026-03-02T08:00:00.000+0100', 'someone-else')] } },
  { match: `^${JIRA}/search/jql\\?jql=updated`, body: { nextPageToken: 'tok1', issues: [
    issue('PROJ-1', 'Login page', '2026-03-02T09:15:00.000+0100', ACCOUNT), issue('PROJ-2', 'Fix build', '2026-01-10T09:00:00.000+0100', 'someone-else'),
  ] } },
  { match: `^${JIRA}/issue/PROJ-1/changelog\\?`, body: { total: 3, values: [
    change(ACCOUNT, '2026-03-02T10:00:00.000+0100', 'status'), change(ACCOUNT, '2026-03-03T11:00:00.000+0100', 'summary'),
    change('someone-else', '2026-03-03T12:00:00.000+0100', 'status'),
  ] } },
  { match: `^${JIRA}/issue/PROJ-2/changelog\\?startAt=0&`, body: { total: 2, isLast: false, values: [change(ACCOUNT, '2026-03-04T10:00:00.000+0100', 'labels')] } },
  { match: `^${JIRA}/issue/PROJ-2/changelog\\?startAt=1&`, body: { total: 2, isLast: true, values: [change('someone-else', '2026-03-04T16:00:00.000+0100', 'resolution')] } },
  { match: `^${JIRA}/issue/PROJ-2/comment\\?`, body: { total: 2, comments: [
    { author: { accountId: ACCOUNT }, created: '2026-03-04T12:00:00.000+0100' }, { author: { accountId: 'someone-else' }, created: '2026-03-04T13:00:00.000+0100' },
  ] } },
  { match: `^${JIRA}/issue/PROJ-2/worklog\\?`, body: { total: 2, worklogs: [
    { author: { accountId: ACCOUNT }, created: '2026-03-05T18:00:00.000+0100', started: '2026-03-03T09:00:00.000+0100', timeSpentSeconds: 27000 },
    { author: { accountId: 'someone-else' }, created: '2026-03-05T18:00:00.000+0100', started: '2026-03-03T09:00:00.000+0100', timeSpentSeconds: 3600 },
  ] } },
  { match: `^${JIRA}/issue/[^/]+/(changelog|comment|worklog)\\?`, body: { total: 0, values: [], comments: [], worklogs: [] } },
];

test('jira: the candidate issues (paged by nextPageToken), on each the person\'s changelog, comments and worklogs — no count query, no resolved, no "not searchable" note', () => {
  const dir = installation((t) => t);
  const r = collect(dir, JIRA_ROUTES, ['--atlassian', ACCOUNT, '--source', 'jira', '--tz', 'Europe/Zurich'], JIRA_ENV);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.deepEqual(totals(r.report, 'jira'), {
    'issues created': 1, 'status changes': 1, edits: 2, comments: 1, worklogs: 1, 'hours logged': 7.5, 'issues acted on': 2,
  });
  assert.ok(!r.calls.some((c) => c.method === 'POST'), 'no approximate-count');
  const searches = r.calls.filter((c) => /\/search\/jql\?/.test(c.url));
  assert.deepEqual(searches.map((c) => new URL(c.url).searchParams.get('jql')), [CANDIDATES_JQL, CANDIDATES_JQL]);
  assert.equal(new URL(searches[0].url).searchParams.get('fields'), 'summary,project,created,creator');
  assert.equal(r.calls.filter((c) => /PROJ-2\/changelog/.test(c.url)).length, 2);
  assert.deepEqual(r.report.sources[0].breakdown.rows, [['PROJ', 1, 1, 2, 1, 1, 7.5]]);
  assert.deepEqual(r.report.sources[0].breakdown.places, ['ACME Corp']);
  assert.equal(day(r.report, '2026-03-03').hours['jira logged'], 7.5);
  const notes = notesOf(r.report, 'jira');
  assert.doesNotMatch(notes, /not searchable|not laid on days/);
  assert.match(notes, /3 issue\(s\) read: updated since 2026-02-28 .* an action on an issue outside these .* is missed/);
  assert.match(notes, /which issues are read depends on their state now .*: a later run can find more actions on older days/);
});

test('jira: an issue that answers 404 or 403 is skipped and named; a 429 is waited out once with its retry-after', async () => {
  let limited = 0;
  const routes = [
    { match: `^${JIRA}/search/jql\\?`, body: { issues: [issue('PROJ-1', 'Login page', '2026-03-02T09:15:00.000+0100', ACCOUNT), issue('PROJ-7', 'Gone', '2026-03-02T09:00:00.000+0100', ACCOUNT),
      issue('SEC-1', 'Hidden', '2026-03-02T09:00:00.000+0100', ACCOUNT)] } },
    { match: `^${JIRA}/issue/PROJ-7/`, status: 404, body: { errorMessages: ['Issue does not exist'] } },
    { match: `^${JIRA}/issue/SEC-1/`, status: 403, body: { errorMessages: ['No permission'] } },
    ...JIRA_ROUTES.slice(2),
  ];
  const { client } = fakeClient(SITE, routes);
  const get = client.get;
  client.get = async (path) => {
    if (/PROJ-1\/comment/.test(path) && limited === 0) {
      limited += 1;
      throw new HttpError(429, path, 'Too many requests', new Headers({ 'retry-after': '0' }));
    }
    return get(path);
  };
  const result = await collectJira(client, { who: ACCOUNT, since: SINCE, until: UNTIL, tz: 'Europe/Zurich' }, { rateLimitPauseMs: 0 });
  assert.deepEqual(result.events.map((e) => [e.kind, e.what.split(' ')[0]]), [['created', 'PROJ-1'], ['status', 'PROJ-1'], ['edit', 'PROJ-1']]);
  const notes = result.notes.join('\n');
  assert.match(notes, /^2 issue\(s\) could not be read \(404 deleted or moved, 403 no access\) and are left out: PROJ-7 \(404\), SEC-1 \(403\)$/m);
  assert.match(notes, /^Jira's rate limit was met 1 time\(s\): waited 0 s in all$/m);
});

test('jira: each action an event of the person at its instant — created, status, edit, comment, worklog at its writing; kind, what, where', async () => {
  const { client } = fakeClient(SITE, JIRA_ROUTES);
  const result = await collectJira(client, { who: ACCOUNT, since: SINCE, until: UNTIL, tz: 'Europe/Zurich' });
  const ev = (at, kind, key, summary) => ({ at, kind, what: `${key} ${summary}`, where: key.split('-')[0] });
  assert.deepEqual(result.events, [
    ev('2026-03-02T09:15:00.000+01:00', 'created', 'PROJ-1', 'Login page'),
    ev('2026-03-02T10:00:00.000+01:00', 'status', 'PROJ-1', 'Login page'),
    ev('2026-03-03T11:00:00.000+01:00', 'edit', 'PROJ-1', 'Login page'),
    ev('2026-03-04T10:00:00.000+01:00', 'edit', 'PROJ-2', 'Fix build'),
    ev('2026-03-04T12:00:00.000+01:00', 'comment', 'PROJ-2', 'Fix build'),
    ev('2026-03-05T18:00:00.000+01:00', 'worklog', 'PROJ-2', 'Fix build'),
  ]);
  assert.deepEqual([...result.hours], [['2026-03-03', 7.5]]);
  // Working days from 11:30 and the period from the 3rd: the edit at 11:00 on the 3rd is the 2nd's working day, out;
  // the edit at 10:00 on the 4th is the 3rd's, in. The worklog started 09:00 on the 3rd keeps its hours on that
  // calendar date, as a timesheet does, so they are in.
  const late = await collectJira(fakeClient(SITE, JIRA_ROUTES).client, { who: ACCOUNT, since: '2026-03-03', until: UNTIL, tz: 'Europe/Zurich', dayStartsMin: 11 * 60 + 30 });
  assert.deepEqual(late.events.map((e) => [e.kind, e.at.slice(0, 16)]), [['edit', '2026-03-04T10:00'], ['comment', '2026-03-04T12:00'], ['worklog', '2026-03-05T18:00']]);
  assert.deepEqual([...late.hours], [['2026-03-03', 7.5]]);
  // A period that ends on the 2nd: the worklog started on the 3rd has its hours outside it.
  const before = await collectJira(fakeClient(SITE, JIRA_ROUTES).client, { who: ACCOUNT, since: SINCE, until: '2026-03-02', tz: 'Europe/Zurich' });
  assert.equal(before.hours.size, 0);
});

// == confluence ==

const WIKI = `${SITE}/wiki/rest/api`;
const userSearch = (name) => `${WIKI}/search/user?cql=${encodeURIComponent(`user.fullname~"${name}"`)}&limit=20`;

test('confluence: the account through its own user search, created pages with words over two result pages, an edit per version the person saved in the period (v1, else v2), never the creation', () => {
  const dir = installation((t) => t);
  const page = (id, space, fields) => ({ id, space: { key: space, name: `${space} space` }, ...fields });
  const created = (date, html) => ({ history: { createdDate: date }, body: { storage: { value: html } } });
  const version = (number, when, by) => ({ version: { number, when, by: { accountId: by } } });
  const r = collect(dir, [
    { url: userSearch('Ada Lovelace'), body: { results: [
      { user: { accountId: ACCOUNT, displayName: 'Ada Lovelace', accountType: 'atlassian' } },
      { user: { accountId: 'app-1', displayName: 'Ada Lovelace bot', accountType: 'app' } },
    ] } },
    // `_links.next` is relative to <site>/wiki.
    { match: `^${WIKI}/content/search\\?cql=next&cursor=c1$`, body: { results: [page('3', 'ENG', created('2026-03-04T09:00:00.000Z', '<p>three more words</p>'))], _links: {} } },
    { match: `^${WIKI}/content/search\\?cql=[^&]*creator`, body: {
      results: [
        page('1', 'ENG', created('2026-03-02T09:00:00.000Z', '<p>Hello <b>world</b> &amp; more</p>')),
        page('2', 'OPS', created('2026-03-03T09:00:00.000Z', '<p>one two</p>')),
      ],
      _links: { next: '/rest/api/content/search?cql=next&cursor=c1' },
    } },
    { match: `^${WIKI}/content/search\\?cql=[^&]*contributor`, body: { results: [
      page('1', 'ENG', version(1, '2026-03-02T09:00:00.000Z', ACCOUNT)), // created in the period, not edited since
      page('2', 'OPS', version(3, '2026-03-05T10:00:00.000Z', ACCOUNT)),
      page('9', 'HR', version(4, '2026-03-06T10:00:00.000Z', 'someone-else')),
      page('8', 'ENG', version(2, '2026-03-06T11:00:00.000Z', ACCOUNT)),
    ] } },
    // The versions, newest first: page 1 only its creation; page 2 two edits; page 9 through v2 (v1 gone), one of theirs;
    // page 8 one edit, and its next page not read since this one already reaches before the period.
    { match: `^${WIKI}/content/1/version\\?`, body: { results: [{ number: 1, by: { accountId: ACCOUNT }, when: '2026-03-02T09:00:00.000Z' }] } },
    { match: `^${WIKI}/content/2/version\\?`, body: { results: [
      { number: 3, by: { accountId: ACCOUNT }, when: '2026-03-05T10:00:00.000Z' }, { number: 2, by: { accountId: ACCOUNT }, when: '2026-03-04T10:00:00.000Z' },
      { number: 1, by: { accountId: ACCOUNT }, when: '2026-03-03T09:00:00.000Z' },
    ] } },
    { match: `^${WIKI}/content/9/version\\?`, status: 404, body: { message: 'gone' } },
    { match: `^${SITE}/wiki/api/v2/pages/9/versions\\?`, body: { results: [
      { number: 4, authorId: 'someone-else', createdAt: '2026-03-06T10:00:00.000Z' }, { number: 3, authorId: ACCOUNT, createdAt: '2026-03-06T09:00:00.000Z' },
    ] } },
    { match: `^${WIKI}/content/8/version\\?start=0&`, body: { results: [
      { number: 2, by: { accountId: ACCOUNT }, when: '2026-03-06T11:00:00.000Z' }, { number: 1, by: { accountId: 'someone-else' }, when: '2026-02-01T09:00:00.000Z' },
    ], _links: { next: '/rest/api/content/8/version?start=2' } } },
  ], ['--atlassian', 'Ada Lovelace', '--source', 'confluence', '--tz', 'UTC'], JIRA_ENV);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.deepEqual(totals(r.report, 'confluence'), {
    'pages created': 3, 'words in them': 8, 'page edits': 4, 'pages edited': 3, spaces: 3,
  });
  assert.deepEqual(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'].map((d) => day(r.report, d).bySource.confluence), [1, 1, 2, 1, 2]);
  assert.deepEqual(r.report.sources[0].breakdown.header, ['Space', 'Created', 'Words', 'Edits', 'Pages edited']);
  assert.deepEqual(r.report.sources[0].breakdown.rows, [['ENG ENG space', 2, 6, 1, 1], ['OPS OPS space', 1, 2, 2, 1], ['HR HR space', 0, 0, 1, 1]]);
  assert.deepEqual(r.report.sources[0].breakdown.places, ['ACME Corp', 'ACME Corp', 'ACME Corp']);
  assert.ok(!r.calls.some((c) => /content\/8\/version\?start=2/.test(c.url)), 'no version page before the period');
  const cql = r.calls.filter((c) => /\/content\/search\?/.test(c.url)).map((c) => new URL(c.url).searchParams.get('cql')).filter((q) => q !== 'next');
  // A day of slack before the period (CQL reads dates in the account's zone); the working days keep it exact.
  assert.deepEqual(cql, [
    `type in (page, blogpost) AND creator = "${ACCOUNT}" AND created >= "2026-02-28" AND created < "2026-03-08"`,
    `type in (page, blogpost) AND contributor = "${ACCOUNT}" AND lastmodified >= "2026-02-28"`,
  ]);
  assert.ok(!r.calls.some((c) => /\/rest\/api\/3\//.test(c.url)), 'no Jira endpoint');
  assert.match(notesOf(r.report, 'confluence'), /an edit is a version the person saved in the period \(version 1 is the creation, not an edit\); .* \(at most 500\)/);
});

test('confluence: a page created the day before the period is left out; versions v1 gave before failing are not counted again from v2', async () => {
  const { client } = fakeClient(SITE, [
    { match: `^${WIKI}/content/search\\?cql=[^&]*creator`, body: { results: [
      { id: '1', title: 'Early', space: { key: 'ENG' }, history: { createdDate: '2026-02-28T22:00:00.000Z' }, body: { storage: { value: '<p>a</p>' } } },
      { id: '2', title: 'In', space: { key: 'ENG' }, history: { createdDate: '2026-03-01T08:00:00.000Z' }, body: { storage: { value: '<p>a</p>' } } },
    ] } },
    { match: `^${WIKI}/content/search\\?cql=[^&]*contributor`, body: { results: [{ id: '3', title: 'Edited', space: { key: 'OPS' } }] } },
    // v1 gives a first page, then is gone (410) on the next one: v2 is read from the start.
    { match: `^${WIKI}/content/3/version\\?start=0&`, body: { results: [{ number: 3, by: { accountId: ACCOUNT }, when: '2026-03-04T09:00:00.000Z' }], _links: { next: '/rest/api/content/3/version?start=1' } } },
    { match: `^${WIKI}/content/3/version\\?start=1&`, status: 410, body: { message: 'gone' } },
    { match: `^${SITE}/wiki/api/v2/pages/3/versions\\?`, body: { results: [
      { number: 3, authorId: ACCOUNT, createdAt: '2026-03-04T09:00:00.000Z' }, { number: 2, authorId: ACCOUNT, createdAt: '2026-03-03T09:00:00.000Z' },
    ] } },
  ]);
  const result = await collectConfluence(client, { who: ACCOUNT, since: SINCE, until: UNTIL, tz: 'UTC' });
  assert.deepEqual(result.events.map((e) => [e.kind, e.what]), [['page created', 'ENG: In'], ['page edited', 'OPS: Edited'], ['page edited', 'OPS: Edited']]);
  assert.equal(Object.fromEntries(result.totals)['page edits'], 2);
});

test('confluence: a page created and a page edited are events with the space as where and "SPACE: title" as what', async () => {
  const { client } = fakeClient(SITE, [
    { match: `^${WIKI}/content/search\\?cql=[^&]*creator`, body: { results: [
      { id: '1', title: 'Runbook', space: { key: 'ENG' }, history: { createdDate: '2026-03-02T09:00:00.000Z' }, body: { storage: { value: '<p>a b</p>' } } },
    ] } },
    { match: `^${WIKI}/content/search\\?cql=[^&]*contributor`, body: { results: [{ id: '2', title: 'On call', space: { key: 'OPS' } }] } },
    { match: `^${WIKI}/content/2/version\\?`, body: { results: [{ number: 2, by: { accountId: ACCOUNT }, when: '2026-03-03T09:00:00.000Z' }] } },
  ]);
  const result = await collectConfluence(client, { who: ACCOUNT, since: SINCE, until: UNTIL, tz: 'UTC' });
  assert.deepEqual(result.events, [
    { at: '2026-03-02T09:00:00.000Z', kind: 'page created', what: 'ENG: Runbook', where: 'ENG' },
    { at: '2026-03-03T09:00:00.000Z', kind: 'page edited', what: 'OPS: On call', where: 'OPS' },
  ]);
});

test('confluence: an email is resolved through Jira\'s user search where jira is listed', () => {
  const dir = installation((t) => t);
  const r = collect(dir, [
    { url: `${JIRA}/user/search?query=ada%40acme.example`, body: [{ accountId: ACCOUNT, displayName: 'Ada Lovelace', accountType: 'atlassian' }] },
    { match: `^${WIKI}/content/search\\?`, body: { results: [] } },
  ], ['--atlassian', 'ada@acme.example', '--source', 'confluence'], JIRA_ENV);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.equal(r.report.sources[0].label, `Confluence ${ACCOUNT}`);
  assert.ok(r.calls.some((c) => new URL(c.url).searchParams.get('cql')?.includes(`creator = "${ACCOUNT}"`)));
  assert.ok(!r.calls.some((c) => /\/search\/user\?/.test(c.url)), 'not Confluence\'s user search');
});

test('confluence: an email is refused with the way to the account id where jira is not listed, before any request', () => {
  const dir = installation((t) => t.replace('task-tracking: [jira]', 'task-tracking: []'));
  const r = collect(dir, [], ['--atlassian', 'ada@acme.example', '--source', 'confluence'], JIRA_ENV);
  assert.equal(r.status, 1, r.output);
  assert.equal(r.report.skipped[0].source, 'confluence');
  assert.match(r.report.skipped[0].reason, /Confluence does not find people by email .*no Jira to ask.*--atlassian <accountId>/);
  assertNoCrashNoRequest(r);
});

// == github ==

const GITHUB_ENV = { GITHUB_TOKEN: 'ghp_fake_token' };
const GRAPHQL_URL = 'https://api.github.com/graphql';
/** A pull request node as the queries select it. */
const pullRequest = (id, repo, fields) => ({
  id, url: `https://github.com/${repo}/pull/${id.replace(/\D/g, '')}`, repository: { nameWithOwner: repo }, updatedAt: '2026-03-08T00:00:00Z',
  merged: false, mergedAt: null, mergedBy: null, additions: 0, deletions: 0,
  reviews: { totalCount: 0, nodes: [] }, commits: { totalCount: 0, nodes: [] }, ...fields,
});
const prCommit = (oid, login, authoredDate) => ({ commit: { oid, authoredDate, author: { user: login ? { login } : null } } });
const searchPage = (nodes, issueCount = nodes.length) => ({ search: { issueCount, pageInfo: { hasNextPage: false, endCursor: null }, nodes } });
/** One page of a repository's pull requests, newest-updated first; `endCursor` null on the last. */
const repoPage = (nodes, endCursor = null) => ({ repository: { pullRequests: { pageInfo: { hasNextPage: Boolean(endCursor), endCursor }, nodes } } });
/** A repository in the probe: its latest-updated pull request and the person's issues (created at). */
const probed = (latest, issues = []) => ({ pullRequests: { nodes: latest ? [{ updatedAt: latest }] : [] }, issues: { totalCount: issues.length, nodes: issues.map((createdAt) => ({ createdAt })) } });
/** The person's pull-request work in the week: opened and merged by another, reviewed and merged, out of the period, not theirs. */
const WEEK_PULLS = [
  // Opened by ada, merged by bob: ada's commit on it, bob's not hers.
  pullRequest('PR1', 'acme-corp/web', {
    author: { login: 'ada' }, createdAt: '2026-03-02T09:00:00Z', merged: true, mergedAt: '2026-03-03T10:00:00Z', mergedBy: { login: 'bob' },
    additions: 10, deletions: 2,
    commits: { totalCount: 2, nodes: [prCommit('c1', 'ada', '2026-03-02T08:00:00Z'), prCommit('c2', 'bob', '2026-03-02T08:30:00Z')] },
  }),
  // bob's, reviewed by ada (one review at 23:30 UTC: the next day in Zurich) and merged by her; c1 again (a stacked branch).
  pullRequest('PR2', 'acme-corp/api', {
    author: { login: 'bob' }, createdAt: '2026-02-20T09:00:00Z', updatedAt: '2026-03-05T12:00:00Z', merged: true, mergedAt: '2026-03-05T12:00:00Z', mergedBy: { login: 'Ada' },
    additions: 40, deletions: 5,
    reviews: { totalCount: 3, nodes: [
      { submittedAt: '2026-03-04T10:00:00Z', state: 'APPROVED' }, { submittedAt: '2026-03-03T23:30:00Z', state: 'COMMENTED' }, { submittedAt: null, state: 'PENDING' },
    ] },
    commits: { totalCount: 2, nodes: [prCommit('c1', 'ada', '2026-03-02T08:00:00Z'), prCommit('c3', 'ada', '2026-03-04T09:00:00Z')] },
  }),
  // ada's, opened before the period and merged by her after it: nothing of it is in the week.
  pullRequest('PR3', 'acme-corp/web', {
    author: { login: 'ada' }, createdAt: '2026-02-10T09:00:00Z', updatedAt: '2026-03-10T09:00:00Z', merged: true, mergedAt: '2026-03-10T09:00:00Z', mergedBy: { login: 'ada' },
    additions: 7, deletions: 7, commits: { totalCount: 1, nodes: [prCommit('c4', 'ada', '2026-02-11T09:00:00Z')] },
  }),
  // carol's, merged by ada without a review of hers.
  pullRequest('PR4', 'acme-corp/web', {
    author: { login: 'carol' }, createdAt: '2026-03-01T09:00:00Z', merged: true, mergedAt: '2026-03-06T09:00:00Z', mergedBy: { login: 'ada' },
    additions: 3, deletions: 1,
  }),
];
const [PR1, PR2, PR3, PR4] = WEEK_PULLS;
/** carol's, merged by bob: nothing of ada's on it. */
const NOT_HERS = pullRequest('PR5', 'acme-corp/web', {
  author: { login: 'carol' }, createdAt: '2026-03-02T09:00:00Z', merged: true, mergedAt: '2026-03-04T09:00:00Z', mergedBy: { login: 'bob' }, additions: 99, deletions: 9,
  commits: { totalCount: 1, nodes: [prCommit('c9', 'carol', '2026-03-02T08:00:00Z')] },
});
/** Updated long before the period: where a repository's reading stops. */
const oldPullRequest = (id, repo) => pullRequest(id, repo, { author: { login: 'ada' }, createdAt: '2025-12-01T09:00:00Z', updatedAt: '2026-01-01T09:00:00Z' });
/** The week's totals, whichever route read the pull requests. */
const WEEK_TOTALS = {
  'pull requests opened': 1, 'pull requests opened, merged since': 1, 'pull request lines': '+10 −2', 'pull requests merged by them': 2,
  reviews: 2, 'reviews by state': 'approved 1, commented 1', 'reviews on own pull requests': 0, "others' pull requests reviewed": 1,
  "others' pull requests merged by them": 2, "others' pull requests reviewed or merged": 2,
  'reviewed volume (their lines, once per pull request)': '+40 −5', 'reviewed or merged volume (their lines, once per pull request)': '+43 −6',
  'comments on pull requests': 0, 'commits in pull requests': 2,
};
const ORG_REPOS = 'https://api.github.com/orgs/acme-corp/repos?type=all&per_page=100';

test('github with GITHUB_ORG: the repositories over two pages, a probe, each active one\'s pull requests until older than the period; the totals on local days; no search', () => {
  const dir = installation((t) => t);
  const pulls = (name, after, body) => ({ graphql: 'OikosFootprintRepoPulls', variables: { name, after }, body: { data: body } });
  const r = collect(dir, [
    { url: ORG_REPOS, headers: { link: `<${ORG_REPOS}&page=2>; rel="next"` }, body: [{ name: 'web' }, { name: 'api' }] },
    { url: `${ORG_REPOS}&page=2`, body: [{ name: 'old', archived: true }] },
    { graphql: 'OikosFootprintProbe', body: { data: {
      r0: probed('2026-03-10T09:00:00Z', ['2026-03-03T10:00:00Z']),
      r1: probed('2026-03-05T12:00:00Z', ['2026-03-04T10:00:00Z', '2026-02-01T10:00:00Z']),
      r2: probed('2025-01-01T00:00:00Z'), // archived, nothing since: no request of its own
    } } },
    // web: two pages, the second ending before the period; api: one page already ending before it.
    pulls('web', null, repoPage([PR3, PR4, PR1, NOT_HERS], 'w1')),
    pulls('web', 'w1', repoPage([oldPullRequest('PR6', 'acme-corp/web')], 'w2')),
    pulls('api', null, repoPage([PR2, oldPullRequest('PR7', 'acme-corp/api')], 'a1')),
  ], ['--github', 'ada', '--source', 'github', '--tz', 'Europe/Zurich'], GITHUB_ENV);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.deepEqual(totals(r.report, 'github'), { ...WEEK_TOTALS, 'issues opened': 2 });
  assert.deepEqual(r.report.sources[0].totals.map(([m]) => m).slice(7, 12), [
    "others' pull requests reviewed", "others' pull requests merged by them", "others' pull requests reviewed or merged",
    'reviewed volume (their lines, once per pull request)', 'reviewed or merged volume (their lines, once per pull request)',
  ]);
  assert.equal(day(r.report, '2026-03-02').bySource.github, 2); // opened PR1 and committed c1
  assert.equal(day(r.report, '2026-03-03').bySource.github, undefined); // bob merged PR1; the 23:30 UTC review is the 4th in Zurich
  assert.deepEqual([day(r.report, '2026-03-04').bySource.github, day(r.report, '2026-03-04').first], [3, '00:30']);
  assert.equal(day(r.report, '2026-03-05').bySource.github, 1);
  assert.equal(day(r.report, '2026-03-06').bySource.github, 1); // ada merged carol's PR4
  assert.deepEqual(r.report.sources[0].breakdown.header, ['Repository', 'PRs', 'Merged since', 'Merged by them', 'PR +', 'PR −', 'Reviews', 'Comments', 'Commits']);
  assert.deepEqual(r.report.sources[0].breakdown.rows, [['acme-corp/api', 0, 0, 1, 0, 0, 2, 0, 1], ['acme-corp/web', 1, 1, 1, 10, 2, 0, 0, 1]]);
  assert.deepEqual(r.report.sources[0].breakdown.places, ['ACME Corp', 'ACME Corp']);
  const queries = r.calls.filter((c) => c.body?.query);
  assert.ok(!queries.some((c) => /search\(|organization\(/.test(c.body.query)), 'no search, no organization lookup');
  const probes = queries.filter((c) => c.body.query.includes('OikosFootprintProbe'));
  assert.equal(probes.length, 1);
  // A day before the period's first instant, itself an hour wider than the period (a daylight-saving change).
  assert.deepEqual(probes[0].body.variables, { owner: 'acme-corp', login: 'ada', since: '2026-02-27T22:00:00.000Z', n0: 'web', n1: 'api', n2: 'old' });
  assert.deepEqual(queries.filter((c) => c.body.query.includes('OikosFootprintRepoPulls')).map((c) => [c.body.variables.name, c.body.variables.after, c.body.variables.first]),
    [['web', null, 25], ['web', 'w1', 25], ['api', null, 25]]);
  const notes = notesOf(r.report, 'github');
  assert.match(notes, /pull requests of the 3 repositories of GITHUB_ORG acme-corp the token can read \(archived included\), read per repository — not through search: 2 had a pull request updated since 2026-02-27/);
  assert.match(notes, /commits pushed directly to a branch without a pull request are not seen here: the git source counts them/);
  assert.doesNotMatch(notes, /lower bound|monthly windows|read up to|shrunk|rate limit/);
});

/** A client for the organization route: `repos` listed, the GraphQL answered by `answer(query, variables)`; every call recorded. */
function fakeOrg(repos, answer) {
  const calls = [];
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    return answer(query, variables, calls);
  };
  const paged = async (path) => { calls.push({ path }); return repos.map((name) => ({ name })); };
  return { calls, g: { graphql, paged, api: async () => ({ data: { login: 'ada' } }) } };
}

/** The probe's answer for `variables`: every repository named in `active` updated in the week, the rest not since 2025. */
const probeAnswer = (variables, active) => Object.fromEntries(Object.entries(variables).filter(([k]) => /^n\d+$/.test(k))
  .map(([k, name]) => [`r${k.slice(1)}`, probed(active.includes(name) ? '2026-03-06T00:00:00Z' : '2025-01-01T00:00:00Z')]));
const ORG_QUERY = { login: 'ada', org: 'acme-corp', since: SINCE, until: UNTIL, tz: 'UTC' };

test('github with GITHUB_ORG, 150 repositories and 5 active: 6 probes of 25 and one page each of the 5 — 11 GraphQL requests', async () => {
  const names = Array.from({ length: 150 }, (_, i) => `repo${i}`);
  const active = names.filter((_, i) => i % 30 === 0);
  const { calls, g } = fakeOrg(names, (query, variables) => (query.includes('OikosFootprintProbe') ? probeAnswer(variables, active) : repoPage([])));
  const result = await collectGithub(g, ORG_QUERY, { pauseMs: 0 });
  const graphql = calls.filter((c) => c.query);
  assert.equal(graphql.filter((c) => c.query.includes('OikosFootprintProbe')).length, 6);
  assert.deepEqual(graphql.filter((c) => c.query.includes('OikosFootprintRepoPulls')).map((c) => c.variables.name), active);
  assert.equal(graphql.length, 11);
  assert.deepEqual(calls.filter((c) => c.path).map((c) => c.path), ['/orgs/acme-corp/repos?type=all']);
  assert.match(result.notes.join('\n'), /the 150 repositories of GITHUB_ORG acme-corp .* 5 had a pull request updated since/);
});

test('github with GITHUB_ORG: a repository page the gateway fails (502) is asked again with half as many pull requests from the same cursor', async () => {
  const { calls, g } = fakeOrg(['web'], (query, variables) => {
    if (query.includes('OikosFootprintProbe')) return probeAnswer(variables, ['web']);
    if (variables.first > 12) throw new HttpError(502, GRAPHQL_URL, 'Bad Gateway');
    return variables.after ? repoPage([PR2]) : repoPage([PR1], 'c1');
  });
  const result = await collectGithub(g, ORG_QUERY, { pauseMs: 0 });
  assert.deepEqual(calls.filter((c) => c.query?.includes('OikosFootprintRepoPulls')).map((c) => [c.variables.first, c.variables.after]), [[25, null], [12, null], [12, 'c1']]);
  const t = Object.fromEntries(result.totals);
  assert.deepEqual([t['pull requests opened'], t['pull requests merged by them'], t.reviews, t['commits in pull requests']], [1, 1, 2, 2]);
  assert.match(result.notes.join('\n'), /pages shrunk from 25 to 12 pull requests/);
});

test('github with GITHUB_ORG: a secondary rate limit (403) is waited out once, then the run goes on; a second one in a row gives up', async () => {
  const limited = () => new HttpError(403, GRAPHQL_URL, '{"message":"You have exceeded a secondary rate limit."}');
  const once = fakeOrg(['web'], (query, variables, calls) => {
    if (calls.length === 2) throw limited(); // the first GraphQL call, after the listing
    return query.includes('OikosFootprintProbe') ? probeAnswer(variables, ['web']) : repoPage([PR1]);
  });
  const result = await collectGithub(once.g, ORG_QUERY, { pauseMs: 0, rateLimitPauseMs: 0 });
  assert.equal(once.calls.filter((c) => c.query?.includes('OikosFootprintProbe')).length, 2);
  assert.equal(Object.fromEntries(result.totals)['pull requests opened'], 1);
  assert.match(result.notes.join('\n'), /GitHub's rate limit was met 1 time\(s\): waited 0 s in all/);
  const always = fakeOrg(['web'], () => { throw limited(); });
  await assert.rejects(collectGithub(always.g, ORG_QUERY, { pauseMs: 0, rateLimitPauseMs: 0 }),
    (e) => e instanceof UsageError && /GitHub's rate limit held after a wait of 0 s: run it again later/.test(e.message));
  assert.equal(always.calls.filter((c) => c.query).length, 2);
});

test('github: every review and commit of a pull request read page by page past the first; each event its kind, what, where, pr; others\' lines once per pull request and day', async () => {
  const at = (day, time) => `2026-03-0${day}T${time}:00Z`;
  const more = (nodes, endCursor = null) => ({ pageInfo: { hasNextPage: Boolean(endCursor), endCursor }, nodes });
  const theirs = pullRequest('PRX', 'acme-corp/api', {
    number: 42, author: { login: 'bob' }, createdAt: '2026-02-20T09:00:00Z', additions: 100, deletions: 50,
    merged: true, mergedAt: at(3, '10:00'), mergedBy: { login: 'ada' },
    reviews: { totalCount: 3, ...more([{ submittedAt: at(2, '10:00'), state: 'APPROVED' }], 'r1') },
    comments: { totalCount: 2, ...more([{ createdAt: at(2, '12:00'), author: { login: 'ada' } }, { createdAt: at(2, '13:00'), author: { login: 'bob' } }]) },
    commits: { totalCount: 102, ...more([prCommit('b1', 'bob', at(2, '08:00'))], 'k1') },
  });
  const { calls, g } = fakeOrg(['api'], (query, variables) => {
    if (query.includes('OikosFootprintProbe')) return probeAnswer(variables, ['api']);
    if (query.includes('OikosFootprintRepoPulls')) return repoPage([theirs]);
    if (query.includes('OikosFootprintMoreReviews')) return { node: { reviews: more([{ submittedAt: at(2, '15:00'), state: 'COMMENTED' }, { submittedAt: at(3, '09:00'), state: 'APPROVED' }]) } };
    if (query.includes('OikosFootprintMoreCommits')) {
      return { node: { commits: variables.after === 'k1' ? more([prCommit('a1', 'ada', at(4, '09:00'))], 'k2') : more([prCommit('a2', 'ada', at(5, '09:00'))]) } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  });
  const result = await collectGithub(g, ORG_QUERY, { pauseMs: 0 });
  const t = Object.fromEntries(result.totals);
  assert.deepEqual([t.reviews, t['reviews by state'], t['comments on pull requests'], t['commits in pull requests'], t["others' pull requests merged by them"]],
    [3, 'approved 2, commented 1', 1, 2, 1]);
  const pr = 'https://github.com/acme-corp/api/pull/';
  const common = { what: 'acme-corp/api#42', where: 'acme-corp/api', pr, others: true };
  assert.deepEqual(result.events.map((e) => ({ ...e, pr })).sort((a, b) => a.at.localeCompare(b.at)), [
    { at: at(2, '10:00'), kind: 'review', ...common, reviewed: [100, 50] },
    { at: at(2, '12:00'), kind: 'comment', ...common },
    { at: at(2, '15:00'), kind: 'review comment', ...common },
    { at: at(3, '09:00'), kind: 'review', ...common, reviewed: [100, 50] },
    { at: at(3, '10:00'), kind: 'merge', ...common },
    { at: at(4, '09:00'), kind: 'commit', ...common },
    { at: at(5, '09:00'), kind: 'commit', ...common },
  ]);
  const followUps = calls.filter((c) => /OikosFootprintMore/.test(c.query || '')).map((c) => [c.query.match(/OikosFootprintMore\w+/)[0], c.variables]);
  assert.deepEqual(followUps, [
    ['OikosFootprintMoreReviews', { id: 'PRX', login: 'ada', after: 'r1', first: 100 }],
    ['OikosFootprintMoreCommits', { id: 'PRX', after: 'k1', first: 100 }],
    ['OikosFootprintMoreCommits', { id: 'PRX', after: 'k2', first: 100 }],
  ]);
  const notes = result.notes.join('\n');
  assert.match(notes, /read beyond the first page of a pull request: reviews of 1, commits of 1 pull request\(s\)/);
  assert.doesNotMatch(notes, /read up to|not read whole/);
  assert.deepEqual(result.breakdown.wheres, ['acme-corp/api']);
});

test('github: reviews and their states count others\' pull requests, the person\'s own apart; a comment alone carries no lines and is no review in the report', async () => {
  const own = pullRequest('PR21', 'acme-corp/web', {
    author: { login: 'ada' }, createdAt: '2026-02-20T09:00:00Z', additions: 5, deletions: 1,
    reviews: { totalCount: 1, nodes: [{ submittedAt: '2026-03-03T09:00:00Z', state: 'COMMENTED' }] },
  });
  // bob's, on which ada only wrote in the conversation: a big pull request, its lines nowhere.
  const talked = pullRequest('PR22', 'acme-corp/web', {
    author: { login: 'bob' }, createdAt: '2026-02-20T09:00:00Z', additions: 333000, deletions: 10,
    comments: { totalCount: 1, nodes: [{ createdAt: '2026-03-03T10:00:00Z', author: { login: 'ada' } }] },
  });
  const { g } = fakeOrg(['web'], (query, variables) => (query.includes('OikosFootprintProbe') ? probeAnswer(variables, ['web']) : repoPage([own, talked, PR2])));
  const result = await collectGithub(g, ORG_QUERY, { pauseMs: 0 });
  const t = Object.fromEntries(result.totals);
  assert.deepEqual([t.reviews, t['reviews by state'], t['reviews on own pull requests'], t["others' pull requests reviewed or merged"], t['comments on pull requests']],
    [2, 'approved 1, commented 1', 1, 1, 1]);
  const comment = result.events.find((e) => e.kind === 'comment');
  assert.deepEqual([comment.others, comment.reviewed], [true, undefined]);
  // The seam: the source's own output laid by the report — one review of PR2 per day (the 3rd at 23:30, the 4th
  // and its merge on the 5th), the comment and the own pull request's review none; PR2's commits are no review either.
  const report = buildReport([result], { since: SINCE, until: UNTIL, tz: 'UTC' });
  assert.deepEqual(report.all.days.filter((d) => d.reviews).map((d) => [d.date, d.reviews, d.reviewed]),
    [['2026-03-03', 1, [40, 5]], ['2026-03-04', 1, [40, 5]], ['2026-03-05', 1, [40, 5]]]);
  assert.deepEqual(report.all.measures.totals.reviewed, [120, 15]);
});

test('github with GITHUB_ORG: a GraphQL answer with neither data nor errors skips the source with a note; the other sources still render', () => {
  const dir = installation((t) => t);
  const repo = join(tempDir('work-'), 'app');
  gitRepo(repo);
  const r = collect(dir, [{ url: ORG_REPOS, body: [{ name: 'web' }] }, { graphql: 'OikosFootprintProbe', body: {} }],
    ['--github', 'ada', '--email', ADA, '--repos', repo, '--source', 'git,github', '--tz', 'UTC'], { ...GITHUB_ENV, ...GIT_RUN });
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.equal(totals(r.report, 'git').commits, 2);
  const skipped = r.report.skipped.find((s) => s.source === 'github');
  assert.match(skipped.reason, /^HTTP 200 from https:\/\/api\.github\.com\/graphql: probe of acme-corp\/web failed: GitHub returned no data for the query/);
});

// The search route: no GITHUB_ORG, the whole of GitHub.

/** A client whose GraphQL answers `pulls(from, to, variables)` for the search of `updated:<from>..<to>`: the calls are recorded. */
function fakeGithub(pulls) {
  const calls = [];
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('OikosFootprintIssues')) return { search: { issueCount: 3 } };
    const [, from, to] = variables.q.match(/updated:(\S+)\.\.(\S+)/);
    return pulls(from, to, variables);
  };
  return { calls, g: { graphql, api: async () => ({ data: { login: 'ada' } }) } };
}
const SEARCH_QUERY = { login: 'ada', org: null, since: SINCE, until: UNTIL, tz: 'Europe/Zurich' };

test('github without GITHUB_ORG: search over the windows, the same totals, each pull request once; named a lower bound', async () => {
  const { calls, g } = fakeGithub(() => searchPage([...WEEK_PULLS, NOT_HERS]));
  const result = await collectGithub(g, SEARCH_QUERY, { today: '2026-04-10', pauseMs: 0 });
  assert.deepEqual(Object.fromEntries(result.totals), { ...WEEK_TOTALS, 'issues opened': 3 });
  assert.equal(result.site, 'https://github.com'); // no Enterprise server: github.com
  const searches = calls.filter((c) => c.query.includes('OikosFootprintPulls'));
  assert.deepEqual(searches.map((c) => c.variables.q), [
    'is:pr involves:ada updated:2026-02-28..2026-03-27 sort:updated-asc', 'is:pr involves:ada updated:2026-03-28..2026-04-10 sort:updated-asc',
  ]);
  assert.equal(calls.find((c) => c.query.includes('OikosFootprintIssues')).variables.q, 'is:issue author:ada created:2026-03-01..2026-03-07');
  const notes = result.notes.join('\n');
  assert.match(notes, /no GITHUB_ORG: pull requests found through GitHub search across the whole of GitHub\. Search can return incomplete results .* every total here is a lower bound/);
  assert.match(notes, /issues opened: GitHub search's count .* a lower bound/);
});

test('github without GITHUB_ORG: a window above 1000 results is split in halves down to a day, a day above it is cut and named; duplicates count once', async () => {
  const { calls, g } = fakeGithub((from, to) => {
    if (from !== to) return searchPage([], 1500);
    const opened = pullRequest(`PR${from.replace(/-/g, '')}`, 'acme-corp/web', { author: { login: 'ada' }, createdAt: `${from}T12:00:00Z` });
    // The 4th finds the 2nd's pull request again.
    const again = from === '2026-03-04' ? [pullRequest('PR20260302', 'acme-corp/web', { author: { login: 'ada' }, createdAt: '2026-03-02T12:00:00Z' })] : [];
    return searchPage([opened, ...again], from === '2026-03-03' ? 1001 : 1 + again.length);
  });
  const result = await collectGithub(g, { ...SEARCH_QUERY, tz: 'UTC' }, { today: '2026-03-10' });
  const ranges = calls.filter((c) => c.query.includes('OikosFootprintPulls')).map((c) => c.variables.q.match(/updated:(\S+)/)[1]);
  assert.equal(ranges[0], '2026-02-28..2026-03-10');
  const days = ['2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'];
  assert.deepEqual(ranges.filter((r) => r.split('..')[0] === r.split('..')[1]).map((r) => r.split('..')[0]), days);
  assert.equal(Object.fromEntries(result.totals)['pull requests opened'], 7); // 03-01 … 03-07, the 2nd once
  assert.match(result.notes.join('\n'), /at most 1000 pull requests per query: cut on 2026-03-03: 1001/);
});

test('github without GITHUB_ORG: monthly windows from the day before the period to today', async () => {
  const { calls, g } = fakeGithub(() => searchPage([]));
  await collectGithub(g, { ...SEARCH_QUERY, since: '2026-01-15', until: '2026-01-31', tz: 'UTC' }, { today: '2026-03-20' });
  assert.deepEqual(calls.filter((c) => c.query.includes('OikosFootprintPulls')).map((c) => c.variables.q), [
    'is:pr involves:ada updated:2026-01-14..2026-02-13 sort:updated-asc',
    'is:pr involves:ada updated:2026-02-14..2026-03-13 sort:updated-asc',
    'is:pr involves:ada updated:2026-03-14..2026-03-20 sort:updated-asc',
  ]);
});

test('github without GITHUB_ORG: a search page the gateway fails (502) is asked again with half as many pull requests from the same cursor', async () => {
  const { calls, g } = fakeGithub((from, to, { first, after }) => {
    if (first > 12) throw new HttpError(502, GRAPHQL_URL, 'Bad Gateway');
    if (!after) return { search: { issueCount: 2, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [PR1] } };
    return searchPage([PR2], 2);
  });
  const result = await collectGithub(g, { ...SEARCH_QUERY, tz: 'UTC' }, { today: '2026-03-10', pauseMs: 0 });
  assert.deepEqual(calls.filter((c) => c.query.includes('OikosFootprintPulls')).map((c) => [c.variables.first, c.variables.after]), [[25, null], [12, null], [12, 'c1']]);
  const t = Object.fromEntries(result.totals);
  assert.deepEqual([t['pull requests opened'], t['pull requests merged by them'], t.reviews, t['commits in pull requests']], [1, 1, 2, 2]);
  assert.match(result.notes.join('\n'), /pages shrunk from 25 to 12 pull requests/);
});

test('github without GITHUB_ORG: a window that returns fewer distinct pull requests than its issueCount is named', async () => {
  const { g } = fakeGithub((from, to, { after }) => {
    // Two pages that repeat PR1 and never show the third of the three counted.
    if (!after) return { search: { issueCount: 3, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [PR1, PR2] } };
    return searchPage([PR1], 3);
  });
  const result = await collectGithub(g, { ...SEARCH_QUERY, tz: 'UTC' }, { today: '2026-03-10', pauseMs: 0 });
  assert.match(result.notes.join('\n'), /GitHub search returned 2 of 3 pull requests updated 2026-02-28\.\.2026-03-10: the totals are a lower bound/);
  assert.equal(Object.fromEntries(result.totals)['pull requests opened'], 1);
});

test('github without GITHUB_ORG: a search that times out or fails at every page size down to 3 gives up naming the query', async () => {
  const timeout = new ChannelError('no channel to api.github.com', { cause: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) });
  const { calls, g } = fakeGithub((from, to, { first }) => {
    throw first === 25 ? timeout : new HttpError(504, GRAPHQL_URL, 'Gateway Timeout');
  });
  await assert.rejects(collectGithub(g, { ...SEARCH_QUERY, tz: 'UTC' }, { today: '2026-03-10', pauseMs: 0 }),
    (e) => e instanceof HttpError && e.status === 504 && /search for is:pr involves:ada updated:2026-02-28\.\.2026-03-10 sort:updated-asc still failed at 3 pull requests per page/.test(e.message));
  assert.deepEqual(calls.map((c) => c.variables.first), [25, 12, 6, 3]);
});

// == sources ==

test('sources: listed or not, credentials present, the identity each needs — no request, no value, nothing read for an unlisted one', () => {
  const dir = installation((t) => t);
  const env = { ...GITHUB_ENV, ...JIRA_ENV, ...GITLAB_ENV };
  const r = tool(dir, 'footprint', ['sources'], env);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.match(r.stdout, /^github +listed; GITHUB_TOKEN set \(env\), GITHUB_ORG set \(config\)$/m);
  assert.match(r.stdout, /^gitlab +not collected — connector gitlab is not listed in oikos\.yaml/m);
  assert.match(r.stdout, /^jira +listed; JIRA_BASE_URL set \(config\), JIRA_EMAIL set \(env\), JIRA_API_TOKEN set \(env\)$/m);
  assert.match(r.stdout, /identity: --github <login>/);
  assert.doesNotMatch(r.stdout, /GITLAB_/);
  assert.doesNotMatch(r.output, /ghp_fake_token|fake-token|glpat-fake/);
  const json = JSON.parse(tool(dir, 'footprint', ['sources', '--json'], env).stdout);
  const row = (source) => json.find((s) => s.source === source);
  assert.deepEqual([row('gitlab').listed, row('gitlab').credentials], [false, null]);
  assert.equal(row('jira').credentials.JIRA_API_TOKEN, 'set (env)');
});

test('identify: git authors by name substring, GitLab, Jira and Confluence users, GitHub by public name', () => {
  const dir = installation(withGitlab);
  const repo = join(tempDir('work-'), 'app');
  gitRepo(repo);
  const fake = withFakeFetch(dir, [
    { url: `${GL}/users?search=Ada&per_page=20`, body: [{ username: 'ada', name: 'Ada Lovelace', state: 'active', web_url: 'https://gitlab.example.com/ada' }] },
    { match: `^${JIRA}/user/search\\?query=Ada$`, body: [{ accountId: ACCOUNT, displayName: 'Ada Lovelace', active: true, accountType: 'atlassian' }] },
    { url: userSearch('Ada'), body: { results: [{ user: { accountId: ACCOUNT, displayName: 'Ada Lovelace', accountType: 'atlassian' } }] } },
    { match: '^https://api\\.github\\.com/search/users\\?q=Ada%20in%3Aname', body: { items: [{ login: 'ada', html_url: 'https://github.com/ada' }] } },
  ]);
  const r = tool(dir, 'footprint', ['identify', '--name', 'Ada', '--repos', repo], { ...GITLAB_ENV, ...JIRA_ENV, ...GITHUB_ENV, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.match(r.stdout, /^ +3 commit\(s\) {2}Ada <ada@acme\.example> {2}in 1 repository$/m);
  assert.match(r.stdout, /^ +1 commit\(s\) {2}Bada <bada@acme\.example>/m);
  assert.doesNotMatch(r.stdout, /Bob/);
  assert.match(r.stdout, /^ {2}@ada {2}Ada Lovelace {2}active/m);
  assert.match(r.stdout, new RegExp(`^jira: \\n  ${ACCOUNT}  Ada Lovelace$`, 'm'));
  assert.match(r.stdout, new RegExp(`^confluence: \\n  ${ACCOUNT}  Ada Lovelace$`, 'm'));
  assert.match(r.stdout, /^ {2}ada {2}https:\/\/github\.com\/ada$/m);
  assert.match(r.stdout, /public profile name only/);
});

test('identify --me: each credential\'s own account, Confluence\'s through Jira where it is listed; git by the installation\'s and the repository\'s emails', () => {
  const repo = join(tempDir('work-'), 'app');
  gitRepo(repo);
  const gitconfig = join(tempDir('home-'), 'gitconfig');
  writeFileSync(gitconfig, `[user]\n\temail = ${ADA}\n`);
  const env = { ...GITLAB_ENV, ...JIRA_ENV, ...GITHUB_ENV, ...GIT_RUN, GIT_CONFIG_GLOBAL: gitconfig };
  const myself = { url: `${JIRA}/myself`, body: { accountId: ACCOUNT, displayName: 'Ada Lovelace', emailAddress: ADA, active: true } };
  const routes = [
    { url: `${GL}/user`, body: { username: 'ada', name: 'Ada Lovelace', state: 'active', web_url: 'https://gitlab.example.com/ada' } },
    { url: 'https://api.github.com/user', body: { login: 'ada', html_url: 'https://github.com/ada' } },
  ];
  const dir = installation(withGitlab);
  const fake = withFakeFetch(dir, [...routes, myself]);
  const r = tool(dir, 'footprint', ['identify', '--me', '--repos', repo], { ...env, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assertNoCrashNoRequest(r);
  assert.match(r.stdout, /^ +3 commit\(s\) {2}Ada <ada@acme\.example> {2}in 1 repository$/m);
  assert.doesNotMatch(r.stdout, /Bada/); // an address matches exactly, not as a part
  assert.match(r.stdout, /^ {2}@ada {2}Ada Lovelace {2}active/m);
  assert.match(r.stdout, new RegExp(`^jira: \\n  ${ACCOUNT}  Ada Lovelace  ada@acme\\.example$`, 'm'));
  assert.match(r.stdout, new RegExp(`^confluence: \\n  ${ACCOUNT}  Ada Lovelace  ada@acme\\.example$`, 'm'));
  assert.match(r.stdout, /^ {2}ada {2}https:\/\/github\.com\/ada$/m);
  assert.equal(fake.calls().filter((c) => c.url === `${JIRA}/myself`).length, 2);
  assert.ok(!fake.calls().some((c) => /\/wiki\/rest\/api\/user\/current/.test(c.url)));
  // Without jira listed, Confluence answers for itself; without --repos, git names the address uncounted.
  const noJira = installation((t) => t.replace('task-tracking: [jira]', 'task-tracking: []'));
  const fake2 = withFakeFetch(noJira, [...routes, { url: `${SITE}/wiki/rest/api/user/current`, body: { accountId: ACCOUNT, displayName: 'Ada Lovelace' } }]);
  const r2 = tool(noJira, 'footprint', ['identify', '--me'], { ...env, ...fake2.env }, fake2);
  assert.equal(r2.status, 0, r2.output);
  assertNoCrashNoRequest(r2);
  assert.match(r2.stdout, new RegExp(`^confluence: \\n  ${ACCOUNT}  Ada Lovelace$`, 'm'));
  assert.match(r2.stdout, /^ +— commit\(s\) {2}<ada@acme\.example> {2}\(no --repos: not counted\)$/m);
  assert.match(r2.stdout, /^jira: not searched — connector jira is not listed/m);
  assert.equal(tool(noJira, 'footprint', ['identify', '--me', '--name', 'Ada'], env).status, 1);
});

// == the report ==

test('readTimesheet: `,` `;` and tab, 7,5 and 7:30, a header and comments skipped, lines of one date added', () => {
  const dir = tempDir('hours-');
  const file = (name, text) => { writeFileSync(join(dir, name), text); return join(dir, name); };
  const comma = readTimesheet(file('march.csv', 'date,hours\n2026-03-02,7.5\n2026-03-03,"7,5"\n'));
  assert.equal(comma.label, 'march');
  assert.deepEqual([...comma.days], [['2026-03-02', 7.5], ['2026-03-03', 7.5]]);
  const semicolon = readTimesheet(file('semi.csv', '# exported\nDate;Hours\n\n2026-03-02;7,5\n2026-03-02;0:30\n'));
  assert.deepEqual([...semicolon.days], [['2026-03-02', 8]]);
  const tab = readTimesheet(file('tab.tsv', '2026-03-02\t7:30\n2026-03-04\t6,25\n'));
  assert.deepEqual([...tab.days], [['2026-03-02', 7.5], ['2026-03-04', 6.25]]);
  assert.throws(() => readTimesheet(file('bad.csv', 'date,hours\n2026-03-02,7\nyesterday,8\n')), (e) => e instanceof UsageError && /line 3/.test(e.message));
  assert.throws(() => readTimesheet(join(dir, 'missing.csv')), /no such file/);
});

test('readTimesheet: an unquoted decimal comma, a malformed first line, empty or odd hours and an impossible date are refused', () => {
  const dir = tempDir('hours-');
  const file = (name, text) => { writeFileSync(join(dir, name), text); return join(dir, name); };
  const refused = (text, pattern) => assert.throws(() => readTimesheet(file('sheet.csv', text)), (e) => e instanceof UsageError && pattern.test(e.message));
  refused('date,hours\n2026-03-02,7,5\n', /line 2 has more fields than "YYYY-MM-DD,hours" — quote a decimal comma \("7,5"\) or separate with ;/);
  refused('2026-03-02,abc\n2026-03-03,8\n', /line 1 has no hours .*got abc/); // a date first: not a header
  refused('2026-03-02,\n', /line 1 has no hours/);
  refused('2026-03-02\n', /line 1 has no hours/);
  for (const hours of ['-3', '1e3', '0x10', '7:75', '.5']) refused(`2026-03-02,${hours}\n`, new RegExp(`got ${hours.replace('.', '\\.')}`));
  refused('2026-02-30,7\n', /line 1 must be a date YYYY-MM-DD, got: 2026-02-30/);
});

test('readTimesheets: two sheets of one name are told apart by their folder, the same file twice by a number', () => {
  const dir = tempDir('hours-');
  const sheet = (folder) => {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, 'march.csv'), '2026-03-02,1\n');
    return join(dir, folder, 'march.csv');
  };
  const [a, b] = [sheet('ada'), sheet('team')];
  assert.deepEqual(readTimesheets([a]).map((t) => t.label), ['march']);
  assert.deepEqual(readTimesheets([a, b]).map((t) => t.label), ['ada/march', 'team/march']);
  assert.deepEqual(readTimesheets([a, b, a]).map((t) => t.label), ['ada/march #1', 'team/march', 'ada/march #2']);
});

test('isoDate: an existing day only', () => {
  assert.equal(isoDate('2026-02-28', 'since'), '2026-02-28');
  assert.throws(() => isoDate('2026-02-30', 'since'), (e) => e instanceof UsageError && /--since must be a date YYYY-MM-DD, got: 2026-02-30/.test(e.message));
  assert.throws(() => isoDate('2026-3-1', 'until'), UsageError);
});

test('zonedMidnight: local midnight across daylight saving; where midnight is skipped, the instant the clocks jump to', () => {
  const at = (date, tz) => new Date(zonedMidnight(date, tz)).toISOString();
  assert.equal(at('2026-03-02', 'UTC'), '2026-03-02T00:00:00.000Z');
  assert.equal(at('2026-03-29', 'Europe/Zurich'), '2026-03-28T23:00:00.000Z'); // clocks forward at 02:00
  assert.equal(at('2026-03-30', 'Europe/Zurich'), '2026-03-29T22:00:00.000Z');
  assert.equal(at('2026-10-25', 'Europe/Zurich'), '2026-10-24T22:00:00.000Z'); // clocks back at 03:00
  assert.equal(at('2026-10-26', 'Europe/Zurich'), '2026-10-25T23:00:00.000Z');
  assert.equal(at('2026-09-05', 'America/Santiago'), '2026-09-05T04:00:00.000Z');
  assert.equal(at('2026-09-06', 'America/Santiago'), '2026-09-06T04:00:00.000Z'); // 00:00 does not exist: 01:00 −03
  assert.equal(at('2026-09-07', 'America/Santiago'), '2026-09-07T03:00:00.000Z');
});

test('buildReport: an event at 23:30 UTC lands on the next day and week in Europe/Zurich; hours beside it', () => {
  const results = [
    { source: 'x', label: 'X', totals: [['events', 1]], events: [{ at: '2026-03-01T23:30:00Z' }], notes: [] },
    { source: 'y', skipped: 'no credential' },
  ];
  const timesheets = [{ label: 'sheet', days: new Map([['2026-03-02', 8]]) }];
  const zurich = buildReport(results, { since: '2026-02-23', until: '2026-03-08', tz: 'Europe/Zurich', timesheets });
  assert.equal(day(zurich, '2026-03-01').bySource.x, undefined);
  assert.deepEqual(day(zurich, '2026-03-02'), { date: '2026-03-02', first: '00:30', last: '00:30', bySource: { x: 1 }, hours: { sheet: 8 } });
  assert.deepEqual(zurich.weeks.map((w) => [w.week, w.activeDays, w.bySource.x]), [['2026-02-23', 0, undefined], ['2026-03-02', 1, 1]]);
  assert.deepEqual(zurich.skipped, [{ source: 'y', reason: 'no credential' }]);
  const utc = buildReport(results, { since: '2026-02-23', until: '2026-03-08', tz: 'UTC', timesheets });
  assert.equal(day(utc, '2026-03-01').bySource.x, 1);
  assert.deepEqual(utc.weeks.map((w) => w.bySource.x), [1, undefined]);
  const md = renderMarkdown(zurich, { person: 'Ada', collectedAt: '2026-03-09 10:00' });
  assert.match(md, /^\| 2026-03-02 \| Mon \| 00:30 \| 00:30 \| 1 \| 8 \|$/m);
  assert.match(md, /^- y: not collected — no credential$/m);
  assert.doesNotMatch(md, /^Purpose:/m);
});

test('buildReport: an event whose time cannot be read is left out with a note, not a crash', () => {
  const report = buildReport([
    { source: 'x', label: 'X', totals: [], events: [{ at: 'not a time' }, { at: '2026-03-02T10:00:00Z' }], notes: ['kept'] },
  ], { since: '2026-03-01', until: '2026-03-07', tz: 'UTC' });
  assert.equal(day(report, '2026-03-02').bySource.x, 1);
  assert.deepEqual(report.sources[0].notes, ['kept', '1 event(s) with no time or date that can be read left out of the days']);
});

test('renderMarkdown: the day table up to 31 days, not for 32, not with --by week, always with --by day', () => {
  const period = (since, until) => buildReport([{ source: 'x', label: 'X', totals: [], events: [], notes: [] }], { since, until, tz: 'UTC' });
  const md = (report, by) => renderMarkdown(report, { person: 'Ada', by, collectedAt: 'now' });
  assert.match(md(period('2026-03-01', '2026-03-31')), /^## By day$/m);
  const long = md(period('2026-03-01', '2026-04-01'));
  assert.doesNotMatch(long, /^## By day$/m);
  assert.match(long, /^- the day table is left out for 32 days \(above 31\); --by day adds it$/m);
  const week = md(period('2026-03-02', '2026-03-08'), 'week');
  assert.doesNotMatch(week, /^## By day$/m);
  assert.match(week, /^- the day table is left out with --by week; --by day adds it$/m);
  assert.match(md(period('2026-03-01', '2026-04-01'), 'day'), /^## By day$/m);
});
