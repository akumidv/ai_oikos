// Atlassian Document Format <-> text.
// markdownToAdf renders a forgiving markdown subset (headings, fenced code, rules, one-level
// nested lists, GFM pipe tables, **bold**, `code`, [links](url), and a mention of a person as
// Jira writes it, [~accountid:<account id>]); with options it also turns task keys into cards
// and an image alone on its line into an image. Unknown syntax degrades to text, never throws.
// adfToText is the reading view; adfToEditableMarkdown keeps the structure markdownToAdf reads
// back. The section helpers edit a document in place, without a markdown round trip.

const OPAQUE = new Set(['media', 'mediaInline', 'inlineCard', 'blockCard', 'embedCard']);
const CARDS = new Set(['inlineCard', 'blockCard', 'embedCard']);
// Confluence leaf nodes whose whole content is an attribute; a macro is named, not expanded.
const MACRO = new Set(['extension', 'inlineExtension', 'bodiedExtension']);
// mediaSingle/mediaGroup are blocks so an image placeholder starts its own line.
const BLOCK = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'rule', 'blockquote', 'mediaSingle', 'mediaGroup']);
const LISTS = new Set(['bulletList', 'orderedList']);
const CARRIED_MARKS = new Set(['strong', 'code', 'link']);

// Not after a word, `/` or `-`; not followed by a word, `-` or `.<digit>` (a version, AI-12.1).
const TASK_KEY = /(?<![\w/-])[A-Z][A-Z0-9]+-\d+(?![\w-]|\.\d)/g;
const BARE_URL = /https?:\/\/\S+/g;
const BROWSE_URL = /^https?:\/\/[^/?#]+\/browse\/(?<key>[A-Z][A-Z0-9]+-\d+)$/;
/** A markdown image line, `![alt](target)`, matched against the trimmed line. */
export const IMAGE_LINE = /^!\[(?<alt>[^\]]*)\]\((?<target>[^)]+)\)$/;
const MEDIA_REF = 'media:';
const SEPARATOR_CELL = /^:?-+:?$/;
const FENCE = '```';
const NEW_SECTION_LEVEL = 2;
const WIDTH_UNITS = [['pixel', 'px'], ['percentage', '%']];

/**
 * @typedef {object} MarkdownOptions
 * @property {(key: string) => (string|null)} [issueUrl] the URL a task-shaped token in plain text
 *   links to as an inline card, or null to leave it text (the caller knows which projects exist)
 * @property {(target: string, alt: string) => (string|null)} [resolveImage] the media file id of an
 *   image line's local path or `attachment:<name>` target, or null to leave the line text; with
 *   it, `media:<id>` and `http(s)://` targets become images without a call. The converter does no
 *   I/O: the caller uploads first (see imageTargets) and answers from what it already has
 */

/** The task key an inline card points at (`<site>/browse/KEY`), or null when it is not a task card. */
export function cardKey(node) {
  if (node?.type !== 'inlineCard') return null;
  return String(node.attrs?.url || '').match(BROWSE_URL)?.groups.key ?? null;
}

function opaquePlaceholder(node) {
  const attrs = node.attrs || {};
  const key = cardKey(node);
  if (key) return key;
  if (CARDS.has(node.type)) return `[embedded card: ${attrs.url || 'unknown url'}]`;
  const kind = attrs.type || 'file';
  const name = attrs.alt || attrs.__fileName || '';
  // Not the node's own id: a media id is a different namespace from the attachment id.
  return `[${name ? `${kind}: ${name}` : kind} — see Attachments]`;
}

function textWithLink(node) {
  const text = node.text || '';
  const href = (node.marks || []).find((m) => m.type === 'link')?.attrs?.href;
  if (!href || href === text) return href || text;
  return `${text} (${href})`;
}

/** The text of a mention, emoji, status or macro node, which carries it in attrs; null for others. */
function leafAttrText(node) {
  const attrs = node.attrs || {};
  if (node.type === 'mention') return attrs.text || '@mention';
  if (node.type === 'emoji') return attrs.shortName || attrs.text || '';
  if (node.type === 'status') return `[${attrs.text || 'status'}]`;
  if (MACRO.has(node.type)) return `[macro: ${attrs.extensionKey || 'unknown'}]`;
  return null;
}

/** One table cell on one line: its lines joined by a space, `|` escaped. */
function flatCell(cell) {
  const lines = adfToText(cell.content || []).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.join(' ').replaceAll('|', '\\|');
}

