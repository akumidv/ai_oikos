// Shell-command parsing for the hook guards: the words a command runs with, the shell syntax it
// holds beyond one plain command, and where its redirections point. Splitting a command into its
// segments is shellSegments in common.mjs; what a guard allows is each guard's own policy.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { realOf } from '../common/paths.mjs';
import { stripPrefix } from './common.mjs';

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
/** The longest word a guard reads: a longer one on a judged position is taken to name anything below `/` ({@link withVariables}). */
export const MAX_WORD = 4096;

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

/** {@link realOf} of `word` read from `from`, remembered in `budget` (what the file system holds is read once per command); `known` are the links met before, those of `budget` by default. */
function realAt(word, from, budget, known = budget.links) {
  const key = `${from}\0${word}`;
  if (!budget.real.has(key)) budget.real.set(key, realOf(word, from, known));
  return budget.real.get(key);
}

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Whether `path` is a folder; with a `budget`, remembered in it. */
const isDir = (path, budget) => {
  if (budget?.dirs.has(path)) return budget.dirs.get(path);
  const found = isDirectory(path);
  budget?.dirs.set(path, found);
  return found;
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
  const { dirs, unknown } = dirsAlong(segments, cwd);
  return { dirs, unknown };
}

/**
 * {@link workingDirs} with the order kept: `along[i]` is the folders segment `i` may run in — `cwd`
 * and the `cd`/`pushd` targets before it (its own target excluded) — so a word is judged against the
 * folders it can be read from, not those a later `cd` leads to; `now[i]` is the one folder it runs in
 * when every `cd` before it took effect one after the other. `dirs` is the last of `along`. A `cd` is
 * read as the shell's logical one (`cd link/..` is above `link`) and as a physical one (`cd -P`: above
 * what `link` leads to), both of which `along` holds; `now` follows the logical one.
 * @param {{exe: string|null, args: string[]}[]} segments from shellSegments
 * The target of a `cd` is expanded as any unquoted word is: its braces, and a glob against the file system
 * (every folder it may name joins `dirs`). A glob too wide to expand (a bound of `budget` cut it short, or
 * a brace group too large to list) adds the folder before it to `wide`: the command may be in any folder below it.
 * @param {string} cwd the folder the command starts in
 * @param {ReturnType<typeof newBudget>} [budget] what the command has left to spend on expanding; a fresh one by default
 * @param {Map<string, string[]>} [inherited] the variables the command is run with besides its own (an outer command's, for a command inside it)
 * Where a `cd` may lead to several folders (a glob, a brace group, `CDPATH`, each value of an assigned `HOME`) the command
 * is in every one of them afterwards: `nows[i]` holds them all, `now[i]` the first, and a later relative `cd` is read from each.
 * @returns {{along: string[][], now: string[], nows: string[][], dirs: string[], unknown: boolean, wide: string[]}}
 */
export function dirsAlong(segments, cwd, budget = newBudget(), inherited = NO_VARIABLES) {
  const dirs = new Set([cwd]);
  const along = [];
  const now = [];
  const nows = [];
  let currents = [cwd];
  let unknown = false;
  let seen = [...dirs];
  const wide = new Set();
  const vars = mergedVars(inherited, assignedVars(segments));
  for (const segment of segments) {
    along.push(seen);
    now.push(currents[0]);
    nows.push(currents);
    if (segment.exe !== 'cd' && segment.exe !== 'pushd') continue;
    if (budget.steps <= 0) {
      unknown = true;
      wide.add(resolve('/'));
      continue;
    }
    const step = cdStep(segment, { vars, currents, cwd, budget, dirs });
    unknown ||= step.unknown;
    for (const folder of step.wide) wide.add(folder);
    currents = step.next;
    seen = [...dirs];
  }
  return { along, now, nows, dirs: [...dirs], unknown, wide: [...wide] };
}

/** The most folders the command may be in at one point: more are taken to be any folder below their common one. */
const MAX_CURRENTS = 16;

/** The deepest folder that holds every one of `paths`. */
function commonFolder(paths) {
  const [first, ...rest] = paths.map((path) => path.split('/'));
  let length = first?.length ?? 1;
  for (const parts of rest) {
    let at = 0;
    while (at < length && at < parts.length && parts[at] === first[at]) at++;
    length = at;
  }
  return first ? first.slice(0, length).join('/') || '/' : '/';
}

/**
 * One `cd` or `pushd` read from each folder the command may be in (`currents`): the folders it may lead to, from any of
 * them (`next`: every word it names resolved and every place its globs and `CDPATH` give, bounded by MAX_CURRENTS and
 * by the budget's steps — what is past the steps is `wide`: any folder below `/`, the rest any below their common one), the folders it adds to
 * `dirs`, whether a target cannot be told (`unknown`) and the folders a glob too wide to expand leaves `wide`.
 */
function cdStep(segment, { vars, currents, cwd, budget, dirs }) {
  const step = { next: [], unknown: false, wide: [] };
  for (const current of currents) {
    if (budget.steps-- <= 0) {
      step.unknown = true;
      step.wide.push(resolve('/'));
      step.next.push(current);
      continue;
    }
    const found = cdTargets(segment, vars, current, budget);
    if (found === null || dirs.size >= MAX_DIRS) {
      step.unknown = true;
      step.next.push(current);
      continue;
    }
    step.wide.push(...found.wide);
    reached(dirs, found, { current, cwd, budget });
    const words = found.words.map((word) => resolve(current, word));
    step.unknown ||= words.length === 0 || words.some((word) => !isDir(word, budget));
    step.next.push(...words, ...found.places);
    if (found.words.length === 0 && found.places.length === 0) step.next.push(current);
  }
  step.next = unique(step.next);
  if (step.next.length > MAX_CURRENTS) {
    step.wide.push(commonFolder(step.next));
    step.next = step.next.slice(0, MAX_CURRENTS);
  }
  return step;
}

