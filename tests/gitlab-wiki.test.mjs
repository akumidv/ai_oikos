// The gitlab-wiki connector tool against canned GitLab answers (tests/helpers/fake-fetch.mjs): the
// tool runs in a copy of the example installation (ACME Corp) with gitlab-wiki listed under `wiki`,
// as an agent runs it. Never a real network call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NETWORK, assertNoCrashNoRequest, installation, tool, withFakeFetch } from './helpers/installation.mjs';

const SITE = 'https://gitlab.example.com';
const API = `${SITE}/api/v4/projects/acme-corp%2Fhandbook`;
const TOKEN = { GITLAB_TOKEN: 'glpat-fake-token' };

const listed = (t) => t
  .replace('wiki: [confluence]', 'wiki: [confluence, gitlab-wiki]')
  .replace('settings:', `settings:\n  GITLAB_URL: ${SITE}\n  GITLAB_WIKI_PROJECT: acme-corp/handbook`);

const NOTES = [
  '---',
  'title: Release Notes',
  '---',
  '# Release Notes',
  '',
  '## 1.0',
  '',
  'First release.',
  '',
  '## 1.1',
  '',
  'Fixes.',
  '',
].join('\n');

const PAGES = [
  { slug: 'Home', title: 'Home', format: 'markdown' },
  { slug: 'guides/Release-Notes', title: 'Release Notes', format: 'markdown' },
  { slug: 'Legacy', title: 'Legacy', format: 'asciidoc' },
];

