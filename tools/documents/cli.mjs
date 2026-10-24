// Office documents without a word processor: read a .docx's text the way an agent needs it,
// make a new .docx from an existing one by replacing text (layout and formatting kept), and
// render a document to look at the result. ZIP through fflate (no dependencies of its own);
// rendering through the LibreOffice the user has (under WSL also the Windows one), or one
// `install` unpacks into the project after the user agreed (common/programs.mjs has the order).
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir, platform, arch } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { runCli, isMain, printJson, UsageError } from '../common/cli.mjs';
import { CORE_ROOT, envValue } from '../common/env.mjs';
import { missingMessage } from '../common/files.mjs';
import { config } from '../common/config.mjs';
import { request, download, ChannelError, HttpError } from '../common/http.mjs';
import { PROJECT_PROGRAMS, findProgram, installed, missingLibraries, onPath, progress, windowsSide,
  toolDependenciesInstalled, installToolDependencies } from '../common/programs.mjs';
import { buildDocx, findBrandAssets, imageResolver, loadBrand } from './markdown.mjs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

// -- WordprocessingML ---------------------------------------------------------------------
// Word splits visible text across many runs (<w:r><w:t>…</w:t></w:r>) at revision ids,
// spell-check marks and formatting changes, so a phrase is rarely one string in the XML.
// Paragraphs are matched by pattern, not parsed: text boxes nested inside a paragraph are not
// handled.

const TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const PARA = /<w:p(?:\s[^>]*?)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const TEXT = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t(?:\s[^>]*)?\/>/g;
const SHOWN = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g;

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (_, k) =>
  ENTITIES[k] ?? String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)));
const encode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const partLabel = (name) => name.slice('word/'.length, -'.xml'.length);

function openDocx(file) {
  if (!file) throw new UsageError('a .docx file is required');
  if (!existsSync(file)) throw new UsageError(missingMessage(file));
  if (extname(file).toLowerCase() !== '.docx') {
    throw new UsageError('only .docx is supported; convert a .doc first: render <file.doc> --format docx');
  }
  const entries = unzipSync(readFileSync(file)); // { name: bytes }, in archive order
  const parts = Object.keys(entries).filter((name) => TEXT_PARTS.test(name))
    .sort((a, b) => (a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)))
    .map((name) => {
      const xml = strFromU8(entries[name]);
      const paras = [...xml.matchAll(PARA)].map((m) => ({
        at: m.index,
        xml: m[0],
        texts: [...m[0].matchAll(TEXT)].map((t) => ({ at: t.index, raw: t[0], text: decode(t[1] ?? '') })),
      }));
      return { name, label: partLabel(name), xml, paras };
    });
  return { entries, parts };
}

const plain = (p) => p.texts.map((t) => t.text).join('');
// For reading: tabs and line breaks shown; tab stops in the paragraph properties are not tabs.
const shown = (p) => [...p.xml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '').matchAll(SHOWN)]
  .map((m) => (m[2] ? (m[2] === 'tab' ? '\t' : ' ⏎ ') : decode(m[1]))).join('');

/** Replace every `from` in a paragraph's text, across run boundaries; the text lands in the run
 *  where the match starts, so it takes that run's formatting. Returns the number replaced. */
function replaceInParagraph(p, from, to) {
  let count = 0;
  let pos = 0;
  for (;;) {
    const i = plain(p).indexOf(from, pos);
    if (i < 0) return count;
    const j = i + from.length;
    let acc = 0;
    let si = -1;
    let so = 0;
    let ei = -1;
    let eo = 0;
    p.texts.forEach((t, k) => {
      const a = acc;
      acc += t.text.length;
      if (si < 0 && i >= a && i < acc) { si = k; so = i - a; }
      if (ei < 0 && j - 1 >= a && j - 1 < acc) { ei = k; eo = j - a; }
    });
    const T = p.texts;
    if (si === ei) {
      T[si].text = T[si].text.slice(0, so) + to + T[si].text.slice(eo);
    } else {
      T[si].text = T[si].text.slice(0, so) + to;
      for (let k = si + 1; k < ei; k++) T[k].text = '';
      T[ei].text = T[ei].text.slice(eo);
    }
    for (let k = si; k <= ei; k++) T[k].changed = true;
    count++;
    pos = i + to.length;
  }
}

