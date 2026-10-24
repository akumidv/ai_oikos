// Jira guards (npm test), against canned answers (fake-fetch.mjs) in a copy of examples/installation:
// `edit --description` refuses to overwrite a description holding what markdown cannot carry unless
// --force; `link` resolves --type by name or verb (an inward verb swaps the ends), reports a link that
// already exists and refuses a reversed one before any POST; a 404 on an issue asks /myself whether
// the credentials are the cause; `context` prints an unavailable line for a section whose read fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installation, tool, withFakeFetch } from './helpers/installation.mjs';
import { lossyNodes, lossyText } from '../tools/common/adf-loss.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
const BLOCKS = { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' };
const RELATES = { name: 'Relates', outward: 'relates to', inward: 'relates to' };

function run(routes, args) {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...CREDS, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}

const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');
const doc = (...content) => ({ type: 'doc', version: 1, content });
const para = (...content) => ({ type: 'paragraph', content });
const text = (t, ...marks) => ({ type: 'text', text: t, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });

// -- lossyNodes -----------------------------------------------------------------------------

test('lossyNodes: what markdown builds is carried, an image line too; odd images, mentions, macros and extra marks are not', () => {
  const carried = doc(
    { type: 'heading', attrs: { level: 2 }, content: [text('Scope')] },
    para(text('plain '), text('bold', 'strong'), text(' code', 'code')),
    { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('one')), { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('nested'))] }] }] }] },
    { type: 'rule' },
    { type: 'codeBlock', content: [text('x = 1')] },
    { type: 'paragraph' },
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'abc' } }] },
  );
  assert.deepEqual(lossyNodes(carried), {});
  const lossy = doc(
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'abc', occurrenceKey: 'k' } }] },
    para(text('hi '), { type: 'mention', attrs: { id: '1', text: '@Ada' } }, { type: 'status', attrs: { text: 'DONE' } }),
    para(text('both', 'strong', 'em'), text('under', 'underline')),
    { type: 'extension', attrs: {} },
    { type: 'table', content: [] },
  );
  assert.deepEqual(lossyNodes(lossy), { mediaSingle: 1, mention: 1, status: 1, 'mark:strong+em': 1, 'mark:underline': 1, extension: 1, table: 1 });
  assert.equal(lossyText({ mention: 2, mediaSingle: 1 }), 'mediaSingle x1, mention x2');
  assert.deepEqual(lossyNodes(null), {});
});

// -- edit --description guard ---------------------------------------------------------------

const descriptionOf = (key, d) => ({ url: `${API}/issue/${key}?fields=description`, body: { key, fields: { description: d } } });
const put = (key) => ({ method: 'PUT', url: `${API}/issue/${key}`, status: 204 });
// The first image an image line carries (`![screen.png](media:abc)`); the second it cannot (occurrenceKey).
const IMAGE_AND_MENTION = doc(
  para(text('See '), { type: 'mention', attrs: { id: '1', text: '@Ada' } }),
  { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'abc', alt: 'screen.png' } }] },
  { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'def', occurrenceKey: 'k' } }] },
);
const EDIT = ['edit', '--task', 'PROJ-15', '--description', 'New text'];

test('edit --description refuses over an odd image and a mention, naming the issue and the kinds, nothing written', () => {
  const r = run([descriptionOf('PROJ-15', IMAGE_AND_MENTION), put('PROJ-15')], EDIT);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /Refusing to replace the description from markdown .*PROJ-15: mediaSingle x1, mention x1\..*description --task KEY --section "Heading".*--force/s);
  assert.deepEqual(writesOf(r.calls), []);
});

test('edit --description --dry-run reports the refusal too', () => {
  const r = run([descriptionOf('PROJ-15', IMAGE_AND_MENTION)], [...EDIT, '--dry-run']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /PROJ-15: mediaSingle x1, mention x1/);
  assert.deepEqual(writesOf(r.calls), []);
});

test('edit --description over a bulk selection names each issue that would lose content', () => {
  const routes = [descriptionOf('PROJ-15', IMAGE_AND_MENTION), descriptionOf('PROJ-39', doc(para(text('plain')))),
    descriptionOf('PROJ-40', doc({ type: 'blockCard', attrs: { url: 'https://example.com' } }))];
  const r = run(routes, ['edit', '--task', 'PROJ-15,PROJ-39,PROJ-40', '--description', 'New text']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /PROJ-15: mediaSingle x1, mention x1; PROJ-40: blockCard x1/);
  assert.doesNotMatch(r.stderr, /PROJ-39:/);
  assert.deepEqual(writesOf(r.calls), []);
});

