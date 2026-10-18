#!/usr/bin/env node
// Confluence: find, read, create and edit pages (info, search, read, create, append,
// replace-section). Searching the
// organization's knowledge is the knowledge base's job; `read` is for the current text of one known page.
// Shares the Atlassian identity with jira (JIRA_* variables). Every write has --dry-run.
import { readFileSync } from 'node:fs';
import { runCli, printJson, nonLatinLetters, UsageError } from '../common/cli.mjs';
import { atlassianCreds, credsComplete, atlassianHelp, atlassianClient, missingCreds } from '../common/atlassian.mjs';
import { adfInline, adfToText, markdownToAdfContent } from '../common/adf.mjs';

/**
 * The credentials and the client for a command that would `what`. Missing credentials are a usage
 * error naming each missing key, raised before any request; only an explicit --dry-run whose
 * preview reads nothing from Confluence (`offline`) goes on, with a null client.
 */
function client(what, { offline = false } = {}) {
  const c = atlassianCreds('CONFLUENCE');
  if (credsComplete(c)) return { c, wiki: atlassianClient(c, 'confluence') };
  if (offline) return { c, wiki: null };
  throw missingCreds(c, 'Atlassian', what);
}

/** A page id, or a /wiki/.../pages/<id>/... URL. */
function pageId(v) {
  const raw = v.page || v['page-id'];
  if (!raw) throw new UsageError('--page is required (a page id or its /wiki/ URL)');
  const m = String(raw).match(/\/pages\/(\d+)/) || String(raw).match(/^(\d+)$/);
  if (!m) throw new UsageError(`cannot read a page id from ${raw}`);
  return m[1];
}

async function fetchPage(wiki, id, withBody) {
  const q = withBody ? '?body-format=atlas_doc_format' : '';
  return wiki.get(`/wiki/api/v2/pages/${id}${q}`);
}

const pageUrl = (c, page) => `${c.baseUrl}/wiki/spaces/-/pages/${page.id}`;

const commands = {
  info: {
    help: 'title, space, version and URL of a page (--page ID|URL) — run before every write',
    options: { page: { type: 'string' }, 'page-id': { type: 'string' } },
    async run(v) {
      const id = pageId(v);
      const { c, wiki } = client(`read page ${id}`);
      const page = await fetchPage(wiki, id, false);
      if (v.json) return printJson(page);
      let space = page.spaceId;
      try {
        const s = await wiki.get(`/wiki/api/v2/spaces/${page.spaceId}`);
        space = `${s.name} (${s.key})`;
      } catch { /* the id is still an answer */ }
      console.log(`Page: ${page.title} (id=${page.id})\nSpace: ${space}\nVersion: ${page.version?.number}\nURL: ${pageUrl(c, page)}`);
    },
  },

  append: {
    help: 'append a markdown section (--page, --heading, --text|--file, --heading-level, --at-start, --version-message, --dry-run)',
    options: {
      page: { type: 'string' }, 'page-id': { type: 'string' },
      heading: { type: 'string' }, 'heading-level': { type: 'string' },
      text: { type: 'string' }, file: { type: 'string' },
      'at-start': { type: 'boolean' }, 'version-message': { type: 'string' },
      'dry-run': { type: 'boolean' }, 'show-adf': { type: 'boolean' },
    },
    async run(v) {
      const id = pageId(v);
      const text = v.file ? readFileSync(v.file, 'utf8') : v.text;
      if (!text) throw new UsageError('--text or --file is required (the section body, markdown)');
      const level = Number(v['heading-level'] || 2);
      const nodes = [];
      if (v.heading) nodes.push({ type: 'heading', attrs: { level }, content: adfInline(v.heading) });
      nodes.push(...markdownToAdfContent(text));
      const where = v['at-start'] ? 'start' : 'end';
      const foreign = nonLatinLetters(`${v.heading || ''}${text}`);

      // The preview of an appended section reads nothing from Confluence, so an explicit --dry-run
      // works without credentials.
      const { c, wiki } = client(`append to page ${id}`, { offline: v['dry-run'] });
      if (v['dry-run']) {
        if (foreign) console.log(`WARNING: non-Latin letters (${foreign}) — documentation is English.`);
        console.log('--- DRY RUN (requested --dry-run) ---');
        console.log(`Page id: ${id}\nSection that WOULD be inserted at the ${where} of the page:`);
        console.log(`${'-'.repeat(40)}\n${v.heading ? `${'#'.repeat(level)} ${v.heading}\n` : ''}${text}\n${'-'.repeat(40)}`);
        if (v['show-adf']) console.log(JSON.stringify(nodes, null, 2));
        console.log('DRY RUN — nothing written to Confluence.');
        if (!wiki) offlineNote(c);
        return 0;
      }

      // Read-modify-write of the whole body: two guards stand between it and a destroyed page.
      const page = await fetchPage(wiki, id, true);
      const raw = page.body?.atlas_doc_format?.value;
      let doc;
      try {
        doc = raw ? JSON.parse(raw) : { type: 'doc', version: 1, content: [] };
      } catch {
        throw new UsageError('the page body does not parse as ADF; refusing to overwrite it. Look at the page.');
      }
      const version = page.version?.number;
      if (version === undefined) throw new UsageError("cannot read the page's current version; aborting rather than writing blind.");
      doc.content = v['at-start'] ? [...nodes, ...(doc.content || [])] : [...(doc.content || []), ...nodes];
      const r = await wiki.put(`/wiki/api/v2/pages/${id}`, {
        id: page.id,
        status: 'current',
        title: page.title,
        spaceId: page.spaceId,
        body: { representation: 'atlas_doc_format', value: JSON.stringify(doc) },
        version: { number: version + 1, message: v['version-message'] || 'Append section' },
      });
      console.log(`Inserted section at the ${where} of "${page.title}" (HTTP ${r.status}, version ${version} → ${version + 1}): ${pageUrl(c, page)}`);
    },
  },
};

