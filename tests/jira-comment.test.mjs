// Jira `comment --edit` / `--delete` and the ids `info` shows (npm test), against canned answers
// (fake-fetch.mjs) in a copy of examples/installation. Both read the comment first and refuse one
// another account wrote unless --others; the edit refuses to overwrite content markdown cannot carry
// unless --force; a dry run names the comment by its first line and writes nothing; the write checks
// Jira's status (200 for the PUT, 204 for the DELETE). `info` names each comment's id and each
// link's id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installation, tool, withFakeFetch } from './helpers/installation.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
const COMMENT_URL = `${API}/issue/PROJ-15/comment/10001`;

function run(routes, args, { creds = CREDS } = {}) {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...creds, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}

const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');
const doc = (...content) => ({ type: 'doc', version: 1, content });
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

const myself = { url: `${API}/myself`, body: { accountId: 'acc-ada', displayName: 'Ada' } };
const commentOf = (accountId, body = doc(para('Old progress note'), para('second line'))) => ({
  url: COMMENT_URL, body: { id: '10001', author: { accountId, displayName: accountId === 'acc-ada' ? 'Ada' : 'Grace' }, body },
});
const put = (status = 200) => ({ method: 'PUT', url: COMMENT_URL, status, body: { id: '10001' } });
const del = (status = 204) => ({ method: 'DELETE', url: COMMENT_URL, status });
const EDIT = ['comment', '--task', 'PROJ-15', '--edit', '10001', '--text', 'New **progress** note'];
const DELETE = ['comment', '--task', 'PROJ-15', '--delete', '10001'];

// -- info -----------------------------------------------------------------------------------

test('info names each comment by its id and each link by its id', () => {
  const issue = {
    match: `^${API}/issue/PROJ-15\\?fields=`,
    body: { id: '10015', key: 'PROJ-15', fields: {
      summary: 'Export', status: { name: 'To Do' }, issuetype: { name: 'Task' },
      issuelinks: [{ id: '10234', type: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }, outwardIssue: { key: 'PROJ-39', fields: { summary: 'Import' } } }],
      comment: { comments: [{ id: '10001', author: { displayName: 'Ada' }, created: '2026-10-01T10:00:00.000+0000', body: doc(para('Started')) }] },
    } },
  };
  const r = run([issue], ['info', '--task', 'PROJ-15']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}--- Ada, 2026-10-01 \[id 10001\]$/m);
  assert.match(r.stdout, /^ {2}blocks PROJ-39 .* \[link 10234\]$/m);
});

// -- edit -----------------------------------------------------------------------------------