/** Pipe-table lines for rows of cell texts: padded to the widest row, the first row as the header. */
function pipeTable(rows) {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (!width) return [];
  const lines = rows.map((row) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`);
  lines.splice(1, 0, `|${'---|'.repeat(width)}`);
  return lines;
}

const tableRows = (node) => (node.content || []).filter((row) => row.type === 'tableRow');

/** A markdown pipe table, its first row as the header, set off by a blank line before it. */
function tableText(node) {
  const lines = pipeTable(tableRows(node).map((row) => (row.content || []).map(flatCell)));
  return lines.length ? `\n\n${lines.join('\n')}\n` : '';
}

/**
 * Flatten an ADF node (or a list of nodes) to readable text: blocks start new lines, a table
 * becomes a markdown pipe table, a task card is its key, and nodes with no text of their own are
 * named, not dropped.
 * @param {object|object[]} node
 * @param {string[]} [out] the accumulator of the recursion
 * @returns {string}
 */
export function adfToText(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) adfToText(child, out);
  } else if (node && typeof node === 'object') {
    if (node.type === 'table') {
      out.push(tableText(node));
      return out.join('');
    }
    const leaf = leafAttrText(node);
    if (node.type === 'text') out.push(textWithLink(node));
    else if (node.type === 'hardBreak') out.push('\n');
    else if (OPAQUE.has(node.type)) out.push(opaquePlaceholder(node));
    else if (leaf !== null) out.push(leaf);
    if (BLOCK.has(node.type)) out.push('\n');
    adfToText(node.content || [], out);
  }
  return out.join('');
}

// --- markdown -> ADF -----------------------------------------------------------------------

/** Plain text, each task-shaped token outside a bare URL that `issueUrl` links becoming a card. */
function textNodes(text, issueUrl) {
  if (!issueUrl) return [{ type: 'text', text }];
  const urls = [...text.matchAll(BARE_URL)].map((u) => [u.index, u.index + u[0].length]);
  const nodes = [];
  let pos = 0;
  for (const m of text.matchAll(TASK_KEY)) {
    if (urls.some(([a, b]) => a <= m.index && m.index < b)) continue;
    const url = issueUrl(m[0]);
    if (!url) continue;
    if (m.index > pos) nodes.push({ type: 'text', text: text.slice(pos, m.index) });
    nodes.push({ type: 'inlineCard', attrs: { url } });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) nodes.push({ type: 'text', text: text.slice(pos) });
  return nodes;
}

/**
 * The inline nodes of one line of markdown (bold, code, links, mentions; task keys with
 * `options.issueUrl`). A key inside bold, code or a link stays text.
 * @param {string} text
 * @param {MarkdownOptions} [options]
 * @returns {object[]}
 */
export function adfInline(text, options = {}) {
  const nodes = [];
  const re = /\*\*(?<bold>.+?)\*\*|`(?<code>[^`]+?)`|\[~accountid:(?<account>[\w:-]+)\]|\[(?<label>[^\]]+?)\]\((?<url>[^)]+?)\)/g;
  let pos = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > pos) nodes.push(...textNodes(text.slice(pos, m.index), options.issueUrl));
    const g = m.groups;
    if (g.bold !== undefined) nodes.push({ type: 'text', text: g.bold, marks: [{ type: 'strong' }] });
    else if (g.code !== undefined) nodes.push({ type: 'text', text: g.code, marks: [{ type: 'code' }] });
    else if (g.account !== undefined) nodes.push({ type: 'mention', attrs: { id: g.account, text: `@${g.account}` } });
    else nodes.push({ type: 'text', text: g.label, marks: [{ type: 'link', attrs: { href: g.url } }] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) nodes.push(...textNodes(text.slice(pos), options.issueUrl));
  return nodes.length ? nodes : [{ type: 'text', text }];
}

const listItem = (text, options) => ({ type: 'listItem', content: [{ type: 'paragraph', content: adfInline(text, options) }] });

const BULLET = /^(?<indent>\s*)[-*]\s+(?<text>.*)$/;
const ORDERED = /^(?<indent>\s*)\d+[.)]\s+(?<text>.*)$/;

