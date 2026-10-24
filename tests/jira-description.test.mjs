// Jira markdown writes (npm test), against canned answers (fake-fetch.mjs) in a copy of
// examples/installation: `info --description` reads the description as editable markdown or raw
// ADF; `description` appends to it, replaces one section (ambiguous refused, missing appended) or replaces it from raw
// ADF under a guard of the identities it drops; a markdown replace keeps each image and card the
// old part carried or is refused; a task key of a project the site has becomes a card, asked
// about only when the markdown names one; an image line is uploaded to the task (or an attachment
// of the same name and size reused) and refused when its file lies outside the installation and
// the markdown file's folder, in a dot-named store of .local/ (a working folder there is open, ADR 0002
// D01), is not an image, or is a symlink loop; a dry run uploads
// nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installation, tempDir, tool, withFakeFetch } from './helpers/installation.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
const MEDIA_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** Run jira in a fresh installation; `setup(dir)` writes files into it first. */
function run(routes, args, setup = () => {}) {
  const dir = installation((t) => t);
  setup(dir);
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...CREDS, ...fake.env }, fake);
  return { ...r, dir, calls: fake.calls() };
}

const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');
const doc = (...content) => ({ type: 'doc', version: 1, content });
const text = (t) => ({ type: 'text', text: t });
const para = (...content) => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? text(c) : c)) });
const heading = (level, t) => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const mention = { type: 'mention', attrs: { id: 'acc-1', text: '@Ada' } };
const card = (key) => ({ type: 'inlineCard', attrs: { url: `${SITE}/browse/${key}` } });

const descriptionOf = (d) => ({ url: `${API}/issue/PROJ-15?fields=description`, body: { key: 'PROJ-15', fields: { description: d } } });
const put = (status = 204) => ({ method: 'PUT', url: `${API}/issue/PROJ-15`, status });
const projects = (...keys) => ({ match: `^${API}/project/search\\?`, body: { isLast: true, values: keys.map((key) => ({ key })) } });
const attachments = (...list) => ({ url: `${API}/issue/PROJ-15?fields=attachment`, body: { key: 'PROJ-15', fields: { attachment: list } } });
const upload = { method: 'POST', url: `${API}/issue/PROJ-15/attachments`, body: [{ id: '10500', filename: 'shot.png', size: PNG.length }] };
const content = (id) => ({ url: `${API}/attachment/content/${id}`, status: 302, headers: { location: `https://api.media.atlassian.com/file/${MEDIA_ID}/binary?token=secret` } });
const postComment = { method: 'POST', url: `${API}/issue/PROJ-15/comment`, status: 201, body: { id: '10001' } };

// The description most tests start from: a mention outside the section they edit.
const CURRENT = doc(
  para('Intro by ', mention),
  heading(2, 'Scope'), para('old scope'),
  heading(2, 'Notes'), para('keep me'),
);
const putBody = (calls) => writesOf(calls).find((c) => c.method === 'PUT')?.body.fields.description;

// -- info --description --------------------------------------------------------------------

test('info --description prints editable markdown: an image line, a card as its key, a note on what markdown cannot carry', () => {
  const image = { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: MEDIA_ID, alt: 'shot' } }] };
  const r = run([descriptionOf(doc(heading(2, 'Scope'), para('see ', card('PROJ-39')), image, para('by ', mention))), projects('PROJ')],
    ['info', '--task', 'PROJ-15', '--description']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^## Scope$/m);
  assert.match(r.stdout, /^see PROJ-39$/m);
  assert.match(r.stdout, new RegExp(`^!\\[shot\\]\\(media:${MEDIA_ID}\\)$`, 'm'));
  assert.match(r.stderr, /NOTE: the description holds what markdown cannot carry: mention x1\./);
  assert.doesNotMatch(r.stderr, /inlineCard|mediaSingle/);
  assert.deepEqual(writesOf(r.calls), []);
});

