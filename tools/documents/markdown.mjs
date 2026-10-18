// A markdown note (Obsidian) -> an on-brand .docx in the approved-policy format: title page,
// Change History, Contents, numbered body, header and footer, brand fonts embedded.
// The layout is oikos's; the look is the organization's. Without a brand the document is neutral
// (system fonts, no logos); the installation's `brand:` names the fonts, logos and palette
// (loadBrand), and their files come from the brand assets folder: OIKOS_BRAND_ASSETS names it,
// or OIKOS_BRAND_PLUGIN names a Claude plugin skill folder whose assets/ holds it. The `docx`
// package is this tool's own dependency (tools/documents/package.json), loaded only when the
// command runs.
//
// What the note may hold, all optional except a title:
//   frontmatter `title`, `status` (draft → "(draft)" next to the version)
//   a front part before the first `---` line: **Company**, `# Title — Subtitle`,
//     `Classification: **Internal**`, `## Change History` with its table (the last row gives
//     the version and date); a `## Contents` list there is replaced by one built from the body
//   the body: `##`/`###` headings, paragraphs, `-`/`1.` lists (two levels), tables (`<br>` in a
//     cell), fenced code, ```mermaid blocks (become figures, see `figures`), image embeds
//     `![[file.png]]` and `![alt](path)`; inline **bold**, *italic*, `code`.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { config } from '../common/config.mjs';

const W = 9638; // A4 content width in twips with 2 cm margins
const MAX_IMG = { w: 640, h: 640 }; // px at 96 dpi

// The neutral look: fonts every office suite has, a slate palette with one accent, no logos.
const DEFAULT_PALETTE = { ink: '0F172A', s700: '334155', s500: '64748B', s300: 'CBD5E1', s100: 'F1F5F9', s50: 'F8FAFC', accent: '1F4E79', paper: 'FFFFFF' };
const DEFAULT_FONTS = { body: { name: 'Arial' }, mono: { name: 'Courier New' }, heading: { name: 'Arial', bold: true } };
const LOGOS = ['title', 'header'];

/**
 * The look of the document: the neutral one, with the installation's `brand:` over it.
 *
 *   brand:
 *     palette: { accent: 1F4E79 }        # any of ink, s700, s500, s300, s100, s50, accent, paper
 *     fonts:                             # name, and the file to embed (relative to the assets folder)
 *       body: { name: Source Sans 3, file: fonts/SourceSans3-Regular.ttf }
 *       mono: { name: Source Code Pro, file: fonts/SourceCodePro-Regular.ttf }
 *       heading: { name: Source Sans 3 Semibold, file: fonts/SourceSans3-Semibold.ttf, bold: false }
 *     logos:                             # PNG, size in px: the title page and the page header
 *       title: { file: logos/wordmark.png, width: 176, height: 44 }
 *       header: { file: logos/signet.png, width: 14, height: 14 }
 *
 * Returns { brand, problems }: a file the brand names and the folder does not hold is a problem,
 * never a silent fallback to the neutral look.
 */
