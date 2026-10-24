// Jira totals and compact dry runs (npm test), against canned answers (fake-fetch.mjs) in a copy of
// examples/installation: `search --count` asks the approximate count and reads no rows; a dry run of a
// text over 2000 characters (edit and create descriptions, description, comment) prints its size, its
// outline and a diff against the current description — or its first lines when there is none —
// unless --full, which prints the whole text and changes nothing in the write itself. No dry run writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installation, tool, withFakeFetch } from './helpers/installation.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };

function run(routes, args, { creds = CREDS } = {}) {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...creds, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}

const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');
const doc = (...content) => ({ type: 'doc', version: 1, content });
const text = (t) => ({ type: 'text', text: t });
const para = (t) => ({ type: 'paragraph', content: [text(t)] });
const heading = (level, t) => ({ type: 'heading', attrs: { level }, content: [text(t)] });

// A long markdown text: two sections of 40 numbered lines each, well over 2000 characters.
const lines = (from, n, word) => Array.from({ length: n }, (_, i) => `Line ${from + i} of the ${word} part, long enough to count.`);
const LONG = ['## Scope', '', ...lines(1, 40, 'scope').join('\n\n').split('\n'), '', '## Plan', '', ...lines(41, 40, 'plan').join('\n\n').split('\n')].join('\n');
const LAST = 'Line 80 of the plan part, long enough to count.';
// The current description: the same text with one line changed in the plan part.
const CURRENT = doc(heading(2, 'Scope'), ...lines(1, 40, 'scope').map(para), heading(2, 'Plan'),
  ...lines(41, 40, 'plan').map((l) => para(l.replace('Line 60 of', 'Line sixty of'))));

const descriptionOf = (d) => ({ url: `${API}/issue/PROJ-15?fields=description`, body: { key: 'PROJ-15', fields: { description: d } } });
const put = { method: 'PUT', url: `${API}/issue/PROJ-15`, status: 204 };

// -- search --count ------------------------------------------------------------------------

const COUNT = { method: 'POST', url: `${API}/search/approximate-count`, body: { count: 1234 } };

test('search --count posts the JQL to approximate-count, prints the total as approximate and reads no rows', () => {
  const r = run([COUNT], ['search', '--jql', 'project = PROJ', '--count']);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.stdout.trim(), '≈ 1234 issues (approximate count)');
  assert.deepEqual(r.calls, [{ method: 'POST', url: `${API}/search/approximate-count`, body: { jql: 'project = PROJ' } }]);
});

test('search --count --json prints the raw answer', () => {
  const r = run([COUNT], ['search', '--jql', 'project = PROJ', '--count', '--json']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(JSON.parse(r.stdout), { count: 1234 });
});

test('search --count with --limit or --fields is a usage error before any request', () => {
  for (const extra of [['--limit', '5'], ['--fields', 'summary']]) {
    const r = run([COUNT], ['search', '--jql', 'project = PROJ', '--count', ...extra]);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, /--count prints only the total: not with --limit or --fields/);
    assert.deepEqual(r.calls, []);
  }
});

// -- edit ------------------------------------------------------------------------------------

const EDIT = ['edit', '--task', 'PROJ-15', '--description', LONG];