test('info --description --adf --out writes the raw ADF to the file', () => {
  const r = run([descriptionOf(CURRENT)], ['info', '--task', 'PROJ-15', '--description', '--adf', '--out', 'd.json']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /PROJ-15 description \(ADF, \d+ characters\) → d\.json/);
  assert.deepEqual(JSON.parse(readFileSync(join(r.dir, 'd.json'), 'utf8')), CURRENT);
});

test('description has no read mode: --get or --out, or no mode at all, is a usage error before any request', () => {
  for (const args of [['--get'], ['--append', '--text', 'x', '--out', 'd.md'], ['--text', 'x'], ['--append', '--section', 'Scope', '--text', 'x']]) {
    const r = run([], ['description', '--task', 'PROJ-15', ...args]);
    assert.equal(r.status, 1, `${args}: ${r.output}`);
    assert.deepEqual(r.calls, []);
  }
});

test('info: --adf or --out without --description, or --description with --extended or --json, is a usage error before any request', () => {
  for (const args of [['--adf'], ['--out', 'd.md'], ['--description', '--extended'], ['--description', '--json']]) {
    const r = run([], ['info', '--task', 'PROJ-15', ...args]);
    assert.equal(r.status, 1, `${args}: ${r.output}`);
    assert.deepEqual(r.calls, []);
  }
});

// -- description --section / --append --------------------------------------------------------

const SECTION = ['description', '--task', 'PROJ-15', '--section', 'scope', '--text', 'New **scope**'];

test('description --section --dry-run shows the old body and the resulting outline, writes nothing', () => {
  const r = run([descriptionOf(CURRENT), put()], [...SECTION, '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /Replacing section "scope" of PROJ-15\. Its body now:\n-+\nold scope\n-+\nNew body:\n-+\nNew \*\*scope\*\*/);
  assert.match(r.stdout, /Resulting outline:\n {2}## Scope {2}<- replaced\n {2}## Notes/);
  assert.match(r.stdout, /DRY RUN — nothing written to Jira\./);
  assert.deepEqual(writesOf(r.calls), []);
});

test('description --section replaces only that body; the mention outside it is kept without a guard', () => {
  const r = run([descriptionOf(CURRENT), put()], SECTION);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(putBody(r.calls).content, [
    CURRENT.content[0], CURRENT.content[1],
    { type: 'paragraph', content: [text('New '), { type: 'text', text: 'scope', marks: [{ type: 'strong' }] }] },
    CURRENT.content[3], CURRENT.content[4],
  ]);
  assert.match(r.stdout, /Wrote the description of PROJ-15 \(section "scope"; HTTP 204\)/);
});

test('description --section: an ambiguous heading exits 1 naming the matches; nothing written', () => {
  const twice = doc(heading(2, 'Scope'), para('a'), heading(3, 'Scope'), para('b'));
  const r = run([descriptionOf(twice), put()], SECTION);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /heading "scope" is ambiguous: 2 matches — "## Scope" \(block 0\), "### Scope" \(block 2\).*--section "## scope"/);
  assert.deepEqual(writesOf(r.calls), []);
});

test('description --section: a missing heading is appended as a new section, and said so', () => {
  const r = run([descriptionOf(CURRENT), put()], ['description', '--task', 'PROJ-15', '--section', 'Risks', '--text', 'none']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /No section "Risks" in the description of PROJ-15 — it is appended as a new one\./);
  assert.deepEqual(putBody(r.calls).content.slice(-2), [heading(2, 'Risks'), para('none')]);
});

test('description --section refuses to replace a body holding what markdown cannot carry, unless --force', () => {
  const held = doc(heading(2, 'Scope'), para('asked by ', mention), heading(2, 'Notes'));
  const refused = run([descriptionOf(held), put()], SECTION);
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.stderr, /Refusing to replace section "scope" of PROJ-15 .*mention x1\. Pass --force/);
  assert.deepEqual(writesOf(refused.calls), []);
  const forced = run([descriptionOf(held), put()], [...SECTION, '--force']);
  assert.equal(forced.status, 0, forced.output);
  assert.equal(writesOf(forced.calls).length, 1);
});

test('description --append adds the blocks after the description, every old node kept', () => {
  const r = run([descriptionOf(CURRENT), put()], ['description', '--task', 'PROJ-15', '--append', '--text', '## Update\nDone.']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(putBody(r.calls).content, [...CURRENT.content, heading(2, 'Update'), para('Done.')]);
});

test('description: a status other than 204 exits 2', () => {
  const r = run([descriptionOf(CURRENT), put(200)], ['description', '--task', 'PROJ-15', '--append', '--text', 'x']);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /Jira answered HTTP 200 to the description, not 204/);
});

// -- description --adf (whole replace) -----------------------------------------------------

test('description --adf replaces the whole description; dropping a mention is refused unless --force', () => {
  const setup = (next) => (dir) => writeFileSync(join(dir, 'd.json'), JSON.stringify(next));
  const args = ['description', '--task', 'PROJ-15', '--adf', '--file', 'd.json'];
  const dropped = doc(para('plain'));
  const refused = run([descriptionOf(CURRENT), put()], args, setup(dropped));
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.stderr, /the new document drops what the old one holds: mention acc-1\..*info --task PROJ-15 --description --adf.*--force/);
  assert.deepEqual(writesOf(refused.calls), []);
  const kept = doc(para('still by ', mention));
  const ok = run([descriptionOf(CURRENT), put()], args, setup(kept));
  assert.equal(ok.status, 0, ok.output);
  assert.deepEqual(putBody(ok.calls), kept);
  const forced = run([descriptionOf(CURRENT), put()], [...args, '--force'], setup(dropped));
  assert.equal(forced.status, 0, forced.output);
  assert.deepEqual(putBody(forced.calls), dropped);
});