/** A list (nested one level by indentation) starting at `start`, and the index after it. */
function listAt(lines, start, re, kind, options) {
  const items = [];
  let j = start;
  while (j < lines.length) {
    const m = lines[j].match(re);
    if (!m) break;
    const indent = m.groups.indent.length;
    const item = listItem(m.groups.text, options);
    const sub = [];
    let k = j + 1;
    for (; k < lines.length; k++) {
      const sm = lines[k].match(re);
      if (sm && sm.groups.indent.length > indent) sub.push(listItem(sm.groups.text, options));
      else break;
    }
    if (sub.length) item.content.push({ type: kind, content: sub });
    j = sub.length ? k : j + 1;
    items.push(item);
  }
  return { node: { type: kind, content: items }, next: j };
}

/** The cells of one pipe-table row: outer pipes are optional and `\|` is a literal pipe. */
function splitRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));
}

/** A header row at `i` followed by a `|---|` separator row of the same width. */
function isTableStart(lines, i) {
  if (i + 1 >= lines.length || !lines[i].includes('|') || !lines[i + 1].includes('|')) return false;
  const separator = splitRow(lines[i + 1]);
  return separator.every((cell) => SEPARATOR_CELL.test(cell)) && separator.length === splitRow(lines[i]).length;
}

/** A table cell of `kind`; an empty cell holds a bare paragraph (ADF has no empty text node). */
function tableCell(kind, text, options) {
  return { type: kind, content: [text ? { type: 'paragraph', content: adfInline(text, options) } : { type: 'paragraph' }] };
}

function tableRow(kind, cells, width, options) {
  return { type: 'tableRow', content: Array.from({ length: width }, (_, i) => tableCell(kind, cells[i] ?? '', options)) };
}

/** The table whose header row is at `start`; short rows are padded and long rows cut to its width. */
function tableAt(lines, start, options) {
  const header = splitRow(lines[start]);
  const rows = [tableRow('tableHeader', header, header.length, options)];
  let j = start + 2;
  for (; j < lines.length && lines[j].trim() && lines[j].includes('|') && !lines[j].trim().startsWith(FENCE); j++) {
    rows.push(tableRow('tableCell', splitRow(lines[j]), header.length, options));
  }
  return { node: { type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: rows }, next: j };
}

const wholeNumber = (value) => (value != null && /^\d+$/.test(value) ? Number(value) : null);

/** The media and mediaSingle attributes a `media:<id>?layout=…&display=…&width=…&height=…&collection=…` target names. */
function mediaRefAttrs(ref) {
  const q = ref.indexOf('?');
  const params = new URLSearchParams(q < 0 ? '' : ref.slice(q + 1));
  const media = { type: 'file', id: decodeURIComponent(q < 0 ? ref : ref.slice(0, q)), collection: params.get('collection') ?? '' };
  for (const name of ['width', 'height']) {
    const size = wholeNumber(params.get(name));
    if (size !== null) media[name] = size;
  }
  const outer = {};
  if (params.has('layout')) outer.layout = params.get('layout');
  const display = params.get('display') ?? '';
  const [unit, suffix] = WIDTH_UNITS.find(([, s]) => display.endsWith(s)) ?? [null, ''];
  const width = wholeNumber(display.slice(0, display.length - suffix.length));
  if (width !== null) Object.assign(outer, { width }, unit ? { widthType: unit } : {});
  return { media, outer };
}

