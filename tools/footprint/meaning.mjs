// The shared definitions of what a footprint's text means (ADR 0008, docs/design/footprint.md): the
// headings that open a decision request in an agent's final summary, the decision codes and task keys
// a text names, the decision documents' folders, the kinds of lines and how words are counted. Every
// source and section reads them from here, so one definition holds everywhere; the user's settings
// (places.mjs) replace the defaults.

/** The headings of a decision request in a final summary (case-insensitive prefixes of a heading line). */
export const DEFAULT_DECISION_HEADINGS = Object.freeze(['Needed from you', 'Нужно от вас', 'Нужно от тебя', 'Требуется от']);
/** A decision code: `D-ORDER`, `Q-C139-TOPIC` — a regular expression source. */
export const DEFAULT_DECISION_CODES = '\\b[DQ]-[A-Z0-9]+(?:-[A-Z0-9]+)*\\b';
/** The folders of decision documents in a repository. */
export const DEFAULT_DECISION_DIRS = Object.freeze(['docs/adr', 'docs/design', 'docs/measurements', 'docs/reviews']);
/** A task key: `PROJ-123`. */
export const TASK_KEY_SOURCE = '\\b[A-Z][A-Z0-9]+-\\d+\\b';
/** The kinds of a commit's lines, in the order of totals and tables (generated lines are left out). */
export const LINE_KINDS = Object.freeze(['code', 'tests', 'docs', 'other']);

/** A word: a run of letters, digits, marks and underscores — as the prototype's `\w+` counted. */
const WORD = /[\p{L}\p{N}\p{M}_]+/gu;
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The words of `text`: runs of letters, digits, marks and underscores (Unicode).
 *
 * @param {string|null|undefined} text
 * @returns {number}
 */
export function wordsOf(text) {
  return String(text ?? '').match(WORD)?.length ?? 0;
}

/**
 * The pattern of a decision request's heading line: one of `headings` at its start, after any of
 * `#`, `*`, `>`, `-`, `_` and spaces; case-insensitive. It matches the heading's prefix only, so
 * `match(...)[0].length` is where the rest of the heading line starts.
 *
 * @param {readonly string[]} [headings] the user's `decision_headings`, else the defaults
 * @returns {RegExp}
 */
export function headingPattern(headings = DEFAULT_DECISION_HEADINGS) {
  const names = headings.map((h) => String(h).trim()).filter(Boolean).map(escapeRegExp);
  if (!names.length) throw new TypeError('headingPattern: no heading given');
  return new RegExp(`^[ \\t>*#_-]*(?:${names.join('|')})`, 'iu');
}

/**
 * The distinct matches of `pattern` in `text`, sorted. The pattern's flags are kept, `g` added.
 *
 * @param {string|null|undefined} text
 * @param {RegExp|string} pattern a RegExp or a regular expression source
 * @returns {string[]}
 */
export function matchesOf(text, pattern) {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  const flags = pattern instanceof RegExp ? pattern.flags.replace('g', '') : '';
  return [...new Set(String(text ?? '').match(new RegExp(source, `${flags}g`)) || [])].sort();
}

/**
 * The decision codes `text` names.
 *
 * @param {string|null|undefined} text
 * @param {RegExp|string} [pattern] the user's `decision_codes`, else the default
 * @returns {string[]} distinct, sorted
 */
export const codesIn = (text, pattern = DEFAULT_DECISION_CODES) => matchesOf(text, pattern);

/**
 * The task keys `text` names (`PROJ-123`).
 *
 * @param {string|null|undefined} text
 * @returns {string[]} distinct, sorted
 */
export const keysIn = (text) => matchesOf(text, TASK_KEY_SOURCE);
