// Editing a YAML file in place, by text splices: the edit is spliced into the source at the node it
// touches — an item appended to a list (flow `[a, b]` or block `- a`), a pair added to a mapping, a
// scalar replaced — and every other byte, comment and key order stays. Shared by the edits of
// `oikos.yaml` (tracking-config.mjs, mount-config.mjs) and of `.local/mounts.yaml`. A caller parses
// the spliced text again and compares it with the intended data before it writes anything.
import YAML from 'yaml';
import { UsageError } from './cli.mjs';

export const INDENT = 2;
const lower = (text) => String(text).trim().toLowerCase();

// == reading a document ==
/** The parsed document of `text`; a usage error naming `label` (the file) when it does not parse. */
export function parsed(text, label = 'oikos.yaml') {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new UsageError(`${label} does not parse: ${doc.errors[0].message.split('\n')[0]}`);
  return doc;
}

export const keyOf = (pair) => (YAML.isScalar(pair.key) ? pair.key.value : pair.key);
export const isNullNode = (node) => node === null || node === undefined || (YAML.isScalar(node) && node.value === null);

/** The pair of `map` under `key` (compared case-insensitively when `anyCase`), or undefined. */
export function pairOf(map, key, anyCase = false) {
  return map.items.find((pair) => (anyCase ? lower(keyOf(pair)) === lower(key) : String(keyOf(pair)) === key));
}

/** The text of `value` as one YAML scalar, safe in a flow collection when `flow`. */
export function scalarText(value, { flow = false } = {}) {
  if (typeof value === 'string' && value.includes('\n')) return JSON.stringify(value);
  const doc = new YAML.Document(flow ? [value] : value);
  if (flow) doc.contents.flow = true;
  const text = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trim();
  return flow ? text.slice(1, -1) : text;
}

/** `value` (a mapping) as block YAML whose lists are flow `[a, b]`, its lines indented by `indent`. */
export function blockText(value, indent) {
  const doc = new YAML.Document(value);
  YAML.visit(doc, { Seq: (_, node) => { node.flow = true; } });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false, indent: INDENT }).trimEnd()
    .split('\n').map((line) => `${' '.repeat(indent)}${line}`).join('\n');
}

/** `value` (a mapping's entries) as the inside of a flow mapping: `a: [x], b: y`. */
export function flowEntries(value) {
  const doc = new YAML.Document(value);
  YAML.visit(doc, { Map: (_, node) => { node.flow = true; }, Seq: (_, node) => { node.flow = true; } });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trim().slice(1, -1);
}

export const lineStart = (text, at) => text.lastIndexOf('\n', at - 1) + 1;
export const lineEnd = (text, at) => {
  const end = text.indexOf('\n', at);
  return end < 0 ? text.length : end;
};
export const column = (text, at) => at - lineStart(text, at);
/** Where a node's content ends, without the line breaks a block node's range carries. */
export function contentEnd(text, node) {
  let end = node.range[1];
  while (end > node.range[0] && /\s/.test(text[end - 1])) end -= 1;
  return end;
}

/** One splice: replace `[from, to)` of the source with `insert`. */
export const splice = (from, to, insert) => ({ from, to, insert });

/** The splice that appends `values` to the list node `seq`. */
export function appendToSeq(text, seq, values) {
  if (seq.flow) {
    const close = text.lastIndexOf(']', seq.range[1]);
    let at = close;
    while (at > seq.range[0] + 1 && /\s/.test(text[at - 1])) at -= 1;
    const items = values.map((v) => scalarText(v, { flow: true })).join(', ');
    return splice(at, at, `${seq.items.length ? ', ' : ''}${items}`);
  }
  const last = seq.items[seq.items.length - 1];
  const dash = ' '.repeat(column(text, seq.range[0]));
  const at = lineEnd(text, contentEnd(text, last));
  return splice(at, at, values.map((v) => `\n${dash}- ${scalarText(v)}`).join(''));
}

/** The splice that adds the entries of `value` (a plain object) to the mapping node `map`. */
export function addToMap(text, map, value) {
  if (map.flow || !map.items.length) {
    const close = text.lastIndexOf('}', map.range[1]);
    let at = close;
    while (at > map.range[0] + 1 && /\s/.test(text[at - 1])) at -= 1;
    return splice(at, at, `${map.items.length ? ', ' : ''}${flowEntries(value)}`);
  }
  const indent = column(text, map.items[0].key.range[0]);
  const last = map.items[map.items.length - 1];
  const at = lineEnd(text, contentEnd(text, last.value ?? last.key));
  return splice(at, at, `\n${blockText(value, indent)}`);
}

/** The splice that gives the pair `pair`, whose value is empty (null), the mapping `value`. */
export function fillPair(text, pair, value) {
  const indent = column(text, pair.key.range[0]) + INDENT;
  const empty = pair.value;
  const from = empty?.range && empty.range[1] > empty.range[0] ? empty.range[0] : null;
  const at = lineEnd(text, from ?? pair.key.range[1]);
  if (from === null) return [splice(at, at, `\n${blockText(value, indent)}`)];
  // An explicit `null` or `~` after the key goes, with the blank before it: the mapping takes its
  // place on the next lines.
  let start = from;
  while (start > 0 && text[start - 1] === ' ') start -= 1;
  return [splice(start, empty.range[1], ''), splice(at, at, `\n${blockText(value, indent)}`)];
}

/** The splices that add `value` under `path` (from the top level), creating what is missing; `label` names the file in a usage error. */
export function addUnder(text, doc, path, value, label) {
  let node = doc.contents;
  if (!YAML.isMap(node)) {
    if (!isNullNode(node)) throw new UsageError(`${label}: the top level must be a mapping`);
    return [splice(text.length, text.length, `${text && !text.endsWith('\n') ? '\n' : ''}${blockText(nest(path, value), 0)}\n`)];
  }
  for (let i = 0; i < path.length; i += 1) {
    const pair = pairOf(node, path[i]);
    const rest = nest(path.slice(i + 1), value);
    if (!pair) {
      if (node === doc.contents && !node.flow) {
        // A new top-level part goes at the end of the file, after whatever comments close it.
        return [splice(text.length, text.length, `${text && !text.endsWith('\n') ? '\n' : ''}${blockText({ [path[i]]: rest }, 0)}\n`)];
      }
      return [addToMap(text, node, { [path[i]]: rest })];
    }
    if (isNullNode(pair.value)) return fillPair(text, pair, rest);
    if (!YAML.isMap(pair.value)) throw new UsageError(`${label}: ${path.slice(0, i + 1).join('.')} must be a mapping`);
    node = pair.value;
  }
  return [addToMap(text, node, value)];
}

export const nest = (path, value) => path.reduceRight((inner, key) => ({ [key]: inner }), value);

/** The text of a scalar node `node` of the pair `pair`, replaced by `value`, or set when it is empty. */
export function scalarSplice(text, pair, value) {
  const node = pair.value;
  if (node?.range && node.range[1] > node.range[0]) return splice(node.range[0], contentEnd(text, node), value);
  // `results:` with nothing after it: the value goes right after the colon, before any comment.
  const colon = text.indexOf(':', pair.key.range[1]) + 1;
  return splice(colon, colon, ` ${value}`);
}

export function applied(text, splices) {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.from - a.from)) out = `${out.slice(0, s.from)}${s.insert}${out.slice(s.to)}`;
  return out;
}
