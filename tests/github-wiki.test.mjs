// The github-wiki connector offline (npm test): the wiki remote is a local bare repository that
// GITHUB_SERVER_URL points at (`<server>/<owner>/<repo>.wiki.git`), the REST calls (`GET /user`,
// `GET /repos/{o}/{r}`) are answered by the fake fetch, and `git` on PATH is a wrapper that logs
// its arguments (and the clone's .git/config at push time) before it runs the real git — the proof
// that the token never reaches argv or a config file. The machine's identity is a decoy: HOME holds
// a .gitconfig with another user and GIT_AUTHOR_* are set, and neither may reach a commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { assertNoCrashNoRequest, installation, tempDir, tool, withFakeFetch } from './helpers/installation.mjs';
import { authHeader, gitEnvironment, gitFailure, noreplyIdentity, WikiChanged } from '../tools/common/gitwiki.mjs';
import { findPageFile, pageRef, searchPages } from '../tools/github-wiki/pages.mjs';
import { UsageError } from '../tools/common/cli.mjs';

const TOKEN = 'ghp_fake_wiki_token_123';
const API = 'https://api.github.com';
const USER = { login: 'octo-bot', id: 4242, name: 'Octo Bot' };
const NOREPLY = '4242+octo-bot@users.noreply.github.com';
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const HOME_PAGE = '# Welcome\n\nIntro text.\n\n## Rollout\n\nOld rollout plan.\n\n## Contacts\n\nAsk the team.\n';

/** Git with no machine configuration, for setting up the fixtures. */
const git = (args, cwd) => execFileSync(REAL_GIT, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
});

/** A working clone of `bare` with a local identity, to seed or advance the remote. */
function workingClone(bare, prefix) {
  const dir = join(tempDir(prefix), 'w');
  git(['clone', '-q', bare, dir]);
  git(['config', 'user.name', 'Seeder'], dir);
  git(['config', 'user.email', 'seeder@example.com'], dir);
  return dir;
}

/**
 * A wiki server: `<server>/acme-corp/tools.wiki.git` seeded with Home.md, Release-Notes.md, a
 * textile page and _Sidebar.md; plus the `git` wrapper, a decoy HOME and a temp folder.
 */
function fixture() {
  const root = tempDir('wiki-');
  const server = join(root, 'server');
  const bare = join(server, 'acme-corp', 'tools.wiki.git');
  mkdirSync(bare, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'master', bare]);
  const seed = workingClone(bare, 'seed-');
  writeFileSync(join(seed, 'Home.md'), HOME_PAGE);
  writeFileSync(join(seed, 'Release-Notes.md'), '# Release notes\n\nVersion 1 shipped the importer.\nNext line.\n');
  writeFileSync(join(seed, 'Old-Page.textile'), 'h1. Old page\n\nTextile text.\n');
  writeFileSync(join(seed, '_Sidebar.md'), '* [[Home]]\n');
  git(['add', '.'], seed);
  git(['commit', '-q', '-m', 'Seed'], seed);
  git(['push', '-q', 'origin', 'HEAD:master'], seed);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const logs = { argv: join(root, 'argv.log'), config: join(root, 'config.log') };
  writeFileSync(join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "$WIKI_TEST_ARGV_LOG"
case " $* " in
  *" push "*)
    [ -f .git/config ] && cat .git/config >> "$WIKI_TEST_CONFIG_LOG"
    if [ -n "$WIKI_TEST_ADVANCE" ]; then "$WIKI_TEST_REAL_GIT" -C "$WIKI_TEST_ADVANCE" push -q origin HEAD:master; fi ;;
esac
exec "$WIKI_TEST_REAL_GIT" "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Machine User\n\temail = machine@other-org.example\n');
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  return { server, bare, bin, home, tmp, logs };
}

const dir = installation((t) => t.replace('wiki: [confluence]', 'wiki: [github-wiki]'));

const ROUTES = [
  { url: `${API}/user`, body: USER, headers: { 'x-oauth-scopes': 'repo' } },
  { url: `${API}/repos/acme-corp/tools`, body: { full_name: 'acme-corp/tools', private: true, visibility: 'private', has_wiki: true } },
  { url: `${API}/repos/acme-corp/open`, body: { full_name: 'acme-corp/open', private: false, visibility: 'public', has_wiki: true } },
  { url: `${API}/repos/acme-corp/nowiki`, body: { full_name: 'acme-corp/nowiki', private: true, visibility: 'private', has_wiki: true } },
];

