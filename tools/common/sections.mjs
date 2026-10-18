// Sections of a markdown page, shared by the markdown wikis (GitHub, GitLab): the headings, the
// section under one heading, and the edits Confluence offers — replace a section's body, append a
// section. Pure: strings in, strings out, no I/O. The rules follow tools/confluence/cli.mjs so the
// connectors behave alike: a heading matches its exact text, and a section runs to the next
// heading of the same or higher level.
import { UsageError } from './cli.mjs';

/**
 * @typedef {object} Heading
 * @property {number} level 1–6, the number of `#`s.
 * @property {string} text The heading's text: trimmed, closing `#`s removed, inline markup kept.
 * @property {number} line 0-based line of the heading.
 */

/**
 * @typedef {object} Section
 * @property {number} level The heading's level.
 * @property {string} text The heading's text.
 * @property {number} headingLine 0-based line of the heading.
 * @property {number} bodyStart First line of the body (the line after the heading).
 * @property {number} bodyEnd Line after the body (exclusive): the next heading of the same or
 *   higher level, or the page's line count — a final newline does not start a line.
 */

/**
 * A heading that is missing from the page or is on it more than once. A usage error (exit code 1),
 * as Confluence reports the same case; the message lists the page's headings.
 */
export class SectionError extends UsageError {
  /**
   * @param {string} heading The heading asked for.
   * @param {number} count How many times it is on the page (0 or more than 1).
   * @param {Heading[]} pageHeadings Every heading of the page.
   */
  constructor(heading, count, pageHeadings) {
    const list = pageHeadings.length
      ? pageHeadings.map((h) => `  ${'#'.repeat(h.level)} ${h.text}`).join('\n')
      : '  (none)';
    super(`heading "${heading}" found ${count} times. Headings:\n${list}`);
    this.name = 'SectionError';
    this.heading = heading;
    this.count = count;
    this.headings = pageHeadings;
  }
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The page split into lines without their terminators; a final newline does not start a line. */
function splitLines(markdown) {
  if (markdown === '') return [];
  const lines = markdown.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (markdown.endsWith('\n')) lines.pop();
  return lines;
}

/** The line ending the page uses, read from its first line break; `\n` when it has none. */
function lineEnding(markdown) {
  const i = markdown.indexOf('\n');
  return i > 0 && markdown[i - 1] === '\r' ? '\r\n' : '\n';
}

/** The text of an ATX heading's content: the optional closing sequence and outer blanks removed. */
function headingContent(raw) {
  if (/^#+$/.test(raw)) return ''; // `## ##` — a heading with only a closing sequence.
  return raw.replace(/[ \t]+#+$/, '').trim();
}

/**
 * The number of lines of the page's YAML front matter: a first line `---` through the next `---`
 * or `...` line, both included; 0 when there is none. Without a closing line it is not front
 * matter, and the page is read as ordinary markdown.
 */
function frontMatterLines(lines) {
  if (!lines.length || !/^---[ \t]*$/.test(lines[0])) return 0;
  const close = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(l));
  return close === -1 ? 0 : close + 1;
}

/**
 * One pass over the page: its headings, its front matter's line count, and the 0-based line of a
 * code fence still open at the end (null when every fence closes).
 */
function scan(markdown) {
  const lines = splitLines(markdown);
  const frontMatter = frontMatterLines(lines);
  const found = [];
  let fence = null;
  let fenceLine = null;
  lines.forEach((line, index) => {
    if (index < frontMatter) return; // A YAML comment `# x` there is not a heading.
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return;
    }
    const open = line.match(FENCE_OPEN);
    // A backtick fence's info string cannot hold a backtick (CommonMark); such a line is inline code.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      fenceLine = index;
      return;
    }
    const atx = line.match(ATX);
    if (atx) found.push({ level: atx[1].length, text: headingContent(atx[2] ?? ''), line: index });
  });
  return { headings: found, frontMatter, openFence: fence ? fenceLine : null };
}

/**
 * The ATX headings of a markdown page (`#` to `######`, with an optional closing sequence of
 * `#`s), outside fenced code blocks and outside YAML front matter. Front matter is a first line
 * `---` through the next `---` or `...` line; without that closing line it is ordinary text. A
 * fence opens with three or more backticks or tildes and closes only with a run of the same
 * character at least as long, so a ``` inside a ```` block is code; an unclosed fence runs to the
 * end of the page. Setext headings (text underlined with `===` or `---`) are not recognised, nor
 * are headings inside block quotes or list items.
 *
 * @param {string} markdown The page.
 * @returns {Heading[]} The headings in page order.
 */
export function headings(markdown) {
  return scan(markdown).headings;
}

/**
 * The section under `heading`: its heading line and the lines of its body, which runs to the next
 * heading of the same or higher level (level <= its own) or the end of the page — so a `###` under
 * a `##` is part of the `##` section's body. The heading matches as Confluence's replace-section
 * does: the exact text, case-sensitive, after trimming the argument; a `#` prefix in the argument
 * is part of the text, not a level.
 *
 * @param {string} markdown The page.
 * @param {string} heading The heading's exact text.
 * @returns {Section} Where the section is.
 * @throws {SectionError} When the heading is not on the page, or is on it more than once.
 */