/** Table rows of a part as spans { at, end }, nested tables included (tags matched by depth). */
function tableRows(xml) {
  const rows = [];
  const open = [];
  for (const m of xml.matchAll(/<w:tr(?=[\s>])[^>]*>|<\/w:tr>/g)) {
    if (m[0] === '</w:tr>') {
      const at = open.pop();
      if (at !== undefined) rows.push({ at, end: m.index + m[0].length });
    } else open.push(m.index);
  }
  return rows;
}

/** Rows to drop: for each text, the innermost row whose text contains it — exactly one. */
function findRows(doc, texts) {
  return texts.map((text) => {
    const hits = [];
    for (const part of doc.parts) {
      for (const row of tableRows(part.xml)) {
        const paras = part.paras.filter((p) => p.at >= row.at && p.at < row.end);
        if (paras.map(plain).join('').includes(text)) hits.push({ part, ...row, paras });
      }
    }
    // A row inside a matching row is the one meant: keep only rows with no matching row inside.
    const innermost = hits.filter((h) => !hits.some((o) => o !== h && o.part === h.part && o.at > h.at && o.end < h.end));
    return { text, rows: innermost };
  });
}

const rowText = (row) => row.paras.map(shown).filter((t) => t.trim()).join(' | ');

function rebuild(part, drop = []) {
  const edits = drop.map((r) => ({ at: r.at, end: r.end, xml: '' }));
  for (const p of part.paras) {
    if (!p.texts.some((t) => t.changed) || drop.some((r) => p.at >= r.at && p.at < r.end)) continue;
    let px = p.xml;
    for (const t of [...p.texts].reverse()) {
      if (t.changed) px = px.slice(0, t.at) + `<w:t xml:space="preserve">${encode(t.text)}</w:t>` + px.slice(t.at + t.raw.length);
    }
    edits.push({ at: p.at, end: p.at + p.xml.length, xml: px });
  }
  let xml = part.xml;
  for (const e of edits.sort((a, b) => b.at - a.at)) xml = xml.slice(0, e.at) + e.xml + xml.slice(e.end);
  return xml;
}

/** Write next to the target and rename over it, so a failed write never leaves half a file. */
function writeDocx(out, bytes) {
  const part = `${out}.oikos-part`;
  writeFileSync(part, bytes);
  renameSync(part, out);
}

function parsePairs(list) {
  return (list || []).map((s) => {
    const k = s.indexOf('=>');
    if (k <= 0) throw new UsageError(`--set needs "old=>new": ${s}`);
    return { from: s.slice(0, k), to: s.slice(k + 2) };
  });
}

// -- LibreOffice ----------------------------------------------------------------------------

const LO_DIR = join(PROJECT_PROGRAMS, 'libreoffice');
const LO_STABLE = 'https://download.documentfoundation.org/libreoffice/stable/';

function findLibreOffice() {
  return findProgram({
    env: 'OIKOS_SOFFICE_PATH',
    names: ['soffice', 'libreoffice'],
    system: {
      linux: installed('/opt').filter((d) => /libreoffice/i.test(d)).map((d) => join(d, 'program', 'soffice')),
      darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice'],
      win32: [join(process.env.PROGRAMFILES || 'C:\\Program Files', 'LibreOffice\\program\\soffice.exe')],
    },
    windows: ['soffice.exe'],
    project: () => installed(join(LO_DIR, 'opt')).map((d) => join(d, 'program', 'soffice')),
  });
}

function soffice() {
  const found = findLibreOffice();
  if (found) return found.path;
  throw new UsageError('LibreOffice not found. Install it with the system (apt install libreoffice-writer-nogui; '
    + 'brew install --cask libreoffice; libreoffice.org) or into this project: node oikos/tools/documents/cli.mjs install');
}