test('edit --description --force overwrites without reading the description', () => {
  const r = run([put('PROJ-15')], [...EDIT, '--force']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(writesOf(r.calls).map((c) => `${c.method} ${c.url}`), [`PUT ${API}/issue/PROJ-15`]);
  assert.deepEqual(r.calls.filter((c) => c.url.includes('fields=description')), []);
});

test('edit --description over an image its line carries passes the guard when the new text keeps that line', () => {
  const image = { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'abc', alt: 'screen.png' } }] };
  const r = run([descriptionOf('PROJ-15', doc(para(text('Old')), image)), put('PROJ-15')],
    ['edit', '--task', 'PROJ-15', '--description', 'New text\n\n![screen.png](media:abc)']);
  assert.equal(r.status, 0, r.output);
  assert.equal(writesOf(r.calls).length, 1);
});

test('edit --description that leaves out a carried image is refused naming its media id, unless --force', () => {
  const image = { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'abc', alt: 'screen.png' } }] };
  const refused = run([descriptionOf('PROJ-15', doc(para(text('Old')), image)), put('PROJ-15')], EDIT);
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.stderr, /leaves out what the old one carries: PROJ-15: media abc\..*deleted from Attachments.*media:<id>.*--force/);
  assert.deepEqual(writesOf(refused.calls), []);
  const forced = run([descriptionOf('PROJ-15', doc(para(text('Old')), image)), put('PROJ-15')], [...EDIT, '--force']);
  assert.equal(forced.status, 0, forced.output);
  assert.equal(writesOf(forced.calls).length, 1);
});

test('edit --description over a plain description passes the guard', () => {
  const r = run([descriptionOf('PROJ-15', doc(para(text('Old '), text('text', 'strong')))), put('PROJ-15')], EDIT);
  assert.equal(r.status, 0, r.output);
  assert.equal(writesOf(r.calls).length, 1);
  assert.match(r.stdout, /^edited PROJ-15$/m);
});

// -- link -----------------------------------------------------------------------------------

const linkTypes = { url: `${API}/issueLinkType`, body: { issueLinkTypes: [BLOCKS, RELATES] } };
const linkPost = { method: 'POST', url: `${API}/issueLink`, status: 201 };
const linksOf = (key, links, times) => ({
  url: `${API}/issue/${key}?fields=issuelinks`,
  ...(times ? { times } : {}),
  body: { key, fields: { issuelinks: links } },
});
const blocksLink = (side, other = 'PROJ-39') => ({ id: '10234', type: BLOCKS, [side]: { key: other, fields: {} } });
const LINK = ['link', '--from', 'PROJ-15', '--type', 'Blocks', '--to', 'PROJ-39'];

test('link: the same link already there is reported, exit 0, no POST', () => {
  for (const args of [LINK, [...LINK, '--dry-run']]) {
    const r = run([linkTypes, linksOf('PROJ-15', [blocksLink('outwardIssue')]), linkPost], args);
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /^Already linked: PROJ-15 blocks PROJ-39 \(link id 10234\)\.$/m);
    assert.deepEqual(writesOf(r.calls), []);
  }
});

test('link: a reversed link of the type is refused with the unlink to run first, no POST', () => {
  for (const args of [LINK, [...LINK, '--dry-run']]) {
    const r = run([linkTypes, linksOf('PROJ-15', [blocksLink('inwardIssue')]), linkPost], args);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, /PROJ-15 already is blocked by PROJ-39 \(link id 10234\).*Remove it first: `.*unlink --id 10234`/);
    assert.deepEqual(writesOf(r.calls), []);
  }
});

