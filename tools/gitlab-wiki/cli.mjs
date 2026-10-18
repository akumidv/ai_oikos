#!/usr/bin/env node
// GitLab wiki of a project (REST API): find, read, create and edit pages (whoami, search, read,
// info, create, append, replace-section) — the commands of tools/confluence/cli.mjs where the
// meaning matches. Markdown is native: a body is written as given, and a page in another format is
// read as raw text and never written. Every write has --dry-run.
//
// Every edit is a read-modify-write of the whole page. The GitLab wiki PUT takes no base version
// (unverified until checked live), and the write guard needs the dry run and the write to be the
// same command, so no `--base` pin: the dry run prints the page's content hash, and the write
// re-reads the page right before the PUT and prints the hash it applied to.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runCli, printJson, nonLatinLetters, UsageError } from '../common/cli.mjs';
import { envValue } from '../common/env.mjs';
import { gitlabClient, projectPath } from '../common/gitlab.mjs';
import { HttpError } from '../common/http.mjs';
import { appendToPage, findSection, replaceSection } from '../common/sections.mjs';

const TOOL = 'gitlab-wiki';
/** Lines of the page shown around an appended section in a dry run. */
const CONTEXT_LINES = 8;
/** Pages read for a title lookup: the wiki list is one answer, the cap only bounds a runaway. */
const LIST_LIMIT = 5000;

/** The token rows of the help text: wiki writes need scope `api`. */
const tokenHelp = (base) => [
  `  Token (scope api — wiki writes; read_api is enough for reads): ${base}/-/user_settings/personal_access_tokens`,
];

/** The GitLab client; a missing site or token is a usage error naming each key, before any request. */
const client = () => gitlabClient(TOOL, { help: tokenHelp });

/** The project from --project, else GITLAB_WIKI_PROJECT, else GITLAB_PROJECT. */
function projectFrom(v) {
  const project = v.project || envValue('GITLAB_WIKI_PROJECT') || envValue('GITLAB_PROJECT');
  if (!project) throw new UsageError('--project group/name is required (or the setting GITLAB_WIKI_PROJECT or GITLAB_PROJECT)');
  return project.replace(/^\/+|\/+$/g, '');
}

/**
 * The project and slug of a wiki URL `<GITLAB_URL>/group/project/-/wikis/<slug>`, or null when
 * `raw` is not such a URL. A URL of another site is a usage error.
 */
