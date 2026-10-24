// markdown -> ADF (npm test): pipe tables, task keys as inline cards, images on their own line,
// and what lossyNodes counts as carried for each. No I/O: the resolvers are plain functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToEditableMarkdown, adfToText, imageTargets, markdownToAdf, taskKeys } from '../tools/common/adf.mjs';
import { lossyNodes } from '../tools/common/adf-loss.mjs';

const doc = (...content) => ({ type: 'doc', version: 1, content });
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const cellTexts = (row) => row.content.map((cell) => cell.content.flatMap((p) => p.content || []).map((t) => t.text).join(''));

function onlyTable(md, options) {
  const tables = markdownToAdf(md, options).content.filter((n) => n.type === 'table');
  assert.equal(tables.length, 1, JSON.stringify(tables));
  return tables[0];
}

// -- tables ---------------------------------------------------------------------------------

test('a pipe table becomes a header row and body rows of one-paragraph cells', () => {
  const table = onlyTable('| a | b |\n|---|:---:|\n| 1 | 2 |\n| 3 | 4 |');
  assert.deepEqual(table.attrs, { isNumberColumnEnabled: false, layout: 'default' });
  const [header, ...body] = table.content;
  assert.deepEqual(header.content.map((c) => c.type), ['tableHeader', 'tableHeader']);
  assert.deepEqual(body.map((r) => r.content.map((c) => c.type)), [['tableCell', 'tableCell'], ['tableCell', 'tableCell']]);
  assert.deepEqual(table.content.map(cellTexts), [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.ok(table.content.every((r) => r.content.every((c) => c.content[0].type === 'paragraph')));
});

test('outer pipes are optional', () => {
  assert.deepEqual(onlyTable('a | b\n--- | ---\n1 | 2').content.map(cellTexts), [['a', 'b'], ['1', '2']]);
});

test('a short row is padded and a long row cut to the header width; an empty cell is a bare paragraph', () => {
  const table = onlyTable('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |');
  assert.deepEqual(table.content.map(cellTexts), [['a', 'b', 'c'], ['1', '', ''], ['1', '2', '3']]);
  assert.deepEqual(table.content[1].content[1].content, [{ type: 'paragraph' }]);
});

test('an escaped pipe is a literal pipe inside a cell', () => {
  assert.deepEqual(cellTexts(onlyTable('| expr | note |\n|---|---|\n| a \\| b | ok |').content[1]), ['a | b', 'ok']);
});

test('a cell goes through the inline parser, mentions included', () => {
  const table = onlyTable('| h |\n|---|\n| **bold** `code` [x](https://example.com) [~accountid:u-1] |');
  const nodes = table.content[1].content[0].content[0].content;
  const marks = nodes.map((n) => (n.marks || []).map((m) => m.type).join('+'));
  for (const mark of ['strong', 'code', 'link']) assert.ok(marks.includes(mark), mark);
  assert.ok(nodes.some((n) => n.type === 'mention' && n.attrs.id === 'u-1'));
});

test('a table is a block between paragraphs', () => {
  assert.deepEqual(markdownToAdf('before\n| a |\n|---|\n| 1 |\nafter\n\nlast').content.map((n) => n.type), ['paragraph', 'table', 'paragraph', 'paragraph']);
});

test('pipes without a separator row, or with one of another width, are not a table', () => {
  assert.deepEqual(markdownToAdf('| a | b |\n| 1 | 2 |').content.map((n) => n.type), ['paragraph']);
  assert.ok(!markdownToAdf('| a | b |\n|---|\n| 1 | 2 |').content.some((n) => n.type === 'table'));
});

test('headings, lists, code and rules convert as before', () => {
  const content = markdownToAdf('# T\n- a\n  - sub\n- b\n1. one\n\n```\nx = 1\n```\n---').content;
  assert.deepEqual(content.map((n) => n.type), ['heading', 'bulletList', 'orderedList', 'codeBlock', 'rule']);
  assert.equal(content[1].content[0].content[1].type, 'bulletList');
  assert.deepEqual(content[3].content, [{ type: 'text', text: 'x = 1' }]);
});

test('the reading view of a table reads back as the same table', () => {
  const md = '| a | b |\n|---|---|\n| x \\| y | **z** |\n|  | w |';
  const text = adfToText(markdownToAdf(md)).trim();
  assert.deepEqual(onlyTable(text).content.map(cellTexts), [['a', 'b'], ['x | y', 'z'], ['', 'w']]);
});

test('a table markdown builds is carried; merged, multi-block and headerless tables are not', () => {
  assert.deepEqual(lossyNodes(markdownToAdf('| a | b |\n|---|---|\n| **1** |  |')), {});
  const cell = (type, ...content) => ({ type, content });
  const merged = { type: 'table', content: [{ type: 'tableRow', content: [{ ...cell('tableHeader', para('a')), attrs: { colspan: 2 } }] }] };
  const blocks = { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', para('a'), para('b'))] }] };
  const headerless = { type: 'table', content: [{ type: 'tableRow', content: [cell('tableCell', para('a'))] }] };
  const marked = { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', { type: 'paragraph', content: [{ type: 'text', text: 't', marks: [{ type: 'em' }] }] })] }] };
  assert.deepEqual(lossyNodes(doc(merged, blocks, headerless, marked, { type: 'table', content: [] })), {
    'merged table cell': 1, 'table cell with several blocks': 1, 'table without a header row': 1, 'mark:em': 1, table: 1,
  });
});

// -- task keys -> inline cards --------------------------------------------------------------

const SITE = 'https://acme.example.com';
const PROJECTS = new Set(['PROJ', 'OPS']);
const issueUrl = (key) => (PROJECTS.has(key.split('-')[0]) ? `${SITE}/browse/${key}` : null);
const CARD = { type: 'inlineCard', attrs: { url: `${SITE}/browse/PROJ-12` } };
const inline = (md, options = { issueUrl }) => markdownToAdf(md, options).content[0].content;

test('a key the resolver links becomes an inline card; others stay text', () => {
  assert.deepEqual(inline('see PROJ-12, not UTF-8 or SHA-256 or ZZ-9 now'), [
    { type: 'text', text: 'see ' }, CARD, { type: 'text', text: ', not UTF-8 or SHA-256 or ZZ-9 now' },
  ]);
});

test('a key in code, a link, bold or a fenced block is left alone', () => {
  const nodes = inline('`PROJ-12` [PROJ-12](https://example.com/x) **PROJ-12** end');
  assert.ok(nodes.every((n) => n.type === 'text'));
  assert.deepEqual(nodes.map((n) => n.text), ['PROJ-12', ' ', 'PROJ-12', ' ', 'PROJ-12', ' end']);
  assert.deepEqual(markdownToAdf('```\nPROJ-12\n```', { issueUrl }).content[0], { type: 'codeBlock', content: [{ type: 'text', text: 'PROJ-12' }] });
});

test('a key inside a URL or a version is not linked', () => {
  const nodes = inline('see https://example.com/?issue=PROJ-12&x=1 and PROJ-12.1 and PROJ-12.');
  assert.equal(nodes.filter((n) => n.type === 'inlineCard').length, 1);
  assert.deepEqual(nodes.at(-1), { type: 'text', text: '.' });
});

test('without a resolver nothing changes', () => {
  assert.deepEqual(inline('see PROJ-12', {}), [{ type: 'text', text: 'see PROJ-12' }]);
});

test('a key in a list, a heading and a table cell links too', () => {
  const built = markdownToAdf('# PROJ-12\n\n- PROJ-12\n\n| a |\n|---|\n| PROJ-12 |', { issueUrl });
  assert.equal(JSON.stringify(built).split('"inlineCard"').length - 1, 3);
});

test('taskKeys names the key-shaped tokens outside code, links and URLs', () => {
  assert.deepEqual(taskKeys('PROJ-1 and UTF-8, `OPS-2`, [OPS-3](https://e.example) https://e.example/OPS-4 PROJ-1'), ['PROJ-1', 'UTF-8']);
});

test('a task card reads back as its key and round-trips through editable markdown', () => {
  const built = markdownToAdf('see PROJ-12 now', { issueUrl });
  assert.equal(adfToText(built).trim(), 'see PROJ-12 now');
  const md = adfToEditableMarkdown(built);
  assert.equal(md, 'see PROJ-12 now\n');
  assert.deepEqual(markdownToAdf(md, { issueUrl }), built);
  assert.deepEqual(lossyNodes(built, { issueUrl }), {});
});

test('a card the resolver would not write back is lost', () => {
  const built = markdownToAdf('see PROJ-12 now', { issueUrl });
  assert.deepEqual(lossyNodes(built), { inlineCard: 1 });
  assert.deepEqual(lossyNodes(built, { issueUrl: () => null }), { inlineCard: 1 });
  assert.deepEqual(lossyNodes(built, { issueUrl: (key) => `https://other.example.com/browse/${key}` }), { inlineCard: 1 });
});

test('a card that would not re-parse as a card is lost', () => {
  const glued = doc({ type: 'paragraph', content: [CARD, { type: 'text', text: 'x tail' }] });
  const version = doc({ type: 'paragraph', content: [CARD, { type: 'text', text: '.1 tail' }] });
  const url = doc({ type: 'paragraph', content: [{ type: 'text', text: 'https://h.example/?i=' }, CARD] });
  const two = doc({ type: 'paragraph', content: [CARD, CARD] });
  for (const d of [glued, version, url, two]) assert.notDeepEqual(lossyNodes(d, { issueUrl }), {}, JSON.stringify(d));
  assert.deepEqual(lossyNodes(doc({ type: 'paragraph', content: [CARD, { type: 'text', text: '. Next' }] }), { issueUrl }), {});
});

test('a card that is not a task keeps its URL and is lost', () => {
  const other = doc({ type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://example.com/page' } }] });
  assert.deepEqual(lossyNodes(other, { issueUrl }), { inlineCard: 1 });
  assert.ok(adfToText(other).includes('[embedded card: https://example.com/page]'));
  assert.equal(adfToEditableMarkdown(other), 'https://example.com/page\n');
});

// -- images ---------------------------------------------------------------------------------

const UUID = 'c7cbf81c-10ec-4c36-8ba2-a02436f35e36';
const firstBlock = (md, resolveImage = (target) => `id-for-${target}`) => markdownToAdf(md, { resolveImage }).content[0];
const refuse = () => { throw new Error('nothing to resolve'); };

test('a local path and an attachment name are resolved to a media id by the caller', () => {
  const seen = [];
  const resolve = (target, alt) => { seen.push([target, alt]); return UUID; };
  const local = firstBlock('![shot](docs/a b.png)', resolve);
  const attached = firstBlock('![](attachment:x.png)', resolve);
  assert.deepEqual(seen, [['docs/a b.png', 'shot'], ['attachment:x.png', '']]);
  assert.deepEqual(local, { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: UUID, collection: '', alt: 'shot' } }] });
  assert.ok(!('alt' in attached.content[0].attrs));
});

test('a media reference and a URL need no resolver call', () => {
  const ref = firstBlock(`![a](media:${UUID}?layout=center&display=50%25&width=10&height=5)`, refuse);
  assert.deepEqual(ref.attrs, { layout: 'center', width: 50, widthType: 'percentage' });
  assert.deepEqual(ref.content[0].attrs, { type: 'file', id: UUID, collection: '', alt: 'a', width: 10, height: 5 });
  assert.deepEqual(firstBlock('![w](https://example.com/w.png)', refuse).content[0].attrs, { type: 'external', url: 'https://example.com/w.png', alt: 'w' });
});

test('without a resolver, or when it cannot place the target, an image line stays text', () => {
  assert.deepEqual(markdownToAdf('![a](x.png)'), markdownToAdf('![a](x.png)', { issueUrl }));
  assert.equal(markdownToAdf('![a](x.png)').content[0].type, 'paragraph');
  assert.equal(firstBlock('![a](x.png)', () => null).type, 'paragraph');
});

test('imageTargets names what the caller has to resolve, once each, outside code', () => {
  const md = `![a](docs/a.png)\n![b](attachment:b.png)\n![c](media:${UUID})\n![d](https://example.com/d.png)\n\`\`\`\n![e](e.png)\n\`\`\`\n![a](docs/a.png)\ntext ![f](f.png) inline`;
  assert.deepEqual(imageTargets(md), ['docs/a.png', 'attachment:b.png']);
});

test('the display width keeps pixels, percent and a bare number apart', () => {
  const parsed = (display) => firstBlock(`![](media:${UUID}?display=${display})`).attrs;
  assert.deepEqual(parsed('742px'), { width: 742, widthType: 'pixel' });
  assert.deepEqual(parsed('50%25'), { width: 50, widthType: 'percentage' });
  assert.deepEqual(parsed('66'), { width: 66 });
});

const JIRA_IMAGE = {
  type: 'mediaSingle',
  attrs: { width: 742, widthType: 'pixel', layout: 'center' },
  content: [{ type: 'media', attrs: { type: 'file', id: UUID, alt: 'Screenshot 2026.png', collection: '', height: 663, width: 1534 } }],
};

const IMAGES = {
  jira: JIRA_IMAGE,
  'no display': { type: 'mediaSingle', attrs: { layout: 'align-start' }, content: [{ type: 'media', attrs: { type: 'file', id: UUID, collection: '', height: 2, width: 3 } }] },
  'percent and collection': { type: 'mediaSingle', attrs: { width: 40, widthType: 'percentage', layout: 'wide' }, content: [{ type: 'media', attrs: { type: 'file', id: UUID, collection: 'team' } }] },
  external: { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'external', url: 'https://example.com/a.png', alt: 'a' } }] },
  'width without a type is a percentage': { type: 'mediaSingle', attrs: { width: 66, layout: 'center' }, content: [{ type: 'media', attrs: { type: 'file', id: UUID, collection: '' } }] },
  'values that are not plain tokens': { type: 'mediaSingle', attrs: { layout: 'a&width=999 b' }, content: [{ type: 'media', attrs: { type: 'file', id: 'x?y&z(1)', collection: 't&e=a' } }] },
};