// == search, read, create, replace-section ============================================

const headingText = (node) => adfToText(node.content || []).trim();

/** The closing note of a dry run made without credentials: the write itself will need them. */
function offlineNote(c) {
  console.log(`\n(no Atlassian credentials — the write itself needs them)\n${atlassianHelp(c)}`);
}

/** Under --dry-run, print `lines` as the preview and say nothing was written; whether it did. */
function dryRun(c, v, lines) {
  if (!v['dry-run']) return false;
  console.log('--- DRY RUN (requested --dry-run) ---');
  for (const l of lines) console.log(l);
  console.log('DRY RUN — nothing written to Confluence.');
  if (!credsComplete(c)) offlineNote(c);
  return true;
}

async function spaceId(wiki, key) {
  const d = await wiki.get(`/wiki/api/v2/spaces?keys=${encodeURIComponent(key)}`);
  const s = (d.results || [])[0];
  if (!s) throw new UsageError(`no space with key ${key}, or no access`);
  return s.id;
}

function bodyText(v) {
  const text = v.file ? readFileSync(v.file, 'utf8') : v.text;
  if (!text) throw new UsageError('--text or --file is required (markdown)');
  return text;
}

function englishOnly(v, ...texts) {
  const foreign = nonLatinLetters(texts.filter(Boolean).join(' '));
  if (foreign && !v['allow-non-english']) {
    throw new UsageError(`Confluence content is English, found non-Latin letters: ${foreign}. Translate, or pass --allow-non-english.`);
  }
}

