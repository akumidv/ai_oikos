// Editing ADF in place (npm test): append, sections by heading, the outline, and the editable
// markdown that markdownToAdf reads back. Every edit returns a new document; the input is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToEditableMarkdown, adfToText, appendBlocks, markdownToAdf, outline, replaceSection, sectionBody } from '../tools/common/adf.mjs';
import { adfIdentities, carriedIdentities, lossyNodes, missingIdentities } from '../tools/common/adf-loss.mjs';

const doc = (...content) => ({ type: 'doc', version: 1, content });
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const heading = (text, level = 2) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
// An image an image line cannot carry (occurrenceKey), so only an in-place edit keeps it.
const MEDIA = { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'u-1', type: 'file', occurrenceKey: 'k' } }] };

/** Run `edit` on a deep copy of `input` and assert the input is unchanged. */
function unchanged(input, edit) {
  const before = structuredClone(input);
  const out = edit(input);
  assert.deepEqual(input, before, 'the input document is not changed');
  return out;
}

// -- appendBlocks ---------------------------------------------------------------------------

test('appendBlocks keeps every existing node and adds the blocks after them', () => {
  const d = doc(para('before'), MEDIA);
  const out = unchanged(d, (x) => appendBlocks(x, [para('after')]));
  assert.deepEqual(out.content, [para('before'), MEDIA, para('after')]);
  assert.equal(out.version, 1);
});

test('appendBlocks on no document starts one', () => {
  assert.deepEqual(appendBlocks(null, [para('x')]), doc(para('x')));
});

// -- sections -------------------------------------------------------------------------------

test('replaceSection touches only the body up to the next heading of the same or a higher level', () => {
  const d = doc(para('intro'), heading('Plan'), para('old'), heading('Detail', 3), para('old detail'), heading('Notes'), para('keep a'), MEDIA, para('keep b'));
  const out = unchanged(d, (x) => replaceSection(x, 'plan', [para('new')]));
  assert.deepEqual(out.content, [para('intro'), heading('Plan'), para('new'), heading('Notes'), para('keep a'), MEDIA, para('keep b')]);
});

test('a section under a level-1 heading ends at the next level-1 heading', () => {
  const d = doc(heading('A', 1), para('a'), heading('B', 2), para('b'), heading('C', 1), para('c'));
  assert.deepEqual(replaceSection(d, 'A', [para('x')]).content, [heading('A', 1), para('x'), heading('C', 1), para('c')]);
});

test('replaceSection drops a copied heading and appends a missing one', () => {
  const d = doc(heading('Plan'), para('old'));
  assert.deepEqual(replaceSection(d, 'Plan', [heading('Plan'), para('new')]).content, [heading('Plan'), para('new')]);
  assert.deepEqual(unchanged(d, (x) => replaceSection(x, '## Risks', [para('r')])).content, [...d.content, heading('Risks'), para('r')]);
  assert.deepEqual(replaceSection(d, 'Risks', [para('r')]).content.at(-2), heading('Risks', 2));
  assert.deepEqual(replaceSection(d, '### Risks', [para('r')]).content.at(-2), heading('Risks', 3));
});

test('leading #s fix the level a heading matches at', () => {
  const d = doc(heading('Plan', 2), para('two'), heading('Plan', 3), para('three'));
  assert.deepEqual(replaceSection(d, '### Plan', [para('x')]).content, [heading('Plan', 2), para('two'), heading('Plan', 3), para('x')]);
});

test('an ambiguous heading is refused, naming the matches', () => {
  const d = doc(heading('Plan'), para('a'), heading('plan', 3));
  assert.throws(() => replaceSection(d, 'Plan', [para('x')]), /2 matches.*"## Plan" \(block 0\).*"### plan" \(block 2\)/);
  assert.throws(() => sectionBody(d, 'Plan'), /ambiguous/);
});

test('sectionBody returns what replaceSection would overwrite, and refuses a missing heading', () => {
  const d = doc(heading('Plan'), para('old'), heading('Detail', 3), para('deep'), heading('Notes'), para('n'));
  assert.deepEqual(sectionBody(d, 'Plan'), [para('old'), heading('Detail', 3), para('deep')]);
  assert.deepEqual(sectionBody(d, 'notes'), [para('n')]);
  assert.throws(() => sectionBody(d, 'Risks'), /no heading "Risks"; headings: Plan, Detail, Notes/);
});

test('a heading holding a task card matches by its key', () => {
  const d = doc({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'About ' }, { type: 'inlineCard', attrs: { url: 'https://acme.example.com/browse/PROJ-1' } }] }, para('x'));
  assert.deepEqual(sectionBody(d, 'About PROJ-1'), [para('x')]);
});