/** Run the tool against the fixture `f`; `env` on top. Returns the result and the REST calls. */
function wiki(f, args, env = {}) {
  const fake = withFakeFetch(dir, ROUTES);
  const r = tool(dir, 'github-wiki', args, {
    GITHUB_TOKEN: TOKEN, GITHUB_SERVER_URL: f.server, GITHUB_WIKI_REPO: 'acme-corp/tools',
    PATH: `${f.bin}:${process.env.PATH}`, HOME: f.home, TMPDIR: f.tmp,
    GIT_AUTHOR_NAME: 'Machine User', GIT_AUTHOR_EMAIL: 'machine@other-org.example',
    WIKI_TEST_REAL_GIT: REAL_GIT, WIKI_TEST_ARGV_LOG: f.logs.argv, WIKI_TEST_CONFIG_LOG: f.logs.config,
    ...fake.env, ...env,
  }, { preload: fake.preload });
  return { ...r, calls: fake.calls() };
}

const head = (f) => git(['rev-parse', 'master'], f.bare).trim();
const show = (f, file) => git(['show', `master:${file}`], f.bare);
const noNonGet = (r) => assert.deepEqual(r.calls.filter((c) => c.method !== 'GET'), [], 'no non-GET request');
const tmpEmpty = (f) => assert.deepEqual(readdirSync(f.tmp), [], 'the clone is removed after the command');

// == pure parts ==========================================================================

test('pageRef reads a page name, a file name and a wiki URL', () => {
  assert.deepEqual(pageRef('Release Notes'), { stem: 'Release-Notes', file: null, repo: null });
  assert.deepEqual(pageRef('Old-Page.textile'), { stem: 'Old-Page', file: 'Old-Page.textile', repo: null });
  assert.deepEqual(pageRef('https://github.com/acme-corp/tools/wiki/Release-Notes'), { stem: 'Release-Notes', file: null, repo: 'acme-corp/tools' });
  assert.deepEqual(pageRef('https://github.com/acme-corp/tools/wiki'), { stem: 'Home', file: null, repo: 'acme-corp/tools' });
  assert.throws(() => pageRef('docs/Page'), UsageError);
  assert.throws(() => pageRef('https://example.com/not/a/wiki/url/x/y'), UsageError);
});

test('findPageFile matches the exact name first, then ignoring case', () => {
  const files = ['Home.md', 'Release-Notes.md', 'Old-Page.textile', 'sub/Deep-Page.md'];
  assert.equal(findPageFile(files, pageRef('release notes')), 'Release-Notes.md');
  assert.equal(findPageFile(files, pageRef('Old Page')), 'Old-Page.textile');
  assert.equal(findPageFile(files, pageRef('Deep Page')), 'sub/Deep-Page.md');
  assert.equal(findPageFile(files, pageRef('Missing')), null);
});

test('searchPages finds titles and lines with a line of context, capped by limit', () => {
  const pages = [{ file: 'Home.md', text: 'a\nimporter here\nb\n' }, { file: 'Importer.md', text: 'importer\n' }];
  const r = searchPages(pages, { title: 'import', query: 'importer', limit: 1 });
  assert.deepEqual(r.titles, ['Importer.md']);
  assert.deepEqual(r.hits, [{ file: 'Home.md', line: 2, text: 'importer here', before: 'a', after: 'b' }]);
  assert.equal(r.more, 1);
});

test('the git environment carries the token only as an extra header scoped to the wiki host and drops the machine configuration', () => {
  const base = { PATH: '/bin', GIT_DIR: '/elsewhere', GIT_ASKPASS: '/askpass', GIT_AUTHOR_EMAIL: 'machine@x' };
  const env = gitEnvironment(TOKEN, base, { serverUrl: 'https://github.com/', identity: noreplyIdentity(USER) });
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_ASKPASS, undefined);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraHeader', 'scoped to the wiki host');
  assert.equal(env.GIT_CONFIG_VALUE_0, authHeader(TOKEN));
  assert.equal(Buffer.from(authHeader(TOKEN).split(' ').pop(), 'base64').toString(), `x-access-token:${TOKEN}`);
  assert.equal(env.GIT_AUTHOR_EMAIL, NOREPLY);
  assert.equal(env.GIT_COMMITTER_NAME, 'octo-bot');
  const local = gitEnvironment(TOKEN, base, { serverUrl: '/srv/wikis' });
  assert.equal(local.GIT_CONFIG_COUNT, undefined, 'no header for a local path');
  assert.ok(!Object.values(local).some((value) => value.includes(authHeader(TOKEN))));
});

