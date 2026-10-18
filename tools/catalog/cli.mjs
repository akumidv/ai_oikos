#!/usr/bin/env node
// The user's local catalog: named roots of their documents, domains and counterparties, each
// with the folders and files where its materials are. It lives in the installation's
// `.local/catalog.yaml` (never committed), grows as the agent works, and turns "show the
// invoices of X" into a lookup instead of a search over the disk. Read-only by default; `add`
// previews, `--yes` writes.
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { runCli, isMain, printJson, UsageError } from '../common/cli.mjs';
import { installRoot, localPath } from '../common/paths.mjs';
import { fold, missingMessage } from '../common/files.mjs';

/** The installation's catalog file; throws outside an installation. */
export const catalogFile = () => localPath('catalog.yaml');
const KINDS = { counterparty: 'counterparties', domain: 'domains' };
const LISTS = ['aliases', 'tags', 'domains', 'folders', 'files'];

const HEADER = `# oikos catalog — personal, in .local/ (never committed). Skill: skills/catalog/SKILL.md
# roots: name → absolute path; a folder or file is written "@<root>/<path>" or as an absolute path;
# a file may also be relative to its entry's first folder.
`;

// -- load / save --------------------------------------------------------------------------

export function loadDocument() {
  const text = existsSync(catalogFile()) ? readFileSync(catalogFile(), 'utf8') : `${HEADER}version: 1\nroots: {}\ndomains: {}\ncounterparties: {}\n`;
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new UsageError(`${catalogFile()}: ${doc.errors[0].message}`);
  return doc;
}

export function loadCatalog() {
  const data = loadDocument().toJS() || {};
  return {
    roots: data.roots || {},
    domains: data.domains || {},
    counterparties: data.counterparties || {},
  };
}

const list = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

// -- paths --------------------------------------------------------------------------------

/** "@root/rest" or an absolute path → an absolute path; `base` resolves a bare relative file. */
export function resolvePath(catalog, value, base) {
  const m = String(value).match(/^@([^/\\]+)[/\\]?(.*)$/);
  if (m) {
    const root = catalog.roots[m[1]];
    if (!root) return { path: null, problem: `unknown root @${m[1]}` };
    return { path: m[2] ? join(root, ...m[2].split(/[/\\]/)) : root };
  }
  if (isAbsolute(value)) return { path: value };
  if (base) return { path: join(base, ...String(value).split(/[/\\]/)) };
  return { path: null, problem: 'relative path without a root (write @<root>/…)' };
}

/** An absolute path under a root → "@root/rest", so the catalog survives a moved root. */
function shorten(catalog, value) {
  if (!isAbsolute(value)) return value;
  const abs = resolve(value);
  for (const [name, root] of Object.entries(catalog.roots)) {
    const rel = relative(resolve(root), abs);
    if (rel === '') return `@${name}`;
    if (!rel.startsWith('..') && !isAbsolute(rel)) return `@${name}/${rel.split(sep).join('/')}`;
  }
  return value;
}

const exists = (p) => { try { return statSync(p); } catch { return null; } };

// -- matching -----------------------------------------------------------------------------

