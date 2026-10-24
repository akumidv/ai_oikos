// ADF -> text (npm test): what Jira descriptions and comments and Confluence pages read back as.
// A node with no text of its own is named, not dropped; a table reads as a markdown pipe table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToText } from '../tools/common/adf.mjs';

const paragraph = (...texts) => ({ type: 'paragraph', content: texts.map((text) => ({ type: 'text', text })) });

function adfTable(headerKind = 'tableHeader') {
  const cell = (kind, ...paragraphs) => ({ type: kind, content: paragraphs.map((p) => paragraph(p)) });
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph('before'),
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell(headerKind, 'name'), cell(headerKind, 'note')] },
          { type: 'tableRow', content: [cell('tableCell', 'a | b'), cell('tableCell', 'two', 'lines')] },
        ],
      },
      paragraph('after'),
    ],
  };
}

test('a table reads as a pipe table set off by blank lines', () => {
  assert.equal(adfToText(adfTable()).trim(), 'before\n\n| name | note |\n|---|---|\n| a \\| b | two lines |\n\nafter');
});

test('the first row is the header even when its cells are plain cells', () => {
  assert.ok(adfToText(adfTable('tableCell')).includes('| name | note |\n|---|---|'));
});

test('a short row is padded to the table width', () => {
  const table = {
    type: 'table',
    content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('a')] }, { type: 'tableHeader', content: [paragraph('b')] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('1')] }] },
    ],
  };
  assert.equal(adfToText(table).trim(), '| a | b |\n|---|---|\n| 1 |  |');
});

test('an image in a description is named, not dropped', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'We do this: ' },
          { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'uuid-1', type: 'file', alt: 'screen.png' } }] },
        ],
      },
    ],
  };
  const text = adfToText(doc);
  assert.ok(text.includes('We do this:'));
  assert.ok(text.includes('screen.png'));
  assert.ok(text.includes('see Attachments'));
  assert.ok(!text.includes('uuid-1'), 'the media id is not an attachment id');
});

test('an image after a paragraph starts its own line', () => {
  const doc = {
    type: 'doc',
    content: [
      paragraph('See below.'),
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'uuid-1', type: 'file', alt: 'shot.png' } }] },
    ],
  };
  assert.ok(adfToText(doc).includes('See below.\n[file: shot.png'));
});

test('an embedded card keeps its url', () => {
  assert.ok(adfToText({ type: 'inlineCard', attrs: { url: 'https://example.com/spec' } }).includes('https://example.com/spec'));
});

test('a mention, an emoji, a status and a macro are named, not dropped', () => {
  const doc = {
    type: 'paragraph',
    content: [
      { type: 'mention', attrs: { id: 'u1', text: '@Ada' } },
      { type: 'text', text: ' set ' },
      { type: 'status', attrs: { text: 'DONE', color: 'green' } },
      { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } },
      { type: 'extension', attrs: { extensionKey: 'toc' } },
      { type: 'inlineExtension', attrs: { extensionKey: 'jira' } },
      { type: 'bodiedExtension', attrs: { extensionKey: 'expand' } },
    ],
  };
  const text = adfToText(doc);
  for (const part of ['@Ada', '[DONE]', ':smile:', '[macro: toc]', '[macro: jira]', '[macro: expand]']) {
    assert.ok(text.includes(part), `${part} in ${JSON.stringify(text)}`);
  }
});

test('a mention without text keeps the generic name', () => {
  assert.equal(adfToText({ type: 'mention', attrs: { id: 'u1' } }), '@mention');
});

test('an unknown container still degrades to its children', () => {
  assert.ok(adfToText({ type: 'someFutureLayout', content: [{ type: 'text', text: 'kept' }] }).includes('kept'));
});

test('a link mark survives flattening as text and href', () => {
  const doc = { type: 'paragraph', content: [{ type: 'text', text: 'spec', marks: [{ type: 'link', attrs: { href: 'https://example.com/s' } }] }] };
  assert.equal(adfToText(doc).trim(), 'spec (https://example.com/s)');
});