export function loadBrand(assets, brand = {}) {
  const problems = [];
  const read = (rel, label) => {
    if (!rel) return null;
    const path = isAbsolute(String(rel)) ? String(rel) : assets && join(assets, String(rel));
    if (!path) { problems.push(`brand ${label} names ${rel}, but no brand assets folder was found`); return null; }
    if (!existsSync(path)) { problems.push(`brand ${label}: ${path} does not exist`); return null; }
    return readFileSync(path);
  };
  const palette = { ...DEFAULT_PALETTE };
  for (const [k, v] of Object.entries(brand.palette || {})) palette[k] = String(v).replace(/^#/, '').toUpperCase();
  const fonts = {};
  for (const role of Object.keys(DEFAULT_FONTS)) {
    const f = { ...DEFAULT_FONTS[role], ...(brand.fonts?.[role] || {}) };
    fonts[role] = { name: String(f.name), bold: !!f.bold, data: read(f.file, `fonts.${role}`) };
  }
  const logos = {};
  for (const place of LOGOS) {
    const l = brand.logos?.[place];
    const data = l && read(l.file, `logos.${place}`);
    if (data) logos[place] = { data, width: Number(l.width) || 100, height: Number(l.height) || 100 };
  }
  return { brand: { palette, fonts, logos }, problems };
}

/** The brand assets folder: explicit, then `<plugin>/assets` under the Claude plugins folder. */
export function findBrandAssets(explicit, plugin) {
  const ok = (d) => d && existsSync(d) && statSync(d).isDirectory();
  if (explicit) return ok(explicit) ? resolve(explicit) : null;
  if (!plugin) return null;
  const walk = (dir, depth) => {
    if (depth > 7) return null;
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of names) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name === plugin && ok(join(p, 'assets'))) return join(p, 'assets');
      const found = walk(p, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(join(homedir(), '.claude', 'plugins'), 0);
}

// -- markdown → blocks ------------------------------------------------------------------------

const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)/;
const EMBED = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$|^!\[[^\]]*\]\(([^)]+)\)$/;

export function parseNote(md) {
  md = md.replace(/\r/g, '');
  let fm = {};
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (m) {
    fm = parseYaml(m[1]) || {};
    md = md.slice(m[0].length);
  }
  return { fm, blocks: parseBlocks(md.split('\n')) };
}

function parseBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    let m;
    if ((m = l.match(/^```(\w*)/))) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      blocks.push({ t: 'code', lang: m[1], code });
    } else if ((m = l.match(/^(#{1,4}) (.*)/))) blocks.push({ t: 'h', level: m[1].length, text: m[2].trim() });
    else if (/^---+$/.test(l)) blocks.push({ t: 'hr' });
    else if ((m = l.trim().match(EMBED))) blocks.push({ t: 'img', src: (m[1] || m[2]).trim() });
    else if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      blocks.push({ t: 'table', rows });
    } else if (LIST.test(l)) {
      const items = [];
      while (i < lines.length && lines[i].trim() && !/^(#|\||```)/.test(lines[i])) {
        const s = lines[i];
        const mm = s.match(LIST);
        const ind = s.match(/^\s*/)[0].length;
        if (mm) items.push({ indent: ind, col: ind + mm[2].length + 1, ordered: /\d/.test(mm[2]), text: mm[3] });
        else {
          // A continuation line belongs to the deepest item whose text starts at or before it;
          // after that item's sub-items it becomes a paragraph of its own at that item's level.
          let k = items.length - 1;
          while (k > 0 && items[k].col > ind) k--;
          if (k === items.length - 1 || items[k].cont) items[k].text += ` ${s.trim()}`;
          else items.push({ indent: items[k].indent, col: items[k].col, cont: true, text: s.trim() });
        }
        i++;
      }
      i--;
      blocks.push({ t: 'list', items });
    } else {
      const p = [l.trim()];
      while (i + 1 < lines.length && lines[i + 1].trim()
        && !/^(\s*([-*]|\d+\.)\s|#|\||```|---+$|!\[)/.test(lines[i + 1])) p.push(lines[++i].trim());
      blocks.push({ t: 'p', text: p.join(' ') });
    }
  }
  return blocks;
}