const norm = (s) => fold(s).replace(/[«»"'“”„]/g, '').replace(/\s+/g, ' ').trim();

function entries(catalog) {
  const out = [];
  for (const [kind, key] of Object.entries(KINDS)) {
    for (const [id, e] of Object.entries(catalog[key])) out.push({ kind, id, ...(e || {}) });
  }
  return out;
}

const normTag = (t) => norm(t).replace(/^#/, '').replace(/\s+/g, '-');

/** An entry's own tags, and for a counterparty also the tags of its domains. */
export function tagsOf(catalog, e) {
  const own = list(e.tags).map(normTag);
  const inherited = e.kind === 'counterparty' ? list(e.domains).flatMap((d) => list(catalog.domains[d]?.tags).map(normTag)) : [];
  return [...new Set([...own, ...inherited])];
}

/** By id (exact wins), name or alias; every --tag must be among the entry's tags. */
export function findEntries(catalog, query, tags = []) {
  const want = tags.map(normTag);
  const all = entries(catalog).filter((e) => want.every((t) => tagsOf(catalog, e).includes(t)));
  if (!query) return all;
  const q = norm(query);
  const exact = all.filter((e) => norm(e.id) === q);
  if (exact.length) return exact;
  return all.filter((e) => [e.id, e.name, ...list(e.aliases)].some((s) => s && norm(s).includes(q)));
}

// -- files --------------------------------------------------------------------------------

function walk(dir, depth, out, limit) {
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (out.length >= limit) return;
    if (it.name.startsWith('.') || it.name.startsWith('~$')) continue;
    const p = join(dir, it.name);
    if (it.isDirectory()) { if (depth > 1) walk(p, depth - 1, out, limit); } else out.push(p);
  }
}

function filesOf(catalog, entry, { match, since, depth, scanLimit }) {
  const words = match ? norm(match).split(' ') : [];
  const found = new Map();
  for (const f of list(entry.folders)) {
    const { path } = resolvePath(catalog, f);
    if (!path || !exists(path)?.isDirectory()) continue;
    const acc = [];
    walk(path, depth, acc, scanLimit);
    for (const p of acc) found.set(p, path);
  }
  const rows = [];
  for (const [p, folder] of found) {
    const name = relative(folder, p);
    if (words.length && !words.every((w) => norm(name).includes(w))) continue;
    const st = exists(p);
    if (!st) continue;
    // A date at the start of the name (20260930 Invoice 14.docx) is the document's date; a synced
    // disk rewrites mtimes, so mtime is the fallback only.
    const d = basename(p).match(/^((?:19|20)\d{2})[-.]?(\d{2})[-.]?(\d{2})(?!\d)/);
    const date = d && !Number.isNaN(Date.parse(`${d[1]}-${d[2]}-${d[3]}`)) ? new Date(`${d[1]}-${d[2]}-${d[3]}`) : st.mtime;
    if (since && date < since) continue;
    rows.push({ path: p, date, dateFrom: d ? 'name' : 'mtime', size: st.size });
  }
  // Dated by name first (newest first), then the rest by mtime.
  const rank = (r) => (r.dateFrom === 'name' ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || b.date - a.date || a.path.localeCompare(b.path));
}

// -- output -------------------------------------------------------------------------------

function describe(catalog, e) {
  const lines = [`${e.kind} ${e.id} — ${e.name || '(no name)'}`];
  if (list(e.aliases).length) lines.push(`  aliases: ${list(e.aliases).join(', ')}`);
  const tags = tagsOf(catalog, e);
  if (tags.length) lines.push(`  tags: ${tags.map((t) => `#${t}`).join(' ')}`);
  if (list(e.domains).length) lines.push(`  domains: ${list(e.domains).join(', ')}`);
  if (e.kind === 'domain') {
    const cps = Object.entries(catalog.counterparties).filter(([, c]) => list(c?.domains).includes(e.id)).map(([id]) => id);
    if (cps.length) lines.push(`  counterparties: ${cps.join(', ')}`);
  }
  const folders = list(e.folders);
  const base = folders.length ? resolvePath(catalog, folders[0]).path : null;
  for (const f of folders) {
    const r = resolvePath(catalog, f);
    lines.push(`  folder: ${r.path || f}${r.problem ? ` (${r.problem})` : exists(r.path)?.isDirectory() ? '' : ' (missing)'}`);
  }
  for (const f of list(e.files)) {
    const r = resolvePath(catalog, f, base);
    lines.push(`  file: ${r.path || f}${r.problem ? ` (${r.problem})` : exists(r.path) ? '' : ' (missing)'}`);
  }
  if (e.note) lines.push(`  note: ${String(e.note).trim().replace(/\s*\n\s*/g, ' ')}`);
  return lines;
}

/** Compact lines for the session start: what the catalog knows, one line per entry. */
export function summaryLines(catalog, limit = 40) {
  const all = entries(catalog);
  const roots = Object.keys(catalog.roots);
  const lines = [`catalog (.local/catalog.yaml): ${Object.keys(catalog.counterparties).length} counterparties, ` +
    `${Object.keys(catalog.domains).length} domains; roots: ${roots.length ? roots.map((r) => `@${r}`).join(', ') : 'none'}`];
  for (const e of all.slice(0, limit)) {
    const aliases = list(e.aliases).length ? ` (${list(e.aliases).join(', ')})` : '';
    const domains = list(e.domains).length ? ` · ${list(e.domains).join(', ')}` : '';
    const tags = list(e.tags).length ? ` ${list(e.tags).map((t) => `#${normTag(t)}`).join(' ')}` : '';
    lines.push(`- ${e.kind} ${e.id} — ${e.name || ''}${aliases}${domains}${tags}`);
  }
  if (all.length > limit) lines.push(`… ${all.length - limit} more: node oikos/tools/catalog/cli.mjs summary --limit ${all.length}`);
  return lines;
}

function problems(catalog) {
  const out = [];
  for (const [name, root] of Object.entries(catalog.roots)) {
    if (!isAbsolute(String(root))) out.push(`root @${name}: not an absolute path`);
    else if (!exists(root)?.isDirectory()) out.push(`root @${name}: missing ${root}`);
  }
  const seenAlias = new Map();
  const seenFolder = new Map();
  for (const e of entries(catalog)) {
    const tag = `${e.kind} ${e.id}`;
    if (!e.name) out.push(`${tag}: no name`);
    for (const k of Object.keys(e)) {
      if (LISTS.includes(k) && e[k] != null && !Array.isArray(e[k])) out.push(`${tag}: ${k} should be a list`);
    }
    for (const d of list(e.domains)) if (!catalog.domains[d]) out.push(`${tag}: unknown domain '${d}'`);
    for (const a of [e.name, ...list(e.aliases)].filter(Boolean)) {
      const k = norm(a);
      const other = seenAlias.get(k);
      if (other && other !== tag) out.push(`${tag}: name/alias '${a}' also used by ${other}`);
      seenAlias.set(k, tag);
    }
    const folders = list(e.folders);
    const base = folders.length ? resolvePath(catalog, folders[0]).path : null;
    for (const f of folders) {
      const r = resolvePath(catalog, f);
      if (r.problem) { out.push(`${tag}: folder ${f}: ${r.problem}`); continue; }
      if (!exists(r.path)?.isDirectory()) out.push(`${tag}: folder missing ${r.path}`);
      if (e.kind === 'counterparty') {
        const other = seenFolder.get(r.path);
        if (other && other !== tag) out.push(`${tag}: folder ${f} also belongs to ${other}`);
        seenFolder.set(r.path, tag);
      }
    }
    for (const f of list(e.files)) {
      const r = resolvePath(catalog, f, base);
      if (r.problem) out.push(`${tag}: file ${f}: ${r.problem}`);
      else if (!exists(r.path)) out.push(`${tag}: file missing ${r.path}`);
    }
  }
  return out;
}

// -- commands -----------------------------------------------------------------------------

function kindKey(kind) {
  const key = KINDS[kind];
  if (!key) throw new UsageError(`kind must be ${Object.keys(KINDS).join(' | ')} (or root)`);
  return key;
}

function save(doc) {
  // Block style throughout, so a person can read and edit the file line by line.
  const block = (_, node) => { node.flow = false; };
  YAML.visit(doc, { Map: block, Seq: block });
  let text = doc.toString({ lineWidth: 0 });
  if (!text.startsWith('#')) text = HEADER + text;
  writeFileSync(catalogFile(), text, { mode: 0o600 });
}

const commands = {
  summary: {
    help: 'what the catalog knows: roots, then one line per counterparty and domain',
    options: { limit: { type: 'string' } },
    run(values) {
      const catalog = loadCatalog();
      if (values.json) return printJson(catalog);
      if (!existsSync(catalogFile())) console.log('no catalog yet — `add root <name> <path>` starts one');
      console.log(summaryLines(catalog, Number(values.limit) || 40).join('\n'));
    },
  },

  find: {
    help: 'entries by id, name or alias, and/or --tag; --files lists their files (newest first), --match "acceptance 12" filters by name',
    options: {
      tag: { type: 'string', multiple: true }, files: { type: 'boolean' }, match: { type: 'string' }, since: { type: 'string' },
      depth: { type: 'string' }, limit: { type: 'string' },
    },
    run(values, positionals) {
      const query = positionals.join(' ').trim();
      const tags = values.tag || [];
      if (!query && !tags.length) throw new UsageError('usage: find <id | name | alias> [--tag t …] [--files] [--match text] [--since YYYY-MM-DD] [--depth 3] [--limit 30]');
      const catalog = loadCatalog();
      const found = findEntries(catalog, query, tags);
      if (!found.length) {
        const what = [query && `"${query}"`, ...tags.map((t) => `#${normTag(t)}`)].filter(Boolean).join(' ');
        console.log(`nothing in the catalog matches ${what} — ${summaryLines(catalog, 0)[0]}; tags in use: node oikos/tools/catalog/cli.mjs tags`);
        return 3;
      }
      const wantFiles = values.files || values.match || values.since;
      const since = values.since ? new Date(values.since) : null;
      if (since && Number.isNaN(since.getTime())) throw new UsageError('--since takes a date: YYYY-MM-DD');
      const limit = Number(values.limit) || 30;
      const opts = { match: values.match, since, depth: Number(values.depth) || 3, scanLimit: 5000 };
      const result = found.map((e) => ({ entry: e, files: wantFiles ? filesOf(catalog, e, opts) : undefined }));
      if (values.json) return printJson(result);
      for (const { entry, files } of result) {
        console.log(describe(catalog, entry).join('\n'));
        if (!files) continue;
        for (const f of files.slice(0, limit)) console.log(`  ${f.date.toISOString().slice(0, 10)}${f.dateFrom === 'mtime' ? '*' : ' '} ${f.path}`);
        if (files.length > limit) console.log(`  … ${files.length - limit} more (--limit, --match, --since narrow it)`);
        if (!files.length) console.log('  no files match');
      }
    },
  },

  add: {
    help: 'add or extend an entry: add counterparty|domain <id> [--name] [--alias] [--tag] [--domain] [--folder] [--file] [--note]; add root <name> <path>; preview unless --yes',
    options: {
      name: { type: 'string' }, alias: { type: 'string', multiple: true }, tag: { type: 'string', multiple: true }, domain: { type: 'string', multiple: true },
      folder: { type: 'string', multiple: true }, file: { type: 'string', multiple: true }, note: { type: 'string' },
      yes: { type: 'boolean' },
    },
    run(values, [kind, id, path]) {
      if (!kind || !id) throw new UsageError('usage: add counterparty|domain <id> [options] | add root <name> <path>');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new UsageError(`id '${id}': lowercase latin letters, digits and '-' (e.g. acme-corp)`);
      const doc = loadDocument();
      const catalog = loadCatalog();
      const warnings = [];
      let before;
      let after;
      let target;

      if (kind === 'root') {
        if (!path || !isAbsolute(path)) throw new UsageError('add root <name> <absolute path>');
        if (!exists(path)?.isDirectory()) warnings.push(missingMessage(path, 'folder'));
        target = `root @${id}`;
        before = catalog.roots[id] ?? null;
        after = resolve(path);
        doc.setIn(['roots', id], after);
      } else {
        const key = kindKey(kind);
        target = `${kind} ${id}`;
        const current = catalog[key][id] || {};
        before = Object.keys(current).length ? current : null;
        const next = { ...current };
        if (values.name) next.name = values.name;
        if (values.note) next.note = values.note;
        const extend = (field, items, map = (x) => x) => {
          if (!items?.length) return;
          const have = list(next[field]);
          for (const item of items.map(map)) if (!have.some((h) => norm(h) === norm(item))) have.push(item);
          next[field] = have;
        };
        extend('aliases', values.alias);
        extend('tags', values.tag, normTag);
        extend('domains', values.domain);
        extend('folders', values.folder, (f) => shorten(catalog, f));
        extend('files', values.file, (f) => shorten(catalog, f));
        if (!next.name) throw new UsageError(`${target} is new: --name is required`);
        for (const d of list(next.domains)) {
          if (!catalog.domains[d] && !(kind === 'domain' && d === id)) warnings.push(`unknown domain '${d}' — add it: add domain ${d} --name …`);
        }
        const base = list(next.folders).length ? resolvePath(catalog, list(next.folders)[0]).path : null;
        for (const f of values.folder || []) {
          const r = resolvePath(catalog, shorten(catalog, f));
          if (r.problem) warnings.push(`folder ${f}: ${r.problem}`);
          else if (!exists(r.path)?.isDirectory()) warnings.push(missingMessage(r.path, 'folder'));
        }
        for (const f of values.file || []) {
          const r = resolvePath(catalog, shorten(catalog, f), base);
          if (r.problem) warnings.push(`file ${f}: ${r.problem}`);
          else if (!exists(r.path)) warnings.push(missingMessage(r.path));
        }
        const order = ['name', 'aliases', 'tags', 'domains', 'folders', 'files', 'note'];
        after = Object.fromEntries([...order.filter((k) => k in next), ...Object.keys(next).filter((k) => !order.includes(k))].map((k) => [k, next[k]]));
        doc.setIn([key, id], doc.createNode(after));
      }

      if (values.json) printJson({ target, before, after, warnings, written: Boolean(values.yes) });
      else {
        console.log(`${before ? 'update' : 'new'} ${target}:`);
        console.log(YAML.stringify(after, { lineWidth: 0 }).trimEnd().replace(/^/gm, '  '));
        for (const w of warnings) console.log(`warning: ${w}`);
      }
      if (!values.yes) {
        if (!values.json) console.log(`preview only; --yes writes ${relative(installRoot(), catalogFile())}`);
        return 0;
      }
      save(doc);
      if (!values.json) console.log(`written ${relative(installRoot(), catalogFile())}`);
    },
  },

  tags: {
    help: 'tags in use, with the entries that carry them (own tags; a counterparty also inherits its domains\' tags)',
    options: {},
    run(values) {
      const catalog = loadCatalog();
      const byTag = new Map();
      for (const e of entries(catalog)) for (const t of tagsOf(catalog, e)) byTag.set(t, [...(byTag.get(t) || []), e.id]);
      const rows = [...byTag].sort(([a], [b]) => a.localeCompare(b));
      if (values.json) return printJson(Object.fromEntries(rows));
      console.log(rows.length ? rows.map(([t, ids]) => `#${t} (${ids.length}): ${ids.join(', ')}`).join('\n') : 'no tags yet — add … --tag <tag>');
    },
  },

  check: {
    help: 'problems in the catalog: missing roots, folders and files, unknown domains, a shared alias or folder',
    options: {},
    run(values) {
      if (!existsSync(catalogFile())) { console.log('no catalog yet'); return 0; }
      const found = problems(loadCatalog());
      if (values.json) return printJson(found);
      console.log(found.length ? found.join('\n') : 'catalog ok');
      return found.length ? 3 : 0;
    },
  },
};

if (isMain(import.meta.url)) runCli('catalog', commands);