test('description --adf refuses a file that is not an ADF document', () => {
  const r = run([descriptionOf(CURRENT)], ['description', '--task', 'PROJ-15', '--adf', '--file', 'd.json'], (dir) => writeFileSync(join(dir, 'd.json'), '{"type":"paragraph"}'));
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /--adf takes an ADF document/);
});

// -- task cards -----------------------------------------------------------------------------

test('a task key of a project the site has becomes a card; another stays text; the project list is asked once', () => {
  const r = run([projects('PROJ'), postComment], ['comment', '--task', 'PROJ-15', '--text', 'Blocked by PROJ-39 and FOO-1, see PROJ-40']);
  assert.equal(r.status, 0, r.output);
  const searches = r.calls.filter((c) => c.url.includes('/project/search'));
  assert.equal(searches.length, 1);
  assert.match(searches[0].url, /keys=PROJ&keys=FOO/);
  const [paragraph] = writesOf(r.calls)[0].body.body.content;
  assert.deepEqual(paragraph.content, [text('Blocked by '), card('PROJ-39'), text(' and FOO-1, see '), card('PROJ-40')]);
});

test('markdown without a task key asks nothing about projects', () => {
  const r = run([postComment], ['comment', '--task', 'PROJ-15', '--text', 'Plain note']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.calls.filter((c) => c.url.includes('/project/search')), []);
});

test('a project list that cannot be read leaves the keys text, said on stderr, and the comment still posts', () => {
  const r = run([{ match: `^${API}/project/search\\?`, status: 500, body: 'boom' }, postComment], ['comment', '--task', 'PROJ-15', '--text', 'See PROJ-39']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stderr, /PROJ keys stay plain text — the project list could not be read \(HTTP 500\)/);
  assert.deepEqual(writesOf(r.calls)[0].body.body.content[0].content, [text('See PROJ-39')]);
});

test('the overwrite guard counts a task card as carried when the site links its key back', () => {
  const withCard = doc(para('see ', card('PROJ-39')));
  const ok = run([descriptionOf(withCard), projects('PROJ'), put()], ['edit', '--task', 'PROJ-15', '--description', 'New, after PROJ-39']);
  assert.equal(ok.status, 0, ok.output);
  const unknown = run([descriptionOf(withCard), projects(), put()], ['edit', '--task', 'PROJ-15', '--description', 'New']);
  assert.equal(unknown.status, 1, unknown.output);
  assert.match(unknown.stderr, /PROJ-15: inlineCard x1/);
});

