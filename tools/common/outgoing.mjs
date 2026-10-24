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
import { IMAGE_LINE } from './adf.mjs';

/** The installation's file of words to keep out (`terms:`) and lines to let pass (`allow:`). */
export const OUTGOING_FILE = '.local/outgoing.yaml';

/** The categories, in the order the check reports them. */
export const CATEGORIES = Object.freeze(['language', 'assistant', 'path', 'secret', 'term']);

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
  // Case-sensitive: the providers' prefixes are, and a token's body follows its prefix.
  secret: [
    /\bgh[pousr]_[A-Za-z0-9]{36}\b/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bglpat-[A-Za-z0-9_-]{20,}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bATATT[A-Za-z0-9_=-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  ],
});

/**
 * @typedef {object} OutgoingRules
 * @property {string[]} terms fixed strings to keep out (category `term`), matched ignoring case
 * @property {string[]} allow literal strings: a finding on a line that contains one is dropped
 * @property {string|null} source the file the words came from, or null for the built-ins only
 */

/** The built-in patterns only: no installation words, nothing allowed. */
export const BUILT_IN_RULES = Object.freeze({ terms: Object.freeze([]), allow: Object.freeze([]), source: null });

/**
 * @typedef {object} OutgoingFinding
 * @property {number} line the line number in its text, from 1
 * @property {string} category one of CATEGORIES
 * @property {string} match what matched (a secret in full: mask it with `maskSecret` before printing)
 * @property {string} text the whole line
 */

/**
 * The rules of the installation at `root` (default: the one oikos runs in): `.local/outgoing.yaml`
 * when it exists — `terms:` and `allow:`, lists of strings — else the built-in patterns only.
 * @param {string|null} [root]
 * @returns {OutgoingRules}
 */
export function outgoingRules(root = installRoot()) {
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
    if (!Array.isArray(value) || value.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new UsageError(`${OUTGOING_FILE}: ${key}: is a list of non-empty strings`);
    }
    return Object.freeze(value.map((s) => s.trim()));
  };
  if (typeof data !== 'object' || Array.isArray(data)) throw new UsageError(`${OUTGOING_FILE} holds terms: and allow:, two lists of strings`);
  return Object.freeze({ terms: list('terms'), allow: list('allow'), source: OUTGOING_FILE });
}

/** Non-Latin letters in text (Cyrillic etc.), sorted, each once — outgoing text is English. */
export function nonLatinLetters(text) {
  const found = new Set();
  for (const ch of text) if (/\p{L}/u.test(ch) && ch.codePointAt(0) > 0x024f) found.add(ch);
  return [...found].sort().join('');
}

/** The first match of a category on one line, or null. */
function lineMatch(category, line, rules) {
  if (category === 'language') return nonLatinLetters(line) || null;
  if (category === 'term') {
    const lower = line.toLowerCase();
    return rules.terms.find((t) => lower.includes(t.toLowerCase())) ?? null;
  }
  for (const pattern of PATTERNS[category]) {
    const m = line.match(pattern);
    if (m) return m[0];
  }
  return null;
}

/**
 * Every finding in `text` under `rules`: one per line and category, a line holding an allowed
 * string left out. Pure.
 * @param {string} text
 * @param {OutgoingRules} rules
 * @returns {OutgoingFinding[]}
 */
export function outgoingFindings(text, rules) {
  const findings = [];
  for (const [i, line] of String(text ?? '').split('\n').entries()) {
    if (rules.allow.some((a) => line.includes(a))) continue;
    for (const category of CATEGORIES) {
      const match = lineMatch(category, line, rules);
      if (match) findings.push({ line: i + 1, category, match, text: line });
    }
  }
  return findings;
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

/** One finding as the check prints it: a secret masked, a line shortened. */
function findingLine(label, f) {
  if (f.category === 'secret') return `  ${label} line ${f.line}: secret — ${maskSecret(f.match)}`;
  const line = f.text.trim();
  return `  ${label} line ${f.line}: ${f.category} — ${f.match}  │ ${line.length > 100 ? `${line.slice(0, 100)}…` : line}`;
}

/**
 * @typedef {object} OutgoingCheck
 * @property {{label: string, finding: OutgoingFinding}[]} findings what is flagged, allow: applied
 * @property {number} allowed lines whose findings an `allow:` entry dropped
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
  let allowed = 0;
  const unread = [];
  for (const { label, text, unread: notRead } of texts) {
    if (notRead) unread.push(label);
    if (!text) continue;
    const kept = outgoingFindings(text, rules);
    findings.push(...kept.map((finding) => ({ label, finding })));
    const all = outgoingFindings(text, { ...rules, allow: [] });
    allowed += new Set(all.map((f) => f.line)).size - new Set(kept.map((f) => f.line)).size;
  }
  return { findings, allowed, unread };
}

/** The `CHECK` lines of a check: each finding, what allow: let pass, what was not read. */
export function checkLines(check, values = {}) {
  const lines = check.findings.map(({ label, finding }) =>
    `${findingLine(label, finding)}${overridden(finding, values) ? '  (overridden)' : ''}`);
  if (check.allowed) lines.push(`  ${check.allowed} line(s) let pass by allow: in ${OUTGOING_FILE}`);
  for (const label of check.unread) lines.push(`  ${label}: content not checked (not text) — only its name`);
  return lines;
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
 * `language`; only an `allow:` entry lets a secret's line pass.
 * @param {OutgoingText[]} texts
 * @param {Record<string, unknown>} values the command's parsed flags (`dry-run`, the overrides)
 * @param {OutgoingRules} rules from `outgoingRules()`, read once at the command
 */
export function guardOutgoing(texts, values, rules) {
  const check = checkOutgoing(texts, rules);
  const open = check.findings.filter(({ finding }) => !overridden(finding, values));
  const secret = open.some(({ finding }) => finding.category === 'secret');
  const fix = `fix the text${secret ? ' — a secret is never posted; an allow: entry in '
    + `${OUTGOING_FILE} if it is not one` : ', or add --allow-flagged to the command once the user has seen the findings and agrees'}`
    + (!secret && open.every(({ finding }) => finding.category === 'language') ? ' (or --allow-non-english)' : '');
  if (values['dry-run']) {
    const lines = checkLines(check, values);
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