test('git failures map to a missing wiki, a refused credential and a moved wiki', () => {
  const context = { repo: 'acme-corp/tools', serverUrl: 'https://github.com', route: 'token (env)' };
  const missing = gitFailure("remote: Repository not found.\nfatal: repository 'https://github.com/acme-corp/tools.wiki.git/' not found", context);
  assert.ok(missing instanceof UsageError);
  assert.match(missing.message, /does not exist yet .* https:\/\/github\.com\/acme-corp\/tools\/wiki/);
  const auth = gitFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled", context);
  assert.ok(auth instanceof UsageError);
  assert.match(auth.message, /fine-grained token may not reach wiki git.*classic token with the `repo` scope.*gh auth login/);
  assert.ok(gitFailure(' ! [rejected]        HEAD -> master (fetch first)', context) instanceof WikiChanged);
});

// == the tool ============================================================================

test('github-wiki is not run where it is not listed, before any request', () => {
  const plain = installation((t) => t);
  const r = tool(plain, 'github-wiki', ['read', '--page', 'Home'], { GITHUB_TOKEN: TOKEN });
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /github-wiki is not a connector of this installation/);
});

test('without GITHUB_TOKEN and a gh login every command names the key, before any request or clone', () => {
  const f = fixture();
  const empty = tempDir('no-programs-');
  for (const args of [['whoami'], ['read', '--page', 'Home'], ['search', '--query', 'x'], ['info', '--page', 'Home'],
    ['append', '--page', 'Home', '--text', 'x', '--dry-run'], ['create', '--title', 'New', '--text', 'x', '--dry-run'],
    ['replace-section', '--page', 'Home', '--heading', 'Rollout', '--text', 'x', '--dry-run']]) {
    const r = wiki(f, args, { GITHUB_TOKEN: '', PATH: empty });
    assert.equal(r.status, 1, `${args[0]}: ${r.output}`);
    assert.match(r.stderr, /GITHUB_TOKEN\s+missing/, args[0]);
    assert.match(r.stderr, /classic token with the `repo` scope/, args[0]);
    assert.deepEqual(r.calls, [], args[0]);
  }
  assert.equal(existsSync(f.logs.argv), false, 'no git run');
});

test('without a repository setting the command names the keys', () => {
  const f = fixture();
  const r = wiki(f, ['read', '--page', 'Home'], { GITHUB_WIKI_REPO: '' });
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /GITHUB_WIKI_REPO .*GITHUB_REPO/);
});

test('whoami shows the noreply commit identity and the scopes', () => {
  const f = fixture();
  const r = wiki(f, ['whoami']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Login: octo-bot \(id 4242\)/);
  assert.match(r.stdout, new RegExp(`Commit identity: octo-bot <${NOREPLY.replace('+', '\\+')}>`));
  assert.match(r.stdout, /Scopes: repo/);
});

test('read prints a page by name, file name or URL, and a textile page as raw text', () => {
  const f = fixture();
  for (const page of ['Home', 'Home.md', 'https://github.com/acme-corp/tools/wiki']) {
    const r = wiki(f, ['read', '--page', page]);
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /^# Home\n\(Home\.md, wiki commit [0-9a-f]{7}, /);
    assert.match(r.stdout, /Old rollout plan\./);
  }
  const t = wiki(f, ['read', '--page', 'Old Page']);
  assert.equal(t.status, 0, t.output);
  assert.match(t.stdout, /textile shown as raw text/);
  assert.match(t.stdout, /h1\. Old page/);
  const fallback = wiki(f, ['read', '--page', 'Home'], { GITHUB_WIKI_REPO: '', GITHUB_REPO: 'tools' });
  assert.equal(fallback.status, 0, `GITHUB_REPO under GITHUB_ORG: ${fallback.output}`);
  const sidebar = wiki(f, ['read', '--page', '_Sidebar']);
  assert.match(sidebar.stdout, /\[\[Home\]\]/);
  const missing = wiki(f, ['read', '--page', 'Nope']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no page "Nope" .*\n {2}Home\.md/);
  tmpEmpty(f);
});

test('search greps the clone: titles and lines with context', () => {
  const f = fixture();
  const r = wiki(f, ['search', '--title', 'release', '--query', 'importer']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Release-Notes\.md\s+Release Notes/);
  assert.match(r.stdout, /Release-Notes\.md:3: Version 1 shipped the importer\./);
  assert.match(r.stdout, /Release-Notes\.md-4- Next line\./);
  const mine = wiki(f, ['search', '--mine']);
  assert.equal(mine.status, 1);
  assert.match(mine.stderr, /--mine is not offered by the github-wiki connector/);
  const capped = wiki(f, ['search', '--query', 'e', '--limit', '1']);
  assert.match(capped.stdout, /more not shown \(raise --limit\)/);
});