Object.assign(commands, {
  search: {
    help: 'find pages by CQL or title (--cql … | --title text [--space KEY] | --mine; --limit) — for knowledge questions ask the knowledge base',
    options: { cql: { type: 'string' }, title: { type: 'string' }, space: { type: 'string' }, mine: { type: 'boolean' }, limit: { type: 'string' } },
    async run(v) {
      const { wiki } = client('search pages');
      let cql = v.cql;
      if (!cql && v.mine) {
        // currentUser() is the account of JIRA_EMAIL: pages it created or edited, newest first.
        cql = `type = page AND contributor = currentUser()${v.space ? ` AND space = "${v.space}"` : ''}${v.title ? ` AND title ~ "${v.title.replace(/"/g, '\\"')}"` : ''} ORDER BY lastmodified DESC`;
      }
      if (!cql) {
        if (!v.title) throw new UsageError('--cql, --title or --mine is required');
        cql = `type = page AND title ~ "${v.title.replace(/"/g, '\\"')}"${v.space ? ` AND space = "${v.space}"` : ''}`;
      }
      const d = await wiki.get(`/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${Number(v.limit || 25)}&expand=space,version`);
      if (v.json) return printJson(d.results);
      for (const p of d.results || []) console.log(`${p.id.padStart(12)}  ${p.space?.key || '?'}  v${p.version?.number}  ${p.title}`);
      console.log(`${(d.results || []).length} page(s)${d._links?.next ? ' … more (raise --limit)' : ''}`);
    },
  },

  read: {
    help: "the current text of one page (--page ID|URL) — the page as it is now, not a knowledge base's indexed copy",
    options: { page: { type: 'string' }, 'page-id': { type: 'string' } },
    async run(v) {
      const id = pageId(v);
      const { c, wiki } = client(`read page ${id}`);
      const page = await fetchPage(wiki, id, true);
      if (v.json) return printJson(page);
      const raw = page.body?.atlas_doc_format?.value;
      const text = raw ? adfToText(JSON.parse(raw)).replace(/\n{3,}/g, '\n\n').trim() : '';
      console.log(`# ${page.title}\n(id=${page.id}, version ${page.version?.number}, ${pageUrl(c, page)})\n\n${text || '(empty page)'}`);
    },
  },

  create: {
    help: 'create a page (--space KEY, --title, --parent ID|URL, --text|--file markdown, --dry-run)',
    options: {
      space: { type: 'string' }, title: { type: 'string' }, parent: { type: 'string' },
      text: { type: 'string' }, file: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'allow-non-english': { type: 'boolean' },
    },
    async run(v) {
      if (!v.space || !v.title) throw new UsageError('--space and --title are required');
      const text = bodyText(v);
      englishOnly(v, v.title, text);
      const parentId = v.parent ? pageId({ page: v.parent }) : null;
      // The preview of a new page reads nothing from Confluence, so an explicit --dry-run works
      // without credentials.
      const { c, wiki } = client(`create a page in ${v.space}`, { offline: v['dry-run'] });
      if (dryRun(c, v, [`Would create "${v.title}" in space ${v.space}${parentId ? ` under page ${parentId}` : ''}:`, '-'.repeat(40), text, '-'.repeat(40)])) return 0;
      const existing = await wiki.get(`/wiki/rest/api/content/search?cql=${encodeURIComponent(`type = page AND space = "${v.space}" AND title = "${v.title.replace(/"/g, '\\"')}"`)}&limit=1`);
      if ((existing.results || []).length) throw new UsageError(`a page titled "${v.title}" already exists in ${v.space} (id ${existing.results[0].id}); edit it instead`);
      const body = {
        spaceId: await spaceId(wiki, v.space),
        status: 'current',
        title: v.title,
        body: { representation: 'atlas_doc_format', value: JSON.stringify({ type: 'doc', version: 1, content: markdownToAdfContent(text) }) },
      };
      if (parentId) body.parentId = parentId;
      const { data } = await wiki.post('/wiki/api/v2/pages', body);
      console.log(`Created "${data.title}" (id=${data.id}): ${pageUrl(c, data)}`);
    },
  },

  'replace-section': {
    help: 'replace the body under an existing heading, up to the next heading of the same or higher level (--page, --heading, --text|--file, --version-message, --dry-run)',
    options: {
      page: { type: 'string' }, 'page-id': { type: 'string' }, heading: { type: 'string' },
      text: { type: 'string' }, file: { type: 'string' }, 'version-message': { type: 'string' },
      'dry-run': { type: 'boolean' }, 'allow-non-english': { type: 'boolean' },
    },
    async run(v) {
      const id = pageId(v);
      if (!v.heading) throw new UsageError('--heading is required (the exact heading text)');
      const text = bodyText(v);
      englishOnly(v, text);
      // Even the dry run reads the page: it shows the section's current text.
      const { c, wiki } = client(`replace a section of page ${id}`);
      const page = await fetchPage(wiki, id, true);
      let doc;
      try { doc = JSON.parse(page.body?.atlas_doc_format?.value || ''); } catch {
        throw new UsageError('the page body does not parse as ADF; refusing to overwrite it. Look at the page.');
      }
      const version = page.version?.number;
      if (version === undefined) throw new UsageError("cannot read the page's current version; aborting rather than writing blind.");
      const content = doc.content || [];
      const matches = content.map((n, i) => (n.type === 'heading' && headingText(n) === v.heading.trim() ? i : -1)).filter((i) => i >= 0);
      if (matches.length !== 1) {
        const headings = content.filter((n) => n.type === 'heading').map((n) => `  ${'#'.repeat(n.attrs?.level || 1)} ${headingText(n)}`);
        throw new UsageError(`heading "${v.heading}" found ${matches.length} times at the top level. Headings:\n${headings.join('\n')}`);
      }
      const start = matches[0];
      const level = content[start].attrs?.level || 1;
      let end = start + 1;
      while (end < content.length && !(content[end].type === 'heading' && (content[end].attrs?.level || 1) <= level)) end += 1;
      const old = adfToText(content.slice(start + 1, end)).trim();
      if (dryRun(c, v, [`Page "${page.title}" v${version}, section "${v.heading}" (${end - start - 1} block(s)).`, 'Current text:', '-'.repeat(40), old || '(empty)', '-'.repeat(40), 'Would become:', '-'.repeat(40), text, '-'.repeat(40)])) return 0;
      doc.content = [...content.slice(0, start + 1), ...markdownToAdfContent(text), ...content.slice(end)];
      const r = await wiki.put(`/wiki/api/v2/pages/${id}`, {
        id: page.id, status: 'current', title: page.title, spaceId: page.spaceId,
        body: { representation: 'atlas_doc_format', value: JSON.stringify(doc) },
        version: { number: version + 1, message: v['version-message'] || `Replace section ${v.heading}` },
      });
      console.log(`Replaced section "${v.heading}" of "${page.title}" (HTTP ${r.status}, version ${version} → ${version + 1}): ${pageUrl(c, page)}`);
    },
  },
});

runCli('confluence', commands, { connector: 'confluence' });