test('link: an inward verb swaps the ends of the POST and confirms the stated verb', () => {
  const routes = [linkTypes, linksOf('PROJ-15', [], 1), linkPost, linksOf('PROJ-15', [blocksLink('inwardIssue')])];
  const r = run(routes, ['link', '--from', 'PROJ-15', '--type', 'IS BLOCKED BY', '--to', 'PROJ-39']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(writesOf(r.calls).map((c) => c.body), [{ type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-39' }, outwardIssue: { key: 'PROJ-15' } }]);
  assert.match(r.stdout, /^Linked: PROJ-15 is blocked by PROJ-39 \(link id 10234\), confirmed by reading PROJ-15 back\.$/m);
});

test('link: an outward verb resolves to the type name', () => {
  const routes = [linkTypes, linksOf('PROJ-15', [], 1), linkPost, linksOf('PROJ-15', [blocksLink('outwardIssue')])];
  const r = run(routes, ['link', '--from', 'PROJ-15', '--type', 'blocks', '--to', 'PROJ-39']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(writesOf(r.calls).map((c) => c.body.type), [{ name: 'Blocks' }]);
});

test('link: an unknown type is refused listing the valid types with their verbs', () => {
  const r = run([linkTypes], ['link', '--from', 'PROJ-15', '--type', 'Duplicates', '--to', 'PROJ-39']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /No link type 'Duplicates'\. Valid: Blocks \(blocks \/ is blocked by\); Relates \(relates to \/ relates to\)\./);
  assert.deepEqual(writesOf(r.calls), []);
});

test('link: a --type several types answer to is refused naming them', () => {
  const twin = { name: 'Depends', outward: 'blocks', inward: 'depends on' };
  const r = run([{ url: `${API}/issueLinkType`, body: { issueLinkTypes: [BLOCKS, twin] } }], ['link', '--from', 'PROJ-15', '--type', 'blocks', '--to', 'PROJ-39']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /--type 'blocks' matches several link types: Blocks, Depends\./);
});

// -- 404 credential probe -------------------------------------------------------------------

const issue404 = { match: `^${API}/issue/PROJ-404\\?fields=`, status: 404, body: { errorMessages: ['Issue does not exist'] } };

test('a 404 with /myself rejecting the credentials blames the credentials', () => {
  const r = run([issue404, { url: `${API}/myself`, status: 401, body: 'unauthorized' }], ['info', '--task', 'PROJ-404']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /Jira rejected the credentials for this lookup — JIRA_EMAIL or JIRA_API_TOKEN is wrong or lacks access, not that PROJ-404 is missing/);
});

test('a 404 with /myself answering says the issue is missing or not visible to this account', () => {
  const r = run([issue404, { url: `${API}/myself`, body: { accountId: 'a-1', displayName: 'Ada' } }], ['info', '--task', 'PROJ-404']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /PROJ-404: does not exist, or the authenticated account cannot see it\./);
  assert.doesNotMatch(r.stderr, /credentials/);
});

// -- context --------------------------------------------------------------------------------

const SPRINT_FIELD = 'customfield_10020';
const fieldList = { url: `${API}/field`, body: [{ id: SPRINT_FIELD, name: 'Sprint' }] };
const task = (status, category, extra = {}) => ({
  match: `^${API}/issue/PROJ-15\\?fields=`,
  body: { id: '10015', key: 'PROJ-15', fields: { summary: 'Export', status: { name: status, statusCategory: { key: category } }, issuetype: { name: 'Task' }, ...extra } },
});
const epicParent = { parent: { key: 'PROJ-1', fields: { summary: 'Reports', issuetype: { name: 'Epic' } } } };

test('context: a failing epic read prints an unavailable line and the report still exits 0', () => {
  const r = run([fieldList, task('To Do', 'new', epicParent), { match: `^${API}/search/jql`, status: 500, body: 'boom' }], ['context', '--task', 'PROJ-15']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^_Epic PROJ-1 — children: unavailable \(HTTP 500\)_$/m);
  assert.match(r.stdout, /^## Warnings$/m);
});

test('context: a failing field list prints the Sprint section unavailable and still reads the task', () => {
  const r = run([{ url: `${API}/field`, status: 503, body: 'down' }, task('In Progress', 'indeterminate')], ['context', '--task', 'PROJ-15']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^_Sprint: unavailable \(HTTP 503\)_$/m);
  assert.match(r.stdout, /work is going on but the task is not in an active sprint/);
});

test('context: the not-in-an-active-sprint warning only while work is going on', () => {
  const idle = run([fieldList, task('To Do', 'new')], ['context', '--task', 'PROJ-15']);
  assert.equal(idle.status, 0, idle.output);
  assert.doesNotMatch(idle.stdout, /not in an active sprint/);
  const busy = run([fieldList, task('In Progress', 'indeterminate')], ['context', '--task', 'PROJ-15']);
  assert.match(busy.stdout, /work is going on but the task is not in an active sprint/);
  const sprinting = run([fieldList, task('In Progress', 'indeterminate', { [SPRINT_FIELD]: [{ id: 7, name: 'S7', state: 'active' }] })], ['context', '--task', 'PROJ-15']);
  assert.doesNotMatch(sprinting.stdout, /not in an active sprint/);
});

test('context: the task fetch itself stays fatal', () => {
  const r = run([fieldList, { match: `^${API}/issue/PROJ-15\\?fields=`, status: 500, body: 'boom' }], ['context', '--task', 'PROJ-15']);
  assert.notEqual(r.status, 0, r.output);
});
