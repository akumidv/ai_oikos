// A line diff without a dependency, for dry runs that show what a long text changes: Myers' O(ND)
// shortest edit script over lines, printed as unified-diff hunks with context lines and caps on
// what is printed. A rewrite past MAX_EDITS lines is shown as the whole middle removed and added:
// a diff that size is not read line by line anyway, and the cap bounds the memory the search takes.

/** Edits (lines removed plus added) past which the search stops and the middle is replaced whole. */
export const MAX_EDITS = 1000;

/**
 * @typedef {object} DiffLine
 * @property {' ' | '-' | '+'} op  ' ' kept, '-' only in the old text, '+' only in the new one
 * @property {string} line         the line, without its newline
 */

const kept = (line) => ({ op: ' ', line });
const removed = (line) => ({ op: '-', line });
const added = (line) => ({ op: '+', line });

/**
 * The edit script that turns the lines `before` into the lines `after`, in order: the common
 * prefix and suffix kept, the middle by Myers' algorithm (or replaced whole past MAX_EDITS).
 * @param {string[]} before
 * @param {string[]} after
 * @returns {DiffLine[]}
 */
export function diffLines(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const middle = shortestEdit(before.slice(start, endBefore), after.slice(start, endAfter));
  return [...before.slice(0, start).map(kept), ...middle, ...before.slice(endBefore).map(kept)];
}

/**
 * Myers' greedy search for the shortest edit script from `a` to `b`. `trace[d]` keeps the furthest
 * x of each diagonal k in [-d-1, d+1] before round d, which is all the walk back reads.
 */
function shortestEdit(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [...a.map(removed), ...b.map(added)];
  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
      let x = down ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return walkBack(trace, a, b);
    }
  }
  return [...a.map(removed), ...b.map(added)];
}

/** The edit script read back from the end of `a` and `b` through the snapshots of shortestEdit. */
function walkBack(trace, a, b) {
  const out = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const at = (k) => trace[d][k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push(kept(a[x - 1]));
      x -= 1;
      y -= 1;
    }
    if (d > 0) out.push(x === prevX ? added(b[y - 1]) : removed(a[x - 1]));
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

/**
 * The hunks of the edit script `ops`: each a run of changes with up to `context` kept lines around
 * it, two runs closer than 2 × `context` kept lines joined into one.
 * @param {DiffLine[]} ops
 * @param {number} context
 * @returns {{ from: number, to: number, oldStart: number, newStart: number }[]} `from`/`to` index `ops` (to exclusive); starts are 1-based
 */
function hunks(ops, context) {
  const changed = [];
  ops.forEach((o, i) => { if (o.op !== ' ') changed.push(i); });
  const out = [];
  for (const i of changed) {
    const last = out[out.length - 1];
    if (last && i - last.to <= 2 * context) last.to = i + 1;
    else out.push({ from: i, to: i + 1 });
  }
  let oldLine = 1;
  let newLine = 1;
  let i = 0;
  for (const h of out) {
    h.from = Math.max(0, h.from - context);
    h.to = Math.min(ops.length, h.to + context);
    for (; i < h.from; i += 1) {
      if (ops[i].op !== '+') oldLine += 1;
      if (ops[i].op !== '-') newLine += 1;
    }
    h.oldStart = oldLine;
    h.newStart = newLine;
  }
  return out;
}

/** `start,count` of a hunk side as unified diff writes it: an empty side names the line before it. */
const range = (start, count) => `${count ? start : start - 1},${count}`;

/**
 * The texts `before` and `after` as a unified line diff: a `---`/`+++` header naming `labels`, then
 * one `@@ -a,b +c,d @@` hunk per run of changes with `context` lines around it. At most `maxHunks`
 * hunks and about `maxLines` diff lines are printed (a hunk is not cut), then one line saying how
 * many hunks were left out. Empty when the texts have the same lines.
 * @param {string} before  the current text
 * @param {string} after   the new text
 * @param {{ context?: number, maxHunks?: number, maxLines?: number, labels?: [string, string] }} [options]
 * @returns {string[]}
 */
export function unifiedDiff(before, after, { context = 3, maxHunks = Infinity, maxLines = Infinity, labels = ['before', 'after'] } = {}) {
  const ops = diffLines(splitLines(before), splitLines(after));
  const all = hunks(ops, context);
  if (!all.length) return [];
  const out = [`--- ${labels[0]}`, `+++ ${labels[1]}`];
  let printed = 0;
  let lines = 0;
  for (const h of all) {
    const body = ops.slice(h.from, h.to);
    if (printed >= maxHunks || (printed && lines + body.length > maxLines)) break;
    const oldCount = body.filter((o) => o.op !== '+').length;
    const newCount = body.filter((o) => o.op !== '-').length;
    out.push(`@@ -${range(h.oldStart, oldCount)} +${range(h.newStart, newCount)} @@`, ...body.map((o) => `${o.op}${o.line}`));
    printed += 1;
    lines += body.length;
  }
  if (printed < all.length) out.push(`… ${all.length - printed} more hunk${all.length - printed === 1 ? '' : 's'} not shown`);
  return out;
}

/** The lines of `text` (no lines for an empty text; a final newline ends the last line). */
function splitLines(text) {
  const value = String(text ?? '');
  if (!value) return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The size of `text` as a dry run states it.
 * @param {string} text
 * @returns {{ chars: number, lines: number }}
 */
export const textSize = (text) => ({ chars: String(text).length, lines: splitLines(text).length });