test('comment --edit --dry-run reads the comment and the account, shows the old first line and the new text, writes nothing', () => {
  const r = run([commentOf('acc-ada'), myself, put()], [...EDIT, '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Comment 10001 that WOULD be replaced \(by Ada\): Old progress note$/m);
  assert.match(r.stdout, /^New \*\*progress\*\* note$/m);
  assert.match(r.stdout, /DRY RUN — nothing written to Jira\./);
  assert.deepEqual(writesOf(r.calls), []);
});

test('comment --edit PUTs the markdown as ADF over the comment, after reading it', () => {
  const r = run([commentOf('acc-ada'), myself, put()], EDIT);
  assert.equal(r.status, 0, r.output);
  const writes = writesOf(r.calls);
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url}`), [`PUT ${COMMENT_URL}`]);
  assert.equal(writes[0].body.body.type, 'doc');
  assert.match(JSON.stringify(writes[0].body.body), /"strong"/);
  assert.match(r.stdout, /^Edited comment 10001 of PROJ-15 \(HTTP 200\)/m);
});

test('comment --edit: an answer other than 200 exits 2', () => {
  const r = run([commentOf('acc-ada'), myself, put(202)], EDIT);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /HTTP 202 to the edit, not 200/);
});

test('comment --edit refuses a comment another account wrote; --others overrides', () => {
  for (const args of [EDIT, [...EDIT, '--dry-run']]) {
    const r = run([commentOf('acc-grace'), myself, put()], args);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, /Refusing: comment 10001 on PROJ-15 was written by Grace, not by this account\..*--others overrides/);
    assert.deepEqual(writesOf(r.calls), []);
  }
  const r = run([commentOf('acc-grace'), myself, put()], [...EDIT, '--others']);
  assert.equal(r.status, 0, r.output);
  assert.equal(writesOf(r.calls).length, 1);
});

test('comment --edit refuses over a mention markdown cannot carry; --force overwrites', () => {
  const lossy = doc({ type: 'paragraph', content: [{ type: 'text', text: 'Ask ' }, { type: 'mention', attrs: { id: '1', text: '@Grace' } }] });
  const r = run([commentOf('acc-ada', lossy), myself, put()], EDIT);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /Refusing to replace comment 10001 on PROJ-15 from markdown .*mention x1\..*--force/);
  assert.deepEqual(writesOf(r.calls), []);
  const forced = run([commentOf('acc-ada', lossy), myself, put()], [...EDIT, '--force']);
  assert.equal(forced.status, 0, forced.output);
  assert.equal(writesOf(forced.calls).length, 1);
});

test('comment --edit of a comment that is not there is a usage error, nothing written', () => {
  const r = run([{ url: COMMENT_URL, status: 404, body: { errorMessages: ['not found'] } }, myself], EDIT);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /PROJ-15 has no comment 10001 visible to this account\./);
  assert.deepEqual(writesOf(r.calls), []);
});

// -- delete ---------------------------------------------------------------------------------

test('comment --delete --dry-run names the comment by its first line and deletes nothing', () => {
  const r = run([commentOf('acc-ada'), myself, del()], [...DELETE, '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Comment that WOULD be deleted: comment 10001 of PROJ-15 by Ada: Old progress note$/m);
  assert.deepEqual(writesOf(r.calls), []);
});

test('comment --delete deletes after reading; anything but 204 exits 2', () => {
  const r = run([commentOf('acc-ada'), myself, del()], DELETE);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.url}`), [`GET ${COMMENT_URL}`, `GET ${API}/myself`, `DELETE ${COMMENT_URL}`]);
  assert.match(r.stdout, /^Deleted comment 10001 of PROJ-15 by Ada \(HTTP 204\)\.$/m);
  const odd = run([commentOf('acc-ada'), myself, del(200)], DELETE);
  assert.equal(odd.status, 2, odd.output);
  assert.match(odd.stderr, /HTTP 200 to the delete, not 204/);
});

test('comment --delete refuses a comment another account wrote; --others overrides', () => {
  const r = run([commentOf('acc-grace'), myself, del()], DELETE);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /written by Grace, not by this account/);
  assert.deepEqual(writesOf(r.calls), []);
  const others = run([commentOf('acc-grace'), myself, del()], [...DELETE, '--others']);
  assert.equal(others.status, 0, others.output);
  assert.equal(writesOf(others.calls).length, 1);
});

test('comment --delete --dry-run without credentials names only the id and reaches nothing', () => {
  const r = run([], [...DELETE, '--dry-run'], { creds: {} });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Comment that WOULD be deleted: comment 10001 of PROJ-15$/m);
  assert.match(r.stdout, /no Jira credentials/);
  assert.deepEqual(r.calls, []);
});

test('comment: --edit with --delete, or an id that is not digits, is refused before any request', () => {
  const both = run([], ['comment', '--task', 'PROJ-15', '--edit', '1', '--delete', '1', '--dry-run']);
  assert.equal(both.status, 1, both.output);
  assert.match(both.stderr, /pass --edit or --delete, not both/);
  const bad = run([], ['comment', '--task', 'PROJ-15', '--delete', '1;x', '--dry-run']);
  assert.equal(bad.status, 1, bad.output);
  assert.match(bad.stderr, /a comment id is digits only, got '1;x'/);
  assert.deepEqual([...both.calls, ...bad.calls], []);
});
