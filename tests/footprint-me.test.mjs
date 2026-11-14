// `--me` over several clones (git source) and the footprint CLI's refusal of stray positionals.
// The user's git configuration is a temporary global file (GIT_CONFIG_GLOBAL), never the real one:
// clones without a user.email of their own read it, a clone with its own keeps it, and the person
// is one across the clones — an address any clone's configuration gives is matched in all of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../tools/common/cli.mjs';
import { gitEnvironment } from '../tools/common/gitwiki.mjs';
import { rejectPositionals } from '../tools/footprint/cli.mjs';
import { collectGit, identifyGitMe } from '../tools/footprint/sources/git.mjs';
import { cleanEnv, installation, tempDir, tool } from './helpers/installation.mjs';

const WORK = 'ada@acme.example';
const HOME = 'ada.home@example.com';
const GLOBAL_CONFIG = join(tempDir('gitconfig-'), 'config');
writeFileSync(GLOBAL_CONFIG, `[user]\n\temail = ${WORK}\n\tname = Ada\n`);
const GIT_ENV = gitEnvironment(null, cleanEnv());
// collectGit and identifyGitMe run git with this process's environment.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: GLOBAL_CONFIG, GIT_CONFIG_NOSYSTEM: '1' });

/** A repository at `dir`, one commit by `email` on `day` (March 2026); `local` sets its own user.email. */
function repo(dir, { email, day, local = null }) {
  mkdirSync(dir, { recursive: true });
  const git = (args, env = {}) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...env } });
    assert.equal(r.status, 0, r.stderr);
  };
  git(['init', '-q', '-b', 'main']);
  if (local) git(['config', 'user.email', local]);
  writeFileSync(join(dir, 'f.txt'), `${day}\n`);
  git(['add', '--', 'f.txt']);
  const at = `2026-03-0${day}T10:00:00+00:00`;
  git(['commit', '-q', '-m', `change on ${day}`], {
    GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: at,
  });
  return dir;
}

const PERIOD = { since: '2026-03-01', until: '2026-03-07', tz: 'UTC' };
const total = (result, name) => Object.fromEntries(result.totals)[name];

/** Six clones in the shape of a person with two addresses: which ones the configurations give, which commits carry. */
function clones() {
  const root = tempDir('clones-');
  return [
    repo(join(root, 'plain'), { email: WORK, day: 2 }), // no user.email of its own: the user's configuration gives WORK
    repo(join(root, 'plain2'), { email: WORK, day: 3 }),
    repo(join(root, 'home'), { email: HOME, day: 4, local: HOME }), // its own address
    repo(join(root, 'mixed'), { email: HOME, day: 5 }), // set to WORK by the user's configuration, committed under HOME
    repo(join(root, 'stranger'), { email: 'bob@example.com', day: 6 }), // nobody's address of the user
  ];
}

test('--me: clones without a user.email of their own match the address the user\'s configuration gives', () => {
  const [plain, plain2] = clones();
  const result = collectGit([plain, plain2], { authors: [], meEmails: true, ...PERIOD });
  assert.equal(total(result, 'commits'), 2);
  assert.match(result.notes.join('\n'), /authors matched: ada@acme\.example$/m);
});

test('--me over several clones: every address the configurations give is matched in every clone', () => {
  const repos = clones();
  const result = collectGit(repos, { authors: [], meEmails: true, ...PERIOD });
  // plain, plain2 by WORK; home by HOME; mixed by HOME although its configuration says WORK; not the stranger's.
  assert.equal(total(result, 'commits'), 4);
  const notes = result.notes.join('\n');
  assert.match(notes, /authors matched: ada@acme\.example, ada\.home@example\.com$/m);
  assert.match(notes, /matched in every repository: ada@acme\.example \(set in plain, plain2, mixed, stranger\); ada\.home@example\.com \(set in home\)$/m);
});

test('identify --me: the addresses of all the clones, with their commits counted across them', () => {
  const found = identifyGitMe(clones(), null);
  assert.deepEqual(found.map((c) => [c.email, c.commits, c.repositories]), [[WORK, 2, 2], [HOME, 2, 2]]);
});

test('rejectPositionals names the stray values and says to repeat the flag', () => {
  rejectPositionals([]);
  assert.throws(() => rejectPositionals(['b', 'c']), (e) => e instanceof UsageError
    && /unexpected arguments: b, c/.test(e.message) && /repeat it for each \(--repos a --repos b\)/.test(e.message));
  assert.throws(() => rejectPositionals(['b']), /unexpected argument: b — /);
});

test('collect --repos a b: refused naming b, nothing is searched; --repos a --repos b is read', () => {
  const root = tempDir('cli-');
  const a = repo(join(root, 'a'), { email: WORK, day: 2 });
  const b = repo(join(root, 'b'), { email: WORK, day: 3 });
  const dir = installation((t) => t);
  const env = { TZ: 'UTC', GIT_CONFIG_GLOBAL: GLOBAL_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };
  const base = ['collect', '--since', '2026-03-01', '--until', '2026-03-07', '--source', 'git', '--email', WORK, '--tz', 'UTC', '--no-save', '--json'];
  const stray = tool(dir, 'footprint', [...base, '--repos', a, b], env);
  assert.equal(stray.status, 1, stray.output);
  assert.match(stray.stderr, /unexpected argument: .*\/b — a flag takes one value/);
  assert.equal(stray.stdout, '');
  const repeated = tool(dir, 'footprint', [...base, '--repos', a, '--repos', b], env);
  assert.equal(repeated.status, 0, repeated.output);
  assert.equal(Object.fromEntries(JSON.parse(repeated.stdout).sources.find((s) => s.source === 'git').totals).commits, 2);
});