/** The mediaSingle an image line stands for, or null when `resolveImage` cannot place its target. */
function mediaBlock(alt, target, resolveImage) {
  let media;
  let outer = {};
  if (target.startsWith(MEDIA_REF)) ({ media, outer } = mediaRefAttrs(target.slice(MEDIA_REF.length)));
  else if (/^https?:\/\//.test(target)) media = { type: 'external', url: target };
  else {
    const id = resolveImage(target, alt);
    if (!id) return null;
    media = { type: 'file', id, collection: '' };
  }
  if (alt) media.alt = alt;
  const block = { type: 'mediaSingle', content: [{ type: 'media', attrs: media }] };
  if (Object.keys(outer).length) block.attrs = outer;
  return block;
}

// Each block parser takes (lines, i, options) and returns { node, next } or null when line i is not its block.
const BLOCK_PARSERS = [
  function fencedCode(lines, i) {
    if (!lines[i].trim().startsWith(FENCE)) return null;
    const code = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j].trim().startsWith(FENCE); j++) code.push(lines[j]);
    return { node: { type: 'codeBlock', content: [{ type: 'text', text: code.join('\n') || ' ' }] }, next: j + 1 };
  },
  (lines, i) => (/^(-{3,}|\*{3,})$/.test(lines[i].trim()) ? { node: { type: 'rule' }, next: i + 1 } : null),
  function heading(lines, i, options) {
    const h = lines[i].trim().match(/^(#{1,6})\s+(.*)$/);
    return h ? { node: { type: 'heading', attrs: { level: h[1].length }, content: adfInline(h[2], options) }, next: i + 1 } : null;
  },
  function image(lines, i, options) {
    const m = options.resolveImage && lines[i].trim().match(IMAGE_LINE);
    const node = m && mediaBlock(m.groups.alt, m.groups.target.trim(), options.resolveImage);
    return node ? { node, next: i + 1 } : null;
  },
  (lines, i, options) => (isTableStart(lines, i) ? tableAt(lines, i, options) : null),
  (lines, i, options) => (BULLET.test(lines[i]) ? listAt(lines, i, BULLET, 'bulletList', options) : null),
  (lines, i, options) => (ORDERED.test(lines[i]) ? listAt(lines, i, ORDERED, 'orderedList', options) : null),
];

function blockAt(lines, i, options) {
  for (const parse of BLOCK_PARSERS) {
    const block = parse(lines, i, options);
    if (block) return block;
  }
  return null;
}

/**
 * The block nodes for a markdown string (Confluence appends these to an existing doc).
 * Without options the output is what it always was; an exception from a callback propagates.
 * @param {string} md
 * @param {MarkdownOptions} [options]
 * @returns {object[]}
 */
export function markdownToAdfContent(md, options = {}) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const content = [];
  let para = [];
  const flush = () => {
    if (para.length) content.push({ type: 'paragraph', content: adfInline(para.join(' '), options) });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const block = blockAt(lines, i, options);
    if (block) {
      flush();
      content.push(block.node);
      i = block.next;
      continue;
    }
    const s = lines[i].trim();
    if (s) para.push(s);
    else flush();
    i += 1;
  }
  flush();
  return content.length ? content : [{ type: 'paragraph', content: [{ type: 'text', text: md }] }];
}

/**
 * An ADF document for a markdown string; see markdownToAdfContent.
 * @param {string} md
 * @param {MarkdownOptions} [options]
 * @returns {object}
 */
export const markdownToAdf = (md, options = {}) => ({ type: 'doc', version: 1, content: markdownToAdfContent(md, options) });

export const plainAdf = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/**
 * The distinct task-shaped tokens of `md` that markdownToAdf would ask `issueUrl` about (outside
 * code, links and URLs) — what is worth checking against the tracker before converting.
 * @param {string} md
 * @returns {string[]}
 */
export function taskKeys(md) {
  const seen = new Set();
  markdownToAdfContent(md, { issueUrl: (key) => { seen.add(key); return null; } });
  return [...seen];
}

/**
 * The distinct image-line targets of `md` that markdownToAdf would ask `resolveImage` about: local
 * paths and `attachment:<name>` targets, not `media:` or `http(s)://` ones. The caller uploads or
 * looks them up first and passes a resolver over the result.
 * @param {string} md
 * @returns {string[]}
 */
export function imageTargets(md) {
  const seen = new Set();
  markdownToAdfContent(md, { resolveImage: (target) => { seen.add(target); return null; } });
  return [...seen];
}

// --- ADF -> markdown that markdownToAdf reads back -----------------------------------------

const isInt = (value) => value === undefined || Number.isInteger(value);
const MEDIA_ATTRS = new Set(['type', 'id', 'alt', 'collection', 'width', 'height', 'localId']); // localId: Jira's own, regenerated
const EXTERNAL_MEDIA_ATTRS = new Set(['type', 'url', 'alt', 'localId']); // an URL line has no room for a size
const MEDIA_SINGLE_ATTRS = new Set(['layout', 'width', 'widthType', 'localId']);
const within = (attrs, allowed) => Object.keys(attrs).every((name) => allowed.has(name));

/**
 * Whether an image line carries this mediaSingle: one file or external media whose attributes
 * fit the line (an alt with no `]` or newline; for a file, sizes and a layout; for a URL, nothing more).
 * @param {object} node a mediaSingle node
 * @returns {boolean}
 */
export function imageLineCarries(node) {
  const content = node.content || [];
  if (content.length !== 1 || content[0].type !== 'media') return false;
  const media = content[0].attrs || {};
  const outer = node.attrs || {};
  const alt = media.alt ?? '';
  if (typeof alt !== 'string' || /[\]\n]/.test(alt) || (!alt && 'alt' in media)) return false;
  if (media.type === 'external') {
    return within(media, EXTERNAL_MEDIA_ATTRS) && within(outer, new Set(['localId']))
      && typeof media.url === 'string' && /^https?:\/\//.test(media.url) && !media.url.includes(')');
  }
  return media.type === 'file' && within(media, MEDIA_ATTRS) && typeof media.id === 'string'
    && within(outer, MEDIA_SINGLE_ATTRS) && isInt(media.width) && isInt(media.height) && isInt(outer.width)
    && WIDTH_UNITS.some(([unit]) => unit === (outer.widthType ?? 'pixel'));
}