test('edit --dry-run of a long description prints its size, outline and the diff from the current one, writes nothing', () => {
  const r = run([descriptionOf(CURRENT), put], [...EDIT, '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}description: \(compact\)$/m);
  assert.match(r.stdout, new RegExp(`^Size: ${LONG.length} characters, ${LONG.split('\n').length} lines — shown compact`, 'm'));
  assert.match(r.stdout, /^Resulting outline:\n {2}## Scope\n {2}## Plan$/m);
  assert.match(r.stdout, /^--- PROJ-15 description \(current\)\n\+\+\+ PROJ-15 description \(new\)\n@@ /m);
  assert.match(r.stdout, /^-Line sixty of the plan part, long enough to count\.$/m);
  assert.match(r.stdout, /^\+Line 60 of the plan part, long enough to count\.$/m);
  assert.doesNotMatch(r.stdout, /Line 1 of the scope part/);
  assert.deepEqual(writesOf(r.calls), []);
});

test('edit --dry-run --full prints the whole description; the write with --full is the write without it', () => {
  const full = run([descriptionOf(CURRENT), put], [...EDIT, '--dry-run', '--full']);
  assert.equal(full.status, 0, full.output);
  assert.match(full.stdout, /Line 1 of the scope part/);
  assert.match(full.stdout, new RegExp(LAST.replace(/\./g, '\\.')));
  assert.doesNotMatch(full.stdout, /shown compact|^--- PROJ-15/m);
  assert.deepEqual(writesOf(full.calls), []);
  const plain = run([descriptionOf(CURRENT), put], EDIT);
  const withFull = run([descriptionOf(CURRENT), put], [...EDIT, '--full']);
  assert.equal(withFull.status, 0, withFull.output);
  assert.deepEqual(writesOf(withFull.calls), writesOf(plain.calls));
  assert.equal(writesOf(plain.calls).length, 1);
});

test('edit --dry-run of a short description prints it as before', () => {
  const r = run([descriptionOf(doc(para('old'))), put], ['edit', '--task', 'PROJ-15', '--description', 'New text', '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}description: \nNew text$/m);
  assert.doesNotMatch(r.stdout, /shown compact/);
});

// -- create ----------------------------------------------------------------------------------

test('create --dry-run of a long description prints its size, outline and first lines, writes nothing', () => {
  const r = run([], ['create', '--project', 'PROJ', '--summary', 'Next', '--description', LONG, '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /shown compact/);
  assert.match(r.stdout, /^Resulting outline:\n {2}## Scope\n {2}## Plan$/m);
  assert.match(r.stdout, /^First lines:\n {2}## Scope\n {2}\n {2}Line 1 of the scope part/m);
  assert.match(r.stdout, /^ {2}… \d+ more lines$/m);
  assert.doesNotMatch(r.stdout, new RegExp(LAST.replace(/\./g, '\\.')));
  assert.deepEqual(writesOf(r.calls), []);
});

// -- description -----------------------------------------------------------------------------

test('description --append --dry-run of a long text prints its size and the diff of the whole description, writes nothing', () => {
  const r = run([descriptionOf(doc(heading(2, 'Intro'), para('kept'))), put], ['description', '--task', 'PROJ-15', '--append', '--text', LONG, '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Appending to the description of PROJ-15:\nSize: \d+ characters/m);
  assert.match(r.stdout, /^@@ -1,3 \+1,\d+ @@\n ## Intro\n \n kept\n\+\n\+## Scope$/m);
  assert.match(r.stdout, /^Resulting outline:\n {2}## Intro\n {2}## Scope\n {2}## Plan$/m);
  assert.deepEqual(writesOf(r.calls), []);
  const full = run([descriptionOf(doc(para('kept'))), put], ['description', '--task', 'PROJ-15', '--append', '--text', LONG, '--dry-run', '--full']);
  assert.match(full.stdout, new RegExp(`-{40}\\n## Scope[^]*${LAST.replace(/\./g, '\\.')}\\n-{40}`));
});

test('description --section --dry-run of a long body names the section without printing its old body', () => {
  const r = run([descriptionOf(CURRENT), put], ['description', '--task', 'PROJ-15', '--section', 'Plan', '--text', LONG, '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Replacing section "Plan" of PROJ-15\.\nSize: /m);
  assert.doesNotMatch(r.stdout, /Its body now:/);
  assert.deepEqual(writesOf(r.calls), []);
});

// -- comment ---------------------------------------------------------------------------------

test('comment --dry-run of a long text prints its size, outline and first lines, offline too; --full the whole text', () => {
  const r = run([], ['comment', '--task', 'PROJ-15', '--text', LONG, '--dry-run'], { creds: {} });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Comment that WOULD be posted:\nSize: \d+ characters, \d+ lines — shown compact/m);
  assert.match(r.stdout, /^First lines:$/m);
  assert.doesNotMatch(r.stdout, new RegExp(LAST.replace(/\./g, '\\.')));
  assert.deepEqual(r.calls, []);
  const full = run([], ['comment', '--task', 'PROJ-15', '--text', LONG, '--dry-run', '--full'], { creds: {} });
  assert.equal(full.status, 0, full.output);
  assert.match(full.stdout, new RegExp(LAST.replace(/\./g, '\\.')));
  assert.deepEqual(full.calls, []);
});
