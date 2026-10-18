// Atlassian Document Format <-> text.
// markdownToAdf renders a forgiving markdown subset (headings, fenced code, rules, one-level
// nested lists, **bold**, `code`, [links](url)); unknown syntax degrades to text, never throws.

const OPAQUE = new Set(['media', 'mediaInline', 'inlineCard', 'blockCard', 'embedCard']);
const BLOCK = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'rule', 'blockquote', 'table']);

function opaquePlaceholder(node) {
  const attrs = node.attrs || {};
  if (node.type !== 'media' && node.type !== 'mediaInline') return `[embedded card: ${attrs.url || 'unknown url'}]`;
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

export function adfToText(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) adfToText(child, out);
  } else if (node && typeof node === 'object') {
    if (node.type === 'tableRow') {
      // A row reads as one line: cells flattened and joined, not a cell per line.
      const cells = (node.content || []).map((cell) => adfToText(cell.content || []).replace(/\s*\n\s*/g, ' ').trim());
      out.push(`| ${cells.join(' | ')} |\n`);
      return out.join('');
    }
    if (node.type === 'text') out.push(textWithLink(node));
    else if (node.type === 'hardBreak') out.push('\n');
    else if (node.type === 'mention') out.push(node.attrs?.text || '@mention');
    else if (OPAQUE.has(node.type)) out.push(opaquePlaceholder(node));
    if (BLOCK.has(node.type)) out.push('\n');
    adfToText(node.content || [], out);
  }
  return out.join('');
}

export function adfInline(text) {
  const nodes = [];
  const re = /\*\*(?<bold>.+?)\*\*|`(?<code>[^`]+?)`|\[(?<label>[^\]]+?)\]\((?<url>[^)]+?)\)/g;
  let pos = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > pos) nodes.push({ type: 'text', text: text.slice(pos, m.index) });
    const g = m.groups;
    if (g.bold !== undefined) nodes.push({ type: 'text', text: g.bold, marks: [{ type: 'strong' }] });
    else if (g.code !== undefined) nodes.push({ type: 'text', text: g.code, marks: [{ type: 'code' }] });
    else nodes.push({ type: 'text', text: g.label, marks: [{ type: 'link', attrs: { href: g.url } }] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) nodes.push({ type: 'text', text: text.slice(pos) });
  return nodes.length ? nodes : [{ type: 'text', text }];
}

const listItem = (text) => ({ type: 'listItem', content: [{ type: 'paragraph', content: adfInline(text) }] });

/** The block nodes for a markdown string (Confluence appends these to an existing doc). */
export function markdownToAdfContent(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const content = [];
  const bullet = /^(?<indent>\s*)[-*]\s+(?<text>.*)$/;
  const ordered = /^(?<indent>\s*)\d+[.)]\s+(?<text>.*)$/;
  let para = [];
  const flush = () => {
    if (para.length) content.push({ type: 'paragraph', content: adfInline(para.join(' ')) });
    para = [];
  };
  const consumeList = (start, re, kind) => {
    const items = [];
    let j = start;
    while (j < lines.length) {
      const m = lines[j].match(re);
      if (!m) break;
      const indent = m.groups.indent.length;
      const item = listItem(m.groups.text);
      const sub = [];
      let k = j + 1;
      for (; k < lines.length; k++) {
        const sm = lines[k].match(re);
        if (sm && sm.groups.indent.length > indent) sub.push(listItem(sm.groups.text));
        else break;
      }
      if (sub.length) {
        item.content.push({ type: kind, content: sub });
        j = k;
      } else j += 1;
      items.push(item);
    }
    content.push({ type: kind, content: items });
    return j;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const s = line.trim();
    if (s.startsWith('```')) {
      flush();
      const code = [];
      for (i += 1; i < lines.length && !lines[i].trim().startsWith('```'); i++) code.push(lines[i]);
      i += 1;
      content.push({ type: 'codeBlock', content: [{ type: 'text', text: code.join('\n') || ' ' }] });
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(s)) {
      flush();
      content.push({ type: 'rule' });
      i += 1;
      continue;
    }
    const h = s.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      content.push({ type: 'heading', attrs: { level: h[1].length }, content: adfInline(h[2]) });
      i += 1;
      continue;
    }
    if (bullet.test(line)) {
      flush();
      i = consumeList(i, bullet, 'bulletList');
      continue;
    }
    if (ordered.test(line)) {
      flush();
      i = consumeList(i, ordered, 'orderedList');
      continue;
    }
    if (!s) {
      flush();
      i += 1;
      continue;
    }
    para.push(s);
    i += 1;
  }
  flush();
  return content.length ? content : [{ type: 'paragraph', content: [{ type: 'text', text: md }] }];
}

export const markdownToAdf = (md) => ({ type: 'doc', version: 1, content: markdownToAdfContent(md) });

export const plainAdf = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
