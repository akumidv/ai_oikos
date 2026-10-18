// The pages of a GitHub wiki as files of its git repository: which file a page name, a file name or
// a wiki URL means, a page's title and format, and the search over a clone's pages. Pure: names and
// texts in, results out; the git side is tools/common/gitwiki.mjs.
import { UsageError } from '../common/cli.mjs';

/**
 * The file extensions GitHub renders as wiki pages (its markup formats, unverified until checked
 * live); `md` is the one this tool writes, every other one is read as raw text.
 */
export const PAGE_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkdn', 'mkd', 'textile', 'rdoc', 'org', 'creole',
  'mediawiki', 'wiki', 'rst', 'asciidoc', 'adoc', 'asc', 'pod'];

/** The one extension a page is written in. */
export const WRITABLE_EXTENSION = 'md';

/**
 * @typedef {object} PageRef What `--page` names.
 * @property {string} stem The file name without extension (`Page-Name`, `Home`, `_Sidebar`).
 * @property {string|null} file The exact file name when one was given (`Page-Name.textile`).
 * @property {string|null} repo `owner/repo` when the page was given as a wiki URL.
 */

/** The extension of `file` (lower case, without the dot), or '' when it has none GitHub renders. */
export function pageExtension(file) {
  const m = String(file).match(/\.([A-Za-z]+)$/);
  return m && PAGE_EXTENSIONS.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : '';
}

const baseName = (file) => file.split('/').pop();
const stemOf = (file) => {
  const name = baseName(file);
  return pageExtension(name) ? name.replace(/\.[A-Za-z]+$/, '') : name;
};

/** A page's title from its file: the name without extension, `-` read as a space. */
export const pageTitle = (file) => stemOf(file).replace(/-/g, ' ');

/** The file stem of a page name: blanks become `-`, as GitHub names the file of a new page. */
function stemOfName(name) {
  const stem = name.trim().replace(/\s+/g, '-');
  if (!stem || /[/\\]/.test(stem) || stem.startsWith('.')) {
    throw new UsageError(`not a wiki page name: ${JSON.stringify(name)} (the wiki is flat: no /, \\ or leading dot)`);
  }
  return stem;
}

/**
 * What `--page` names: a wiki URL (`<server>/<owner>/<repo>/wiki/Page-Name`; `/wiki` alone is
 * Home), a file name with a page extension (`Page-Name.md`), or a page name (`Page Name`).
 *
 * @param {string} raw
 * @returns {PageRef}
 */
export function pageRef(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new UsageError('--page is required (a page name, its file name, or its wiki URL)');
  const url = value.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/wiki(?:\/([^?#]*))?\/?(?:[?#].*)?$/);
  if (url) {
    const segment = url[3] ? decodeURIComponent(url[3]).replace(/\/+$/, '') : '';
    return { stem: segment ? stemOfName(segment) : 'Home', file: null, repo: `${url[1]}/${url[2]}` };
  }
  if (/^https?:\/\//.test(value)) throw new UsageError(`not a wiki page URL (expected <server>/<owner>/<repo>/wiki/Page-Name): ${value}`);
  if (pageExtension(value)) {
    const file = baseName(stemOfName(value));
    return { stem: stemOf(file), file, repo: null };
  }
  return { stem: stemOfName(value), file: null, repo: null };
}

/**
 * The file of the page `ref` among the repository's `files`, or null when there is none: the
 * exact file name, or a page file of that stem; an exact match first, then ignoring case. A page
 * in a subfolder is still one page of the flat wiki, matched by its own name.
 *
 * @param {string[]} files Repository-relative paths.
 * @param {PageRef} ref
 * @returns {string|null}
 * @throws {UsageError} When the name matches several files.
 */
export function findPageFile(files, ref) {
  const pages = files.filter((f) => pageExtension(f));
  const pick = (same) => {
    const hits = pages.filter((f) => (ref.file ? same(baseName(f), ref.file) : same(stemOf(f), ref.stem)));
    if (hits.length > 1) throw new UsageError(`"${ref.file || ref.stem}" matches several files: ${hits.join(', ')}; pass the file name`);
    return hits[0] ?? null;
  };
  return pick((a, b) => a === b) ?? pick((a, b) => a.toLowerCase() === b.toLowerCase());
}

/**
 * @typedef {object} TextHit
 * @property {string} file
 * @property {number} line 1-based.
 * @property {string} text The matching line.
 * @property {string|null} before The line before, or null at the start.
 * @property {string|null} after The line after, or null at the end.
 */

/**
 * @typedef {object} SearchResult
 * @property {string[]} titles Files whose title contains the title text.
 * @property {TextHit[]} hits Lines that contain the query text.
 * @property {number} more How many matches beyond `limit` were left out.
 */

/**
 * Search `pages` the way the wiki's own search box would, since GitHub search does not index wiki
 * repositories (unverified until checked live): `title` against each page's title (and file name),
 * `query` against every line; both ignore case. At most `limit` titles and `limit` lines.
 *
 * @param {{ file: string, text: string }[]} pages
 * @param {{ title?: string, query?: string, limit?: number }} options
 * @returns {SearchResult}
 */
export function searchPages(pages, { title, query, limit = 25 } = {}) {
  let more = 0;
  const titles = [];
  if (title) {
    const t = title.toLowerCase();
    for (const p of pages) {
      if (!pageTitle(p.file).toLowerCase().includes(t) && !baseName(p.file).toLowerCase().includes(t)) continue;
      if (titles.length < limit) titles.push(p.file); else more += 1;
    }
  }
  const hits = [];
  if (query) {
    const q = query.toLowerCase();
    for (const p of pages) {
      const lines = p.text.split(/\r?\n/);
      lines.forEach((text, i) => {
        if (!text.toLowerCase().includes(q)) return;
        if (hits.length >= limit) { more += 1; return; }
        hits.push({ file: p.file, line: i + 1, text, before: i > 0 ? lines[i - 1] : null, after: i + 1 < lines.length ? lines[i + 1] : null });
      });
    }
  }
  return { titles, hits, more };
}