function parseWikiUrl(gl, raw) {
  if (!/^https?:\/\//i.test(raw)) return null;
  const url = new URL(raw);
  const base = new URL(gl.base);
  const m = decodeURIComponent(url.pathname).match(/^(.*?)\/-\/wikis\/(.+?)\/?$/);
  if (!m) throw new UsageError(`not a GitLab wiki page URL (…/group/project/-/wikis/<slug>): ${raw}`);
  const basePath = base.pathname.replace(/\/+$/, '');
  if (url.host !== base.host || !m[1].startsWith(`${basePath}/`)) {
    throw new UsageError(`${raw} is not on GITLAB_URL ${gl.base}`);
  }
  return { project: m[1].slice(basePath.length + 1), slug: m[2] };
}

/** The wiki API path of `project`, with `slug` URL-encoded (its `/` included) when given. */
const wikiPath = (project, slug) => `/projects/${projectPath(project)}/wikis${slug === undefined ? '' : `/${encodeURIComponent(slug)}`}`;

/** The web URL of a page: the slug's segments encoded, its `/` kept. */
const pageUrl = (gl, project, slug) => `${gl.base}/${project}/-/wikis/${slug.split('/').map(encodeURIComponent).join('/')}`;

/** Every page of the wiki, without content: [{ slug, title, format }]. */
const listPages = (gl, project) => gl.paged(`${wikiPath(project)}?with_content=0`, LIST_LIMIT);

/** The page among `pages` that `name` names: its slug first, then its exact title, then the title in any case. */
function pageNamed(pages, name) {
  const wanted = name.trim();
  return pages.find((p) => p.slug === wanted)
    || pages.find((p) => p.title === wanted)
    || pages.find((p) => p.title?.toLowerCase() === wanted.toLowerCase())
    || null;
}

/**
 * The project and slug that --page names: a wiki URL, else a slug or title looked up in the list
 * of the project's pages. A name that matches no page is a usage error listing a few slugs.
 */
async function resolvePage(gl, v, option = 'page') {
  const raw = v[option];
  if (!raw) throw new UsageError(`--${option} is required (a slug, a title, or the page's wiki URL)`);
  const fromUrl = parseWikiUrl(gl, String(raw));
  if (fromUrl) {
    if (v.project && v.project.replace(/^\/+|\/+$/g, '') !== fromUrl.project) {
      throw new UsageError(`--project ${v.project} and the URL's project ${fromUrl.project} differ`);
    }
    return fromUrl;
  }
  const project = projectFrom(v);
  const pages = await listPages(gl, project);
  const page = pageNamed(pages, String(raw));
  if (!page) {
    const some = pages.slice(0, 20).map((p) => `  ${p.slug}`).join('\n') || '  (the wiki has no pages)';
    throw new UsageError(`no page with slug or title "${raw}" in the wiki of ${project}. Pages${pages.length > 20 ? ` (20 of ${pages.length})` : ''}:\n${some}`);
  }
  return { project, slug: page.slug };
}

/** One page with its content: { slug, title, format, content, … } as the API answers. */
const fetchPage = (gl, project, slug) => gl.get(wikiPath(project, slug));

/** The short content hash a dry run and the write print: sha256, the first 12 hex digits. */
const contentHash = (text) => `sha256:${createHash('sha256').update(text ?? '', 'utf8').digest('hex').slice(0, 12)}`;

/**
 * A version the API gives for the page, when it gives one (unverified until checked live which
 * field, if any, carries it); null otherwise.
 */
function pageVersion(page) {
  const v = page.version ?? page.commit_id ?? page.last_commit_sha ?? page.commit?.id;
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'object' ? (v.id ?? v.sha ?? JSON.stringify(v)) : String(v);
}

const NO_VERSION = 'no version from the API: the write re-reads the page and applies to it as it is then';

/** Writes go to markdown pages only: another format is refused (exit 3) with the page's URL. */
function refuseNonMarkdown(gl, project, page) {
  if ((page.format || 'markdown') === 'markdown') return false;
  console.error(`refused: page ${page.slug} is in format ${page.format}, not markdown — the tool writes markdown pages only; edit it yourself: ${pageUrl(gl, project, page.slug)}`);
  return true;
}

/** The body of a write from --text or --file. */
function bodyText(v) {
  const text = v.file ? readFileSync(v.file, 'utf8') : v.text;
  if (!text) throw new UsageError('--text or --file is required (markdown)');
  return text;
}

/** Wiki content is English unless --allow-non-english. */
function englishOnly(v, ...texts) {
  const foreign = nonLatinLetters(texts.filter(Boolean).join(' '));
  if (foreign && !v['allow-non-english']) {
    throw new UsageError(`wiki content is English, found non-Latin letters: ${foreign}. Translate, or pass --allow-non-english.`);
  }
}

const RULE = '-'.repeat(40);

/** Print a dry run in Jira's frame; `lines` are its body. */
function dryRun(lines) {
  console.log('--- DRY RUN (requested --dry-run) ---');
  for (const l of lines) console.log(l);
  console.log('DRY RUN — nothing written to the GitLab wiki.');
}

/** The lines `from`–`to` (0-based, `to` exclusive) of `text`, without a final newline's empty line. */
function linesOf(text, from = 0, to = undefined) {
  if (text === '') return [];
  return text.replace(/\r?\n$/, '').split(/\r?\n/).slice(from, to);
}

const lineCount = (text) => linesOf(text).length;

/** The page head lines of a dry run: project, page, slug, URL, format, hash and version. */
function pageLines(gl, project, page) {
  const version = pageVersion(page);
  return [
    `Project: ${project}`,
    `Page:    ${page.title} (slug ${page.slug}, format ${page.format || 'markdown'})`,
    `URL:     ${pageUrl(gl, project, page.slug)}`,
    `Base:    ${contentHash(page.content)}${version ? `, version ${version}` : ` (${NO_VERSION})`}`,
  ];
}

/** Read the page for a write: its content, refused when not markdown. Null when refused. */
async function pageForWrite(gl, v) {
  const { project, slug } = await resolvePage(gl, v);
  const page = await fetchPage(gl, project, slug);
  if (refuseNonMarkdown(gl, project, page)) return null;
  return { project, page };
}

/**
 * The PUT of a page's new content; the title is left out, so it stays as it is (and a nested page
 * stays in its folder). Prints what was applied: the hash of the content it replaced.
 */
async function writePage(gl, project, page, content, what) {
  if (content === page.content) {
    console.log(`Nothing to change: page ${page.slug} already reads so (${contentHash(page.content)}).`);
    return 0;
  }
  const done = await gl.put(wikiPath(project, page.slug), { content });
  const now = typeof done?.content === 'string' ? done.content : content;
  console.log(`${what} "${page.title}" (applied to ${contentHash(page.content)}, now ${contentHash(now)}): ${pageUrl(gl, project, page.slug)}`);
  console.log('Compare the "applied to" hash with the dry run\'s Base: a difference means the page changed in between.');
  return 0;
}

const PAGE_OPTIONS = { project: { type: 'string' }, page: { type: 'string' } };
const WRITE_OPTIONS = {
  text: { type: 'string' }, file: { type: 'string' },
  'dry-run': { type: 'boolean' }, 'allow-non-english': { type: 'boolean' },
};

const commands = {
  whoami: {
    help: 'check the token: which GitLab user the tool acts as, and whether its scope allows wiki writes',
    options: {},
    async run(v) {
      const gl = client();
      const me = await gl.get('/user');
      let scopes = null;
      // The token's own record (unverified until checked live on every GitLab version): best effort.
      try { scopes = (await gl.get('/personal_access_tokens/self')).scopes || null; } catch { /* not visible */ }
      if (v.json) return printJson({ user: me, scopes });
      console.log(`@${me.username} (${me.name}) on ${gl.base}`);
      if (!scopes) console.log('Token scopes: not visible to the API — wiki writes need scope api.');
      else if (scopes.includes('api')) console.log(`Token scopes: ${scopes.join(', ')}`);
      else console.log(`Token scopes: ${scopes.join(', ')} — WARNING: no scope api, wiki writes will be rejected.`);
    },
  },

  search: {
    help: 'find pages (--query text: full text and titles; --title text: titles only; --project, --limit)',
    options: { project: { type: 'string' }, query: { type: 'string' }, title: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      const text = v.query || v.title;
      if (!text) throw new UsageError('--query or --title is required');
      const project = projectFrom(v);
      const limit = Number(v.limit || 25);
      const gl = client();
      const pages = await listPages(gl, project);
      const needle = text.toLowerCase();
      const titles = pages.filter((p) => p.title?.toLowerCase().includes(needle) || p.slug?.toLowerCase().includes(needle));
      let blobs = [];
      let note = '';
      if (v.query) {
        try {
          blobs = await gl.paged(`/projects/${projectPath(project)}/search?scope=wiki_blobs&search=${encodeURIComponent(v.query)}`, limit);
        } catch (e) {
          // Without Advanced Search the instance may refuse the wiki scope (unverified until checked live).
          if (!(e instanceof HttpError) || ![400, 403].includes(e.status)) throw e;
          note = `full-text wiki search refused by GitLab (HTTP ${e.status}); titles only`;
        }
      }
      if (v.json) return printJson({ titles: titles.slice(0, limit), blobs, note: note || undefined });
      for (const p of titles.slice(0, limit)) {
        console.log(`  ${p.slug}  ${p.title}${p.format && p.format !== 'markdown' ? `  [${p.format}]` : ''}`);
      }
      for (const b of blobs) {
        const slug = String(b.path || b.filename || b.basename || '').replace(/\.[^./]+$/, '');
        const line = String(b.data || '').split(/\r?\n/).find((l) => l.toLowerCase().includes(v.query.toLowerCase())) || String(b.data || '').split(/\r?\n/)[0] || '';
        console.log(`  ${slug}${b.startline ? `:${b.startline}` : ''}  ${line.trim().slice(0, 100)}`);
      }
      const cut = titles.length > limit ? ` (${titles.length - limit} more title match(es) — raise --limit)` : '';
      console.log(`${Math.min(titles.length, limit)} title match(es)${cut}${v.query && !note ? `, ${blobs.length} text match(es)${blobs.length >= limit ? ' … more may exist (raise --limit)' : ''}` : ''} in the wiki of ${project}`);
      if (note) console.log(`NOTE: ${note}.`);
    },
  },

  read: {
    help: 'the current text of one page (--page slug|title|URL, --project) — a page in another format than markdown comes as raw text',
    options: { ...PAGE_OPTIONS },
    async run(v) {
      const gl = client();
      const { project, slug } = await resolvePage(gl, v);
      const page = await fetchPage(gl, project, slug);
      if (v.json) return printJson(page);
      const format = page.format || 'markdown';
      const raw = format === 'markdown' ? '' : `, format ${format}: raw text, writes refused`;
      console.log(`# ${page.title}\n(slug ${page.slug}, ${contentHash(page.content)}${raw}, ${pageUrl(gl, project, page.slug)})\n\n${page.content?.trim() || '(empty page)'}`);
    },
  },

  info: {
    help: 'title, slug, format, content hash, version (when the API gives one) and URL of a page (--page, --project) — run before every write',
    options: { ...PAGE_OPTIONS },
    async run(v) {
      const gl = client();
      const { project, slug } = await resolvePage(gl, v);
      const page = await fetchPage(gl, project, slug);
      if (v.json) return printJson(page);
      const version = pageVersion(page);
      console.log([
        `Page: ${page.title}`,
        `Slug: ${page.slug}`,
        `Project: ${project}`,
        `Format: ${page.format || 'markdown'}${(page.format || 'markdown') === 'markdown' ? '' : ' (writes refused)'}`,
        `Content: ${contentHash(page.content)}, ${lineCount(page.content || '')} line(s)`,
        `Version: ${version || NO_VERSION}`,
        `URL: ${pageUrl(gl, project, page.slug)}`,
      ].join('\n'));
    },
  },

  create: {
    help: 'create a markdown page (--title, --parent slug|title|URL: the page goes under that path, --project, --text|--file, --dry-run)',
    options: { project: { type: 'string' }, title: { type: 'string' }, parent: { type: 'string' }, ...WRITE_OPTIONS },
    async run(v) {
      if (!v.title) throw new UsageError('--title is required');
      if (v.title.includes('/')) throw new UsageError('--title is one name; give the path above it as --parent');
      const text = bodyText(v);
      englishOnly(v, v.title, text);
      const gl = client();
      const project = projectFrom(v);
      const pages = await listPages(gl, project);
      let parent = null;
      let parentNote = '';
      if (v.parent) {
        const fromUrl = parseWikiUrl(gl, v.parent);
        if (fromUrl && fromUrl.project !== project) throw new UsageError(`the parent ${v.parent} is in ${fromUrl.project}, not ${project}`);
        const named = fromUrl ? null : pageNamed(pages, v.parent);
        parent = fromUrl ? fromUrl.slug : named ? named.slug : v.parent.trim().replace(/^\/+|\/+$/g, '');
        if (!fromUrl && !named) parentNote = ' (no page by that name: a new folder)';
      }
      // GitLab makes the slug from the title, spaces to hyphens, and a nested page from a title
      // with `/` (both unverified until checked live).
      const title = parent ? `${parent}/${v.title}` : v.title;
      const slug = title.replace(/ /g, '-');
      const taken = pages.find((p) => p.slug === slug || p.slug.toLowerCase() === slug.toLowerCase());
      if (taken) {
        console.error(`refused: page ${taken.slug} already exists in the wiki of ${project}; edit it instead: ${pageUrl(gl, project, taken.slug)}`);
        return 3;
      }
      if (v['dry-run']) {
        dryRun([
          `Project: ${project}`,
          `Would create "${v.title}"${parent ? ` under ${parent}${parentNote}` : ''} — slug ${slug} (format markdown):`,
          `URL:     ${pageUrl(gl, project, slug)}`,
          RULE, text, RULE,
        ]);
        return 0;
      }
      const page = await gl.post(wikiPath(project), { title, content: text, format: 'markdown' });
      console.log(`Created "${page.title || v.title}" (slug ${page.slug || slug}): ${pageUrl(gl, project, page.slug || slug)}`);
      return 0;
    },
  },

  append: {
    help: 'append a markdown section (--page, --project, --heading, --heading-level, --text|--file, --at-start, --dry-run)',
    options: { ...PAGE_OPTIONS, heading: { type: 'string' }, 'heading-level': { type: 'string' }, 'at-start': { type: 'boolean' }, ...WRITE_OPTIONS },
    async run(v) {
      const text = bodyText(v);
      englishOnly(v, v.heading, text);
      const level = Number(v['heading-level'] || 2);
      const atStart = Boolean(v['at-start']);
      const gl = client();
      const target = await pageForWrite(gl, v);
      if (!target) return 3;
      const { project, page } = target;
      const current = page.content || '';
      const next = appendToPage(current, text, { heading: v.heading, level, atStart });
      if (v['dry-run']) {
        const n = lineCount(current);
        const shownNow = atStart ? linesOf(current, 0, CONTEXT_LINES) : linesOf(current, Math.max(0, n - CONTEXT_LINES));
        const shownNext = atStart
          ? linesOf(next, 0, lineCount(next) - n + CONTEXT_LINES)
          : linesOf(next, Math.max(0, n - CONTEXT_LINES));
        const where = atStart ? 'first' : 'last';
        dryRun([
          ...pageLines(gl, project, page),
          `Current text (${where} ${shownNow.length} of ${n} line(s)):`, RULE, ...(shownNow.length ? shownNow : ['(empty page)']), RULE,
          `Would become (the section inserted at the ${atStart ? 'start' : 'end'}):`, RULE, ...shownNext, RULE,
        ]);
        return 0;
      }
      return writePage(gl, project, page, next, `Appended a section ${atStart ? 'at the start' : 'at the end'} of`);
    },
  },

  'replace-section': {
    help: 'replace the body under an existing heading, up to the next heading of the same or higher level (--page, --project, --heading, --text|--file, --dry-run)',
    options: { ...PAGE_OPTIONS, heading: { type: 'string' }, ...WRITE_OPTIONS },
    async run(v) {
      if (!v.heading) throw new UsageError('--heading is required (the exact heading text)');
      const text = bodyText(v);
      englishOnly(v, text);
      const gl = client();
      const target = await pageForWrite(gl, v);
      if (!target) return 3;
      const { project, page } = target;
      const current = page.content || '';
      // A missing or repeated heading is a SectionError (exit 1) that lists the page's headings.
      const old = findSection(current, v.heading);
      const next = replaceSection(current, v.heading, text);
      if (v['dry-run']) {
        const now = findSection(next, v.heading);
        const oldBody = linesOf(current, old.bodyStart, old.bodyEnd).join('\n').trim();
        const newBody = linesOf(next, now.bodyStart, now.bodyEnd).join('\n').trim();
        dryRun([
          ...pageLines(gl, project, page),
          `Section "${old.text}" (level ${old.level}, ${old.bodyEnd - old.bodyStart} line(s) under it).`,
          'Current text:', RULE, oldBody || '(empty)', RULE,
          'Would become:', RULE, newBody || '(empty)', RULE,
        ]);
        return 0;
      }
      return writePage(gl, project, page, next, `Replaced section "${old.text}" of`);
    },
  },
};

runCli(TOOL, commands, { connector: TOOL });