export function findSection(markdown, heading) {
  const all = headings(markdown);
  const wanted = heading.trim();
  const matches = all.filter((h) => h.text === wanted);
  if (matches.length !== 1) throw new SectionError(heading, matches.length, all);
  const own = matches[0];
  const next = all.find((h) => h.line > own.line && h.level <= own.level);
  return {
    level: own.level,
    text: own.text,
    headingLine: own.line,
    bodyStart: own.line + 1,
    bodyEnd: next ? next.line : splitLines(markdown).length,
  };
}

/** `body` with its outer blank lines removed and its line breaks written as `eol`. */
function bodyLines(body, eol) {
  const lines = body.split(/\r?\n/);
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join(eol);
}

/** Offset in `markdown` where each line starts, plus the page's length as the end. */
function lineOffsets(markdown) {
  const offsets = [0];
  for (let i = markdown.indexOf('\n'); i !== -1 && i + 1 < markdown.length; i = markdown.indexOf('\n', i + 1)) {
    offsets.push(i + 1);
  }
  offsets.push(markdown.length);
  return offsets;
}

/**
 * The page with the body under `heading` replaced by `body`, as Confluence's replace-section: the
 * heading line stays, the body (its deeper subsections included) becomes one blank line, `body`,
 * and one blank line before the next heading. The rest of the page is kept byte for byte, `body`
 * is written with the page's line ending (`\n` or `\r\n`), and the page keeps or lacks its final
 * newline as before. An empty `body` leaves the heading with an empty section.
 *
 * @param {string} markdown The page.
 * @param {string} heading The heading's exact text (matched as in {@link findSection}).
 * @param {string} body The new body, markdown; its outer blank lines are dropped.
 * @returns {string} The new page.
 * @throws {SectionError} When the heading is not on the page, or is on it more than once.
 */
export function replaceSection(markdown, heading, body) {
  const section = findSection(markdown, heading);
  const eol = lineEnding(markdown);
  const offsets = lineOffsets(markdown);
  const before = markdown.slice(0, offsets[section.headingLine]);
  const headingLine = markdown.slice(offsets[section.headingLine], offsets[section.bodyStart]).replace(/\r?\n$/, '');
  const text = bodyLines(body, eol);
  const atEnd = section.bodyEnd === offsets.length - 1;
  if (atEnd) {
    const finalNewline = markdown.endsWith('\n') ? eol : '';
    return `${before}${headingLine}${text ? `${eol}${eol}${text}` : ''}${finalNewline}`;
  }
  const middle = text ? `${eol}${eol}${text}${eol}${eol}` : `${eol}${eol}`;
  return `${before}${headingLine}${middle}${markdown.slice(offsets[section.bodyEnd])}`;
}

/**
 * The page with `body` added as a new section, as Confluence's append: after one blank line at the
 * end of the page, or with `atStart` before its content — after the YAML front matter, which stays
 * first — under a heading of `level` when `heading` is given. Trailing blank lines of the page
 * (leading ones of the content with `atStart`) collapse into that one blank line; everything else,
 * front matter included, is kept byte for byte. The page's line ending and final newline are kept;
 * an empty page gets a final newline. A page that ends inside an unclosed code fence is refused at
 * the end — the section would land in the code block.
 *
 * @param {string} markdown The page.
 * @param {string} body The section's body, markdown; its outer blank lines are dropped.
 * @param {{ heading?: string, level?: number, atStart?: boolean }} [options] The new section's
 *   heading (none by default) and its level (2, as Confluence's --heading-level), and whether it
 *   goes at the start of the page.
 * @returns {string} The new page.
 * @throws {UsageError} When there is nothing to add, the heading spans lines, the level is not
 *   1–6, or the section would go at the end of a page that ends inside an unclosed code fence.
 */
export function appendToPage(markdown, body, { heading, level = 2, atStart = false } = {}) {
  const eol = lineEnding(markdown);
  if (!Number.isInteger(level) || level < 1 || level > 6) throw new UsageError(`heading level must be 1 to 6, got ${level}`);
  const title = heading?.trim();
  if (title && /[\r\n]/.test(title)) throw new UsageError(`a heading is one line, got ${JSON.stringify(heading)}`);
  const text = bodyLines(body, eol);
  if (!text && !title) throw new UsageError('nothing to append: the body is empty and there is no heading');
  const section = [title ? `${'#'.repeat(level)} ${title}` : null, text || null].filter((p) => p !== null).join(`${eol}${eol}`);
  const finalNewline = markdown === '' || markdown.endsWith('\n');
  const { frontMatter, openFence } = scan(markdown);
  if (atStart) {
    const split = lineOffsets(markdown)[frontMatter];
    let head = markdown.slice(0, split);
    if (head && !head.endsWith('\n')) head += eol; // The page is only front matter, without a newline.
    const rest = markdown.slice(split).replace(/^(?:[ \t]*\r?\n)+/, '');
    if (!rest.trim()) return `${head}${section}${finalNewline ? eol : ''}`;
    return `${head}${section}${eol}${eol}${rest}`;
  }
  if (openFence !== null) {
    // 1-based in the message: the number an editor shows.
    throw new UsageError(`the page ends inside an unclosed code fence opened on line ${openFence + 1}; fix the page first`);
  }
  const kept = markdown.replace(/(?:\r?\n[ \t]*)+$/, '');
  return `${kept ? `${kept}${eol}${eol}` : ''}${section}${finalNewline ? eol : ''}`;
}