const byVersion = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().slice(-400)}`);
  return r.stdout;
}

/** The download.documentfoundation.org redirect first, then mirrors from its mirror list. */
async function downloadLibreOffice(url, file) {
  let mirrors = [];
  try {
    const { data } = await request(`${url}.mirrorlist`, { tool: 'documents', as: 'text' });
    const name = basename(url).replace(/\./g, '\\.');
    mirrors = [...new Set([...data.matchAll(new RegExp(`https?://[^"'\\s<>]+/${name}`, 'g'))].map((m) => m[0]))].slice(0, 5);
  } catch { /* the redirect alone */ }
  const problems = [];
  for (const candidate of [url, ...mirrors]) {
    try {
      process.stderr.write(`downloading from ${new URL(candidate).host}\n`);
      return await download(candidate, file, { tool: 'documents', onProgress: progress('LibreOffice') });
    } catch (e) {
      if (!(e instanceof ChannelError || e instanceof HttpError)) throw e;
      problems.push(e.message);
      process.stderr.write(`  ${e.message}\n`);
    }
  }
  throw new ChannelError(`LibreOffice could not be downloaded:\n  ${problems.join('\n  ')}`);
}

/** A folder both sides can use: for a Windows LibreOffice under WSL it must live on the Windows disk. */
function workBase(windows) {
  if (!windows) return tmpdir();
  const local = execFileSync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], { cwd: '/mnt/c', encoding: 'utf8' }).trim();
  return join(execFileSync('wslpath', ['-u', local], { encoding: 'utf8' }).trim(), 'Temp');
}

// -- commands -------------------------------------------------------------------------------

