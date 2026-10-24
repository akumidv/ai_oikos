#!/usr/bin/env node
// GitHub wiki: find, read, create and edit pages (whoami, search, read, info, create, append,
// replace-section). The wiki has no REST API, so every command works on a clone of
// `<repo>.wiki.git` that exists only while the command runs (tools/common/gitwiki.mjs). Pages are
// flat files (`Page-Name.md`, `Home.md`, `_Sidebar.md`); markdown pages are written, other formats
// only read. Every write has --dry-run, commits as the token owner's noreply identity and pushes
// without force.
import { readFileSync } from 'node:fs';
import { runCli, printJson, UsageError } from '../common/cli.mjs';
import { guardOutgoing, outgoingRules } from '../common/outgoing.mjs';
import { envValue } from '../common/env.mjs';
import { githubClient, githubToken, repoName } from '../common/github.mjs';
import { appendToPage, findSection, replaceSection } from '../common/sections.mjs';
import { noreplyIdentity, wikiCloneUrl, wikiWebUrl, withWikiClone } from '../common/gitwiki.mjs';
import { WRITABLE_EXTENSION, findPageFile, pageExtension, pageRef, pageTitle, searchPages } from './pages.mjs';

const TOOL = 'github-wiki';
const RULE = '-'.repeat(40);
/** The lines of a page shown around an appended section in a dry run. */
const CONTEXT_LINES = 10;

// The wiki is written over git: the token must reach wiki git with write access (TV).
const WRITE_HELP = [
  '  Token: a classic token with the `repo` scope reaches wiki git (read and push): https://github.com/settings/tokens',
  '  A fine-grained token (Contents read/write) may not reach wiki git — unverified until checked live.',
  '  Or log in once with `gh auth login`.',
];

/**
 * The connection for a command: the token (for git), the REST client (for the token owner and the
 * repository) and the context error messages name. A missing credential is a usage error naming
 * the key, raised before any request.
 */