for (const [name, node] of Object.entries(IMAGES)) {
  test(`an image as Jira returns it survives editable markdown: ${name}`, () => {
    const d = doc(para('before'), node, para('after'));
    assert.deepEqual(markdownToAdf(adfToEditableMarkdown(d), { resolveImage: refuse }), d);
  });
}

test('an image the line cannot carry reads as its placeholder', () => {
  const odd = { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: UUID, occurrenceKey: 'k' } }] };
  const bracket = { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: UUID, alt: 'a]b' } }] };
  const sizedUrl = { type: 'mediaSingle', attrs: { layout: 'wide' }, content: [{ type: 'media', attrs: { type: 'external', url: 'https://example.com/a.png' } }] };
  assert.equal(adfToEditableMarkdown(doc(odd, bracket, sizedUrl)), '[file — see Attachments]\n\n[file: a]b — see Attachments]\n\n[external — see Attachments]\n');
});

test('an image its line carries passes the overwrite guard; one it cannot carry stays lost', () => {
  assert.deepEqual(lossyNodes(doc(JIRA_IMAGE, ...Object.values(IMAGES))), {});
  const odd = { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: UUID, occurrenceKey: 'k' } }] };
  const group = { type: 'mediaGroup', content: [{ type: 'media', attrs: { type: 'file', id: UUID } }] };
  assert.deepEqual(lossyNodes(doc(odd, group)), { mediaSingle: 1, mediaGroup: 1 });
});
