// The line diff of dry runs (npm test): the shortest edit script, unified hunks with context, the
// caps on what is printed, and a rewrite past MAX_EDITS shown as the middle replaced whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EDITS, diffLines, textSize, unifiedDiff } from '../tools/common/diff.mjs';

/** The text `script` (ops) turns `before` into, and what it keeps of `before`. */
const apply = (ops) => ({ before: ops.filter((o) => o.op !== '+').map((o) => o.line), after: ops.filter((o) => o.op !== '-').map((o) => o.line) });
const edits = (ops) => ops.filter((o) => o.op !== ' ').length;

test('diffLines: the script reproduces both texts and is a shortest one', () => {
  const cases = [
    [[], []],
    [[], ['a', 'b']],
    [['a', 'b'], []],
    [['a', 'b', 'c'], ['a', 'b', 'c']],
    [['a', 'b', 'c', 'a', 'b', 'b', 'a'], ['c', 'b', 'a', 'b', 'a', 'c']],
    [['x', 'a', 'y'], ['a']],
    [['one', 'two', 'three'], ['zero', 'one', 'three', 'four']],
  ];
  const shortest = [0, 2, 2, 0, 5, 2, 3];
  cases.forEach(([before, after], i) => {
    const ops = diffLines(before, after);
    assert.deepEqual(apply(ops), { before, after }, JSON.stringify(cases[i]));
    assert.equal(edits(ops), shortest[i], JSON.stringify(cases[i]));
  });
});

test('diffLines: a change in the middle keeps the common prefix and suffix', () => {
  const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd']);
  assert.deepEqual(ops.map((o) => `${o.op}${o.line}`), [' a', '-b', '+B', ' c', ' d']);
});

test('diffLines: a rewrite past MAX_EDITS is the middle removed and added whole', () => {
  const before = Array.from({ length: MAX_EDITS }, (_, i) => `old ${i}`);
  const after = Array.from({ length: MAX_EDITS }, (_, i) => `new ${i}`);
  const ops = diffLines(['top', ...before, 'end'], ['top', ...after, 'end']);
  assert.deepEqual(apply(ops), { before: ['top', ...before, 'end'], after: ['top', ...after, 'end'] });
  assert.deepEqual(ops.slice(1, MAX_EDITS + 1).map((o) => o.op), Array(MAX_EDITS).fill('-'));
});

test('unifiedDiff: a header, one hunk per run of changes with its context, unified ranges', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const after = [...before];
  after[1] = 'line two';
  after.splice(15, 1);
  const diff = unifiedDiff(before.join('\n'), after.join('\n'), { context: 2, labels: ['PROJ-1 (current)', 'PROJ-1 (new)'] });
  assert.deepEqual(diff, [
    '--- PROJ-1 (current)', '+++ PROJ-1 (new)',
    '@@ -1,4 +1,4 @@', ' line 1', '-line 2', '+line two', ' line 3', ' line 4',
    '@@ -14,5 +14,4 @@', ' line 14', ' line 15', '-line 16', ' line 17', ' line 18',
  ]);
});

test('unifiedDiff: changes closer than twice the context share one hunk', () => {
  const diff = unifiedDiff('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE', { context: 2 });
  assert.equal(diff.filter((l) => l.startsWith('@@')).length, 1);
  assert.equal(diff[2], '@@ -1,5 +1,5 @@');
});

test('unifiedDiff: an added text and an emptied one name the line before an empty side', () => {
  assert.deepEqual(unifiedDiff('', 'a\nb'), ['--- before', '+++ after', '@@ -0,0 +1,2 @@', '+a', '+b']);
  assert.deepEqual(unifiedDiff('a\n', ''), ['--- before', '+++ after', '@@ -1,1 +0,0 @@', '-a']);
});

test('unifiedDiff: the same lines give no diff; a final newline is not a line', () => {
  assert.deepEqual(unifiedDiff('a\nb', 'a\nb\n'), []);
});

test('unifiedDiff: maxHunks and maxLines cap the hunks printed, and the rest is counted', () => {
  const before = Array.from({ length: 100 }, (_, i) => `l${i}`);
  const after = before.map((l, i) => (i % 10 === 5 ? `${l}!` : l));
  const all = unifiedDiff(before.join('\n'), after.join('\n'), { context: 1 });
  assert.equal(all.filter((l) => l.startsWith('@@')).length, 10);
  const byHunks = unifiedDiff(before.join('\n'), after.join('\n'), { context: 1, maxHunks: 3 });
  assert.equal(byHunks.filter((l) => l.startsWith('@@')).length, 3);
  assert.equal(byHunks.at(-1), '… 7 more hunks not shown');
  const byLines = unifiedDiff(before.join('\n'), after.join('\n'), { context: 1, maxLines: 9 });
  assert.equal(byLines.filter((l) => l.startsWith('@@')).length, 2);
  assert.equal(byLines.at(-1), '… 8 more hunks not shown');
  // The first hunk is printed whole even when it alone is longer than maxLines.
  const big = unifiedDiff('a', Array.from({ length: 30 }, (_, i) => `b${i}`).join('\n'), { maxLines: 5 });
  assert.equal(big.length, 2 + 1 + 31);
});

test('textSize counts characters and lines', () => {
  assert.deepEqual(textSize('ab\ncd\n'), { chars: 6, lines: 2 });
  assert.deepEqual(textSize(''), { chars: 0, lines: 0 });
});
