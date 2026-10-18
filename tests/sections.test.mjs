// Sections of a markdown page (npm test): the pure helpers the markdown wikis share — headings
// outside fenced code, the section under a heading, replacing its body and appending a section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageError } from '../tools/common/cli.mjs';
import { SectionError, appendToPage, findSection, headings, replaceSection } from '../tools/common/sections.mjs';

const PAGE = [
  '# Title',
  '',
  'Intro.',
  '',
  '## Alpha',
  '',
  'Alpha body.',
  '',
  '### Alpha detail',
  '',
  'Deeper text.',
  '',
  '## Beta ##',
  '',
  'Beta body.',
  '',
].join('\n');

test('headings: levels, closing #s, line numbers, and lines that are not headings', () => {
  const md = ['# One', '#NoSpace', '    # indented code', '###### Six ###', '####### seven', '## Hash#tag', '#', '## ##', 'Setext', '======'].join('\n');
  assert.deepEqual(headings(md), [
    { level: 1, text: 'One', line: 0 },
    { level: 6, text: 'Six', line: 3 },
    { level: 2, text: 'Hash#tag', line: 5 },
    { level: 1, text: '', line: 6 },
    { level: 2, text: '', line: 7 },
  ]);
});

test('headings: nested levels in page order', () => {
  assert.deepEqual(headings(PAGE).map((h) => [h.level, h.text, h.line]), [
    [1, 'Title', 0], [2, 'Alpha', 4], [3, 'Alpha detail', 8], [2, 'Beta', 12],
  ]);
});

test('headings: a heading inside fenced code is ignored — backticks, tildes, longer fences', () => {
  const md = [
    '# Real',
    '```bash',
    '# a shell comment',
    '```',
    '~~~',
    '# in tildes',
    '```',
    '# still in tildes: a backtick run does not close a tilde fence',
    '~~~',
    '````markdown',
    '```',
    '# inside a four-backtick fence',
    '```',
    '````',
    '## After',
    '``` not a fence: inline `code` ```',
    '## Also real',
    '```',
    '# unclosed fence runs to the end',
  ].join('\n');
  assert.deepEqual(headings(md).map((h) => h.text), ['Real', 'After', 'Also real']);
});

test('findSection: a section runs to the next heading of the same or higher level', () => {
  assert.deepEqual(findSection(PAGE, 'Alpha'), { level: 2, text: 'Alpha', headingLine: 4, bodyStart: 5, bodyEnd: 12 });
  assert.deepEqual(findSection(PAGE, 'Alpha detail'), { level: 3, text: 'Alpha detail', headingLine: 8, bodyStart: 9, bodyEnd: 12 });
  assert.deepEqual(findSection(PAGE, 'Title'), { level: 1, text: 'Title', headingLine: 0, bodyStart: 1, bodyEnd: 15 });
  assert.deepEqual(findSection(PAGE, '  Beta  '), { level: 2, text: 'Beta', headingLine: 12, bodyStart: 13, bodyEnd: 15 });
});

test('findSection: matches the exact text as Confluence does — case-sensitive, no # prefix', () => {
  assert.throws(() => findSection(PAGE, 'alpha'), SectionError);
  assert.throws(() => findSection(PAGE, '## Alpha'), SectionError);
});

test('findSection: a missing heading lists the page headings', () => {
  assert.throws(() => findSection(PAGE, 'Gamma'), (e) => {
    assert.ok(e instanceof SectionError && e instanceof UsageError);
    assert.equal(e.message, 'heading "Gamma" found 0 times. Headings:\n  # Title\n  ## Alpha\n  ### Alpha detail\n  ## Beta');
    assert.equal(e.count, 0);
    return true;
  });
  assert.throws(() => findSection('no headings here\n', 'X'), /found 0 times\. Headings:\n {2}\(none\)$/);
});

test('findSection: a duplicate heading lists the page headings', () => {
  const md = '## Notes\n\na\n\n### Notes\n\nb\n';
  assert.throws(() => findSection(md, 'Notes'), (e) => {
    assert.ok(e instanceof SectionError);
    assert.equal(e.message, 'heading "Notes" found 2 times. Headings:\n  ## Notes\n  ### Notes');
    assert.equal(e.count, 2);
    return true;
  });
});

test('replaceSection: replaces the body with its deeper subsections, keeps the rest', () => {
  const out = replaceSection(PAGE, 'Alpha', 'New alpha.');
  assert.equal(out, '# Title\n\nIntro.\n\n## Alpha\n\nNew alpha.\n\n## Beta ##\n\nBeta body.\n');
});

test('replaceSection: a subsection stops at the next heading of the same or higher level', () => {
  const out = replaceSection(PAGE, 'Alpha detail', '\n\nNew detail.\n\n');
  assert.equal(out, PAGE.replace('Deeper text.', 'New detail.'));
});

test('replaceSection: the last section, with and without a final newline', () => {
  assert.equal(replaceSection(PAGE, 'Beta', 'B1\nB2'), PAGE.replace('Beta body.\n', 'B1\nB2\n'));
  const bare = PAGE.trimEnd();
  assert.equal(replaceSection(bare, 'Beta', 'B1'), bare.replace('Beta body.', 'B1'));
  assert.equal(replaceSection('# A\n\n## Last', 'Last', 'x'), '# A\n\n## Last\n\nx');
  assert.equal(replaceSection('# A\n## Last\n', 'Last', 'x'), '# A\n## Last\n\nx\n');
});