test('create links task keys of its description, and refuses image lines (the issue does not exist yet)', () => {
  const created = { method: 'POST', url: `${API}/issue`, status: 201, body: { id: '10099', key: 'PROJ-99' } };
  const r = run([projects('PROJ'), created], ['create', '--project', 'PROJ', '--summary', 'Next', '--description', 'After PROJ-15']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(writesOf(r.calls)[0].body.fields.description.content[0].content, [text('After '), card('PROJ-15')]);
  const refused = run([created], ['create', '--project', 'PROJ', '--summary', 'Next', '--description', '![shot](shot.png)']);
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.stderr, /create does not upload images .*shot\.png.*description --task <KEY> --append/);
  assert.deepEqual(writesOf(refused.calls), []);
});

// -- images ---------------------------------------------------------------------------------

/** shot.png beside notes/n.md, which names it relatively. */
const notes = (line = '![shot](shot.png)') => (dir) => {
  mkdirSync(join(dir, 'notes'));
  writeFileSync(join(dir, 'notes', 'shot.png'), PNG);
  writeFileSync(join(dir, 'notes', 'n.md'), `Result:\n\n${line}\n`);
};
const COMMENT_FILE = ['comment', '--task', 'PROJ-15', '--file', 'notes/n.md'];
const imageOf = (calls) => writesOf(calls).find((c) => c.url.endsWith('/comment')).body.body.content[1];

test('an image beside the markdown file is uploaded to the task, then placed by its media file id', () => {
  const r = run([attachments(), upload, content('10500'), postComment], COMMENT_FILE, notes());
  assert.equal(r.status, 0, r.output);
  const posts = writesOf(r.calls).map((c) => c.url);
  assert.deepEqual(posts, [`${API}/issue/PROJ-15/attachments`, `${API}/issue/PROJ-15/comment`]);
  assert.match(writesOf(r.calls)[0].body, /filename="shot\.png"/);
  assert.deepEqual(imageOf(r.calls), { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: MEDIA_ID, collection: '', alt: 'shot' } }] });
  assert.match(r.stdout, /Uploaded shot\.png \(\d+ bytes\) to PROJ-15\./);
  assert.doesNotMatch(r.output, /token=secret/);
});

test('an attachment of the same name and size is reused, not uploaded again', () => {
  const r = run([attachments({ id: '10400', filename: 'shot.png', size: PNG.length }), content('10400'), postComment], COMMENT_FILE, notes());
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(writesOf(r.calls).map((c) => c.url), [`${API}/issue/PROJ-15/comment`]);
  assert.match(r.stdout, /Reusing attachment shot\.png/);
  assert.equal(imageOf(r.calls).content[0].attrs.id, MEDIA_ID);
});

test('attachment:<name> names an attachment of the task; an unknown one is refused before any write', () => {
  const ok = run([attachments({ id: '10400', filename: 'plan.png', size: 9 }), content('10400'), postComment],
    ['comment', '--task', 'PROJ-15', '--text', 'Plan:\n\n![plan](attachment:plan.png)']);
  assert.equal(ok.status, 0, ok.output);
  assert.equal(imageOf(ok.calls).content[0].attrs.id, MEDIA_ID);
  const missing = run([attachments({ id: '10400', filename: 'plan.png', size: 9 }), postComment],
    ['comment', '--task', 'PROJ-15', '--text', 'Plan:\n\n![x](attachment:other.png)']);
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.stderr, /PROJ-15 has no attachment named other\.png\. Attachments: plan\.png/);
  assert.deepEqual(writesOf(missing.calls), []);
});

test('a dry run uploads nothing and says what would be uploaded, with a placeholder id', () => {
  const r = run([attachments(), upload, postComment], [...COMMENT_FILE, '--dry-run', '--show-adf'], notes());
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(writesOf(r.calls), []);
  assert.match(r.stdout, /Images \(the media ids in a dry run are placeholders\):\n {2}shot\.png → shot\.png \(\d+ bytes\) — uploaded to PROJ-15/);
  assert.match(r.stdout, /"id": "00000000-0000-4000-8000-000000000000"/);
});