const hash = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)}`;

/** The canned wiki: the list, three pages, and whatever `extra` routes come first. */
function wiki(extra = []) {
  return [
    ...extra,
    { match: '/wikis\\?with_content=0', body: PAGES },
    { url: `${API}/wikis/Home`, body: { slug: 'Home', title: 'Home', format: 'markdown', content: '# Home\n\nWelcome.\n' } },
    { url: `${API}/wikis/guides%2FRelease-Notes`, body: { slug: 'guides/Release-Notes', title: 'Release Notes', format: 'markdown', content: NOTES } },
    { url: `${API}/wikis/Legacy`, body: { slug: 'Legacy', title: 'Legacy', format: 'asciidoc', content: '= Legacy\n\nOld text.\n' } },
    { method: 'PUT', match: '/wikis/', body: { slug: 'guides/Release-Notes', title: 'Release Notes', format: 'markdown' } },
    { method: 'POST', url: `${API}/wikis`, body: { slug: 'guides/Setup', title: 'Setup', format: 'markdown' } },
  ];
}

/** Run gitlab-wiki in a fresh installation against the canned wiki. */
function run(args, { routes = wiki(), env = TOKEN, config = listed } = {}) {
  const dir = installation(config);
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'gitlab-wiki', args, { ...env, ...fake.env }, { preload: fake.preload });
  return { ...r, calls: fake.calls() };
}

const nonGet = (calls) => calls.filter((c) => c.method !== 'GET');

test('gitlab-wiki not listed under any skill is a usage error, before any credential or request', () => {
  const r = run(['info', '--page', 'Home'], { config: (t) => listed(t).replace('wiki: [confluence, gitlab-wiki]', 'wiki: [confluence]') });
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /^gitlab-wiki: gitlab-wiki is not a connector of this installation/m);
  assert.equal(r.calls.length, 0);
});

test('without GITLAB_TOKEN every command, dry runs included, is a usage error naming the key, before any request', () => {
  for (const args of [
    ['whoami'], ['read', '--page', 'Home'], ['search', '--title', 'notes'],
    ['create', '--title', 'Setup', '--text', 'Steps.', '--dry-run'],
    ['append', '--page', 'Home', '--text', 'More.', '--dry-run'],
  ]) {
    const r = run(args, { env: {} });
    assertNoCrashNoRequest(r);
    assert.equal(r.status, 1, `${args[0]}: ${r.output}`);
    assert.match(r.stderr, /^gitlab-wiki: no GITLAB_TOKEN$/m);
    assert.match(r.stderr, /GITLAB_TOKEN\s+missing/);
    assert.match(r.stderr, /scope api — wiki writes/, 'the help names the write scope');
    assert.equal(r.calls.length, 0);
  }
});

test('read by title resolves the slug through the list and encodes its `/`', () => {
  const r = run(['read', '--page', 'Release Notes']);
  assert.equal(r.status, 0, r.output);
  assert.ok(r.calls.some((c) => c.url === `${API}/wikis/guides%2FRelease-Notes`), JSON.stringify(r.calls));
  assert.match(r.stdout, /^# Release Notes$/m);
  assert.match(r.stdout, new RegExp(`slug guides/Release-Notes, ${hash(NOTES)}`));
  assert.match(r.stdout, /First release\./);
  assert.match(r.stdout, /-\/wikis\/guides\/Release-Notes/);
});

test('read by wiki URL goes to the page without the list; a page in another format reads as raw text', () => {
  const byUrl = run(['read', '--page', `${SITE}/acme-corp/handbook/-/wikis/guides/Release-Notes`]);
  assert.equal(byUrl.status, 0, byUrl.output);
  assert.deepEqual(byUrl.calls.map((c) => c.url), [`${API}/wikis/guides%2FRelease-Notes`]);
  const legacy = run(['read', '--page', 'Legacy']);
  assert.equal(legacy.status, 0, legacy.output);
  assert.match(legacy.stdout, /format asciidoc: raw text, writes refused/);
  assert.match(legacy.stdout, /^= Legacy$/m);
  const unknown = run(['read', '--page', 'Nowhere']);
  assert.equal(unknown.status, 1, unknown.output);
  assert.match(unknown.stderr, /no page with slug or title "Nowhere".*\n.*Home/);
});

test('search: full text through wiki_blobs plus a title filter over the list', () => {
  const blobs = { match: '/search\\?scope=wiki_blobs&search=release', body: [{ path: 'guides/Release-Notes.md', startline: 8, data: 'First release.\n' }] };
  const r = run(['search', '--query', 'release'], { routes: wiki([blobs]) });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}guides\/Release-Notes {2}Release Notes$/m);
  assert.match(r.stdout, /^ {2}guides\/Release-Notes:8 {2}First release\.$/m);
  assert.match(r.stdout, /1 title match\(es\), 1 text match\(es\) in the wiki of acme-corp\/handbook/);
  const titles = run(['search', '--title', 'home']);
  assert.equal(titles.status, 0, titles.output);
  assert.ok(!titles.calls.some((c) => /search\?/.test(c.url)), 'a title search reads only the list');
  assert.match(titles.stdout, /^ {2}Home {2}Home$/m);
});

test('search falls back to titles when GitLab refuses the wiki scope, and says so', () => {
  for (const status of [400, 403]) {
    const refused = { match: '/search\\?scope=wiki_blobs', status, body: { message: 'Scope not supported without Advanced Search' } };
    const r = run(['search', '--query', 'release'], { routes: wiki([refused]) });
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /Release Notes/);
    assert.match(r.stdout, new RegExp(`NOTE: full-text wiki search refused by GitLab \\(HTTP ${status}\\); titles only\\.`));
  }
});

test('info: title, slug, format, hash, URL, and no version from the API stated', () => {
  const r = run(['info', '--page', 'guides/Release-Notes']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Slug: guides\/Release-Notes$/m);
  assert.match(r.stdout, /^Format: markdown$/m);
  assert.match(r.stdout, new RegExp(`^Content: ${hash(NOTES)}`, 'm'));
  assert.match(r.stdout, /^Version: no version from the API: the write re-reads the page/m);
  assert.match(r.stdout, new RegExp(`^URL: ${SITE}/acme-corp/handbook/-/wikis/guides/Release-Notes$`, 'm'));
});

test('create is refused when the slug exists (exit 3), and posts nothing', () => {
  for (const args of [['--title', 'Home'], ['--title', 'Release Notes', '--parent', 'guides']]) {
    for (const dry of [[], ['--dry-run']]) {
      const r = run(['create', ...args, '--text', 'Again.', ...dry]);
      assert.equal(r.status, 3, r.output);
      assert.match(r.stderr, /^refused: page .* already exists in the wiki of acme-corp\/handbook; edit it instead: https:/m);
      assert.deepEqual(nonGet(r.calls), []);
    }
  }
});

test('create --parent: the dry run shows the slug path and makes only GETs; the write posts title, content, format', () => {
  const dry = run(['create', '--title', 'Setup', '--parent', 'guides', '--text', 'Install it.', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /^--- DRY RUN \(requested --dry-run\) ---$/m);
  assert.match(dry.stdout, /Would create "Setup" under guides \(no page by that name: a new folder\) — slug guides\/Setup/);
  assert.match(dry.stdout, /^DRY RUN — nothing written to the GitLab wiki\.$/m);
  assert.deepEqual(nonGet(dry.calls), []);
  const write = run(['create', '--title', 'Setup', '--parent', 'Release Notes', '--text', 'Install it.']);
  assert.equal(write.status, 0, write.output);
  const posts = nonGet(write.calls);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { method: 'POST', url: `${API}/wikis`, body: { title: 'guides/Release-Notes/Setup', content: 'Install it.', format: 'markdown' } });
});

test('append: the dry run shows project, page, base hash, current and new text with GETs only; the write PUTs the content', () => {
  const dry = run(['append', '--page', 'Release Notes', '--heading', '1.2', '--text', 'New things.', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.deepEqual(nonGet(dry.calls), []);
  assert.match(dry.stdout, /^Project: acme-corp\/handbook$/m);
  assert.match(dry.stdout, /^Page: {4}Release Notes \(slug guides\/Release-Notes, format markdown\)$/m);
  assert.match(dry.stdout, new RegExp(`^Base: {4}${hash(NOTES)} \\(no version from the API`, 'm'));
  assert.match(dry.stdout, /Would become[^\n]*\n-+\n[\s\S]*Fixes\.\n\n## 1\.2\n\nNew things\.\n-+/);
  const write = run(['append', '--page', 'Release Notes', '--heading', '1.2', '--text', 'New things.']);
  assert.equal(write.status, 0, write.output);
  const puts = nonGet(write.calls);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].method, 'PUT');
  assert.equal(puts[0].url, `${API}/wikis/guides%2FRelease-Notes`);
  assert.deepEqual(puts[0].body, { content: `${NOTES.trimEnd()}\n\n## 1.2\n\nNew things.\n` }, 'only the content: the title stays');
  assert.match(write.stdout, new RegExp(`applied to ${hash(NOTES)}, now ${hash(`${NOTES.trimEnd()}\n\n## 1.2\n\nNew things.\n`)}`));
});

test('append --at-start keeps the front matter first', () => {
  const write = run(['append', '--page', 'guides/Release-Notes', '--text', 'Read me first.', '--at-start']);
  assert.equal(write.status, 0, write.output);
  assert.match(nonGet(write.calls)[0].body.content, /^---\ntitle: Release Notes\n---\nRead me first\.\n\n# Release Notes/);
});

test('replace-section: a missing heading lists the headings (exit 1); the dry run shows old and new; the write PUTs', () => {
  const missing = run(['replace-section', '--page', 'Release Notes', '--heading', '2.0', '--text', 'x', '--dry-run']);
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.stderr, /heading "2\.0" found 0 times\. Headings:\n {2}# Release Notes\n {2}## 1\.0\n {2}## 1\.1/);
  assert.deepEqual(nonGet(missing.calls), []);
  const dry = run(['replace-section', '--page', 'Release Notes', '--heading', '1.1', '--text', 'Fixes and speed.', '--dry-run']);
  assert.equal(dry.status, 0, dry.output);
  assert.deepEqual(nonGet(dry.calls), []);
  assert.match(dry.stdout, /Current text:\n-+\nFixes\.\n-+\nWould become:\n-+\nFixes and speed\.\n-+/);
  const write = run(['replace-section', '--page', 'Release Notes', '--heading', '1.1', '--text', 'Fixes and speed.']);
  assert.equal(write.status, 0, write.output);
  const puts = nonGet(write.calls);
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { content: NOTES.replace('Fixes.', 'Fixes and speed.') });
  assert.match(write.stdout, new RegExp(`applied to ${hash(NOTES)}`));
});

test('writes to a page in another format than markdown are refused (exit 3), dry runs too', () => {
  for (const args of [
    ['append', '--page', 'Legacy', '--text', 'More.'],
    ['append', '--page', 'Legacy', '--text', 'More.', '--dry-run'],
    ['replace-section', '--page', 'Legacy', '--heading', 'Legacy', '--text', 'x'],
  ]) {
    const r = run(args);
    assert.equal(r.status, 3, r.output);
    assert.match(r.stderr, /^refused: page Legacy is in format asciidoc, not markdown/m);
    assert.deepEqual(nonGet(r.calls), []);
  }
});

test('non-English content is refused unless --allow-non-english', () => {
  const refused = run(['append', '--page', 'Home', '--text', 'Привет', '--dry-run']);
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.stderr, /wiki content is English, found non-Latin letters/);
  assert.equal(refused.calls.length, 0);
  const allowed = run(['append', '--page', 'Home', '--text', 'Привет', '--dry-run', '--allow-non-english']);
  assert.equal(allowed.status, 0, allowed.output);
  assert.doesNotMatch(allowed.output, new RegExp(NETWORK));
});

test('whoami names the user and warns when the token cannot write', () => {
  const routes = [
    { url: `${SITE}/api/v4/user`, body: { username: 'ada', name: 'Ada Lovelace' } },
    { url: `${SITE}/api/v4/personal_access_tokens/self`, body: { scopes: ['read_api'] } },
  ];
  const r = run(['whoami'], { routes });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^@ada \(Ada Lovelace\) on https:\/\/gitlab\.example\.com$/m);
  assert.match(r.stdout, /no scope api, wiki writes will be rejected/);
});
