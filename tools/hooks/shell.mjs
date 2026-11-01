// Shell-command parsing for the hook guards: the words a command runs with, the shell syntax it
// holds beyond one plain command, and where its redirections point. Splitting a command into its
// segments is shellSegments in common.mjs; what a guard allows is each guard's own policy.
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Characters the shell may expand in a word: parameters, substitutions, globs, braces. */
export const EXPANDS = /[$`*?[{]/;
/** A word that is a plain path and nothing else. */
export const CLEAN_PATH = /^[\w@%+:./-]+$/;
/** A word that is a path the shell may expand: path characters and expansions, no code. */
export const EXPANDING_PATH = /^[\w@%+:./${}*?[\],~-]+$/;
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that open or continue a compound command; the command after them is its body. */
const OPENERS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do']);
/** Words that close a compound command. */
const CLOSERS = new Set(['done', 'fi', 'esac']);
const MAX_DIRS = 16;

/** The distinct values of a list, in the order they first appear. */
export const unique = (list) => [...new Set(list)];

/**
 * Whether a word may be other than it reads: it holds an expansion character and the command
 * expands somewhere. The lexer drops quotes, so the command's syntax decides for every word.
 * @param {string} word a word of the command, quotes removed
 * @param {Set<string>} syntax the command's shell syntax (shellSyntax)
 * @returns {boolean}
 */
export const mayExpand = (word, syntax) => (/[$`]/.test(word) && syntax.has('substitution')) || (/[*?[{~]/.test(word) && syntax.has('expansion'));

/** The index of a segment's command word in its tokens. */
export const executedFrom = (segment) => segment.tokens.length - segment.args.length - 1;

/** The words a segment runs with: its command word and every word after it (none without a command). */
export function executedWords(segment) {
  if (segment.exe === null) return [];
  return segment.tokens.slice(executedFrom(segment));
}

/** The real path of a file or folder, symlinks resolved; null when it does not exist. */
export const real = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The command's text as the shell would join it: backslash-newlines, backslashes and quotes removed. */
export const plainText = (command) => command.replace(/\\\n/g, '').replace(/[\\'"]/g, '');

/**
 * The folders a relative word of the command can be read from: `cwd` and every literal
 * `cd`/`pushd` target, cumulatively and from `cwd`. `unknown` once a target cannot be told.
 * @param {{exe: string|null, args: string[]}[]} segments from shellSegments
 * @param {string} cwd the folder the command starts in
 * @returns {{dirs: string[], unknown: boolean}}
 */
export function workingDirs(segments, cwd) {
  const dirs = new Set([cwd]);
  let current = cwd;
  let unknown = false;
  for (const { exe, args } of segments) {
    if (exe !== 'cd' && exe !== 'pushd') continue;
    const target = args.find((arg) => arg === '-' || !arg.startsWith('-'));
    if (target === undefined || target === '-' || /[$`~*?[{]/.test(target) || dirs.size >= MAX_DIRS) {
      unknown = true;
      continue;
    }
    current = resolve(current, target);
    if (!isDir(current)) unknown = true;
    dirs.add(current).add(resolve(cwd, target));
  }
  return { dirs: [...dirs], unknown };
}

/**
 * A segment with the words of a compound command taken off its tokens: shellSegments has already
 * found the command after `if`, `then`, `do`, … (stripPrefix), so only the tokens are cut here. A
 * `for … in …` or `case … in` header and a lone closing word are `control`: their words are
 * values, nothing runs.
 * @param {{exe: string|null, args: string[], tokens: string[]}} segment from shellSegments
 * @returns {{exe: string|null, args: string[], tokens: string[], control?: boolean}}
 */
export function bodyOf(segment) {
  const { tokens } = segment;
  let i = 0;
  while (i < tokens.length && OPENERS.has(tokens[i])) i++;
  const rest = tokens.slice(i);
  if (rest.length === 0 || rest[0] === 'for' || rest[0] === 'case' || (rest.length === 1 && CLOSERS.has(rest[0]))) {
    return { exe: null, args: [], viaEnv: false, tokens: rest, control: true };
  }
  return i ? { ...segment, tokens: rest } : segment;
}

/**
 * Removes the redirections outside quotes (`>f`, `2>&1`, `<<<word`, `&>f`) with their target, so
 * the words left are the arguments the program receives. A target that expands stays as text.
 * @param {string} command a shell command
 * @returns {string}
 */
export function withoutRedirections(command) {
  const operator = /\d*(?:<<<|<<-|<<|<>|<&|>>|>\||>&|<|>)|&>>|&>/y;
  let out = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote || ch === "'" || ch === '"') {
      if (!quote) quote = ch;
      else if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') out += command[i++];
      out += command[i] ?? '';
      continue;
    }
    if (ch === '\\') {
      out += command.slice(i, i + 2);
      i++;
      continue;
    }
    operator.lastIndex = i;
    const op = /[\d<>&]/.test(ch) ? operator.exec(command) : null;
    const wordStart = i === 0 || /[\s;&|()]/.test(command[i - 1]);
    if (op && (wordStart || !/^\d/.test(op[0]))) {
      i = skipTarget(command, i + op[0].length) - 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** The index after the redirection target starting at `from` — `from` itself if it expands. */
function skipTarget(command, from) {
  let i = from;
  while (command[i] === ' ' || command[i] === '\t') i++;
  const start = i;
  let quote = null;
  for (; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\') i++;
    else if (/[\s;&|()<>]/.test(ch)) break;
  }
  return /[$`]/.test(command.slice(start, i)) ? start : i;
}

/** What follows a `>` that redirects into no file: a descriptor (`>&2`) or exactly /dev/null (also after `>>`). */
const NO_FILE = /^(?:&[\d-]|>?[ \t]{0,4}\/dev\/null(?![^\s;&|()<>]))/;

/** The shell syntax one unquoted character brings in (`next`: up to 16 characters after it). */
function syntaxOf(ch, next, wordStart) {
  if (ch === '`' || (ch === '$' && next[0] === '(') || ((ch === '<' || ch === '>') && next[0] === '(')) return ['substitution', 'command substitution'];
  if (ch === '$') return ['substitution'];
  if (ch === '>') return NO_FILE.test(next) ? ['redirection'] : ['redirection', 'file redirection'];
  if (ch === '<') return ['redirection'];
  if (';&|()\n'.includes(ch)) return ['chaining'];
  if (ch === '#' && wordStart) return ['comment'];
  if ('*?[{'.includes(ch) || (ch === '~' && wordStart)) return ['expansion'];
  return [];
}

/**
 * The shell syntax that makes `command` more than one plain command: `chaining` (`; & | ( )`, a
 * newline), `redirection` (`file redirection` when into a file, /dev/null aside), `substitution` (`command
 * substitution` for `$(`, backticks, `<(`), `expansion` (globs, braces, `~`), `comment`,
 * `unclosed quote`, `control character`. Single-quoted text and escaped characters are plain.
 * @param {string} command a shell command
 * @returns {Set<string>}
 */
export function shellSyntax(command) {
  const found = new Set();
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    // oxlint-disable-next-line no-control-regex -- detecting control characters is the point
    if (/[\0-\x08\x0b-\x1f\x7f]/.test(ch)) found.add('control character');
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '\\') i++;
    else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '$' || ch === '`') for (const f of syntaxOf(ch, command.slice(i + 1, i + 3), false)) found.add(f);
    } else if (ch === "'" || ch === '"') quote = ch;
    else {
      const wordStart = i === 0 || /[\s;&|()<>]/.test(command[i - 1]);
      for (const f of syntaxOf(ch, command.slice(i + 1, i + 17), wordStart)) found.add(f);
    }
  }
  if (quote) found.add('unclosed quote');
  return found;
}

/** Whether `command` is one plain command: nothing chained, piped, redirected, substituted, expanded or commented. */
export const plainCommand = (command) => shellSyntax(command).size === 0;