test('outline lists the top-level headings with their levels', () => {
  const d = doc(heading('Title', 1), para('x'), heading('Plan'), heading('Detail', 3));
  assert.deepEqual(outline(d), [{ level: 1, text: 'Title' }, { level: 2, text: 'Plan' }, { level: 3, text: 'Detail' }]);
  assert.deepEqual(outline(null), []);
});

// -- editable markdown ----------------------------------------------------------------------

const EVERY_KIND = `# Title

Plain text with **bold**, \`code\`, [a link](https://example.com/a) and [~accountid:u-1].

## Lists

- one
- two **bold**
  - nested a
  - nested b

1. first
2. second
  1. inner

- after a blank line

\`\`\`
code with

blank lines
\`\`\`

\`\`\`
\`\`\`

---

| a | b |
|---|---|
| 1 | with \\| pipe |
|  | **x** |

### Last

closing paragraph
`;

test('editable markdown round-trips every node markdownToAdf builds', () => {
  const built = markdownToAdf(EVERY_KIND);
  const kinds = new Set(built.content.map((n) => n.type));
  for (const kind of ['heading', 'paragraph', 'bulletList', 'orderedList', 'codeBlock', 'rule', 'table']) assert.ok(kinds.has(kind), kind);
  assert.deepEqual(markdownToAdf(adfToEditableMarkdown(built)), built);
});

test('editable markdown keeps the structure the reading view flattens', () => {
  const built = markdownToAdf('## Plan\n\n- one\n- **two**\n\n```\ncode\n```');
  assert.equal(adfToEditableMarkdown(built), '## Plan\n\n- one\n- **two**\n\n```\ncode\n```\n');
  assert.equal(adfToText(built), '\nPlan\n\none\n\ntwo\ncode');
});

test('a mention is written as Jira reads it; a node outside the subset as its reading text', () => {
  const d = doc({ type: 'paragraph', content: [
    { type: 'mention', attrs: { id: 'u-1', text: '@Ada' } },
    { type: 'text', text: ' set ' },
    { type: 'status', attrs: { text: 'DONE' } },
    { type: 'hardBreak' },
    { type: 'text', text: 'both', marks: [{ type: 'em' }, { type: 'strong' }] },
  ] }, { type: 'panel', content: [para('inside')] });
  assert.equal(adfToEditableMarkdown(d), '[~accountid:u-1] set [DONE] **both**\n\ninside\n');
  assert.deepEqual(Object.keys(lossyNodes(d)).sort(), ['hardBreak', 'mark:em+strong', 'mention', 'panel', 'status']);
});

test('editable markdown of an empty document is empty', () => {
  assert.equal(adfToEditableMarkdown(null), '');
  assert.equal(adfToEditableMarkdown(doc({ type: 'paragraph' })), '');
});

// -- identities -------------------------------------------------------------------------------

const ids = (found) => Object.fromEntries(Object.entries(found).map(([kind, set]) => [kind, [...set].sort()]));

test('adfIdentities collects every identity through panels, expands, layouts, tables and lists', () => {
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'panel', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'acc-1' } }, { type: 'status', attrs: { text: 'DONE' } }] }] },
      { type: 'expand', content: [{ type: 'bodiedExtension', attrs: { extensionType: 'com.atlassian.confluence.macro.core', extensionKey: 'toc' }, content: [] }] },
      { type: 'layoutSection', content: [{ type: 'layoutColumn', content: [{ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'm-1' } }] }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://acme.example/browse/PROJ-1' } }, { type: 'emoji', attrs: { shortName: ':tada:' } }] }] }] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'external', url: 'https://example.com/x.png' } }] },
    ],
  };
  assert.deepEqual(ids(adfIdentities(doc)), {
    media: ['https://example.com/x.png', 'm-1'], mentions: ['acc-1'], cards: ['https://acme.example/browse/PROJ-1'],
    extensions: ['com.atlassian.confluence.macro.core:toc'], statuses: ['DONE'], emoji: [':tada:'],
  });
  assert.deepEqual(ids(carriedIdentities(doc)), { media: ['https://example.com/x.png', 'm-1'], cards: ['https://acme.example/browse/PROJ-1'] });
});

test('missingIdentities names what the new document lacks: a swapped mention, an emptied panel', () => {
  const mention = (id) => ({ type: 'paragraph', content: [{ type: 'mention', attrs: { id } }] });
  const before = { type: 'doc', content: [{ type: 'panel', content: [mention('acc-1')] }, { type: 'extension', attrs: { extensionType: 't', extensionKey: 'k' } }] };
  const after = { type: 'doc', content: [{ type: 'panel', content: [] }, mention('acc-2'), { type: 'extension', attrs: { extensionType: 't', extensionKey: 'k' } }] };
  assert.deepEqual(missingIdentities(adfIdentities(before), adfIdentities(after)), ['mention acc-1']);
  assert.deepEqual(missingIdentities(adfIdentities(before), adfIdentities(before)), []);
});