test('info shows the file, the last commit touching it and the URL', () => {
  const f = fixture();
  const r = wiki(f, ['info', '--page', 'Release Notes']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /File: Release-Notes\.md \(markdown\)/);
  assert.match(r.stdout, /Last change: [0-9a-f]{7} \d{4}-\d\d-\d\dT\S+ by Seeder/);
  assert.match(r.stdout, /URL: .*\/acme-corp\/tools\/wiki\/Release-Notes/);
  tmpEmpty(f);
});

test('a missing wiki repository says GitHub creates it from the first page in the web interface', () => {
  const f = fixture();
  const r = wiki(f, ['read', '--page', 'Home', '--repo', 'acme-corp/nowiki']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /the wiki of acme-corp\/nowiki does not exist yet — GitHub creates the wiki repository when the first page is made in the web interface: .*\/acme-corp\/nowiki\/wiki/);
  tmpEmpty(f);
});

test('append --dry-run shows the base commit, the page end and the section, and pushes nothing', () => {
  const f = fixture();
  const before = head(f);
  const r = wiki(f, ['append', '--page', 'Home', '--heading', 'Decision', '--text', 'We ship on Friday.', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^--- DRY RUN \(requested --dry-run\) ---$/m);
  assert.match(r.stdout, /Repository: acme-corp\/tools/);
  assert.match(r.stdout, new RegExp(`Page: Home \\(Home\\.md\\) — base commit ${before.slice(0, 7)}`));
  assert.match(r.stdout, /Ask the team\./);
  assert.match(r.stdout, /## Decision\n\nWe ship on Friday\./);
  assert.match(r.stdout, new RegExp(`as octo-bot <${NOREPLY.replace('+', '\\+')}>`));
  assert.match(r.stdout, /DRY RUN — nothing written to the GitHub wiki\.$/m);
  assert.doesNotMatch(r.stdout, /PUBLIC repository/);
  assert.equal(head(f), before, 'the remote did not move');
  assert.doesNotMatch(readFileSync(f.logs.argv, 'utf8'), /\bpush\b/);
  noNonGet(r);
  tmpEmpty(f);
});

test('append writes, commits as the noreply identity and not the machine, and keeps the token out of argv and config', () => {
  const f = fixture();
  const before = head(f);
  const r = wiki(f, ['append', '--page', 'Home', '--heading', 'Decision', '--text', 'We ship on Friday.']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Updated "Home" in the wiki of acme-corp\/tools \(commit [0-9a-f]{7} on master/);
  assert.notEqual(head(f), before);
  assert.equal(show(f, 'Home.md'), `${HOME_PAGE}\n## Decision\n\nWe ship on Friday.\n`);
  const who = git(['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', 'master'], f.bare).trim();
  assert.equal(who, `octo-bot <${NOREPLY}>|octo-bot <${NOREPLY}>|Update Home (oikos)`);
  assert.doesNotMatch(who, /machine|Machine/);
  const argv = readFileSync(f.logs.argv, 'utf8');
  const config = readFileSync(f.logs.config, 'utf8');
  const encoded = authHeader(TOKEN).split(' ').pop();
  for (const [what, text] of [['argv', argv], ['.git/config', config]]) {
    assert.ok(!text.includes(TOKEN) && !text.includes(encoded), `no token in ${what}`);
  }
  assert.ok(!r.output.includes(TOKEN) && !r.output.includes(encoded), 'no token in the output');
  assert.match(argv, /^push --quiet origin HEAD:refs\/heads\/master$/m);
  assert.doesNotMatch(argv, /--force|-f\b/);
  assert.match(config, /url = .*tools\.wiki\.git/);
  noNonGet(r);
  tmpEmpty(f);
});

test('replace-section shows current and new text in the dry run, writes the section, and lists headings when missing', () => {
  const f = fixture();
  const before = head(f);
  const dry = wiki(f, ['replace-section', '--page', 'Home', '--heading', 'Rollout', '--text', 'New plan.', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /Current text:\n-+\nOld rollout plan\.\n-+\nWould become:\n-+\nNew plan\./);
  assert.equal(head(f), before, 'the dry run pushed nothing');
  noNonGet(dry);
  const r = wiki(f, ['replace-section', '--page', 'Home', '--heading', 'Rollout', '--text', 'New plan.', '--version-message', 'Rollout plan v2']);
  assert.equal(r.status, 0, r.output);
  assert.equal(show(f, 'Home.md'), HOME_PAGE.replace('Old rollout plan.', 'New plan.'));
  assert.equal(git(['log', '-1', '--format=%s', 'master'], f.bare).trim(), 'Rollout plan v2');
  const missing = wiki(f, ['replace-section', '--page', 'Home', '--heading', 'Nope', '--text', 'x', '--dry-run']);
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.stderr, /heading "Nope" found 0 times\. Headings:\n {2}# Welcome\n {2}## Rollout\n {2}## Contacts/);
});

test('create refuses an existing page and --parent, previews and writes a new page', () => {
  const f = fixture();
  const exists = wiki(f, ['create', '--title', 'release notes', '--text', 'x', '--dry-run']);
  assert.equal(exists.status, 1, exists.output);
  assert.match(exists.stderr, /already exists \(Release-Notes\.md\)/);
  const parent = wiki(f, ['create', '--title', 'New Page', '--parent', 'Home', '--text', 'x']);
  assert.equal(parent.status, 1);
  assert.match(parent.stderr, /flat/);
  const before = head(f);
  const dry = wiki(f, ['create', '--title', 'New Page', '--text', '# New\n\nBody.', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /Page: New Page \(New-Page\.md, new\)/);
  assert.equal(head(f), before);
  const r = wiki(f, ['create', '--title', 'New Page', '--text', '# New\n\nBody.']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Created "New Page"/);
  assert.equal(show(f, 'New-Page.md'), '# New\n\nBody.\n');
  assert.equal(git(['log', '-1', '--format=%s', 'master'], f.bare).trim(), 'Create New Page (oikos)');
});

test('a write to a page that is not markdown is refused (exit 3)', () => {
  const f = fixture();
  const before = head(f);
  const r = wiki(f, ['append', '--page', 'Old Page', '--text', 'x']);
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, /refused: Old-Page\.textile is a textile page, not markdown/);
  const c = wiki(f, ['create', '--title', 'Other.rst', '--text', 'x', '--dry-run']);
  assert.equal(c.status, 3, c.output);
  assert.equal(head(f), before);
});

test('non-English text is refused without --allow-non-english', () => {
  const f = fixture();
  const r = wiki(f, ['append', '--page', 'Home', '--text', 'Привет', '--dry-run']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /non-Latin letters.*--allow-non-english/);
  assert.deepEqual(r.calls, []);
  const ok = wiki(f, ['append', '--page', 'Home', '--text', 'Привет', '--dry-run', '--allow-non-english']);
  assert.equal(ok.status, 0, ok.output);
});

test('a public repository: refused unless listed in GITHUB_PUBLIC_REPOS, and the dry run carries the banner', () => {
  const f = fixture();
  // The public repository's wiki is the same bare repository, reached under a second name.
  mkdirSync(join(f.server, 'acme-corp', 'open.wiki.git'), { recursive: true });
  git(['clone', '-q', '--bare', f.bare, join(f.server, 'acme-corp', 'open.wiki.git')]);
  const args = ['append', '--repo', 'acme-corp/open', '--page', 'Home', '--text', 'Public note.', '--dry-run'];
  const refused = wiki(f, args);
  assert.equal(refused.status, 3, refused.output);
  assert.match(refused.stderr, /refused: PUBLIC repository acme-corp\/open .*GITHUB_PUBLIC_REPOS/);
  assert.equal(existsSync(f.logs.argv), false, 'refused before the clone');
  const listed = wiki(f, args, { GITHUB_PUBLIC_REPOS: 'acme-corp/other, ACME-CORP/open' });
  assert.equal(listed.status, 0, listed.output);
  assert.match(listed.stdout, /^PUBLIC repository acme-corp\/open — everything written is visible to anyone$/m);
  noNonGet(listed);
});

test('a push the wiki moved ahead of is rejected with exit 2 and no rebase', () => {
  const f = fixture();
  const other = workingClone(f.bare, 'advance-');
  writeFileSync(join(other, 'Home.md'), `${HOME_PAGE}\nSomeone else.\n`);
  git(['commit', '-q', '-am', 'Concurrent edit'], other);
  const r = wiki(f, ['append', '--page', 'Home', '--text', 'Mine.'], { WIKI_TEST_ADVANCE: other });
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /the wiki changed since; run the dry run again/);
  assert.equal(git(['log', '-1', '--format=%s', 'master'], f.bare).trim(), 'Concurrent edit');
  assert.doesNotMatch(readFileSync(f.logs.argv, 'utf8'), /\b(rebase|pull|fetch)\b/);
  tmpEmpty(f);
});
