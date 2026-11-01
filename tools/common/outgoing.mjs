// The one check of the text a tool writes into the organization's systems (ADR 0003): a title, a
// body, a heading, a move's comment, a --file's content, an image's name and alt text, a text
// attachment. `outgoingFindings` judges one text by fixed patterns, pure; `guardOutgoing` is the
// call each write command makes, in its dry run and its real run alike: the dry run shows each
// flagged line, the real run refuses what is not overridden. The rules — the built-in patterns
// plus the installation's own words in `.local/outgoing.yaml` — are read once, at the command,
// by `outgoingRules`, and passed down.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import YAML from 'yaml';
import { GuardRefusal, UsageError } from './cli.mjs';
import { installRoot } from './paths.mjs';
import { config } from './config.mjs';
import { IMAGE_LINE } from './adf.mjs';
import { linkedTerms } from './outgoing-terms.mjs';

/** The installation's file of words to keep out (`terms:`) and lines to let pass (`allow:`). */
export const OUTGOING_FILE = '.local/outgoing.yaml';

/**
 * The shortest `allow:` entry that counts. A shorter one would let through every line that holds a
 * common word, so it is a problem and is ignored.
 */
export const MIN_ALLOW_LENGTH = 8;

/**
 * The categories, in the order the check reports them. `executable` is on only where the rules name
 * kinds to refuse (`refuse`, a vault note: ADR 0007 D04); every other check has the five before it.
 */
export const CATEGORIES = Object.freeze(['language', 'assistant', 'path', 'secret', 'term', 'executable']);

/**
 * The start of a remote address: `http:` or `https:` with any slashes after it, or a scheme-relative `//` —
 * a browser reads a backslash in such a URL as a slash (`https:\\host`, `https:/\host`, `\\host`).
 */
const REMOTE = String.raw`(?:https?:[/\\]*|[/\\]{2})`;
/** The elements whose attributes fetch (an anchor's `href` is a link, not a fetch, and is not here). */
const FETCHING_TAGS = 'img|video|audio|source|embed|object|link|input|track|image|feimage|use|frame|table|thead|tbody|tfoot|tr|td|th|body|form|button';
const FETCHING_ATTRIBUTES = 'src|href|data|poster|background|formaction|action';

/** `text` with its CSS escapes decoded (`\75 rl` is `url`), and for each decoded character the index it started at in `text`. */
function decodeCssEscapes(text) {
  let decoded = '';
  const starts = [];
  const escape = /\\(?:([0-9a-f]{1,6})[ \t\n\f]?|([^\n]))/gi;
  let from = 0;
  const push = (chunk, at) => { for (let i = 0; i < chunk.length; i++) starts.push(at + i); decoded += chunk; };
  for (const m of text.matchAll(escape)) {
    push(text.slice(from, m.index), from);
    const code = m[1] ? parseInt(m[1], 16) : 0;
    const valid = m[1] && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    push(m[1] ? (valid ? String.fromCodePoint(code) : '�') : m[2], m.index);
    from = m.index + m[0].length;
  }
  push(text.slice(from), from);
  return { decoded, starts };
}

const CSS_FETCHES = [
  new RegExp(String.raw`\burl\(\s*["']?\s*${REMOTE}`, 'i'),
  new RegExp(String.raw`\bimage-set\(\s*["']?\s*${REMOTE}`, 'i'),
  new RegExp(String.raw`@import\s+["']?\s*${REMOTE}`, 'i'),
];

/** The indexes in `text` of CSS that fetches a remote address, read as written and with its CSS escapes decoded. */
function remoteCss(text) {
  const { decoded, starts } = decodeCssEscapes(text);
  const found = new Set();
  for (const pattern of CSS_FETCHES) {
    const global = new RegExp(pattern.source, 'gi');
    for (const m of text.matchAll(global)) found.add(m.index);
    for (const m of decoded.matchAll(global)) found.add(starts[m.index]);
  }
  return [...found];
}

/**
 * The kinds of executable or fetching content a note may carry that Obsidian runs or fetches outside every
 * guard, each with what shows it (ADR 0007 D04, D-A9-NOTE-EXEC). A kind a vault's `wiki.rules` allows is
 * left out of `rules.refuse`; an `allow:` entry of `.local/outgoing.yaml` does not lift it. A pattern is
 * matched over the whole text, not line by line (an HTML tag may span lines), and reports the line its match
 * starts on; a function takes the whole text and returns the indexes of its matches.
 */