const commands = {
  text: {
    help: 'paragraphs of a .docx (body, then headers/footers/notes), numbered for replace; --runs shows run splits',
    options: { all: { type: 'boolean' }, runs: { type: 'boolean' } },
    run(v, [file]) {
      const { parts } = openDocx(file);
      const rows = parts.flatMap((part) => part.paras.map((p, i) => ({
        part: part.label, index: i, text: shown(p), runs: p.texts.map((t) => t.text),
      }))).filter((r) => v.all || r.text.trim());
      if (v.json) return printJson(rows);
      for (const r of rows) {
        const at = r.part === 'document' ? `${r.index}` : `${r.part}:${r.index}`;
        console.log(`${at} | ${v.runs ? r.runs.map((t) => `[${t}]`).join('') : r.text}`);
      }
      if (!v.all) console.log('(empty paragraphs not shown; --all shows them)');
    },
  },
  replace: {
    help: 'replace text across runs (--set "old=>new") and drop table rows (--drop-row "text"), keeping formatting: preview by default; --out <new.docx> writes a new file, --in-place rewrites this one (a backup is kept)',
    options: {
      set: { type: 'string', multiple: true }, 'drop-row': { type: 'string', multiple: true },
      out: { type: 'string' }, 'in-place': { type: 'boolean' },
    },
    run(v, [file]) {
      const pairs = parsePairs(v.set);
      const dropTexts = v['drop-row'] || [];
      if (!pairs.length && !dropTexts.length) throw new UsageError('nothing to do: give --set "old=>new" and/or --drop-row "text in the row"');
      if (v.out && v['in-place']) throw new UsageError('--out and --in-place exclude each other');
      const doc = openDocx(file);
      const drops = findRows(doc, dropTexts);
      const dropped = drops.flatMap((d) => (d.rows.length === 1 ? d.rows : []));
      const inDropped = (part, p) => dropped.some((r) => r.part === part && p.at >= r.at && p.at < r.end);
      const before = new Map();
      for (const pair of pairs) {
        pair.count = 0;
        for (const part of doc.parts) {
          part.paras.forEach((p, i) => {
            if (inDropped(part, p)) return; // the row goes; its text is not replaced
            const was = plain(p);
            const n = replaceInParagraph(p, pair.from, pair.to);
            if (n && !before.has(p)) before.set(p, { at: part.label === 'document' ? `${i}` : `${part.label}:${i}`, was });
            pair.count += n;
          });
        }
      }
      const changed = [...before].map(([p, b]) => ({ at: b.at, before: b.was, after: plain(p) }));
      const missing = pairs.filter((p) => !p.count);
      const rowsOut = drops.map((d) => ({ text: d.text, rows: d.rows.map((r) => ({ part: r.part.label, text: rowText(r) })) }));
      const target = v['in-place'] ? file : v.out || null;
      if (v.json) printJson({ replacements: pairs, changed, droppedRows: rowsOut, out: target });
      else {
        for (const p of pairs) console.log(`${p.count}× ${JSON.stringify(p.from)} → ${JSON.stringify(p.to)}`);
        for (const d of rowsOut) {
          console.log(`drop row ${JSON.stringify(d.text)}: ${d.rows.length === 1 ? '1 row' : `${d.rows.length} rows`}`);
          for (const r of d.rows) console.log(`  - ${r.part === 'document' ? '' : `${r.part}: `}${r.text}`);
        }
        for (const c of changed) console.log(`\n${c.at} | ${c.before}\n${' '.repeat(c.at.length)} → ${c.after}`);
      }
      const problems = [];
      if (missing.length) problems.push(`not found: ${missing.map((p) => JSON.stringify(p.from)).join(', ')} (a match cannot span a tab, a line break or two paragraphs, and text in a dropped row is not replaced; check with \`text\`)`);
      for (const d of drops) {
        if (!d.rows.length) problems.push(`no table row contains ${JSON.stringify(d.text)}`);
        if (d.rows.length > 1) problems.push(`${d.rows.length} table rows contain ${JSON.stringify(d.text)}; give text unique to one row`);
      }
      if (problems.length) {
        console.error(`\n${problems.join('\n')}\nnothing written`);
        return 3;
      }
      if (!target) return console.log('\npreview only; --out <new.docx> writes a new file, --in-place rewrites this one');
      const out = resolve(target);
      if (v.out) {
        if (out === resolve(file)) { console.error('refused: --out is the source file; write a new file, or --in-place for a file this task made'); return 3; }
        if (existsSync(out)) { console.error(`refused: ${v.out} exists; choose another name, or --in-place on it`); return 3; }
      }
      for (const part of doc.parts) {
        const drop = dropped.filter((r) => r.part === part);
        if (drop.length || part.paras.some((p) => p.texts.some((t) => t.changed))) doc.entries[part.name] = strToU8(rebuild(part, drop));
      }
      let backup;
      if (v['in-place']) {
        const dir = join(tmpdir(), 'oikos-documents-backup');
        mkdirSync(dir, { recursive: true });
        backup = join(dir, `${basename(file, extname(file))}.${new Date().toISOString().replace(/[:.]/g, '-')}${extname(file)}`);
        copyFileSync(file, backup);
      }
      writeDocx(out, zipSync(doc.entries, { level: 6 }));
      console.log(`\nwrote ${target}${backup ? ` (the previous version: ${backup})` : ''} — check it: node oikos/tools/documents/cli.mjs render "${target}"`);
    },
  },
  render: {
    help: 'convert with LibreOffice to look at a document: --format png (first page, default) | pdf | docx | …',
    options: { format: { type: 'string' }, 'out-dir': { type: 'string' } },
    run(v, [file]) {
      if (!file) throw new UsageError('a file is required');
      if (!existsSync(file)) throw new UsageError(missingMessage(file));
      const format = v.format || 'png';
      const target = convert(file, format, resolve(v['out-dir'] || tmpdir()));
      if (!target) return 2;
      if (v.json) return printJson({ file: target, format });
      console.log(target);
      if (format.startsWith('png')) console.log('(png is the first page only; --format pdf renders every page)');
    },
  },
  'from-markdown': {
    help: 'a markdown note → an on-brand .docx in the approved-policy format (title page, Change History, contents); --pdf also renders the PDF',
    options: {
      out: { type: 'string' }, pdf: { type: 'boolean' }, figures: { type: 'string' }, brand: { type: 'string' },
      owner: { type: 'string' }, eyebrow: { type: 'string' }, meta: { type: 'string', multiple: true },
    },
    async run(v, [file]) {
      if (!file) throw new UsageError('a markdown file is required');
      if (!existsSync(file)) throw new UsageError(missingMessage(file));
      if (!v.out) throw new UsageError('--out <file.docx> is required (a working copy goes to the scratchpad)');
      // No brand at all is the neutral look; a brand that is named and not found is an error.
      const named = v.brand || envValue('OIKOS_BRAND_ASSETS') || envValue('OIKOS_BRAND_PLUGIN');
      const assets = findBrandAssets(v.brand || envValue('OIKOS_BRAND_ASSETS'), envValue('OIKOS_BRAND_PLUGIN'));
      if (named && !assets) {
        throw new UsageError(`the brand assets folder ${named} was not found: name the folder with --brand or `
          + 'OIKOS_BRAND_ASSETS, or the brand plugin skill folder with OIKOS_BRAND_PLUGIN (settings of the installation)');
      }
      const { brand, problems } = loadBrand(assets, config().brand);
      if (problems.length) throw new UsageError(`the installation's brand: ${problems.join('; ')}`);
      const figures = (v.figures || '').split(',').map((f) => f.trim()).filter(Boolean);
      for (const f of figures) if (!existsSync(f)) throw new UsageError(missingMessage(f));
      const meta = (v.meta || []).map((m) => {
        const at = m.indexOf('=');
        if (at < 1) throw new UsageError(`--meta takes Key=Value, got: ${m}`);
        return [m.slice(0, at).trim(), m.slice(at + 1).trim()];
      });
      let built;
      try {
        built = await buildDocx(readFileSync(file, 'utf8'), {
          brand, figures, meta, owner: v.owner, eyebrow: v.eyebrow, resolveImage: imageResolver(file),
        });
      } catch (e) {
        if (e.code === 'ERR_MODULE_NOT_FOUND') throw new UsageError('the docx package is not installed: node oikos/tools/documents/cli.mjs install');
        throw e;
      }
      if (built.missingFigures.length) {
        const dir = join(tmpdir(), `oikos-mermaid-${process.pid}`);
        mkdirSync(dir, { recursive: true });
        const files = built.missingFigures.map((m) => {
          const f = join(dir, `figure-${m.index}.mmd`);
          writeFileSync(f, `${m.code}\n`);
          return f;
        });
        console.error(`the note has ${built.missingFigures.length} mermaid block(s) without a figure; their sources: ${files.join(', ')}\n`
          + 'render each to PNG (skill documents, scenario from-markdown) and pass them in order: --figures a.png,b.png');
        return 1;
      }
      const out = resolve(v.out);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, built.buffer);
      const pdf = v.pdf ? convert(out, 'pdf', dirname(out)) : null;
      if (v.pdf && !pdf) return 2;
      if (v.json) return printJson({ docx: out, pdf, figures: built.figures, assets });
      console.log(`wrote ${out}${pdf ? `\nwrote ${pdf}` : ''} (${built.figures} figure(s)); `
        + `look at the pages: node oikos/tools/documents/cli.mjs render "${pdf || out}" --format pdf`);
    },
  },
};