test('description --section uploads its images and places them in the section', () => {
  const r = run([descriptionOf(CURRENT), attachments(), upload, content('10500'), put()],
    ['description', '--task', 'PROJ-15', '--section', 'Scope', '--file', 'notes/n.md'], notes());
  assert.equal(r.status, 0, r.output);
  assert.equal(putBody(r.calls).content[3].type, 'mediaSingle');
  assert.deepEqual(putBody(r.calls).content.slice(-2), CURRENT.content.slice(-2));
});

test('a local image is refused, before any request, outside the roots, in a store of .local/, by its suffix, or as a symlink loop', () => {
  const outside = join(tempDir('elsewhere-'), 'x.png');
  writeFileSync(outside, PNG);
  const cases = [
    [`![x](${outside})`, /resolves outside the installation and the markdown file's folder/, () => {}],
    ['![x](~/x.png)', /a home or network path is not read/, () => {}],
    ['![x](notes.txt)', /only \.png, .* files are uploaded/, () => {}],
    ['![x](link.png)', /resolves outside/, (dir) => symlinkSync(outside, join(dir, 'link.png'))],
    ['![x](env.png)', /resolves to \.env; only/, (dir) => { writeFileSync(join(dir, '.local', '.env'), 'X=1'); symlinkSync(join(dir, '.local', '.env'), join(dir, 'env.png')); }],
    ['![x](.local/.secrets/x.png)', /it is in \.local\/\.secrets, a closed store of the installation's private \.local\/ folder/,
      (dir) => { mkdirSync(join(dir, '.local', '.secrets')); writeFileSync(join(dir, '.local', '.secrets', 'x.png'), PNG); }],
    ['![x](.local/browser/x.png)', /it is in \.local\/browser, a closed store/, (dir) => { mkdirSync(join(dir, '.local', 'browser')); writeFileSync(join(dir, '.local', 'browser', 'x.png'), PNG); }],
    ['![x](notes/.env.png)', /\.env\.png is a \.env file, never read/, (dir) => { mkdirSync(join(dir, 'notes')); writeFileSync(join(dir, 'notes', '.env.png'), PNG); }],
    ['![x](.claude/x.png)', /it is under \.claude, a dot-named file or folder/, (dir) => { mkdirSync(join(dir, '.claude')); writeFileSync(join(dir, '.claude', 'x.png'), PNG); }],
    ['![x](loop.png)', /cannot be resolved \(ELOOP\)/, (dir) => { symlinkSync('loop2.png', join(dir, 'loop.png')); symlinkSync('loop.png', join(dir, 'loop2.png')); }],
  ];
  for (const [line, why, setup] of cases) {
    const r = run([attachments(), upload, postComment], ['comment', '--task', 'PROJ-15', '--text', line], setup);
    assert.equal(r.status, 1, `${line}: ${r.output}`);
    assert.match(r.stderr, /Refusing image/, line);
    assert.match(r.stderr, why, line);
    assert.deepEqual(r.calls, [], line);
  }
});

test('edit: an image line over several issues is refused (an image is uploaded to one issue)', () => {
  const plain = (key) => ({ url: `${API}/issue/${key}?fields=description`, body: { key, fields: { description: doc(para('old')) } } });
  const r = run([plain('PROJ-15'), plain('PROJ-16')], ['edit', '--task', 'PROJ-15,PROJ-16', '--file', 'notes/n.md'], notes());
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /edit one --task at a time \(selected: PROJ-15, PROJ-16\)/);
  assert.deepEqual(writesOf(r.calls), []);
});

// -- identity guards (what the new part must still hold) ---------------------------------------

const IMAGE = { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: MEDIA_ID, alt: 'shot' } }] };