// encodeURIComponent keeps ( and ), which would end the image target early.
const encodeTarget = (value) => encodeURIComponent(String(value)).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The image line for a mediaSingle that imageLineCarries accepts: `![alt](media:<id>?…)` or `![alt](<url>)`. */
function imageLine(node) {
  const media = node.content[0].attrs || {};
  const outer = node.attrs || {};
  const alt = media.alt ?? '';
  if (media.type === 'external') return `![${alt}](${media.url})`;
  const params = [];
  if ('layout' in outer) params.push(['layout', outer.layout]);
  // An ADF width with no widthType is a percentage; `px` and `%` keep it apart from a bare number.
  if ('width' in outer) params.push(['display', `${outer.width}${WIDTH_UNITS.find(([unit]) => unit === outer.widthType)?.[1] ?? ''}`]);
  for (const name of ['width', 'height']) if (name in media) params.push([name, media[name]]);
  if (media.collection) params.push(['collection', media.collection]);
  const query = params.map(([name, value]) => `${name}=${encodeTarget(value)}`).join('&');
  return `![${alt}](${MEDIA_REF}${encodeTarget(media.id)}${query ? `?${query}` : ''})`;
}

/** A text node as markdown: its first carried mark (strong, code, link) applied, others dropped. */
function markedText(node) {
  const text = node.text || '';
  const mark = (node.marks || []).find((m) => CARRIED_MARKS.has(m.type));
  if (mark?.type === 'strong') return `**${text}**`;
  if (mark?.type === 'code') return `\`${text}\``;
  if (mark?.type === 'link') return `[${text}](${mark.attrs?.href || ''})`;
  return text;
}

function inlineNodeMarkdown(node) {
  if (node.type === 'text') return markedText(node);
  if (node.type === 'hardBreak') return ' ';
  if (node.type === 'mention' && node.attrs?.id) return `[~accountid:${node.attrs.id}]`;
  if (CARDS.has(node.type)) return cardKey(node) ?? (node.attrs?.url || opaquePlaceholder(node));
  return adfToText(node);
}

const inlineMarkdown = (nodes) => (nodes || []).map(inlineNodeMarkdown).join('');

function listMarkdown(node, depth) {
  const marker = node.type === 'bulletList' ? '-' : '1.';
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const item of node.content || []) {
    const parts = item.content || [];
    const first = parts[0]?.type === 'paragraph' ? parts[0] : null;
    lines.push(`${pad}${marker} ${first ? inlineMarkdown(first.content) : adfToText(item).trim()}`);
    for (const extra of parts.slice(first ? 1 : parts.length)) {
      if (LISTS.has(extra.type)) lines.push(...listMarkdown(extra, depth + 1));
      else lines.push(`${pad}  ${adfToText(extra).trim()}`);
    }
  }
  return lines;
}

function tableMarkdown(node) {
  const cellText = (cell) => (cell.content || []).map((block) => inlineMarkdown(block.content)).join(' ').trim().replaceAll('|', '\\|');
  return pipeTable(tableRows(node).map((row) => (row.content || []).map(cellText))).join('\n');
}

function blockMarkdown(node) {
  const content = node.content || [];
  if (node.type === 'paragraph') return inlineMarkdown(content);
  if (node.type === 'heading') return `${'#'.repeat(node.attrs?.level || 1)} ${inlineMarkdown(content)}`;
  if (node.type === 'codeBlock') return `${FENCE}\n${content.map((c) => c.text || '').join('')}\n${FENCE}`;
  if (node.type === 'rule') return '---';
  if (LISTS.has(node.type)) return listMarkdown(node, 0).join('\n');
  if (node.type === 'table') return tableMarkdown(node);
  if (node.type === 'mediaSingle' && imageLineCarries(node)) return imageLine(node);
  return adfToText(node).trim();
}

/**
 * The markdown subset markdownToAdf parses, so edited output can be written back. Unlike
 * adfToText (a reading view) it keeps headings, lists, fences, tables and marks; a mention is
 * `[~accountid:<id>]`, a task card its key, another card its URL, and an image an image line
 * (`![alt](media:<id>?…)`, read back with `resolveImage`). A node outside the subset appears as
 * its reading-view text, and lossyNodes names it.
 * @param {object|null|undefined} doc an ADF document
 * @returns {string}
 */