/** Splits the note into the front part (title, classification, Change History) and the body. */
function layout(fm, blocks) {
  const hr = blocks.findIndex((b) => b.t === 'hr');
  const hasFront = hr > 0 && blocks.slice(0, hr).some((b) => b.t === 'h' && /change history/i.test(b.text));
  const front = hasFront ? blocks.slice(0, hr) : [];
  const body = (hasFront ? blocks.slice(hr + 1) : blocks).filter((b) => b.t !== 'hr');
  const title = front.find((b) => b.t === 'h' && b.level === 1)?.text
    || (body[0]?.t === 'h' && body[0].level === 1 ? body.shift().text : null) || fm.title;
  if (!title) throw new Error('the note has no title (frontmatter `title` or a `# heading`)');
  const [main, subtitle] = title.split(/\s+[—–]\s+/);
  const company = front.find((b) => b.t === 'p' && /^\*\*[^*]+\*\*$/.test(b.text))?.text.slice(2, -2) || config().organization.name || '';
  const cls = front.map((b) => b.t === 'p' && b.text.match(/^Classification:\s*\**([^*]+)\**/i)).find(Boolean);
  const hIdx = front.findIndex((b) => b.t === 'h' && /change history/i.test(b.text));
  const history = hIdx >= 0 ? front.slice(hIdx + 1).find((b) => b.t === 'table')?.rows : null;
  const last = history?.at(-1);
  return {
    body, main, subtitle, company, history,
    classification: cls ? cls[1].trim() : 'Internal',
    version: last?.[1] ?? '', date: last?.[0] ?? '',
    draft: String(fm.status || '').toLowerCase() === 'draft',
  };
}

// -- rendering --------------------------------------------------------------------------------

/**
 * Builds the .docx. options: { brand (loadBrand; neutral when absent), figures: [png paths, one per mermaid block in order],
 * resolveImage(src) -> path, owner, meta: [[key, value]], eyebrow }. Returns { buffer, figures,
 * missingFigures: [{ index, code }] } — mermaid blocks without a figure are listed, not drawn.
 */
