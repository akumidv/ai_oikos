// What a markdown overwrite of an ADF document would lose. Judged against what markdownToAdf
// (adf.mjs) builds: paragraphs, headings, fenced code, rules, lists nested one level, pipe tables
// of one-paragraph cells with a header row, text with at most one of **bold**, `code`,
// [link](url), — when the caller links task keys — task cards that come back from their key, and
// an image an image line carries (imageLineCarries: `![alt](media:<id>?…)` reads back as it was).
// Anything else — file groups and odd images, other cards, macros, mentions, status lozenges,
// emoji, other marks — would be dropped or flattened.

import { cardKey, imageLineCarries } from './adf.mjs';

const LISTS = new Set(['bulletList', 'orderedList']);
const CARRIED_MARKS = new Set(['strong', 'code', 'link']);
const MAX_LIST_DEPTH = 2; // the parser nests one level, by indentation
const WORD_END = /[\w/-]$/;
const WORD_START = /^(?:[\w-]|\.\d)/;

/**
 * @typedef {object} LossOptions
 * @property {(key: string) => (string|null)} [issueUrl] the resolver markdownToAdf will write with;
 *   without it every card counts as lost
 */

/** The text beside `nodes[i]` as markdown would show it to the key parser; marked text shows its own delimiters. */
const plainNeighbour = (node) => (node && !node.marks?.length ? node.text || '' : '');

/** Whether the card `nodes[i]` comes back from its bare key as the same card: a task card, linked to the same URL, nothing glued on. */
function cardRelinks(nodes, i, issueUrl) {
  const key = cardKey(nodes[i]);
  if (!key || !issueUrl || issueUrl(key) !== nodes[i].attrs.url) return false;
  const prev = nodes[i - 1];
  const next = nodes[i + 1];
  if ((prev && prev.type !== 'text') || (next && next.type !== 'text')) return false;
  const before = plainNeighbour(prev);
  const tail = !before || /\s$/.test(before) ? '' : before.split(/\s+/).pop();
  return !(WORD_END.test(tail) || /^https?:\/\//.test(tail) || WORD_START.test(plainNeighbour(next)));
}

/** Count each inline node or mark combination of `nodes` that markdown cannot carry. */
function inlineKinds(nodes, add, options) {
  (nodes || []).forEach((node, i, all) => {
    if (node.type !== 'text') {
      if (!cardRelinks(all, i, options.issueUrl)) add(node.type || '?');
      return;
    }
    const marks = (node.marks || []).map((m) => m.type || '?');
    if (marks.length > 1 || marks.some((m) => !CARRIED_MARKS.has(m))) add(`mark:${marks.join('+')}`);
  });
}

/** Count what a list `node` at nesting `depth` holds beyond one paragraph and one nested list per item. */
function listKinds(node, add, depth, options) {
  for (const item of node.content || []) {
    const parts = item.content || [];
    if (item.type !== 'listItem' || !parts.length || parts[0].type !== 'paragraph') {
      add(`${node.type} item`);
      continue;
    }
    inlineKinds(parts[0].content, add, options);
    for (const extra of parts.slice(1)) {
      if (extra.type === node.type && depth + 1 < MAX_LIST_DEPTH) listKinds(extra, add, depth + 1, options);
      else add(`${extra.type || '?'} in a list item`);
    }
  }
}

/** Count what one table cell holds beyond one paragraph of carried inline content. */
function cellKinds(cell, add, options) {
  const blocks = (cell.content || []).filter((b) => b.content?.length);
  if (blocks.length > 1 || blocks.some((b) => b.type !== 'paragraph')) add('table cell with several blocks');
  else if (blocks.length) inlineKinds(blocks[0].content, add, options);
  if ((cell.attrs?.colspan ?? 1) !== 1 || (cell.attrs?.rowspan ?? 1) !== 1) add('merged table cell');
}

/** Count what a table holds beyond a header row over plain rows of one-paragraph cells; a table with no rows is lost whole. */
function tableKinds(node, add, options) {
  const rows = node.content || [];
  if (!rows.length || rows.some((row) => row.type !== 'tableRow')) {
    add('table');
    return;
  }
  rows.forEach((row, r) => {
    const expected = r === 0 ? 'tableHeader' : 'tableCell';
    if ((row.content || []).some((cell) => cell.type !== expected)) add(r === 0 ? 'table without a header row' : 'table header cell below the first row');
    for (const cell of row.content || []) cellKinds(cell, add, options);
  });
}

/** Whether a block outside text, lists and tables comes back whole: a rule, or an image its image line carries. */
const carriedBlock = (node) => node.type === 'rule' || (node.type === 'mediaSingle' && imageLineCarries(node));

/**
 * What a markdown round trip of `doc` would drop or flatten: { kind: count }, empty when nothing.
 * Only the outermost unsupported block is named; attributes and empty paragraphs are ignored.
 * @param {object|null|undefined} doc an ADF document
 * @param {LossOptions} [options]
 * @returns {Record<string, number>}
 */
export function lossyNodes(doc, options = {}) {
  const found = {};
  const add = (kind) => { found[kind] = (found[kind] || 0) + 1; };
  for (const node of doc?.content || []) {
    if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) inlineKinds(node.content, add, options);
    else if (LISTS.has(node.type)) listKinds(node, add, 0, options);
    else if (node.type === 'table') tableKinds(node, add, options);
    else if (!carriedBlock(node)) add(node.type || '?');
  }
  return found;
}