/** Adds to `dirs` the folders the `found` targets of a `cd` from `current` lead to (a relative one also as read from `cwd`, the folder the command started in, and physically). */
function reached(dirs, { words, places }, { current, cwd, budget }) {
  for (const place of places) dirs.add(place);
  for (const word of words) dirs.add(resolve(current, word)).add(resolve(cwd, word)).add(realAt(word, current, budget));
}

/**
 * The folders the `cd` or `pushd` `segment` may lead to, read from `current` (`~`, `$HOME`, `$PWD` and the
 * variables of `vars` replaced, braces expanded unless the shell reads the word in quotes): `words` that are
 * plain paths, `places` that its globs name and `wide` the folders below which a glob too wide to expand may
 * lead anywhere; null when it has no target, is `-`, or still holds a variable or a substitution.
 */
function cdTargets(segment, vars, current, budget) {
  const env = withPrefix(vars, segment);
  const target = cdWord(segment, env);
  const homes = unique([...(env.get('HOME') ?? []), homedir()]);
  const texts = target ? unique(homes.map((home) => homed(target.word, home)).filter((text) => text !== null)) : [];
  const forms = unique(texts.flatMap((text) => withVariables(text, env, current, { braces: target.braces, budget })));
  if (forms.length === 0 || forms.some((form) => /[$`]/.test(form))) return null;
  const found = { words: [], places: [], wide: [] };
  for (const form of forms) {
    if (hasGlob(form)) addGlobbed(found, form, current, budget);
    else if (!form.includes('{') || !target.braces) found.words.push(form);
  }
  addCdpath(found, forms.filter((form) => !form.includes('{') || !target.braces), env, current, budget);
  return found;
}

/** The values a variable `name` set to `value` has, a leading `~` read with the home folders of `vars` (the assigned `HOME`, then the real one; `HOME` itself with the real one). */
function valuesAs(name, value, vars) {
  if (!value.startsWith('~')) return [value];
  const homes = name === 'HOME' ? [homedir()] : unique([...(vars.get('HOME') ?? []), homedir()]);
  return unique(homes.map((home) => homed(value, home) ?? value));
}

/** `vars` with the variables the `segment` is given as a prefix (`CDPATH=dir cd x`) added to their values. */
export function withPrefix(vars, segment) {
  const given = Object.entries(assignments(segment.tokens.slice(0, executedFrom(segment))));
  if (given.length === 0) return vars;
  const env = new Map(vars);
  for (const [name, value] of given) env.set(name, [...(vars.get(name) ?? []), ...valuesAs(name, value, vars)].slice(0, MAX_VALUES));
  return env;
}

/** The folders `CDPATH` names, from `current`: null when a value cannot be told (it holds an expansion left over); none when it is not set. */
function cdpathFolders(env, current, budget) {
  const folders = [];
  for (const value of env.get('CDPATH') ?? []) {
    for (const text of withVariables(value, env, current, { braces: false, budget })) {
      if (/[$`*?[{]/.test(text)) return null;
      for (const entry of text.split(':')) if (entry !== '') folders.push(resolve(current, entry));
    }
  }
  return unique(folders).slice(0, MAX_DIRS);
}

/**
 * Adds to `found` the folders a relative `cd` target leads to through `CDPATH` — each of its folders joined with the
 * target (a glob target as {@link addGlobbed} reads it) that exists; a `CDPATH` that cannot be told makes `/` wide.
 * A target that starts with `/`, `./` or `../` (or is `.`, `..`) is never searched in `CDPATH`.
 */
function addCdpath(found, forms, env, current, budget) {
  const relative = forms.filter((form) => form !== '' && !isAbsolute(form) && !/^\.\.?(?:\/|$)/.test(form));
  if (relative.length === 0 || !env.has('CDPATH')) return;
  const folders = cdpathFolders(env, current, budget);
  if (folders === null) {
    found.wide.push(resolve('/'));
    return;
  }
  for (const folder of folders) {
    for (const form of relative) {
      const joined = join(folder, form);
      if (hasGlob(joined)) addGlobbed(found, joined, current, budget);
      else if (isDir(joined, budget)) found.places.push(joined);
    }
  }
}

/** The target word of the `cd` or `pushd` `segment`, with whether the shell expands its braces (not in quotes); with none it is `~` when the command sets `HOME` (`env`), else null, as it is for `-`. */
function cdWord({ args, tokens, quoting }, env) {
  const at = args.findIndex((arg) => arg === '-' || !arg.startsWith('-'));
  if (at < 0 && env.has('HOME')) return { word: '~', braces: false };
  if (at < 0 || args[at] === '-') return null;
  return { word: args[at], braces: quoting?.[tokens.length - args.length + at]?.brace !== false };
}

/** Adds to `found` (see {@link cdTargets}) what the glob `form` names from `current`: its places, or — too many or too wide to expand — the folder before it as `wide`. */
function addGlobbed(found, form, current, budget) {
  const { places, complete } = globPlaces(form, current, undefined, budget);
  if (places.length <= MAX_DIRS) found.places.push(...places);
  if (!complete || places.length > MAX_DIRS) found.wide.push(realAt(folderBefore(form), current, budget));
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
  return i ? { ...segment, tokens: rest, quoting: segment.quoting?.slice(i) } : segment;
}

/**
 * Removes the redirections outside quotes (`>f`, `2>&1`, `<<<word`, `&>f`) with their target, so
 * the words left are the arguments the program receives. A target that expands stays as text.
 * @param {string} command a shell command
 * @returns {string}
 */
export const withoutRedirections = (command) => scanRedirections(command).text;

/**
 * Where the redirections outside quotes of `command` write: the file each one opens for writing
 * (`>`, `>>`, `>|`, `&>`, `<>`, `>&file`), as written but for the quotes — a target that expands is
 * given with its expansion, for the caller to judge by what stands before it. `>&2`, `>&-`, reads
 * (`<`, `<<`, `<<<`) and `/dev/null` open no file here.
 * @param {string} command a shell command
 * @returns {{operator: string, target: string}[]}
 */
export function redirectionTargets(command) {
  return scanRedirections(command).redirects
    .filter(({ operator, target }) => /^(?:\d*(?:>>|>\||>&|>)|&>>|&>|\d*<>)$/.test(operator) && !(operator.endsWith('&') && /^(?:\d+-?|-)$/.test(target)) && target !== '')
    .map(({ operator, target }) => ({ operator, target: target.replace(/\\\n/g, '').replace(/[\\'"]/g, '') }));
}

/**
 * What the redirections outside quotes of `command` feed to its programs as input: the text of each here-string
 * (`<<< "text"`, quotes removed) as `here`, and whether anything else is read (`<file`, a heredoc, `<&3`) as `other`.
 * A process substitution (`<(…)`) is neither: it is no redirection of the standard input.
 * @param {string} command a shell command
 * @returns {{here: string[], other: boolean}}
 */
export function inputRedirections(command) {
  const redirects = scanRedirections(command).redirects;
  const reads = redirects.filter(({ operator, target }) => /^\d*(?:<<<|<<-|<<|<&|<)$/.test(operator) && target !== '');
  return {
    here: reads.filter(({ operator }) => operator === '<<<').map(({ target }) => target.replace(/\\\n/g, '').replace(/[\\'"]/g, '')),
    other: reads.some(({ operator }) => operator !== '<<<'),
  };
}

/** The command with its redirections cut out (`text`), and each one's operator and raw target (`redirects`). */
function scanRedirections(command) {
  const operator = /\d*(?:<<<|<<-|<<|<>|<&|>>|>\||>&|<|>)|&>>|&>/y;
  const redirects = [];
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
      const found = targetAt(command, i + op[0].length);
      redirects.push({ operator: op[0], target: command.slice(found.start, found.end) });
      i = (found.expands ? found.start : found.end) - 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  for (const inner of quotedSubstitutions(command)) redirects.push(...scanRedirections(inner).redirects);
  return { text: out, redirects };
}

/** The quote state after the character `ch`: `quote` is the open one (`'` or `"`) or null. */
function quoteAfter(quote, ch) {
  if (quote === null) return ch === "'" || ch === '"' ? ch : null;
  return ch === quote ? null : quote;
}

/** The index of the `)` that closes the substitution whose text starts at `from` (the command's length when it is not closed). */
function closeParen(command, from) {
  let depth = 1;
  let quote = null;
  for (let i = from; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'") i++;
    else if (quote === null && ch === '(') depth++;
    else if (quote === null && ch === ')' && --depth === 0) return i;
    else quote = quoteAfter(quote, ch);
  }
  return command.length;
}

/** The substitution (`$(…)` or backticks) that starts at `command[i]`: its text and the index of its last character, or null. */
function substitutionAt(command, i) {
  if (command[i] === '$' && command[i + 1] === '(') {
    const end = closeParen(command, i + 2);
    return { text: command.slice(i + 2, end), end };
  }
  if (command[i] !== '`') return null;
  const close = command.indexOf('`', i + 1);
  const end = close < 0 ? command.length : close;
  return { text: command.slice(i + 1, end), end };
}

/**
 * The commands inside the substitutions (`$(…)`, backticks) that stand in double quotes in `command`, which
 * the scan for redirections and for commands passes over as quoted text; each is scanned again as a command
 * of its own, so a substitution in one of them is found too. One outside quotes is not here: its text is
 * scanned with the rest.
 * @param {string} command a shell command
 * @returns {string[]}
 */
export function quotedSubstitutions(command) {
  if (!command.includes('$(') && !command.includes('`')) return [];
  const found = [];
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '\\' && quote !== "'") { i++; continue; }
    const inner = quote === '"' ? substitutionAt(command, i) : null;
    if (inner) {
      found.push(inner.text);
      i = inner.end;
    } else quote = quoteAfter(quote, command[i]);
  }
  return found;
}

/** The redirection target starting at `from`: its `start` and `end` in the command, and whether it `expands` (then it is not skipped). */
function targetAt(command, from) {
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
  return { start, end: i, expands: /[$`]/.test(command.slice(start, i)) };
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

/** `word` with a leading `~` made the home folder (`home`: this user's by default), as the shell does; null for a `~user`, which cannot be told. */
export function homed(word, home = homedir()) {
  if (word === '~' || word.startsWith('~/')) return home + word.slice(1);
  return word.startsWith('~') ? null : word;
}

/** The commands whose `NAME=value` words set variables of the shell that goes on. */
const VARIABLE_SETTERS = new Set(['export', 'declare', 'local', 'typeset', 'readonly']);
const VARIABLE = /\$(?:\{(\w+)\}|(\w+))/g;
const MAX_VALUES = 8;

/**
 * The variables a command sets with a bare `NAME=value` or an `export`, `declare`, … (not those given to
 * one program, which its own words never see): a Map from each name to every value it is set to, anywhere
 * in the command — the broader reading, as {@link gitCalls} takes `GIT_DIR`. A `~` at the start of a
 * value is the home folder, as the shell reads it in an assignment: each home the command may have (an assigned `HOME`, the real one).
 * `NAME+=value` makes the variable one the command cannot tell (its value holds an expansion left over).
 * @param {{exe: string|null, args: string[], tokens: string[]}[]} segments from shellSegments
 * @returns {Map<string, string[]>}
 */
export function assignedVars(segments) {
  const given = new Map();
  for (const { exe, args, tokens } of segments) {
    const words = exe === null ? tokens : VARIABLE_SETTERS.has(exe) ? args : null;
    if (!words) continue;
    for (const [name, value] of Object.entries(assignments(words))) {
      const values = given.get(name) ?? [];
      if (values.length < MAX_VALUES) given.set(name, [...values, value]);
    }
  }
  const vars = new Map();
  for (const name of [...given.keys()].sort((a, b) => Number(b === 'HOME') - Number(a === 'HOME'))) {
    vars.set(name, unique(given.get(name).flatMap((value) => valuesAs(name, value, vars))).slice(0, MAX_VALUES));
  }
  return vars;
}

/** The variables of `outer` and of `inner` (assignedVars), each with the values of both. */
export function mergedVars(outer, inner) {
  if (outer.size === 0) return inner;
  const vars = new Map(outer);
  for (const [name, values] of inner) vars.set(name, unique([...(outer.get(name) ?? []), ...values]).slice(0, MAX_VALUES));
  return vars;
}

/** The values a variable has: the home folder, the folder `pwd`, a variable the command sets (`TMPDIR` otherwise the temporary folder of this process); null when they cannot be told. */
function valuesOf(name, vars, pwd) {
  if (name === 'HOME') return unique([...(vars.get('HOME') ?? []), homedir()]);
  if (name === 'PWD') return [pwd];
  return vars.get(name) ?? (name === 'TMPDIR' ? [tmpdir()] : null);
}

const MAX_VARIABLES = 16;

/**
 * What one command may spend on expanding, shared by every word it judges ({@link newBudget}): `listings`
 * folders read and `entries` names looked at for globs, `places` paths they gave, `chars` of words
 * substituted or brace-expanded, `steps` of `cd` read from a folder and `judgements` of a command inside
 * another. `seen` remembers the globs already expanded, `units` the compiled patterns, `links` what the file
 * system holds at the names met ({@link realOf}), `dirs` which paths are folders and `inner` the commands
 * inside others already judged.
 * A spent budget is not an error: what it cannot afford is judged as too wide to tell ({@link globPlaces}, {@link withVariables}).
 */
export const newBudget = () => ({
  listings: MAX_LISTINGS, entries: 50000, places: 1024, chars: 400000, steps: 2048, judgements: 256,
  seen: new Map(), units: new Map(), links: new Map(), real: new Map(), dirs: new Map(), inner: new Set(),
});

/** Whether `budget` (none: unbounded) can spend `chars` more on expanding; it is charged either way. */
function afford(budget, chars) {
  if (!budget) return true;
  const left = budget.chars > 0;
  budget.chars -= chars;
  return left;
}

/** `word` with each variable it names that has values replaced by them, one word per combination (at most MAX_VALUES); one that has none stays as written, as does every variable after the MAX_VARIABLES-th or once `budget` is spent. */
function substituted(word, vars, pwd, budget) {
  if (!afford(budget, word.length)) return [word];
  let words = [''];
  let last = 0;
  let count = 0;
  for (const found of word.matchAll(VARIABLE)) {
    if (++count > MAX_VARIABLES) break;
    const values = valuesOf(found[1] ?? found[2], vars, pwd) ?? [found[0]];
    const literal = word.slice(last, found.index);
    const next = [];
    for (const text of words) for (const value of values) if (next.length < MAX_VALUES) next.push(text + literal + value);
    words = next;
    last = found.index + found[0].length;
  }
  return words.map((text) => text + word.slice(last));
}

/**
 * The words `word` may be once the variables it names are read: `$HOME` and `${HOME}` as the home folder,
 * `$PWD` and `${PWD}` as `pwd` (the folder the word is read from), and a variable `vars` holds (assignedVars)
 * by each of its values, a value that names another variable read again (three passes). A variable with no
 * value stays in the word, which the judging code then skips, as it does any expansion it cannot tell. A
 * word with a brace group (`{../other,x}/f`, a sequence `{1..3}`) is followed by the words the group stands
 * for ({@link braceForms}), so each is judged as the shell expands it; the word as written stays first. A
 * group the guard cannot expand in full (more than MAX_FORMS forms, a sequence it does not list) is
 * followed by the glob `folder/**` instead — any name below the folder before its first brace, which a
 * judge of globs takes to name every mount there; so is a word longer than MAX_WORD (`/**`: anything), and
 * a word with a brace once `budget` is spent.
 * @param {string} word
 * @param {Map<string, string[]>} vars
 * @param {string} pwd
 * @param {{braces?: boolean, budget?: ReturnType<typeof newBudget>}} [options] `braces: false` leaves the braces of the word as text (a word the shell reads inside quotes); `budget` is what the command spends on expanding
 * @returns {string[]}
 */
export function withVariables(word, vars, pwd, { braces = true, budget } = {}) {
  if (word.length > MAX_WORD) return [word, ANYTHING];
  let words = [word];
  for (let pass = 0; pass < 3 && words.some((text) => text.includes('$')); pass++) {
    words = unique(words.flatMap((text) => (text.includes('$') ? substituted(text, vars, pwd, budget) : [text]))).slice(0, MAX_VALUES);
  }
  if (!braces || !words.some((text) => text.includes('{'))) return words;
  const distinct = unique(words.flatMap((text) => (text.includes('{') ? [text, ...bracedForms(text, budget)] : [text])));
  return distinct.length > 2 * MAX_FORMS ? [...distinct.slice(0, 2 * MAX_FORMS), widened(words.find((text) => text.includes('{')))] : distinct;
}

/** The words the braces of `text` stand for, or its {@link widened} glob when it cannot be listed or `budget` cannot pay for it. */
function bracedForms(text, budget) {
  const forms = text.length <= MAX_WORD && afford(budget, text.length) ? braceForms(text) : null;
  if (forms === null) return [widened(text)];
  if (budget) budget.chars -= text.length * forms.length;
  return forms;
}

const MAX_FORMS = 64;
/** The glob that names anything: what a word the guard cannot read at all is taken to be. */
const ANYTHING = '/**';

/** The glob a word with a brace the guard cannot expand is taken to be: any name below the folder before its first brace. */
const widened = (word) => `${word.slice(0, word.lastIndexOf('/', word.indexOf('{')) + 1)}**`;

const SEQUENCE = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/;
/** The longest body of braces `{x..y}` that is read as a sequence expression. */
const MAX_SEQUENCE = 64;

/** The text of the integer `value`, `width` digits at least (the shell pads when an end of the sequence has a leading zero). */
const padded = (value, width) => `${value < 0 ? '-' : ''}${String(Math.abs(value)).padStart(width, '0')}`;

/** The members of the sequence expression `body` (`1..3`, `a..e..2`, `01..10`): undefined when `body` is no sequence (the braces are text); null when it has a step of 0 or more than MAX_FORMS members, which the guard does not list. */
function sequenceMembers(body) {
  const match = SEQUENCE.exec(body);
  if (!match) return undefined;
  const numeric = match[1] !== undefined;
  const from = numeric ? Number(match[1]) : match[3].charCodeAt(0);
  const to = numeric ? Number(match[2]) : match[4].charCodeAt(0);
  const step = Math.abs(Number(match[5] ?? 1));
  const count = Math.floor(Math.abs(to - from) / step) + 1;
  if (step === 0 || !(count <= MAX_FORMS)) return null;
  const width = numeric ? paddingOf(match[1], match[2]) : 0;
  const direction = to >= from ? 1 : -1;
  return Array.from({ length: count }, (_, k) => (numeric ? padded(from + direction * k * step, width) : String.fromCharCode(from + direction * k * step)));
}

/** The width a numeric sequence from `first` to `last` pads to: that of the longer end when either has a leading zero, else none. */
function paddingOf(first, last) {
  const zeroed = [first, last].some((end) => /^-?0\d/.test(end));
  return zeroed ? Math.max(first.replace('-', '').length, last.replace('-', '').length) : 0;
}

/**
 * The brace groups of `word` found in one pass: `groups` maps the index of the `{` of each to its `close`
 * and its top-level commas (`cuts`) or, for a sequence, its `members`; `total` is how many words the whole
 * brace expansion gives (more than MAX_FORMS is counted as MAX_FORMS + 1), and `listable` is false when
 * a sequence is one the guard does not list. `${…}` is no group, and a brace with no top-level comma
 * (`{a}`, `{}`) or one that is not closed is text. Linear in the word's length.
 */
function scanBraces(word) {
  const cap = MAX_FORMS + 1;
  const groups = new Map();
  const stack = [{ sum: 0, prod: 1, all: 1 }];
  let listable = true;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    const top = stack.at(-1);
    if (ch === '{') stack.push({ open: i, dollar: word[i - 1] === '$', cuts: [], sum: 0, prod: 1, all: 1 });
    else if (ch === ',' && stack.length > 1 && !top.dollar) {
      top.cuts.push(i);
      top.sum = Math.min(cap, top.sum + top.prod);
      top.prod = 1;
    } else if (ch === '}' && stack.length > 1) {
      stack.pop();
      const closed = closeGroup(word, top, i, groups);
      listable &&= closed.listable;
      const parent = stack.at(-1);
      parent.prod = Math.min(cap, parent.prod * closed.count);
      parent.all = Math.min(cap, parent.all * closed.count);
    }
  }
  while (stack.length > 1) {
    const unclosed = stack.pop();
    stack.at(-1).all = Math.min(cap, stack.at(-1).all * unclosed.all);
  }
  return { groups, total: stack[0].all, listable };
}

/** Records the group `top` of `word` that closes at `close` in `groups` when it is one; its `count` of words (for text, what its contents give) and whether the guard `listable` lists it ({@link scanBraces}). */
function closeGroup(word, top, close, groups) {
  if (top.dollar) return { count: top.all, listable: true };
  if (top.cuts.length) {
    groups.set(top.open, { close, cuts: top.cuts });
    return { count: Math.min(MAX_FORMS + 1, top.sum + top.prod), listable: true };
  }
  const members = close - top.open <= MAX_SEQUENCE ? sequenceMembers(word.slice(top.open + 1, close)) : undefined;
  if (!members) return { count: top.all, listable: members !== null };
  groups.set(top.open, { close, cuts: [], members });
  return { count: members.length, listable: true };
}

/** The words the text of `word` between `from` and `to` gives, the `groups` of scanBraces expanded left to right. */
function formsBetween(word, groups, from, to) {
  let forms = [''];
  let literal = from;
  for (let i = from; i < to; i++) {
    const group = word[i] === '{' ? groups.get(i) : undefined;
    if (!group) continue;
    forms = forms.map((form) => form + word.slice(literal, i));
    const parts = group.members ?? alternatives(word, groups, i, group);
    forms = forms.flatMap((form) => parts.map((part) => form + part));
    i = group.close;
    literal = i + 1;
  }
  return forms.map((form) => form + word.slice(literal, to));
}

/** The words each alternative of the comma group that opens at `open` gives, in order. */
function alternatives(word, groups, open, { close, cuts }) {
  const bounds = [open, ...cuts, close];
  return bounds.slice(0, -1).flatMap((start, n) => formsBetween(word, groups, start + 1, bounds[n + 1]));
}

/**
 * The words a brace expansion of `word` gives (`{../other,x}/f` is `../other/f` and `x/f`; nested groups,
 * several groups and sequences such as `{1..3}` or `{a..c}` too), in the shell's order; a word with no group
 * is its own only form. A brace that is no group (no comma, not closed) stays text, as in the shell. Null
 * when there are more than `limit` forms (at most MAX_FORMS are listed) or the word holds a sequence the
 * guard does not list (more than MAX_FORMS members): the caller then cannot tell what the word names.
 * @param {string} word
 * @param {number} [limit]
 * @returns {string[]|null}
 */
export function braceForms(word, limit = MAX_FORMS) {
  const { groups, total, listable } = scanBraces(word);
  if (!listable || total > Math.min(limit, MAX_FORMS)) return null;
  return groups.size === 0 ? [word] : formsBetween(word, groups, 0, word.length);
}


/** Whether `word` holds a character of a glob (`*`, `?`, `[`). */
export const hasGlob = (word) => /[*?[]/.test(word);

/** The units of the glob `pattern`: `*`, `?`, a bracket expression as a RegExp (one that cannot be read is `?`, any character) or a lowercase character. */
function globUnits(pattern) {
  const units = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const negated = ch === '[' && /^[!^]/.test(pattern.slice(i + 1, i + 2));
    const close = ch === '[' ? bracketEnd(pattern, i + (negated ? 3 : 2)) : -1;
    if (ch === '*') {
      if (units.at(-1) !== '*') units.push('*');
    } else if (close >= 0) {
      units.push(bracketUnit(pattern.slice(i + 1 + (negated ? 1 : 0), close), negated));
      i = close;
    } else units.push(ch === '?' ? '?' : ch.toLowerCase());
  }
  return units;
}

/** The index of the `]` that closes the bracket expression of `pattern` whose body starts at or after `from`, passing the `[:class:]` inside it; -1 when it is not closed. */
function bracketEnd(pattern, from) {
  let close = pattern.indexOf(']', from);
  while (close >= 0 && pattern.slice(from - 2, close).split('[:').length > pattern.slice(from - 2, close).split(':]').length) close = pattern.indexOf(']', close + 1);
  return close;
}

/** The unit of the bracket expression with `body` between its brackets. */
function bracketUnit(body, negated) {
  if (body.includes('[')) return '?';
  try {
    return new RegExp(`^[${negated ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]$`, 'i');
  } catch {
    return '?';
  }
}

const unitMatches = (unit, ch) => unit === '?' || (typeof unit === 'string' ? unit === ch : unit.test(ch));

/**
 * Whether the glob `pattern` — one path component — matches `name`, as a guard needs it: case does not
 * matter (a file system may fold it) and a leading dot is matched like any character, so a pattern is
 * never taken to miss a name the shell might give it. Linear in the two lengths, no RegExp backtracking.
 * @param {string} pattern
 * @param {string} name
 * @param {Map<string, ReturnType<typeof globUnits>>} [compiled] patterns already read, to be reused by a caller that matches one against many names
 * @returns {boolean}
 */
export function globMatches(pattern, name, compiled) {
  const units = compiled?.get(pattern) ?? globUnits(pattern);
  compiled?.set(pattern, units);
  const text = name.toLowerCase();
  let u = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (units[u] === '*') {
      star = u++;
      mark = t;
    } else if (u < units.length && unitMatches(units[u], text[t])) {
      u++;
      t++;
    } else if (star >= 0) {
      u = star + 1;
      t = ++mark;
    } else return false;
  }
  while (units[u] === '*') u++;
  return u === units.length;
}

const MAX_LISTINGS = 64;
const MAX_PLACES = 256;
/** The longest glob component expanded: a longer one is taken to be too wide to tell. */
const MAX_COMPONENT = 256;

/** The entries of the folder `dir`, counted against the command's budget; null once that is spent, none when the folder cannot be read. */
function entriesOf(dir, { budget }) {
  if (budget.listings <= 0 || budget.entries <= 0) return null;
  budget.listings--;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    budget.entries -= entries.length;
    return entries;
  } catch {
    return [];
  }
}

/** Whether `state` may take one more place: neither this word's MAX_PLACES nor the command's are spent; false marks the expansion as cut short. */
function roomFor(state) {
  const room = state.places.length < MAX_PLACES && state.budget.places > 0;
  if (!room) state.complete = false;
  return room;
}

/** Adds the real path `at` to the places of `state`, when there is room for it. */
function takePlace(at, state) {
  if (!roomFor(state)) return;
  state.budget.places--;
  state.places.push(at);
}

/** Walks the glob components `comps` from the real folder `here`, adding to `state.places` the real path of every name they may give: a literal component is followed (a link before the next `..`), a glob one is matched against the entries of the folder. */
function walkGlob(here, comps, state, known) {
  let at = here;
  let i = 0;
  for (; i < comps.length && !hasGlob(comps[i]); i++) at = realAt(comps[i], at, state.budget, known);
  if (i === comps.length) return takePlace(at, state);
  if (comps[i].length > MAX_COMPONENT) {
    state.complete = false;
    return;
  }
  if (comps[i] === '**') walkGlob(at, comps.slice(i + 1), state, known);
  const entries = entriesOf(at, state);
  state.complete &&= entries !== null;
  for (const entry of entries ?? []) {
    if (!roomFor(state)) return;
    walkEntry(entry, at, comps.slice(i), state, known);
  }
}

/** Follows the glob components `comps` (the first is a glob) through `entry` of the real folder `at`: into it when the first matches its name (a folder, unless the glob ends there) and, for `**`, below it. */
function walkEntry(entry, at, [comp, ...rest], state, known) {
  const folder = entry.isDirectory() || entry.isSymbolicLink();
  if (comp === '**' && folder) walkGlob(realAt(entry.name, at, state.budget, known), [comp, ...rest], state, known);
  if ((rest.length === 0 || folder) && globMatches(comp, entry.name, state.budget.units)) walkGlob(realAt(entry.name, at, state.budget, known), rest, state, known);
}

/**
 * The real paths a word with a glob may name, found by expanding it against the file system, component
 * by component: what is not there yet (a new file after the glob) is carried along as written — the
 * shell leaves a glob that matches nothing as it is — and a link a component matches is followed. Bounded:
 * a word takes at most MAX_PLACES paths, and everything a command expands draws on one `budget`
 * ({@link newBudget}: folders read, names looked at, paths taken), the globs it has already expanded
 * costing nothing again. `complete` is false when a bound cut the expansion short (or a component is longer
 * than MAX_COMPONENT), and the caller then judges as for a glob it cannot tell. `**` is any number of folders.
 * @param {string} word a path with a glob, as the shell reads it from `from`
 * @param {string} from the folder a relative word is read from
 * @param {Map<string, string|null|undefined>} [known] the links met before ({@link realOf})
 * @param {ReturnType<typeof newBudget>} [budget] what the command has left to spend; a fresh one by default
 * @returns {{places: string[], complete: boolean}}
 */
export function globPlaces(word, from, known, budget = newBudget()) {
  const key = `${from}\0${word}`;
  if (budget.seen.has(key)) return budget.seen.get(key);
  const state = { places: [], complete: true, budget };
  const links = known ?? budget.links;
  const start = word.startsWith('/') ? '/' : realAt(from, from, budget, links);
  walkGlob(start, word.split('/').filter((comp) => comp !== '' && comp !== '.'), state, links);
  const found = { places: unique(state.places), complete: state.complete };
  budget.seen.set(key, found);
  return found;
}

/**
 * `segments` with the program of a segment that names a variable the command sets (`G=git; $G -C vault commit`,
 * `G=gi; ${G}t …`: the word with each variable replaced by its value) read as that value, when `score` rates the program that makes it above 0. A value may be several words
 * (`G="git -C vault"`) and may start with a wrapper; of the values the command sets it to, the one with
 * the best score is taken (the command may run it in any order); a segment stays as it is when none scores.
 * @param {{exe: string|null, args: string[], viaEnv: boolean, tokens: string[]}[]} segments from shellSegments
 * @param {Map<string, string[]>} vars from {@link assignedVars}
 * @param {(exe: string|null) => number} score how much a guard cares about a program: 0 for none
 * @returns {{exe: string|null, args: string[], viaEnv: boolean, tokens: string[]}[]}
 */
export function withProgramVariables(segments, vars, score) {
  return segments.map((segment) => {
    if (!segment.exe?.includes('$')) return segment;
    const at = executedFrom(segment);
    let best = segment;
    let bestScore = 0;
    for (const value of withVariables(segment.exe, vars, '.', { braces: false }).filter((form) => !form.includes('$'))) {
      const inner = value.split(/\s+/).filter(Boolean);
      const quoting = segment.quoting ?? segment.tokens.map(() => null);
      const read = stripPrefix([...segment.tokens.slice(0, at), ...inner, ...segment.tokens.slice(at + 1)], {
        quoting: [...quoting.slice(0, at), ...inner.map(() => null), ...quoting.slice(at + 1)],
        heredoc: segment.heredoc,
      });
      if (score(read.exe) > bestScore) [best, bestScore] = [read, score(read.exe)];
    }
    return best;
  });
}

/** The options of `git` itself (before the subcommand) that take a value as the next word. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--attr-source']);
/**
 * The variables that give a git call a configuration value, or a program to run, as `-c` does: the
 * configuration files it reads, and the editor, pager, diff, ssh, askpass and proxy commands it starts.
 */
const GIT_CONFIG_ENV = new Set([
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER',
  'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND',
]);

/** The `NAME=value` words of a list as an object. */
function assignments(words) {
  const found = {};
  for (const word of words) {
    const at = word.indexOf('=');
    if (at > 0 && ASSIGNMENT.test(word)) found[word.slice(0, at)] = word.slice(at + 1);
    else if (at > 1 && APPENDING.test(word)) found[word.slice(0, at - 1)] = APPENDED;
  }
  return found;
}

/** `NAME+=value`: the variable is its old value and more. */
const APPENDING = /^[A-Za-z_][A-Za-z0-9_]*\+=/;
/** What a variable is once `NAME+=` appended to it: a value the guard cannot tell (an expansion it does not read). */
const APPENDED = '$appended';

/**
 * One git call read from its words: the subcommand and what follows it (past git's own options), the
 * folders it is told to change to (`-C`, in order, and `env -C`), the git directory and the work tree
 * it is given (`--git-dir`, `--work-tree`, or `GIT_DIR`, `GIT_WORK_TREE` in `env`), and whether it
 * carries a configuration value or a program to run (`-c`, `--config-env`, a variable of GIT_CONFIG_ENV).
 * @param {{args: string[], tokens: string[]}} segment a segment whose program is git (shellSegments)
 * @param {Record<string, string>} [env] variables set earlier in the command (`export GIT_DIR=…`)
 * @returns {{sub: string|undefined, rest: string[], chdirs: string[], gitDir: string|null, workTree: string|null, configured: boolean}}
 */
export function gitCall(segment, env = {}) {
  const { args } = segment;
  const before = segment.tokens.slice(0, executedFrom(segment));
  const vars = { ...env, ...assignments(before) };
  const call = {
    chdirs: envChdirs(before),
    gitDir: vars.GIT_DIR ?? null,
    workTree: vars.GIT_WORK_TREE ?? null,
    configured: Object.keys(vars).some((name) => GIT_CONFIG_ENV.has(name)),
  };
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) i = gitOption(call, args, i);
  return { sub: args[i], rest: args.slice(i + 1), ...call };
}

/** The folders `env -C <dir>` / `env --chdir=<dir>` in the words before a command changes to. */
function envChdirs(before) {
  const dirs = [];
  before.forEach((word, i) => {
    if ((word === '-C' || word === '--chdir') && before[i + 1] !== undefined) dirs.push(before[i + 1]);
    else if (word.startsWith('--chdir=')) dirs.push(word.slice('--chdir='.length));
  });
  return dirs;
}

/** Reads the option of git itself at `args[i]` into `call`; the index of its last word (its value follows it unless written `--name=value`). */
function gitOption(call, args, i) {
  const [name, inline] = args[i].split(/=(.*)/s);
  const value = inline ?? args[i + 1] ?? '';
  if (name === '-C') call.chdirs.push(value);
  else if (name === '--git-dir') call.gitDir = value;
  else if (name === '--work-tree') call.workTree = value;
  else if (name === '-c' || name === '--config-env') call.configured = true;
  return inline === undefined && GIT_VALUE_OPTIONS.has(name) ? i + 1 : i;
}

/**
 * The git calls of a command, by segment: a Map from each segment whose program is `git` to its
 * {@link gitCall}. A variable set by a bare assignment or by `export` (`GIT_DIR=x; git …`) goes to
 * every git call after it, in any subshell too — the broader reading.
 * @param {{exe: string|null, args: string[], tokens: string[]}[]} segments from shellSegments
 * @returns {Map<object, ReturnType<typeof gitCall>>}
 */
export function gitCalls(segments) {
  const calls = new Map();
  let env = {};
  for (const segment of segments) {
    if (segment.exe === 'git') calls.set(segment, gitCall(segment, env));
    else if (segment.exe === null) env = { ...env, ...assignments(segment.tokens) };
    else if (segment.exe === 'export') env = { ...env, ...assignments(segment.args) };
  }
  return calls;
}

const NO_VARIABLES = new Map();

/** The folder before the first glob character of `word`, as the text of a path (`.` when there is none). */
const folderBefore = (word) => word.slice(0, word.lastIndexOf('/', word.search(/[*?[]/)) + 1) || '.';

/**
 * The real paths the word `word`, read from the real folder `from`, may name once `~`, the variables of
 * `vars` and the braces are replaced and a glob is expanded against the file system ({@link globPlaces}; a
 * glob that matches nothing stays the word as written); none when it still starts with an expansion or is a `~user`.
 * `wide` lists the real folders below which the word may name any path, as a glob too wide to expand does
 * (a bound cut it short): the caller judges them as it judges a glob of that kind.
 */
function placesOf(word, from, vars, budget) {
  const text = word === null ? null : homed(word);
  if (text === null) return { places: [], wide: [] };
  const places = [];
  const wide = [];
  for (const one of withVariables(text, vars, from, { budget }).filter((form) => !/^[$`{]/.test(form))) {
    const { places: matched, complete } = hasGlob(one) ? globPlaces(one, from, undefined, budget) : { places: [], complete: true };
    places.push(...(matched.length ? matched : [realAt(one, from, budget)]));
    if (!complete) wide.push(realAt(folderBefore(one), from, budget));
  }
  return { places, wide };
}

/**
 * Every place a git call, run from the folder `dir`, may work in: its work tree (the folder after the
 * `-C`s, or `--work-tree`), its git directory (`--git-dir`, or null: git finds the repository from the
 * work tree) and `base`, the folder after the `-C`s, which its pathspecs are read from. Real paths, each
 * `-C` followed from the one before as git does. One place for each value a variable in its words may
 * have (`vars`, from {@link assignedVars}); none when a word cannot be told (it expands, or is a `~user`).
 * A word that is a glob too wide to expand (or a brace group too wide to list) adds a last place with
 * `wide`: the call may work in any repository below that folder (its `workTree`, `gitDir` and `base`).
 * @param {ReturnType<typeof gitCall>} call
 * @param {string} dir the folder the command runs in
 * @param {Map<string, string[]>} [vars] the variables the command sets
 * @param {ReturnType<typeof newBudget>} [budget] what the command has left to spend on expanding; a fresh one by default
 * @returns {{workTree: string, gitDir: string|null, base: string, wide?: true}[]}
 */
export function gitPlacesAll(call, dir, vars = NO_VARIABLES, budget = newBudget()) {
  let bases = [realAt(dir, dir, budget)];
  const wide = [];
  for (const word of call.chdirs) {
    bases = unique(bases.flatMap((from) => {
      const found = placesOf(word, from, vars, budget);
      wide.push(...found.wide);
      return found.places;
    })).slice(0, MAX_PLACES);
  }
  const places = [];
  for (const base of bases) {
    const workTrees = call.workTree === null ? { places: [base], wide: [] } : placesOf(call.workTree, base, vars, budget);
    const gitDirs = call.gitDir === null ? { places: [null], wide: [] } : placesOf(call.gitDir, base, vars, budget);
    wide.push(...workTrees.wide, ...gitDirs.wide);
    for (const workTree of workTrees.places) for (const gitDir of gitDirs.places) places.push({ workTree, gitDir, base });
  }
  for (const folder of unique(wide)) places.push({ workTree: folder, gitDir: folder, base: folder, wide: true });
  return places;
}

/**
 * Where a git call, run from the folder `dir`, works: the first of {@link gitPlacesAll}, as its work
 * tree and its git directory; null when a word cannot be told (it expands, or is a `~user`).
 * @param {ReturnType<typeof gitCall>} call
 * @param {string} dir the folder the command runs in
 * @param {Map<string, string[]>} [vars] the variables the command sets
 * @returns {{workTree: string, gitDir: string|null}|null}
 */
export function gitPlaces(call, dir, vars = NO_VARIABLES) {
  const [first] = gitPlacesAll(call, dir, vars);
  return first ? { workTree: first.workTree, gitDir: first.gitDir } : null;
}