export const EXECUTABLE_KINDS = Object.freeze({
  dataviewjs: [/\bdataviewjs\b/i],
  'inline-js': [/`[ \t]*\$=/],
  'template-tag': [/<%/],
  script: [/<\s*script\b/i, /\bjavascript[ \t]*:/i],
  iframe: [/<\s*iframe\b/i],
  'remote-embed': [
    // ![alt](https://…) and ![[https://…]]
    new RegExp(String.raw`!\[[^\]]*\]\(\s*<?\s*${REMOTE}`, 'i'),
    new RegExp(String.raw`!\[\[\s*${REMOTE}`, 'i'),
    // an element that fetches: its src, href, data, poster, background or action is a remote address
    new RegExp(String.raw`<\s*(?:${FETCHING_TAGS})\b[^>]*?\b(?:${FETCHING_ATTRIBUTES})\s*=\s*["']?\s*${REMOTE}`, 'i'),
    // srcset: a list of `address descriptor` entries, any of them remote
    new RegExp(String.raw`<\s*(?:img|source|link)\b[^>]*?\b(?:image)?srcset\s*=\s*["']?(?:[^"'>,]*,)*\s*${REMOTE}`, 'i'),
    // CSS that fetches: url(), image-set(), @import — also with the escapes CSS allows in a name (`\75 rl(`)
    remoteCss,
    // ![alt][ref], ![ref][] or ![ref], whose definition `[ref]: https://…` is remote
    remoteReferenceImages,
    // an address a browser reads as remote after dropping the tab and line breaks it ignores inside a URL
    remoteAcrossBreaks,
  ],
});

const STARTS_REMOTE = new RegExp(String.raw`^\s*<?\s*${REMOTE}`, 'i');
const FETCHING_TAG = new RegExp(String.raw`<\s*(?:${FETCHING_TAGS})\b[^>]*>`, 'gi');
const FETCHING_VALUE = new RegExp(String.raw`\b(?:${FETCHING_ATTRIBUTES})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`, 'gi');
const MARKDOWN_TARGETS = [/!\[[^\]]*\]\(([^)]{0,200})/g, /!\[\[([^\]]{0,200})/g];

/** Whether the address `value` is remote once a browser has dropped the tab and line breaks it ignores inside a URL. */
const remoteWithoutBreaks = (value) => STARTS_REMOTE.test(value.replace(/[\t\n\r]/g, ''));

/**
 * The indexes in `raw` of an element or a Markdown image whose address is remote only once the ASCII tab,
 * LF and CR inside it are removed (`ht<TAB>tps://…`, `/<TAB>/host`, a line break inside the value) — which a
 * browser does and the other patterns, matching blanks as one space, do not see. `raw` is the text with its
 * blanks kept; the index is that of the element or image, so its line is the one it starts on.
 */
function remoteAcrossBreaks(raw) {
  const found = [];
  for (const tag of raw.matchAll(FETCHING_TAG)) {
    for (const m of tag[0].matchAll(FETCHING_VALUE)) {
      if (remoteWithoutBreaks(m[1] ?? m[2] ?? m[3])) found.push(tag.index);
    }
  }
  for (const pattern of MARKDOWN_TARGETS) {
    for (const m of raw.matchAll(pattern)) if (remoteWithoutBreaks(m[1])) found.push(m.index);
  }
  return found;
}
/** Runs on the text with its blanks kept, not on the views that collapse them. */
remoteAcrossBreaks.raw = true;

/** The label of a reference as Markdown compares it: blanks collapsed, ignoring case. */
const referenceLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();

/** The indexes of the images in `text` that use a reference whose definition (`[ref]: address`) is remote. */
function remoteReferenceImages(text) {
  const remote = new Set([...text.matchAll(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*\n?[ \t]*<?\s*(?:https?:[/\\]*|[/\\]{2})/gim)].map((m) => referenceLabel(m[1])));
  if (!remote.size) return [];
  return [...text.matchAll(/!\[([^[\]]*)\](?:\[([^[\]]*)\])?(?!\()/g)]
    .filter((m) => remote.has(referenceLabel(m[2] || m[1])))
    .map((m) => m.index);
}

/** The indexes in `text` where `pattern` (a RegExp, or a function of the whole text) matches. */
const matchIndexes = (pattern, text) => (typeof pattern === 'function'
  ? pattern(text)
  : [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map((m) => m.index));

// Most specific first: a line's finding of a category names the first pattern that matches it.
const PATTERNS = Object.freeze({
  assistant: [
    /OIKOS_HOME/i, /\bnode oikos\/tools\//i, /\boikos\.yaml\b/i, /\bOIKOS\.md\b/i, /\boikos\b/i,
    // Skill names are ordinary words (wiki, documents): only their path form counts.
    /\bskills\/[a-z][a-z0-9-]*\//i, /\bSKILL\.md\b/i,
  ],
  path: [
    /\/home\/[^/\s]+\//i, /\/Users\/[^/\s]+\//i, /\bC:\\Users\\/i, /\/mnt\/[a-z]\/Users\//i, /\\\\wsl\$/i,
    /\/tmp\//i, /scratchpad/i, /\.local\//i, /file:\/\//i,
  ],
  // Case-sensitive: the providers' prefixes are, and a token's body follows its prefix. A fixed-length
  // token has no closing boundary: one followed by more characters is still a token.
  secret: [
    /\bgh[pousr]_[A-Za-z0-9]{36}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bglpat-[A-Za-z0-9_-]{20,}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bATATT[A-Za-z0-9_=-]{20,}/, /\bAKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  ],
});

// Every match of every secret pattern on a line, not only the first: the allow: rule and the masking need all.
const GLOBAL_SECRETS = PATTERNS.secret.map((pattern) => new RegExp(pattern.source, 'g'));

/**
 * @typedef {object} OutgoingRules
 * @property {string[]} terms fixed strings to keep out (category `term`), matched ignoring case
 * @property {string[]} allow literal strings of at least MIN_ALLOW_LENGTH characters: a finding on a line that
 *   contains one is dropped, except a `secret` finding, dropped only by an entry that contains the matched
 *   secret text itself (D-ALLOW-SECRET), and an `executable` finding, which no entry lifts (only the vault's
 *   `wiki.rules` allows a kind)
 * @property {string[]} problems what is wrong in the file without making it unusable — an `allow:` entry
 *   that is empty or shorter than MIN_ALLOW_LENGTH, which is ignored
 * @property {string|null} source the file the words came from, or null for the built-ins only
 * @property {RegExp[]} [patterns] shapes kept out as the installation's own words (category `term`) — the
 *   organization's tracker key patterns for a personal vault; absent means none
 * @property {string[]} [off] categories switched off for this check (a vault: `language`, and `assistant`
 *   where the mount allows the word); absent means none
 * @property {string[]} [refuse] kinds of EXECUTABLE_KINDS refused (category `executable`); absent means none
 */

/** The built-in patterns only: no installation words, nothing allowed. */
export const BUILT_IN_RULES = Object.freeze({ terms: Object.freeze([]), allow: Object.freeze([]), problems: Object.freeze([]), source: null });

/**
 * @typedef {object} OutgoingFinding
 * @property {number} line the line number in its text, from 1
 * @property {string} category one of CATEGORIES
 * @property {string} match what matched (a secret in full: mask it with `maskSecret` before printing)
 * @property {string} text the whole line
 */

/**
 * The rules of the installation at `root` (default: the one oikos runs in): `.local/outgoing.yaml`
 * when it exists — `terms:` and `allow:`, lists of strings — else the built-in patterns only; with the
 * terms of every installation linked to it added to `terms` (ADR 0007 D05: every check takes them).
 * An `allow:` entry that is not a string, is empty or is shorter than MIN_ALLOW_LENGTH is left out and
 * named in `problems`. A linked installation whose `.local/outgoing.yaml` exists and cannot be read or
 * parsed fails closed: a GuardRefusal naming the file, since a check without its terms would let them out.
 * @param {string|null} [root]
 * @param {{mounts?: {path: string, root: string}[]}} [options] the mounts to find linked installations
 *   among; by default those of the configuration, when `root` is the installation oikos runs in
 * @returns {OutgoingRules}
 */
export function outgoingRules(root = installRoot(), { mounts } = {}) {
  const own = fileRules(root);
  const linked = linkedTerms(mounts ?? (root && root === installRoot() ? config().mounts : []), fileTerms);
  if (!linked.terms.length && !linked.problems.length) return own;
  return Object.freeze({
    ...own,
    terms: Object.freeze([...new Set([...own.terms, ...linked.terms])]),
    problems: Object.freeze([...own.problems, ...linked.problems]),
  });
}

/**
 * The `terms:` of the linked installation at `root`. A file that is there and does not read fails closed
 * (a GuardRefusal, exit 3): the terms it holds would be left out of the check; a missing file has none.
 * @param {string} root
 * @returns {{terms: string[], problems: string[]}}
 */
function fileTerms(root) {
  try {
    return { terms: [...fileRules(root).terms], problems: [] };
  } catch (e) {
    throw new GuardRefusal(`refused: content check: the terms file ${join(root, OUTGOING_FILE)} of a linked installation cannot be used — ${e.message}; fix it, every check takes the linked installations' terms (ADR 0007 D05) — nothing written.`, { cause: e });
  }
}

/** The rules of the file `.local/outgoing.yaml` of the installation at `root`: its own words, no linked ones. */
function fileRules(root) {
  const file = root ? join(root, OUTGOING_FILE) : null;
  if (!file || !existsSync(file)) return BUILT_IN_RULES;
  let data;
  try {
    data = YAML.parse(readFileSync(file, 'utf8')) ?? {};
  } catch (e) {
    throw new UsageError(`${OUTGOING_FILE} does not parse: ${e.message.split('\n')[0]}`, { cause: e });
  }
  const list = (key) => {
    const value = data[key] ?? [];
    if (!Array.isArray(value)) throw new UsageError(`${OUTGOING_FILE}: ${key}: is a list of non-empty strings`);
    return value;
  };
  if (typeof data !== 'object' || Array.isArray(data)) throw new UsageError(`${OUTGOING_FILE} holds terms: and allow:, two lists of strings`);
  const terms = list('terms');
  if (terms.some((s) => typeof s !== 'string' || !s.trim())) throw new UsageError(`${OUTGOING_FILE}: terms: is a list of non-empty strings`);
  const { allow, problems } = usableAllow(list('allow'));
  return Object.freeze({ terms: Object.freeze(terms.map((s) => s.trim())), allow, problems, source: OUTGOING_FILE });
}

/** The `allow:` entries that count (trimmed) and a problem for each that does not: not a string, empty, or shorter than MIN_ALLOW_LENGTH. */
function usableAllow(entries) {
  const allow = [];
  const problems = [];
  for (const entry of entries) {
    const text = typeof entry === 'string' ? entry.trim() : null;
    const flaw = text === null ? 'is not a string' : text === '' ? 'is empty' : text.length < MIN_ALLOW_LENGTH ? `is shorter than ${MIN_ALLOW_LENGTH} characters` : null;
    if (flaw) problems.push(`${OUTGOING_FILE}: allow: ${JSON.stringify(entry)} ${flaw} — ignored`);
    else allow.push(text);
  }
  return { allow: Object.freeze(allow), problems: Object.freeze(problems) };
}

/**
 * Non-Latin letters in text (Cyrillic etc.), sorted, each once — outgoing text is English. Greek
 * letters are not counted: they are the symbols of a formula (α, Δt, σ), not a language (ADR 0003 D02).
 */
export function nonLatinLetters(text) {
  const found = new Set();
  for (const ch of text) if (/\p{L}/u.test(ch) && ch.codePointAt(0) > 0x024f && !/\p{Script=Greek}/u.test(ch)) found.add(ch);
  return [...found].sort().join('');
}

// Invisible characters (zero-width, bidi marks, soft hyphen, variation selectors, fillers) and emphasis markup
// (`*`, `_`, `~`, a backtick, the inline HTML emphasis tags) split a word the check would match: they are taken
// out before matching (ADR 0007 D04, 0003 D02).
const INVISIBLE = /\p{Cf}|\p{Variation_Selector}|\u034F|[\u115F\u1160\u3164\uFFA0]/gu;
const EMPHASIS = /[*~`]|<\/?(?:b|i|em|strong|u|s|del|ins|mark|code|kbd|sup|sub|span)\b[^>]*>/gi;
// Spaces of any kind (NFKC maps most to U+0020; the Ogham space mark and the braille blank it leaves) are one space.
const SPACES = /[\s\u1680\u180E\u2800]+/g;
// The HTML entities a text may use to spell a word, an address or a space differently from how it reads.
const NAMED_ENTITIES = Object.freeze({
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', tab: ' ', newline: ' ', amp: '&', quot: '"', apos: "'",
  colon: ':', sol: '/', period: '.', comma: ',', lpar: '(', rpar: ')',
});

/** `text` with the common HTML entities decoded: `&nbsp;`, `&amp;`, the numeric `&#…;` and `&#x…;`. A space entity is a space; `<` and `>` stay as written (an escaped tag is not a tag). */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (whole, name) => (name[0] === '#' ? numericEntity(whole, name) : namedEntity(whole, name.toLowerCase())));
}

/** The character of the named entity `whole` (`name` lower case); the entity as written when it is not one decoded. */
function namedEntity(whole, name) {
  return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : whole;
}

/** The character of the numeric entity `whole` (`name` is its `#…` part); the entity as written when it names no character to decode. */
function numericEntity(whole, name) {
  const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  const surrogate = code >= 0xd800 && code <= 0xdfff;
  if (!Number.isInteger(code) || code > 0x10ffff || surrogate || code === 0x3c || code === 0x3e) return whole;
  const ch = String.fromCodePoint(code);
  if (/\s/.test(ch)) return ' ';
  return /\p{Cc}/u.test(ch) ? '' : ch;
}

/**
 * The three views of one line, the plain one first: the line in NFKC with its HTML entities decoded,
 * invisible characters removed and every run of spaces (a no-break space, `&nbsp;`, two blanks) one space;
 * that again without emphasis markup (`*`, `~`, a backtick, the inline HTML emphasis tags); and that again
 * without `_`, which is also emphasis but belongs to some patterns (`OIKOS_HOME`, a token's `ghp_`) and so is
 * kept in the view before. Never changes the number of lines.
 */
function threeViews(line) {
  const decoded = decodeEntities(line.normalize('NFKC')).normalize('NFKC');
  const plain = decoded.replace(INVISIBLE, '').replace(SPACES, ' ');
  const marked = plain.replace(EMPHASIS, '');
  return [plain, marked, marked.replace(/_/g, '')];
}

// The entities of the characters a browser drops from inside a URL (tab, LF, CR): `&#9;`, `&#x0A;`, `&Tab;`, `&NewLine;`.
const URL_BREAK_ENTITIES = /&(?:#0*(?:9|10|13)(?![0-9])|#x0*(?:9|a|d)(?![0-9a-f])|tab(?![a-z0-9])|newline(?![a-z0-9]));?/gi;

/** One line with its blanks kept (tab, CR): NFKC, entities decoded (those of a tab or line break dropped, as the browser drops them from a URL), invisible characters removed. */
const rawLine = (line) => decodeEntities(line.normalize('NFKC').replace(URL_BREAK_ENTITIES, '')).normalize('NFKC').replace(INVISIBLE, '');

/**
 * What the check sees of one line, as {@link threeViews} makes it, each different one once. Every view is
 * matched. Pure.
 * @param {string} line
 * @returns {string[]} one to three views, the plain one first
 */
export function viewsOf(line) {
  return [...new Set(threeViews(line))];
}

const unique = (list) => [...new Set(list)];

/** Every secret on a line, in the order of the patterns. */
const secretsOn = (line) => GLOBAL_SECRETS.flatMap((pattern) => [...line.matchAll(pattern)].map((m) => m[0]));

/** Every secret in any of the views of a line. */
const secretsIn = (views) => unique(views.flatMap(secretsOn));

/** The categories a check runs under `rules`: all but those switched off, and `executable` only where kinds are refused. */
const activeCategories = (rules) => CATEGORIES.filter((category) => !(rules.off ?? []).includes(category) && (category !== 'executable' || (rules.refuse ?? []).length));

const firstMatches = (patterns, view) => patterns.flatMap((pattern) => { const m = view.match(pattern); return m ? [m[0]] : []; });

/** What `category` matches in one view of a line, every match, the most specific first. */
function viewMatches(category, view, rules) {
  if (category === 'language') return [nonLatinLetters(view)].filter(Boolean);
  if (category === 'secret') return secretsOn(view).filter((secret) => !rules.allow.some((a) => a.includes(secret)));
  if (category === 'term') {
    const lower = view.toLowerCase();
    const squeezed = lower.replace(/\s+/g, '');
    // A term of several words is also found with its blanks gone: a zero-width character may stand for the space.
    const found = (term) => {
      const wanted = term.toLowerCase().replace(/\s+/g, ' ');
      return lower.includes(wanted) || (wanted.includes(' ') && squeezed.includes(wanted.replace(/ /g, '')));
    };
    return [...rules.terms.filter(found), ...firstMatches(rules.patterns ?? [], view)];
  }
  return firstMatches(PATTERNS[category], view);
}

/** What `category` matches on a line given its views (the language only in the plain one), every match. */
const lineMatches = (category, views, rules) => unique((category === 'language' ? views.slice(0, 1) : views).flatMap((view) => viewMatches(category, view, rules)));

/** The first match of a category on one line, or null. */
const lineMatch = (category, views, rules) => lineMatches(category, views, rules)[0] ?? null;

/** The first `allow:` entry a line holds, in the line as written or in any of its views, or undefined. */
const allowedBy = (line, views, rules) => rules.allow.find((entry) => line.includes(entry) || views.some((view) => view.includes(entry)));

/** The categories whose words a line split by a line break can still hold. */
const JOINED = ['assistant', 'path', 'secret', 'term'];

/**
 * The first match of `category` that lies across the break between two lines — a word split by a line
 * break, written as it is (a space or nothing between the two parts) or hyphenated at the end of the first
 * line — and in neither line alone, or null. `a` and `b` are the views of the two lines.
 */
function acrossBreak(category, a, b, rules) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[Math.min(i, a.length - 1)].trimEnd();
    const right = b[Math.min(i, b.length - 1)].trimStart();
    const joined = [`${left} ${right}`, `${left}${right}`, ...(left.endsWith('-') ? [`${left.slice(0, -1)}${right}`] : [])];
    for (const text of joined) {
      const found = lineMatches(category, [text], rules).find((match) => ![...a, ...b].some((view) => view.toLowerCase().includes(match.toLowerCase())));
      if (found) return found;
    }
  }
  return null;
}

/**
 * Every finding in `text` under `rules`: one per line and category, a line holding an allowed
 * string left out — except a `secret`, left out only when an allowed string contains the secret, and an
 * `executable` finding, left out by no allowed string. The
 * text is matched as `viewsOf` makes it, and a word split across a line break is found too (reported on
 * the line it starts on). Pure.
 * @param {string} text
 * @param {OutgoingRules} rules
 * @returns {OutgoingFinding[]}
 */
export function outgoingFindings(text, rules) {
  const categories = activeCategories(rules).filter((category) => category !== 'executable');
  const lines = String(text ?? '').split('\n');
  const views = lines.map(viewsOf);
  const found = lines.flatMap((line, i) => {
    const allowed = allowedBy(line, views[i], rules) !== undefined;
    const wraps = i + 1 < lines.length && line.trim() !== '' && lines[i + 1].trim() !== '';
    return categories.flatMap((category) => {
      if (allowed && category !== 'secret') return [];
      const match = lineMatch(category, views[i], rules)
        ?? (wraps && JOINED.includes(category) ? acrossBreak(category, views[i], views[i + 1], rules) : null);
      return match ? [{ line: i + 1, category, match, text: line }] : [];
    });
  });
  return [...found, ...executableFindings(lines, rules)]
    .sort((a, b) => a.line - b.line || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
}

/**
 * The `executable` findings of `lines`: each refused kind whose pattern matches the whole text — in any of its
 * three views, which have the lines of the text, and for a pattern marked `.raw` the text with its blanks kept — reported on the line its match starts on, the first kind
 * (in the order of `rules.refuse`) once per line. No `allow:` entry lifts one.
 */
function executableFindings(lines, rules) {
  if (!activeCategories(rules).includes('executable')) return [];
  const perLine = lines.map(threeViews);
  const wholes = [0, 1, 2].map((v) => ({ raw: false, text: perLine.map((views) => views[v]).join('\n') }));
  wholes.push({ raw: true, text: lines.map(rawLine).join('\n') }); // blanks kept: for the patterns that are marked `.raw`
  const kindsOnLine = new Map();
  for (const kind of rules.refuse) {
    for (const pattern of EXECUTABLE_KINDS[kind] ?? []) {
      for (const { raw, text } of wholes) {
        if (Boolean(pattern.raw) !== raw) continue;
        for (const index of matchIndexes(pattern, text)) {
          const line = text.slice(0, index).split('\n').length;
          kindsOnLine.set(line, [...(kindsOnLine.get(line) ?? []), kind]);
        }
      }
    }
  }
  return [...kindsOnLine].map(([line, kinds]) => ({ line, category: 'executable', match: rules.refuse.find((kind) => kinds.includes(kind)), text: lines[line - 1] }));
}

/**
 * @typedef {object} AllowPass
 * @property {number} line the line number in its text, from 1
 * @property {string} entry the `allow:` entry that let a finding on the line pass (the first one that did)
 * @property {string} text the whole line
 */

/**
 * The lines of `text` on which an `allow:` entry dropped a finding, each with the entry that did:
 * for a finding of any category but `secret`, the first entry the line contains; for a secret, the
 * first entry that contains it. A line is listed once per entry. Pure.
 * @param {string} text
 * @param {OutgoingRules} rules
 * @returns {AllowPass[]}
 */
export function allowedPasses(text, rules) {
  if (!rules.allow.length) return [];
  return String(text ?? '').split('\n').flatMap((line, i) => [...entriesLetPass(line, rules)].map((entry) => ({ line: i + 1, entry, text: line })));
}

/** The `allow:` entries that dropped a finding on `line`: for a secret the entry that contains it, for any other category the first entry the line contains. */
function entriesLetPass(line, rules) {
  const entries = new Set();
  const views = viewsOf(line);
  for (const secret of secretsIn(views)) {
    const holder = rules.allow.find((entry) => entry.includes(secret));
    if (holder !== undefined) entries.add(holder);
  }
  const onLine = allowedBy(line, views, rules);
  const bare = { ...rules, allow: [] };
  if (onLine !== undefined && activeCategories(rules).some((category) => category !== 'secret' && category !== 'executable' && lineMatch(category, views, bare))) entries.add(onLine);
  return entries;
}

/** A secret as it may be printed: its first four characters and its length, never the rest. */
export const maskSecret = (secret) => `${secret.slice(0, 4)}… (${secret.length} characters)`;

/** The local image an image line uploads, as { alt, target }, or null (a URL, a media id, an attachment). */
function localImage(line) {
  const m = line.trim().match(IMAGE_LINE);
  return m && !/^(https?:|media:|attachment:)/.test(m.groups.target) ? m.groups : null;
}

/**
 * The texts of `markdown` whose image lines are uploaded (jira): the markdown as it reaches the
 * service — a local image's path becomes its file name, which is what the service shows; the path
 * stays on this machine; line numbers are kept —, and each uploaded image, whose content is not read.
 * @param {string} label
 * @param {string} [markdown]
 * @returns {OutgoingText[]}
 */
export function uploadedMarkdown(label, markdown) {
  if (!markdown) return [];
  const images = [];
  const text = String(markdown).split('\n').map((line) => {
    const image = localImage(line);
    if (!image) return line;
    images.push(basename(image.target));
    return `![${image.alt}](${basename(image.target)})`;
  }).join('\n');
  return [{ label, text }, ...[...new Set(images)].map((name) => ({ label: `image ${name}`, unread: true }))];
}

/**
 * @typedef {object} OutgoingText
 * @property {string} label what the text is (title, body, comment, attachment report.md)
 * @property {string} [text] what is sent; empty or missing is skipped
 * @property {boolean} [unread] its content is not read (an image, a binary attachment): `text`
 *   is its name only, and the dry run says the content was not checked
 */

/** Whether the command's flags override a finding: a secret never, language by either flag. */
function overridden(finding, values) {
  if (finding.category === 'secret') return false;
  if (finding.category === 'language' && values['allow-non-english']) return true;
  return Boolean(values['allow-flagged']);
}

/** `text` with every secret in it masked. */
const masked = (text) => GLOBAL_SECRETS.reduce((out, pattern) => out.replace(pattern, maskSecret), text);

/**
 * `line` with every secret in it masked, so no finding of another category prints one. A secret the line
 * hides behind markup or invisible characters is found in the line as the check saw it, which is what is shown then.
 */
export function maskedLine(line) {
  const out = masked(line);
  if (out !== line) return out;
  const hidden = viewsOf(line).find((view) => secretsOn(view).length);
  return hidden === undefined ? line : masked(hidden);
}

/** A line as the check prints it: masked of any secret, trimmed and shortened. */
function shownLine(text) {
  const line = maskedLine(text.trim());
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/** One finding as the check prints it: a secret masked, a line masked of any secret and shortened. */
function findingLine(label, f) {
  if (f.category === 'secret') return `  ${label} line ${f.line}: secret — ${maskSecret(f.match)}`;
  return `  ${label} line ${f.line}: ${f.category} — ${f.match}  │ ${shownLine(f.text)}`;
}

/** One line an `allow:` entry let pass, as the check prints it: the entry (masked when it holds a secret) and the line. */
const passLine = (label, pass) => `  ${label} line ${pass.line}: let pass by allow: ${JSON.stringify(maskedLine(pass.entry))}  │ ${shownLine(pass.text)}`;

/**
 * @typedef {object} OutgoingCheck
 * @property {{label: string, finding: OutgoingFinding}[]} findings what is flagged, allow: applied
 * @property {{label: string, pass: AllowPass}[]} passes every line an `allow:` entry let a finding through on, with the entry
 * @property {number} allowed how many lines that is
 * @property {string[]} problems what is wrong in the rules file (an `allow:` entry that is ignored)
 * @property {string[]} unread labels of the texts whose content was not read
 */

/**
 * The check of every text a command sends: what is flagged, what allow: let pass, what was not read.
 * @param {OutgoingText[]} texts
 * @param {OutgoingRules} rules
 * @returns {OutgoingCheck}
 */
export function checkOutgoing(texts, rules) {
  const findings = [];
  const passes = [];
  const unread = [];
  for (const { label, text, unread: notRead } of texts) {
    if (notRead) unread.push(label);
    if (!text) continue;
    findings.push(...outgoingFindings(text, rules).map((finding) => ({ label, finding })));
    passes.push(...allowedPasses(text, rules).map((pass) => ({ label, pass })));
  }
  const allowed = new Set(passes.map(({ label, pass }) => `${label}\n${pass.line}`)).size;
  return { findings, passes, allowed, problems: [...(rules.problems ?? [])], unread };
}

/** The `CHECK` lines of a check: each finding, each line allow: let pass with its entry, the problems of the rules, what was not read. */
export function checkLines(check, values = {}) {
  const lines = check.findings.map(({ label, finding }) =>
    `${findingLine(label, finding)}${overridden(finding, values) ? '  (overridden)' : ''}`);
  if (check.allowed) lines.push(`  ${check.allowed} line(s) let pass by allow: in ${OUTGOING_FILE}`, ...check.passes.map(({ label, pass }) => passLine(label, pass)));
  for (const problem of check.problems) lines.push(`  problem: ${problem}`);
  for (const label of check.unread) lines.push(`  ${label}: content not checked (not text) — only its name`);
  return lines;
}

/** What a refusal tells the person to do about the open findings: a secret is never posted, anything else needs the user's agreement (a flag, or for a command without one an `allow:` line; for executable content, which no `allow:` line lifts, the vault's own note rules). */
function adviceFor(open, flags) {
  if (open.some(({ finding }) => finding.category === 'secret')) {
    return `fix the text — a secret is never posted; an allow: entry holding it in ${OUTGOING_FILE} if it is not one`;
  }
  const executable = open.some(({ finding }) => finding.category === 'executable');
  const others = open.some(({ finding }) => finding.category !== 'executable');
  const allowLine = `have the user add an allow: line for it to ${OUTGOING_FILE}, which they edit themselves`;
  // No allow: entry lifts an executable finding (L1): only the vault's note rules do.
  const vaultRules = 'the vault\'s note rules (`wiki.rules` front matter `allow:`) are the only way to allow executable content';
  let way = `, or ${allowLine}`;
  if (flags) way = ', or add --allow-flagged to the command once the user has seen the findings and agrees';
  else if (executable) way = others ? `; for the other findings ${allowLine}; ${vaultRules}` : ` — ${vaultRules}`;
  return `fix the text${way}${flags && open.every(({ finding }) => finding.category === 'language') ? ' (or --allow-non-english)' : ''}`;
}

const categoriesOf = (findings) => [...new Set(findings.map(({ finding }) => finding.category))].join(', ');

/**
 * The content check of a write command, called with every text it sends, in the dry run and the
 * real run alike (the override flags are part of the command, so the confirmed command is the one
 * that showed the findings). The dry run prints a `CHECK` block; a finding not overridden there
 * prints `flagged: content check: …` on stderr and sets the exit code 3 while the preview goes on —
 * except a secret, whose dry run stops before the preview, so the secret never reaches the output.
 * The real run refuses (GuardRefusal, exit 3, `refused: content check: …`) any finding not
 * overridden: `--allow-flagged` overrides every category but `secret`, `--allow-non-english` only
 * `language`; only an `allow:` entry that contains the secret itself lets a secret pass.
 * A command that takes no override flag (the `vault` tool, ADR 0007 D04) passes `{ flags: false }`: no flag
 * overrides anything, and the way past a finding is an `allow:` line of the file, which the user writes.
 * @param {OutgoingText[]} texts
 * @param {Record<string, unknown>} values the command's parsed flags (`dry-run`, the overrides)
 * @param {OutgoingRules} rules from `outgoingRules()`, read once at the command
 * @param {{flags?: boolean}} [options] `flags: false` — the command has no override flag
 */
export function guardOutgoing(texts, values, rules, { flags = true } = {}) {
  const check = checkOutgoing(texts, rules);
  const flagged = flags ? values : { 'dry-run': values['dry-run'] };
  const open = check.findings.filter(({ finding }) => !overridden(finding, flagged));
  const secret = open.some(({ finding }) => finding.category === 'secret');
  const fix = adviceFor(open, flags);
  if (values['dry-run']) {
    const lines = checkLines(check, flagged);
    if (lines.length) console.log(`CHECK outgoing text: ${check.findings.length} finding(s)\n${lines.join('\n')}`);
    if (!open.length) return;
    if (secret) throw new GuardRefusal(`flagged: content check: ${categoriesOf(open)} — preview withheld, the text holds a secret; ${fix}.`);
    console.error(`flagged: content check: ${categoriesOf(open)} — the real run refuses this text; ${fix}.`);
    process.exitCode = 3;
    return;
  }
  if (!open.length) return;
  const lines = open.map(({ label, finding }) => findingLine(label, finding));
  throw new GuardRefusal(`refused: content check: ${categoriesOf(open)} — nothing written; ${fix}.\n${lines.join('\n')}`);
}