/** Converts with LibreOffice; returns the produced file in outDir, or null after printing why. */
function convert(file, format, outDir) {
  const ext = format.split(':')[0];
  const exe = soffice();
  const windows = windowsSide(exe);
  const toSoffice = (p) => (windows ? execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim() : p);
  const base = workBase(windows);
  const work = join(base, `oikos-render-${process.pid}`);
  // A private LibreOffice profile: with the user's own profile a running LibreOffice window
  // swallows a headless conversion silently.
  const profile = join(base, 'oikos-soffice-profile');
  mkdirSync(work, { recursive: true });
  try {
    const input = join(work, `in${extname(file)}`); // an ASCII name: Windows argv and Cyrillic do not mix well
    copyFileSync(file, input);
    const profileUrl = 'file:///' + toSoffice(profile).replace(/\\/g, '/').replace(/^\//, '');
    const r = spawnSync(exe, [`-env:UserInstallation=${profileUrl}`, '--headless', '--convert-to', format,
      '--outdir', toSoffice(work), toSoffice(input)], { encoding: 'utf8', timeout: 180000 });
    const produced = readdirSync(work).find((f) => f === `in.${ext}` && f !== basename(input));
    if (!produced) {
      console.error(`render: LibreOffice produced no .${ext} (exit ${r.status ?? r.signal})\n${[r.stdout, r.stderr].join('\n').trim().slice(-800)}`);
      return null;
    }
    mkdirSync(outDir, { recursive: true });
    const target = join(outDir, `${basename(file, extname(file))}.${ext}`);
    copyFileSync(join(work, produced), target);
    return target;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

commands.install = {
  help: 'what the commands need and is missing: the docx package for `from-markdown` (~5 MB into tools/documents/node_modules), '
    + 'LibreOffice for `render` only when none is installed (the official build unpacked into the project, Linux x86-64, ~220 MB); a plan by default, --yes installs',
  options: { yes: { type: 'boolean' } },
  async run(v) {
    if (toolDependenciesInstalled('documents')) console.log('docx package (from-markdown): installed');
    else if (!v.yes) console.log('docx package (from-markdown): missing — --yes installs it into tools/documents/node_modules (~5 MB)');
    else {
      installToolDependencies('documents');
      console.log('docx package (from-markdown): installed into tools/documents/node_modules');
    }
    const found = findLibreOffice();
    if (found) {
      console.log(`LibreOffice is available (${found.source}): ${found.path}`);
      return 0;
    }
    if (platform() !== 'linux' || arch() !== 'x64') {
      console.log('a project install covers Linux x86-64 only; install LibreOffice with the system: https://www.libreoffice.org/download/ (macOS: brew install --cask libreoffice)');
      return 1;
    }
    const lacking = ['tar', 'dpkg-deb'].filter((t) => !onPath([t]).some((p) => existsSync(p)));
    if (lacking.length) {
      console.log(`unpacking needs ${lacking.join(', ')} (not found); install LibreOffice with the system package manager instead`);
      return 1;
    }
    const { data } = await request(LO_STABLE, { tool: 'documents', as: 'text' });
    const version = [...data.matchAll(/href="(\d+(?:\.\d+)+)\/"/g)].map((m) => m[1]).sort(byVersion).pop();
    if (!version) throw new ChannelError(`no version listed at ${LO_STABLE}`);
    const name = `LibreOffice_${version}_Linux_x86-64_deb.tar.gz`;
    console.log(`LibreOffice ${version}: the official .deb archive (~220 MB), unpacked with dpkg-deb into ${relative(CORE_ROOT, LO_DIR)} — nothing is installed system-wide, no sudo`);
    if (!v.yes) {
      console.log('plan only; run again with --yes to download and unpack');
      return 0;
    }
    mkdirSync(PROJECT_PROGRAMS, { recursive: true });
    const archive = join(PROJECT_PROGRAMS, name);
    if (!existsSync(archive)) await downloadLibreOffice(`${LO_STABLE}${version}/deb/x86_64/${name}`, archive);
    const unpack = join(PROJECT_PROGRAMS, 'libreoffice-unpack');
    rmSync(unpack, { recursive: true, force: true });
    mkdirSync(unpack, { recursive: true });
    run('tar', ['-xzf', archive, '-C', unpack]);
    const debs = readdirSync(unpack, { recursive: true }).filter((f) => f.endsWith('.deb')).map((f) => join(unpack, f));
    rmSync(LO_DIR, { recursive: true, force: true });
    for (const deb of debs) run('dpkg-deb', ['-x', deb, LO_DIR]);
    rmSync(unpack, { recursive: true, force: true });
    rmSync(archive, { force: true });
    const exe = findLibreOffice()?.path;
    if (!exe) throw new Error(`unpacked ${debs.length} package(s) but found no program/soffice under ${LO_DIR}`);
    const missing = missingLibraries(join(dirname(exe), 'soffice.bin'));
    if (missing.length) {
      console.log(`installed ${exe}, but these system libraries are missing: ${missing.join(', ')}\n`
        + 'the user installs them with the system package manager (apt search <name>); oikos does not use sudo');
      return 1;
    }
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 60000 });
    console.log(`installed: ${exe}\n${(r.stdout || r.stderr || '').trim()}`);
  },
};

if (isMain(import.meta.url)) runCli('documents', commands);