function connect(repo) {
  const token = githubToken({ help: WRITE_HELP });
  const gh = githubClient(TOOL, { help: WRITE_HELP });
  return { token: token.value, gh, repo, context: { repo, serverUrl: gh.serverUrl, route: token.route } };
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/**
 * The main repository whose wiki is meant: the one of a wiki URL in --page, else --repo
 * (`owner/repo`, or `repo` under GITHUB_ORG), else GITHUB_WIKI_REPO, else GITHUB_REPO.
 */
function wikiRepo(v, ref) {
  const given = v.repo ? repoName(v.repo) : null;
  let repo = given;
  if (ref?.repo) {
    if (given && given.toLowerCase() !== ref.repo.toLowerCase()) throw new UsageError(`--repo ${given} and the page URL's repository ${ref.repo} differ`);
    repo = ref.repo;
  }
  if (!repo) {
    const setting = envValue('GITHUB_WIKI_REPO') || envValue('GITHUB_REPO');
    if (!setting) throw new UsageError('no repository: pass --repo owner/repo, or set GITHUB_WIKI_REPO (or GITHUB_REPO with GITHUB_ORG) in oikos.yaml settings');
    repo = repoName(setting);
  }
  if (!REPO.test(repo) || /\/\.\.?$/.test(repo)) throw new UsageError(`not a repository name (owner/repo): ${repo}`);
  return repo;
}

/** Clone the wiki of `conn.repo` for the duration of `work`. */
function cloned(conn, work, { history = false } = {}) {
  return withWikiClone(wikiCloneUrl(conn.gh.serverUrl, conn.repo), { token: conn.token, context: conn.context, history }, work);
}

/** The page files of a clone with their text. */
async function pagesOf(clone) {
  return (await clone.files()).filter((f) => pageExtension(f)).map((file) => ({ file, text: clone.read(file) }));
}

/** The file of `ref` in `clone`; a usage error listing the pages when there is none. */
async function existingPage(clone, ref, repo) {
  const files = await clone.files();
  const file = findPageFile(files, ref);
  if (file) return file;
  const pages = files.filter((f) => pageExtension(f)).map((f) => `  ${f}`);
  throw new UsageError(`no page "${ref.file || ref.stem}" in the wiki of ${repo}. Pages:\n${pages.join('\n') || '  (none)'}`);
}

const short = (sha) => (sha ? sha.slice(0, 7) : '(none)');
const stemOfFile = (file) => file.split('/').pop().replace(/\.[A-Za-z]+$/, '');

function bodyText(v) {
  const text = v.file ? readFileSync(v.file, 'utf8') : v.text;
  if (!text) throw new UsageError('--text or --file is required (markdown)');
  return text;
}

/** The content check (common/outgoing.mjs) of a write's texts, its --version-message included. */
function checkContent(v, texts) {
  guardOutgoing([...texts, { label: 'version message', text: v['version-message'] }], v, outgoingRules());
}

/** The repositories GITHUB_PUBLIC_REPOS allows writes to, lower case. */
const publicAllowed = () => new Set((envValue('GITHUB_PUBLIC_REPOS') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

/**
 * The checks of a write before the clone: the repository (its visibility, whether its wiki is
 * on) and the commit identity. A public repository not listed in GITHUB_PUBLIC_REPOS is refused:
 * the refusal is printed and the exit code (3) returned; otherwise { public, identity }.
 */
async function writeTarget(conn) {
  const { data: repo } = await conn.gh.api(`/repos/${conn.repo}`);
  if (repo.has_wiki === false) throw new UsageError(`the wiki is turned off for ${conn.repo} — a person turns it on under Settings → Features → Wikis: ${conn.gh.serverUrl}/${conn.repo}/settings`);
  const isPublic = repo.private === false || repo.visibility === 'public';
  if (isPublic && !publicAllowed().has(conn.repo.toLowerCase())) {
    console.error(`refused: PUBLIC repository ${conn.repo} — everything written to its wiki is visible to anyone. `
      + 'To allow writes, a person lists it in the setting GITHUB_PUBLIC_REPOS (comma separated owner/repo) in oikos.yaml.');
    return 3;
  }
  const { data: user } = await conn.gh.api('/user');
  return { public: isPublic, identity: noreplyIdentity(user) };
}

/**
 * @typedef {object} PageChange What a write does to one page.
 * @property {string} file The page's file.
 * @property {string|null} current The page's text now, null for a new page.
 * @property {string} next The page's text after the write.
 * @property {string[]} preview The dry run's lines about the page's current and new text.
 * @property {string} message The commit message.
 */

/**
 * The frame every write shares: the checks, a clone, the change `plan` computes on it, and then a
 * dry run (printed, nothing pushed) or the commit and the push. `plan` returns a PageChange, or an
 * exit code when it refused (and printed why).
 *
 * @param {object} v The command's values.
 * @param {string} repo
 * @param {(clone: import('../common/gitwiki.mjs').WikiClone) => Promise<PageChange|number>} plan
 */
async function writePage(v, repo, plan) {
  const conn = connect(repo);
  const target = await writeTarget(conn);
  if (typeof target === 'number') return target;
  return cloned(conn, async (clone) => {
    const change = await plan(clone);
    if (typeof change === 'number') return change;
    const base = await clone.head();
    const branch = await clone.branch();
    const stem = stemOfFile(change.file);
    const url = wikiWebUrl(conn.gh.serverUrl, repo, stem);
    if (v['dry-run']) {
      console.log('--- DRY RUN (requested --dry-run) ---');
      if (target.public) console.log(`PUBLIC repository ${repo} — everything written is visible to anyone`);
      console.log(`Repository: ${repo} (wiki ${wikiCloneUrl(conn.gh.serverUrl, repo)}, branch ${branch})`);
      console.log(`Page: ${pageTitle(change.file)} (${change.file}${change.current === null ? ', new' : ''}) — base commit ${short(base)}`);
      for (const line of change.preview) console.log(line);
      if (change.current === change.next) console.log('(no change: the page already reads so — the write would commit nothing)');
      console.log(`Commit: "${change.message}" as ${target.identity.name} <${target.identity.email}>, pushed to ${branch} without force`);
      console.log('DRY RUN — nothing written to the GitHub wiki.');
      return 0;
    }
    if (change.current === change.next) {
      console.log(`No change: "${pageTitle(change.file)}" already reads so; nothing committed: ${url}`);
      return 0;
    }
    const sha = await clone.commit(change.next, change.file, { identity: target.identity, message: change.message });
    await clone.push();
    console.log(`${change.current === null ? 'Created' : 'Updated'} "${pageTitle(change.file)}" in the wiki of ${repo} (commit ${short(sha)} on ${branch}, base ${short(base)}): ${url}`);
    return 0;
  });
}

/** The refusal of a write to a page that is not markdown: printed, exit code 3. */
function notMarkdown(file, repo, serverUrl) {
  console.error(`refused: ${file} is a ${pageExtension(file)} page, not markdown — this tool writes only .${WRITABLE_EXTENSION} pages; `
    + `a person edits it in the web interface: ${wikiWebUrl(serverUrl, repo, stemOfFile(file))}`);
  return 3;
}

/** `text`'s last (or with `atStart` first) lines, with a note of what was left out. */
function pageContext(text, atStart) {
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length <= CONTEXT_LINES) return lines;
  const cut = `… (${lines.length - CONTEXT_LINES} more line(s) not shown)`;
  return atStart ? [...lines.slice(0, CONTEXT_LINES), cut] : [cut, ...lines.slice(-CONTEXT_LINES)];
}

const withNewline = (text) => (text.endsWith('\n') ? text : `${text}\n`);

const pageOptions = { page: { type: 'string' }, repo: { type: 'string' } };
const writeOptions = { 'version-message': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'allow-non-english': { type: 'boolean' }, 'allow-flagged': { type: 'boolean' } };

const commands = {
  whoami: {
    help: 'the token owner and the commit identity wiki writes use (login, noreply address), the credential route',
    options: {},
    async run(v) {
      const token = githubToken({ help: WRITE_HELP });
      const gh = githubClient(TOOL, { help: WRITE_HELP });
      const r = await gh.api('/user');
      if (v.json) return printJson(r.data);
      const identity = noreplyIdentity(r.data);
      const scopes = r.headers.get('x-oauth-scopes');
      console.log(`Login: ${r.data.login} (id ${r.data.id})${r.data.name ? ` — ${r.data.name}` : ''}`);
      console.log(`Commit identity: ${identity.name} <${identity.email}>`);
      console.log(`Route: ${token.route}`);
      console.log(`Scopes: ${scopes === null ? 'not exposed (a fine-grained token or the gh login: the wiki access shows on the first clone)' : scopes || '(none)'}`);
    },
  },

  search: {
    help: 'find pages by title and/or full text in the wiki (--title text | --query text, --repo, --limit) — GitHub search does not index wikis, so the tool searches its clone',
    options: { title: { type: 'string' }, query: { type: 'string' }, repo: { type: 'string' }, limit: { type: 'string' }, mine: { type: 'boolean' } },
    async run(v) {
      if (v.mine) throw new UsageError('search --mine is not offered by the github-wiki connector; a page\'s history on GitHub (Page history) shows who edited it');
      if (!v.title && !v.query) throw new UsageError('--title or --query is required');
      const limit = Number(v.limit || 25);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive number, got ${v.limit}`);
      const repo = wikiRepo(v);
      const conn = connect(repo);
      return cloned(conn, async (clone) => {
        const result = searchPages(await pagesOf(clone), { title: v.title, query: v.query, limit });
        if (v.json) return printJson(result);
        if (v.title) {
          console.log(`Titles matching "${v.title}":`);
          for (const f of result.titles) console.log(`  ${f.padEnd(32)} ${pageTitle(f)}`);
          if (!result.titles.length) console.log('  (none)');
        }
        if (v.query) {
          console.log(`Lines containing "${v.query}":`);
          for (const h of result.hits) {
            if (h.before !== null) console.log(`  ${h.file}-${h.line - 1}- ${h.before.slice(0, 160)}`);
            console.log(`  ${h.file}:${h.line}: ${h.text.slice(0, 160)}`);
            if (h.after !== null) console.log(`  ${h.file}-${h.line + 1}- ${h.after.slice(0, 160)}`);
          }
          if (!result.hits.length) console.log('  (none)');
        }
        console.log(`${result.titles.length} title(s), ${result.hits.length} line(s) in the wiki of ${repo}${result.more ? ` … ${result.more} more not shown (raise --limit)` : ''}`);
        return 0;
      });
    },
  },

  read: {
    help: 'the current text of one page (--page "Page Name"|File.md|wiki URL, --repo) — other formats than markdown as raw text',
    options: { ...pageOptions },
    async run(v) {
      const ref = pageRef(v.page);
      const repo = wikiRepo(v, ref);
      const conn = connect(repo);
      return cloned(conn, async (clone) => {
        const file = await existingPage(clone, ref, repo);
        const text = clone.read(file);
        const head = await clone.head();
        const url = wikiWebUrl(conn.gh.serverUrl, repo, stemOfFile(file));
        if (v.json) return printJson({ repo, file, title: pageTitle(file), head, url, text });
        const format = pageExtension(file) === WRITABLE_EXTENSION ? '' : `, ${pageExtension(file)} shown as raw text`;
        console.log(`# ${pageTitle(file)}\n(${file}, wiki commit ${short(head)}${format}, ${url})\n\n${text.trim() || '(empty page)'}`);
        return 0;
      });
    },
  },

  info: {
    help: 'page, file, format, the last commit touching it and the URL (--page, --repo) — run before every write',
    options: { ...pageOptions },
    async run(v) {
      const ref = pageRef(v.page);
      const repo = wikiRepo(v, ref);
      const conn = connect(repo);
      // The page's last commit needs the history, which a shallow clone lacks.
      return cloned(conn, async (clone) => {
        const file = await existingPage(clone, ref, repo);
        const last = await clone.lastCommit(file);
        const head = await clone.head();
        const url = wikiWebUrl(conn.gh.serverUrl, repo, stemOfFile(file));
        const format = pageExtension(file);
        if (v.json) return printJson({ repo, file, title: pageTitle(file), format, writable: format === WRITABLE_EXTENSION, lastCommit: last, head, url });
        console.log(`Page: ${pageTitle(file)}\nFile: ${file} (${format === WRITABLE_EXTENSION ? 'markdown' : `${format}, read only here`})`);
        console.log(`Last change: ${last ? `${short(last.sha)} ${last.date} by ${last.author}` : '(unknown)'}\nWiki head: ${short(head)}`);
        console.log(`Repository: ${repo}\nURL: ${url}`);
        return 0;
      }, { history: true });
    },
  },

  create: {
    help: 'create a page (--title "Page Name", --repo, --text|--file markdown, --version-message, --dry-run) — refused when it exists; the wiki is flat, so no --parent',
    options: {
      title: { type: 'string' }, repo: { type: 'string' }, parent: { type: 'string' },
      text: { type: 'string' }, file: { type: 'string' }, ...writeOptions,
    },
    async run(v) {
      if (v.parent) throw new UsageError('the GitHub wiki is flat: a page has no parent. Link the new page from another page or from _Sidebar instead.');
      if (!v.title) throw new UsageError('--title is required (the page name)');
      const ref = pageRef(v.title);
      if (ref.repo) throw new UsageError('--title is the new page name, not a URL');
      const text = bodyText(v);
      checkContent(v, [{ label: 'title', text: v.title }, { label: 'page', text }]);
      const repo = wikiRepo(v);
      const file = ref.file || `${ref.stem}.${WRITABLE_EXTENSION}`;
      return writePage(v, repo, async (clone) => {
        if (pageExtension(file) !== WRITABLE_EXTENSION) return notMarkdown(file, repo, clone.context.serverUrl);
        const existing = findPageFile(await clone.files(), { stem: ref.stem, file: null, repo: null });
        if (existing) throw new UsageError(`the page "${pageTitle(existing)}" already exists (${existing}); edit it with append or replace-section instead`);
        const next = withNewline(text);
        return {
          file, current: null, next,
          preview: ['New page text:', RULE, next.replace(/\n$/, ''), RULE],
          message: v['version-message'] || `Create ${pageTitle(file)} (oikos)`,
        };
      });
    },
  },

  append: {
    help: 'append a markdown section (--page, --repo, --heading, --heading-level, --text|--file, --at-start, --version-message, --dry-run)',
    options: {
      ...pageOptions, heading: { type: 'string' }, 'heading-level': { type: 'string' },
      text: { type: 'string' }, file: { type: 'string' }, 'at-start': { type: 'boolean' }, ...writeOptions,
    },
    async run(v) {
      const ref = pageRef(v.page);
      const text = bodyText(v);
      checkContent(v, [{ label: 'heading', text: v.heading }, { label: 'section', text }]);
      const level = Number(v['heading-level'] || 2);
      const repo = wikiRepo(v, ref);
      return writePage(v, repo, async (clone) => {
        const file = await existingPage(clone, ref, repo);
        if (pageExtension(file) !== WRITABLE_EXTENSION) return notMarkdown(file, repo, clone.context.serverUrl);
        const current = clone.read(file);
        const next = appendToPage(current, text, { heading: v.heading, level, atStart: Boolean(v['at-start']) });
        const section = `${v.heading ? `${'#'.repeat(level)} ${v.heading.trim()}\n\n` : ''}${text.trim()}`;
        const where = v['at-start'] ? 'start' : 'end';
        return {
          file, current, next,
          preview: [`Current ${where} of the page:`, RULE, ...pageContext(current, v['at-start']), RULE,
            `Section that WOULD be inserted at the ${where} of the page:`, RULE, section, RULE],
          message: v['version-message'] || `Update ${pageTitle(file)} (oikos)`,
        };
      });
    },
  },

  'replace-section': {
    help: 'replace the body under an existing heading, up to the next heading of the same or higher level (--page, --repo, --heading, --text|--file, --version-message, --dry-run)',
    options: { ...pageOptions, heading: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, ...writeOptions },
    async run(v) {
      const ref = pageRef(v.page);
      if (!v.heading) throw new UsageError('--heading is required (the exact heading text)');
      const text = bodyText(v);
      checkContent(v, [{ label: 'section', text }]);
      const repo = wikiRepo(v, ref);
      return writePage(v, repo, async (clone) => {
        const file = await existingPage(clone, ref, repo);
        if (pageExtension(file) !== WRITABLE_EXTENSION) return notMarkdown(file, repo, clone.context.serverUrl);
        const current = clone.read(file);
        const section = findSection(current, v.heading);
        const lines = current.split(/\r?\n/);
        const old = lines.slice(section.bodyStart, section.bodyEnd).join('\n').trim();
        const next = replaceSection(current, v.heading, text);
        return {
          file, current, next,
          preview: [`Section "${section.text}" (level ${section.level}, ${section.bodyEnd - section.bodyStart} line(s)). Current text:`, RULE, old || '(empty)', RULE,
            'Would become:', RULE, text.trim(), RULE],
          message: v['version-message'] || `Update ${pageTitle(file)} (oikos)`,
        };
      });
    },
  },
};

runCli(TOOL, commands, { connector: TOOL });