test('description --section refuses a body that leaves out a carried image or task card, unless --force', () => {
  const held = doc(heading(2, 'Scope'), para('after ', card('PROJ-39')), IMAGE, heading(2, 'Notes'));
  const refused = run([descriptionOf(held), projects('PROJ'), put()], SECTION);
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.stderr, new RegExp(`section "scope" of PROJ-15 .*leaves out what the old one carries: media ${MEDIA_ID}, card ${SITE}/browse/PROJ-39\\..*--force`));
  assert.deepEqual(writesOf(refused.calls), []);
  const kept = run([descriptionOf(held), projects('PROJ'), put()],
    ['description', '--task', 'PROJ-15', '--section', 'scope', '--text', `New, after PROJ-39\n\n![shot](media:${MEDIA_ID})`]);
  assert.equal(kept.status, 0, kept.output);
  assert.deepEqual(writesOf(kept.calls).map((c) => c.method), ['PUT']);
  const forced = run([descriptionOf(held), projects('PROJ'), put()], [...SECTION, '--force']);
  assert.equal(forced.status, 0, forced.output);
});

test('description --adf refuses a swapped mention, an emptied panel and a dropped image, naming each, unless --force', () => {
  const setup = (next) => (dir) => writeFileSync(join(dir, 'd.json'), JSON.stringify(next));
  const args = ['description', '--task', 'PROJ-15', '--adf', '--file', 'd.json'];
  const status = { type: 'status', attrs: { text: 'BLOCKED', color: 'red' } };
  const macro = { type: 'extension', attrs: { extensionType: 'com.example', extensionKey: 'chart' } };
  const old = doc({ type: 'panel', attrs: { panelType: 'info' }, content: [para('by ', mention, ' ', status), macro] }, IMAGE);
  const next = doc({ type: 'panel', attrs: { panelType: 'info' }, content: [] }, para('by ', { type: 'mention', attrs: { id: 'acc-2' } }), IMAGE);
  const refused = run([descriptionOf(old), put()], args, setup(next));
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.stderr, /drops what the old one holds: mention acc-1, macro com\.example:chart, status BLOCKED\./);
  assert.deepEqual(writesOf(refused.calls), []);
  const noImage = run([descriptionOf(old), put()], args, setup(doc(...old.content.slice(0, 1))));
  assert.equal(noImage.status, 1, noImage.output);
  assert.match(noImage.stderr, new RegExp(`drops what the old one holds: media ${MEDIA_ID}\\.`));
  const forced = run([descriptionOf(old), put()], [...args, '--force'], setup(next));
  assert.equal(forced.status, 0, forced.output);
});

const PRIVATE = '.local';

test('an image in a working folder of .local/ is uploaded like any file of the installation', () => {
  const r = run([attachments(), upload, content('10500'), postComment], ['comment', '--task', 'PROJ-15', '--text', 'Result:\n\n![shot](.local/cv/shot.png)'], (dir) => {
    mkdirSync(join(dir, '.local', 'cv'));
    writeFileSync(join(dir, '.local', 'cv', 'shot.png'), PNG);
  });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(writesOf(r.calls).map((c) => c.url), [`${API}/issue/PROJ-15/attachments`, `${API}/issue/PROJ-15/comment`]);
});

test('an image under a store of a symlinked private folder is refused by the folder it points to', () => {
  const r = run([attachments(), upload, postComment], ['comment', '--task', 'PROJ-15', '--text', '![x](store/.secrets/x.png)'], (dir) => {
    mkdirSync(join(dir, 'store', '.secrets'), { recursive: true });
    writeFileSync(join(dir, 'store', '.secrets', 'x.png'), PNG);
    rmSync(join(dir, PRIVATE), { recursive: true, force: true });
    symlinkSync(join(dir, 'store'), join(dir, PRIVATE));
  });
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /Refusing image 'store\/\.secrets\/x\.png': it is in \.local\/\.secrets, a closed store of the installation's private \.local\/ folder/);
  assert.deepEqual(r.calls, []);
});

test('on a file system that folds case, an image under a store of the private folder in upper case is refused too', { skip: !['win32', 'darwin'].includes(process.platform) && 'this file system tells the cases apart' }, () => {
  const r = run([attachments(), upload, postComment], ['comment', '--task', 'PROJ-15', '--text', `![x](${PRIVATE.toUpperCase()}/.secrets/x.png)`],
    (dir) => { mkdirSync(join(dir, PRIVATE, '.secrets')); writeFileSync(join(dir, PRIVATE, '.secrets', 'x.png'), PNG); });
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /private \.local\/ folder/);
});