export function adfToEditableMarkdown(doc) {
  const text = (doc?.content || []).map(blockMarkdown).filter(Boolean).join('\n\n');
  return text ? `${text}\n` : '';
}

// --- editing a document in place -----------------------------------------------------------

const headingLevel = (node) => node.attrs?.level || 1;
const headingText = (node) => adfToText(node.content || []).replace(/\s+/g, ' ').trim();
const withContent = (doc, content) => ({ ...(doc || { type: 'doc', version: 1 }), content });

/**
 * `doc` with `blocks` after its last block; every existing node is kept as it is.
 * @param {object|null|undefined} doc an ADF document (none: a new one)
 * @param {object[]} blocks
 * @returns {object} a new document; `doc` is not changed
 */
export const appendBlocks = (doc, blocks) => withContent(doc, [...(doc?.content || []), ...blocks]);

/**
 * The top-level headings of `doc`, in order.
 * @param {object|null|undefined} doc
 * @returns {{level: number, text: string}[]}
 */
export const outline = (doc) => (doc?.content || []).filter((n) => n.type === 'heading').map((n) => ({ level: headingLevel(n), text: headingText(n) }));

/**
 * Where the section under `heading` is: its title, the level fixed by leading `#`s (or null), and
 * [heading index, index after the body] or null when absent. Throws when several headings match.
 */
function locateSection(doc, heading) {
  const m = heading.trim().match(/^(#{1,6})\s+(.*)$/);
  const level = m ? m[1].length : null;
  const title = (m ? m[2] : heading).trim();
  const content = doc?.content || [];
  const hits = content.flatMap((n, i) => (n.type === 'heading' && headingText(n).toLowerCase() === title.toLowerCase()
    && (level === null || headingLevel(n) === level) ? [i] : []));
  if (hits.length > 1) {
    const names = hits.map((i) => `"${'#'.repeat(headingLevel(content[i]))} ${headingText(content[i])}" (block ${i})`);
    throw new Error(`heading "${title}" is ambiguous: ${hits.length} matches — ${names.join(', ')}`);
  }
  if (!hits.length) return { title, level, span: null };
  const start = hits[0];
  const depth = headingLevel(content[start]);
  const after = content.findIndex((n, j) => j > start && n.type === 'heading' && headingLevel(n) <= depth);
  return { title, level, span: [start, after < 0 ? content.length : after] };
}

/**
 * The blocks under `heading`, up to the next heading of the same or a higher level. `heading`
 * matches a top-level heading's text, case-insensitively; leading `#`s fix its level.
 * @param {object|null|undefined} doc
 * @param {string} heading
 * @returns {object[]}
 * @throws {Error} when no heading or more than one matches
 */
export function sectionBody(doc, heading) {
  const { title, span } = locateSection(doc, heading);
  if (!span) throw new Error(`no heading "${title}"; headings: ${outline(doc).map((h) => h.text).join(', ') || 'none'}`);
  return doc.content.slice(span[0] + 1, span[1]);
}

/**
 * `doc` with the body under `heading` replaced by `blocks` (the section ends at the next heading
 * of the same or a higher level). A missing heading is appended, at level 2 unless leading `#`s
 * fix it, followed by `blocks`; a copy of the heading itself at the start of `blocks` is dropped.
 * Nodes outside the section stay as they are.
 * @param {object|null|undefined} doc
 * @param {string} heading
 * @param {object[]} blocks
 * @returns {object} a new document; `doc` is not changed
 * @throws {Error} when more than one heading matches, naming them
 */
export function replaceSection(doc, heading, blocks) {
  const { title, level, span } = locateSection(doc, heading);
  const content = doc?.content || [];
  if (!span) {
    const added = { type: 'heading', attrs: { level: level || NEW_SECTION_LEVEL }, content: [{ type: 'text', text: title }] };
    return withContent(doc, [...content, added, ...blocks]);
  }
  const [start, end] = span;
  const first = blocks[0];
  const copied = first?.type === 'heading' && headingLevel(first) === headingLevel(content[start])
    && headingText(first).toLowerCase() === title.toLowerCase();
  return withContent(doc, [...content.slice(0, start + 1), ...(copied ? blocks.slice(1) : blocks), ...content.slice(end)]);
}