export async function buildDocx(md, options) {
  const d = await import('docx');
  const { fm, blocks } = parseNote(md);
  const L = layout(fm, blocks);
  const { palette: C, fonts: F, logos } = options.brand || loadBrand(null).brand;
  const BODY = F.body.name;
  const MONO = F.mono.name;
  const MONO_M = F.heading.name;
  const border = { style: d.BorderStyle.SINGLE, size: 4, color: C.s300 };
  const none = { style: d.BorderStyle.NONE, size: 0, color: 'auto' };
  const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };

  const runs = (text, base = {}) => {
    const out = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m;
    const push = (t, o) => t && out.push(new d.TextRun({ text: t, font: BODY, color: C.ink, ...base, ...o }));
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('**')) out.push(...runs(t.slice(2, -2), { ...base, bold: true }));
      else if (t.startsWith('`')) push(t.slice(1, -1), { font: MONO, size: (base.size || 20) - 2, color: C.s700 });
      else if (t.startsWith('[[')) push(t.slice(2, -2).split('|').pop());
      else if (t.startsWith('[')) {
        const [, label, url] = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        out.push(new d.ExternalHyperlink({ link: url, children: [new d.TextRun({ text: label, font: BODY, color: C.accent, underline: {}, ...base })] }));
      } else push(t.slice(1, -1), { italics: true });
      last = m.index + t.length;
    }
    push(text.slice(last));
    return out;
  };
  const para = (text, p = {}) => new d.Paragraph({ children: runs(text), spacing: { after: 120, line: 276 }, ...p });

  const widths = (rows) => {
    const n = Math.max(...rows.map((r) => r.length));
    const len = Array.from({ length: n }, (_, c) => Math.max(...rows.map((r) => (r[c] || '').replace(/<br>/g, ' ').length)));
    const wt = len.map((x) => Math.max(Math.sqrt(x), 3.2));
    const sum = wt.reduce((a, b) => a + b, 0);
    const tw = wt.map((x) => Math.round((W * x) / sum));
    tw[n - 1] += W - tw.reduce((a, b) => a + b, 0);
    return tw;
  };
  const table = (rows) => {
    const cw = widths(rows);
    return new d.Table({
      width: { size: W, type: d.WidthType.DXA }, columnWidths: cw, layout: d.TableLayoutType.FIXED, borders,
      rows: rows.map((r, ri) => new d.TableRow({
        tableHeader: ri === 0, cantSplit: true,
        children: cw.map((w, ci) => new d.TableCell({
          width: { size: w, type: d.WidthType.DXA },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          shading: ri === 0 ? { type: d.ShadingType.CLEAR, fill: C.s700, color: 'auto' }
            : ri % 2 === 0 ? { type: d.ShadingType.CLEAR, fill: C.s50, color: 'auto' } : undefined,
          children: (r[ci] || '').split('<br>').map((t) => new d.Paragraph({
            spacing: { after: 40, line: 252 },
            children: ri === 0 ? [new d.TextRun({ text: t.replace(/\*\*/g, ''), font: MONO_M, size: 16, color: C.paper })] : runs(t, { size: 17 }),
          })),
        })),
      })),
    });
  };

  let listNo = 0;
  const list = (items) => {
    const instance = ++listNo;
    const base = items[0].indent;
    return items.map((it) => {
      const level = it.indent > base ? 1 : 0;
      if (it.cont) return para(it.text, { indent: { left: 360 * (level + 1) }, spacing: { after: 80, line: 276 } });
      return new d.Paragraph({
        children: runs(it.text),
        numbering: it.ordered ? { reference: 'num', level, instance } : { reference: 'bul', level },
        spacing: { after: 60, line: 276 },
      });
    });
  };

  const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
  const jpgSize = (buf) => {
    for (let i = 2; i < buf.length;) {
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return { w: 800, h: 600 };
  };
  let figNo = 0;
  const figure = (file, caption) => {
    const buf = readFileSync(file);
    const png = buf.readUInt32BE(0) === 0x89504e47;
    const s = png ? pngSize(buf) : jpgSize(buf);
    let w = Math.min(MAX_IMG.w, s.w);
    let h = Math.round((s.h * w) / s.w);
    if (h > MAX_IMG.h) { w = Math.round((w * MAX_IMG.h) / h); h = MAX_IMG.h; }
    figNo++;
    return [
      new d.Paragraph({ alignment: d.AlignmentType.CENTER, keepNext: true, spacing: { before: 120, after: 80 },
        children: [new d.ImageRun({ type: png ? 'png' : 'jpg', data: buf, transformation: { width: w, height: h } })] }),
      new d.Paragraph({ alignment: d.AlignmentType.CENTER, spacing: { after: 200 },
        children: [new d.TextRun({ text: `Figure ${figNo}.${caption ? ` ${caption}` : ''}`, font: BODY, size: 16, color: C.s500 })] }),
    ];
  };
  const code = (lines) => lines.map((l, k) => new d.Paragraph({
    shading: { type: d.ShadingType.CLEAR, fill: C.s100, color: 'auto' },
    keepNext: k < lines.length - 1, keepLines: true,
    spacing: { after: k === lines.length - 1 ? 160 : 0, line: 240 },
    indent: { left: 120, right: 120 },
    children: [new d.TextRun({ text: l || ' ', font: MONO, size: 16, color: C.s700 })],
  }));
  const heading = (text, level) => new d.Paragraph({
    heading: level <= 2 ? d.HeadingLevel.HEADING_1 : level === 3 ? d.HeadingLevel.HEADING_2 : d.HeadingLevel.HEADING_3,
    keepNext: true,
    children: [new d.TextRun({ text, font: MONO_M, bold: F.heading.bold, color: C.ink, size: level <= 2 ? 30 : level === 3 ? 23 : 21 })],
    spacing: { before: level <= 2 ? 360 : 240, after: 120 },
  });

  // body
  const out = [];
  const missingFigures = [];
  let mermaidNo = 0;
  L.body.forEach((b, k) => {
    const prev = L.body[k - 1];
    // A figure's caption: the bold lead of the paragraph just before it ("**Request processing.** …").
    const caption = prev?.t === 'p' ? prev.text.match(/^\*\*([^*]+?)\.?\*\*/)?.[1] : undefined;
    if (b.t === 'h') out.push(heading(b.text, b.level));
    else if (b.t === 'p') out.push(para(b.text));
    else if (b.t === 'table') out.push(table(b.rows), new d.Paragraph({ spacing: { after: 120 }, children: [] }));
    else if (b.t === 'list') out.push(...list(b.items), new d.Paragraph({ spacing: { after: 60 }, children: [] }));
    else if (b.t === 'img') {
      const file = options.resolveImage(b.src);
      if (file) out.push(...figure(file, caption));
      else out.push(para(`[image not found: ${b.src}]`));
    } else if (b.t === 'code' && b.lang === 'mermaid') {
      const file = options.figures?.[mermaidNo];
      if (file) out.push(...figure(file, caption));
      else missingFigures.push({ index: mermaidNo + 1, code: b.code.join('\n') });
      mermaidNo++;
    } else if (b.t === 'code') out.push(...code(b.code));
  });

  // title page
  const kvCell = (w, children, left) => new d.TableCell({
    width: { size: w, type: d.WidthType.DXA }, borders: { top: border, bottom: border, left: none, right: none },
    margins: { top: 80, bottom: 80, left: left ? 0 : 100, right: 100 }, children: [new d.Paragraph({ children })],
  });
  const meta = [['Classification', L.classification]];
  if (L.version) meta.push(['Version', `${L.version}${L.draft ? ' (draft)' : ''}`]);
  if (L.date) meta.push(['Date', L.date]);
  if (options.owner) meta.push(['Owner', options.owner]);
  meta.push(...(options.meta || []));
  const eyebrow = (options.eyebrow || L.classification).toUpperCase().replace(/\s*·\s*/g, '  ·  ');
  const titlePage = [
    new d.Paragraph({ children: logos.title ? [new d.ImageRun({ type: 'png', data: logos.title.data,
      transformation: { width: logos.title.width, height: logos.title.height } })] : [], spacing: { after: 2400 } }),
    new d.Paragraph({ children: [new d.TextRun({ text: eyebrow, font: MONO_M, size: 18, color: C.accent, characterSpacing: 10 })], spacing: { after: 240 } }),
    new d.Paragraph({ children: [new d.TextRun({ text: L.company, font: BODY, bold: true, size: 26, color: C.s700 })], spacing: { after: 120 } }),
    new d.Paragraph({ children: [new d.TextRun({ text: L.main, font: MONO_M, size: 52, color: C.ink, characterSpacing: -20 })], spacing: { after: 160, line: 264 } }),
    ...(L.subtitle ? [new d.Paragraph({ children: [new d.TextRun({ text: L.subtitle, font: BODY, bold: true, size: 30, color: C.accent })], spacing: { after: 1600 } })] : []),
    new d.Table({
      width: { size: 7200, type: d.WidthType.DXA }, columnWidths: [2400, 4800], layout: d.TableLayoutType.FIXED,
      borders: { top: border, bottom: border, left: none, right: none, insideHorizontal: border, insideVertical: none },
      rows: meta.map(([k, v]) => new d.TableRow({ children: [
        kvCell(2400, [new d.TextRun({ text: k.toUpperCase(), font: MONO_M, size: 16, color: C.s500 })], true),
        kvCell(4800, [new d.TextRun({ text: v, font: BODY, size: 20, color: C.ink })]),
      ] })),
    }),
    new d.Paragraph({ children: [new d.PageBreak()] }),
  ];
  const contents = L.body.filter((b) => b.t === 'h' && b.level === 2).map((b) => b.text);
  const numbered = contents.every((t) => /^\d+\./.test(t));
  const frontPage = [
    ...(L.history ? [heading('Change History', 2), table(L.history)] : []),
    ...(contents.length ? [heading('Contents', 2), ...contents.map((t, k) => new d.Paragraph({ spacing: { after: 80 },
      children: [new d.TextRun({ text: numbered ? t.replace(/^(\d+\.)\s*/, '$1  ') : `${k + 1}.  ${t}`, font: BODY, size: 21, color: C.ink })] }))] : []),
    new d.Paragraph({ children: [new d.PageBreak()] }),
  ];

  const small = { font: BODY, size: 15, color: C.s500 };
  const docTitle = L.subtitle ? `${L.main} — ${L.subtitle}` : L.main;
  const header = new d.Header({ children: [new d.Paragraph({
    border: { bottom: { style: d.BorderStyle.SINGLE, size: 4, color: C.s300, space: 4 } },
    tabStops: [{ type: 'right', position: W }],
    children: [...(logos.header ? [new d.ImageRun({ type: 'png', data: logos.header.data,
      transformation: { width: logos.header.width, height: logos.header.height } })] : []),
      new d.TextRun({ text: `${logos.header ? '  ' : ''}${docTitle}`, ...small }), new d.TextRun({ text: `\t${L.classification}`, ...small })],
  })] });
  const versionText = [L.version && `Version ${L.version}${L.draft ? ' draft' : ''}`, L.date].filter(Boolean).join('  ·  ');
  const footer = new d.Footer({ children: [new d.Paragraph({
    tabStops: [{ type: 'right', position: W }],
    children: [new d.TextRun({ text: [L.company, versionText].filter(Boolean).join('  ·  '), ...small }),
      new d.TextRun({ children: ['\tPage ', d.PageNumber.CURRENT, ' of ', d.PageNumber.TOTAL_PAGES], ...small })],
  })] });
  const blank = { header: new d.Header({ children: [new d.Paragraph('')] }), footer: new d.Footer({ children: [new d.Paragraph('')] }) };

  const bullet = (level) => ({ level, format: d.LevelFormat.BULLET, text: level ? '–' : '•', alignment: d.AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } }, run: { font: BODY, color: C.accent } } });
  const doc = new d.Document({
    title: docTitle, creator: L.company,
    // One file per family: bold and italic are synthesised by the reader from the regular face.
    // A font without a file is named, not embedded: the reader's own copy is used.
    fonts: Object.values(F).filter((f, k, all) => f.data && all.findIndex((g) => g.name === f.name) === k)
      .map((f) => ({ name: f.name, data: f.data, characterSet: d.CharacterSet.ANSI })),
    styles: {
      default: { document: { run: { font: BODY, size: 20, color: C.ink } } },
      paragraphStyles: [1, 2, 3].map((n) => ({ id: `Heading${n}`, name: `Heading ${n}`, basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: MONO_M, bold: F.heading.bold, size: [30, 23, 21][n - 1], color: C.ink }, paragraph: { outlineLevel: n - 1 } })),
    },
    numbering: { config: [
      { reference: 'bul', levels: [bullet(0), bullet(1)] },
      { reference: 'num', levels: [
        { level: 0, format: d.LevelFormat.DECIMAL, text: '%1.', alignment: d.AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 300 } }, run: { font: BODY } } },
        bullet(1),
      ] },
    ] },
    sections: [{
      properties: { titlePage: true, page: { size: { width: 11906, height: 16838 },
        margin: { top: 1134, bottom: 1134, left: 1134, right: 1134, header: 567, footer: 567 } } },
      headers: { default: header, first: blank.header },
      footers: { default: footer, first: blank.footer },
      children: [...titlePage, ...frontPage, ...out],
    }],
  });
  return { buffer: await d.Packer.toBuffer(doc), figures: figNo, missingFigures };
}

/** Resolves an image embed: a path next to the note, or an Obsidian name in the vault. */
export function imageResolver(notePath) {
  const noteDir = dirname(resolve(notePath));
  let vault = noteDir;
  while (vault !== dirname(vault) && !existsSync(join(vault, '.obsidian'))) vault = dirname(vault);
  if (!existsSync(join(vault, '.obsidian'))) vault = null;
  return (src) => {
    const s = decodeURIComponent(src);
    for (const p of [isAbsolute(s) ? s : join(noteDir, s), vault && join(vault, s), vault && join(vault, 'attachments', s)]) {
      if (p && existsSync(p) && statSync(p).isFile()) return p;
    }
    return null;
  };
}