test('replaceSection: an empty body leaves an empty section', () => {
  assert.equal(replaceSection(PAGE, 'Alpha', ''), '# Title\n\nIntro.\n\n## Alpha\n\n## Beta ##\n\nBeta body.\n');
  assert.equal(replaceSection('## Only\nold\n', 'Only', ''), '## Only\n');
});

test('replaceSection: a CRLF page stays CRLF, the body included', () => {
  const crlf = PAGE.replace(/\n/g, '\r\n');
  const out = replaceSection(crlf, 'Alpha', 'Line 1\nLine 2');
  assert.equal(out, '# Title\r\n\r\nIntro.\r\n\r\n## Alpha\r\n\r\nLine 1\r\nLine 2\r\n\r\n## Beta ##\r\n\r\nBeta body.\r\n');
  assert.ok(!/[^\r]\n/.test(out));
});

test('replaceSection: a heading in code is not a section boundary', () => {
  const md = '## A\n\n```\n## B\n```\n\n## C\n\nc\n';
  assert.equal(replaceSection(md, 'A', 'new'), '## A\n\nnew\n\n## C\n\nc\n');
  assert.throws(() => replaceSection(md, 'B', 'x'), SectionError);
});

test('appendToPage: one blank line before the body, final newline kept or absent as before', () => {
  assert.equal(appendToPage('# T\n\ntext\n', 'more'), '# T\n\ntext\n\nmore\n');
  assert.equal(appendToPage('# T\n\ntext\n\n\n', '\nmore\n\n'), '# T\n\ntext\n\nmore\n');
  assert.equal(appendToPage('# T\n\ntext', 'more'), '# T\n\ntext\n\nmore');
  assert.equal(appendToPage('', 'first'), 'first\n');
});

test('appendToPage: with a heading (level 2 by default) and at the start, as Confluence append', () => {
  assert.equal(appendToPage('# T\n', 'body', { heading: 'Decision' }), '# T\n\n## Decision\n\nbody\n');
  assert.equal(appendToPage('# T\n', 'body', { heading: 'Deep', level: 4 }), '# T\n\n#### Deep\n\nbody\n');
  assert.equal(appendToPage('\n# T\n', 'body', { heading: 'First', atStart: true }), '## First\n\nbody\n\n# T\n');
  assert.equal(appendToPage('# T\n', '', { heading: 'Empty' }), '# T\n\n## Empty\n');
});

test('appendToPage: keeps CRLF', () => {
  assert.equal(appendToPage('# T\r\n\r\ntext\r\n', 'a\nb', { heading: 'H' }), '# T\r\n\r\ntext\r\n\r\n## H\r\n\r\na\r\nb\r\n');
});

test('appendToPage: refuses nothing to add, a bad level, a multi-line heading', () => {
  assert.throws(() => appendToPage('# T\n', '  \n'), UsageError);
  assert.throws(() => appendToPage('# T\n', 'x', { heading: 'H', level: 7 }), /heading level must be 1 to 6, got 7/);
  assert.throws(() => appendToPage('# T\n', 'x', { heading: 'a\nb' }), UsageError);
});

const FRONT = '---\ntitle: Handbook\n# a YAML comment\n---\n\n# Handbook\n\n## Scope\n\ntext\n';

test('front matter: excluded from headings, a YAML comment there is not a heading', () => {
  assert.deepEqual(headings(FRONT), [{ level: 1, text: 'Handbook', line: 5 }, { level: 2, text: 'Scope', line: 7 }]);
  assert.deepEqual(headings('---\n# yaml\n...\n# Real\n').map((h) => h.text), ['Real']);
  assert.throws(() => findSection(FRONT, 'a YAML comment'), SectionError);
});

test('front matter: without a closing line it is ordinary text', () => {
  assert.deepEqual(headings('---\n# Not front matter\ntext\n').map((h) => h.text), ['Not front matter']);
  assert.deepEqual(headings('text\n---\n# After a rule\n---\n').map((h) => h.text), ['After a rule']);
});

test('front matter: kept byte for byte by replace and append', () => {
  assert.equal(replaceSection(FRONT, 'Scope', 'new'), FRONT.replace('text', 'new'));
  assert.equal(appendToPage(FRONT, 'more'), `${FRONT}\nmore\n`);
});

test('front matter: appendToPage at the start inserts after it', () => {
  assert.equal(appendToPage(FRONT, 'body', { heading: 'First', atStart: true }),
    '---\ntitle: Handbook\n# a YAML comment\n---\n## First\n\nbody\n\n# Handbook\n\n## Scope\n\ntext\n');
  assert.equal(appendToPage('---\r\na: 1\r\n---', 'x', { atStart: true }), '---\r\na: 1\r\n---\r\nx');
  assert.equal(appendToPage('---\n# not closed\n', 'x', { atStart: true }), 'x\n\n---\n# not closed\n');
});

test('appendToPage: refuses to append at the end of a page inside an unclosed code fence', () => {
  const md = '# T\n\n```js\nconst a = 1;\n';
  assert.throws(() => appendToPage(md, 'more'), (e) => {
    assert.ok(e instanceof UsageError);
    assert.equal(e.message, 'the page ends inside an unclosed code fence opened on line 3; fix the page first');
    return true;
  });
  assert.equal(appendToPage(md, 'first', { atStart: true }), `first\n\n${md}`);
  assert.equal(appendToPage('```\ncode\n```\n', 'after'), '```\ncode\n```\n\nafter\n');
});