/** "mediaSingle x1, mention x2" — the kinds of `lost`, sorted. */
export const lossyText = (lost) => Object.entries(lost).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} x${n}`).join(', ');

// == identities: what a node is, not what kind it is ==
// A count of kinds misses a swap (one mention for another) and an emptied container; an identity
// check asks whether each thing the old document holds is still in the new one.

const CARD_TYPES = new Set(['inlineCard', 'blockCard', 'embedCard']);
const EXTENSION_TYPES = new Set(['extension', 'bodiedExtension', 'inlineExtension']);

/**
 * @typedef {object} Identities
 * @property {Set<string>} media the id of each file media node, the URL of each external one
 * @property {Set<string>} mentions the account id of each mention
 * @property {Set<string>} cards the URL of each inline, block or embed card
 * @property {Set<string>} extensions `extensionType:extensionKey` of each macro
 * @property {Set<string>} statuses the text of each status lozenge
 * @property {Set<string>} emoji the short name of each emoji (its text when it has none)
 */

/** Add the identity of `node`, and of every node inside it, to `found`. */
function collectIdentities(node, found) {
  if (Array.isArray(node)) {
    for (const child of node) collectIdentities(child, found);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const attrs = node.attrs || {};
  if (node.type === 'media') {
    const id = attrs.type === 'external' ? attrs.url : attrs.id;
    if (id) found.media.add(String(id));
  } else if (node.type === 'mention' && attrs.id) found.mentions.add(String(attrs.id));
  else if (CARD_TYPES.has(node.type) && attrs.url) found.cards.add(String(attrs.url));
  else if (EXTENSION_TYPES.has(node.type)) found.extensions.add(`${attrs.extensionType ?? '?'}:${attrs.extensionKey ?? '?'}`);
  else if (node.type === 'status' && attrs.text !== undefined) found.statuses.add(String(attrs.text));
  else if (node.type === 'emoji' && (attrs.shortName || attrs.text)) found.emoji.add(String(attrs.shortName || attrs.text));
  collectIdentities(node.content, found);
}

/**
 * The identities of `doc`, collected through every node (lists, tables, panels, expands, layouts).
 * @param {object|null|undefined} doc an ADF document or node
 * @returns {Identities}
 */
export function adfIdentities(doc) {
  const found = { media: new Set(), mentions: new Set(), cards: new Set(), extensions: new Set(), statuses: new Set(), emoji: new Set() };
  collectIdentities(doc, found);
  return found;
}

/**
 * The identities a markdown overwrite can keep — media ids (an image line) and card URLs (a task
 * key) — so a guard can check that the new document still holds each of them.
 * @param {object|null|undefined} doc an ADF document or node
 * @returns {{media: Set<string>, cards: Set<string>}}
 */
export function carriedIdentities(doc) {
  const { media, cards } = adfIdentities(doc);
  return { media, cards };
}

const IDENTITY_NAMES = { media: 'media', mentions: 'mention', cards: 'card', extensions: 'macro', statuses: 'status', emoji: 'emoji' };

/**
 * What of `before` is missing from `after`, per kind of identity `before` has: ["media 1234…", "mention abc"].
 * @param {Partial<Identities>} before
 * @param {Partial<Identities>} after
 * @returns {string[]} empty when `after` holds every identity of `before`
 */
export function missingIdentities(before, after) {
  const missing = [];
  for (const [kind, ids] of Object.entries(before)) {
    for (const id of ids) if (!after[kind]?.has(id)) missing.push(`${IDENTITY_NAMES[kind] || kind} ${id}`);
  }
  return missing;
}
