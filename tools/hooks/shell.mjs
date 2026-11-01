// Shell-command parsing for the hook guards: the words a command runs with, the shell syntax it
// holds beyond one plain command, and where its redirections point. Splitting a command into its
// segments is shellSegments in common.mjs; what a guard allows is each guard's own policy.
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { realOf } from '../common/paths.mjs';

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
 * @param {string} cwd the folder the command starts in
 * @returns {{along: string[][], now: string[], dirs: string[], unknown: boolean}}
 */
export function dirsAlong(segments, cwd) {
  const dirs = new Set([cwd]);
  const along = [];
  const now = [];
  let current = cwd;
  let unknown = false;
  let seen = [...dirs];
  const vars = assignedVars(segments);
  for (const { exe, args } of segments) {
    along.push(seen);
    now.push(current);
    if (exe !== 'cd' && exe !== 'pushd') continue;
    const target = args.find((arg) => arg === '-' || !arg.startsWith('-'));
    const targets = target === undefined || target === '-' ? null : cdTargets(target, vars, current);
    if (targets === null || dirs.size >= MAX_DIRS) {
      unknown = true;
      continue;
    }
    for (const word of targets) {
      const physical = realOf(word, current);
      dirs.add(resolve(current, word)).add(resolve(cwd, word)).add(physical);
    }
    current = resolve(current, targets.at(-1));
    if (!isDir(current)) unknown = true;
    seen = [...dirs];
  }
  return { along, now, dirs: [...dirs], unknown };
}

/** The folders a `cd` to `target` may lead to, read from `current` (`~`, `$HOME`, `$PWD` and the variables of `vars` replaced); null when it still expands. */
function cdTargets(target, vars, current) {
  const text = homed(target);
  const words = text === null ? [] : withVariables(text, vars, current);
  return words.length === 0 || words.some((word) => /[$`*?[{]/.test(word)) ? null : words;
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

/** `word` with a leading `~` made the home folder, as the shell does; null for a `~user`, which cannot be told. */
export function homed(word) {
  if (word === '~' || word.startsWith('~/')) return homedir() + word.slice(1);
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
 * value is the home folder, as the shell reads it in an assignment.
 * @param {{exe: string|null, args: string[], tokens: string[]}[]} segments from shellSegments
 * @returns {Map<string, string[]>}
 */
export function assignedVars(segments) {
  const vars = new Map();
  for (const { exe, args, tokens } of segments) {
    const words = exe === null ? tokens : VARIABLE_SETTERS.has(exe) ? args : null;
    if (!words) continue;
    for (const [name, value] of Object.entries(assignments(words))) {
      const values = vars.get(name) ?? [];
      if (values.length < MAX_VALUES) vars.set(name, [...values, homed(value) ?? value]);
    }
  }
  return vars;
}

/** The values a variable has: the home folder, the folder `pwd`, a variable the command sets; null when they cannot be told. */
function valuesOf(name, vars, pwd) {
  if (name === 'HOME') return [homedir()];
  if (name === 'PWD') return [pwd];
  return vars.get(name) ?? null;
}

/** `word` with each variable it names that has values replaced by them, one word per combination (at most MAX_VALUES); one that has none stays as written. */
function substituted(word, vars, pwd) {
  let words = [''];
  let last = 0;
  for (const found of word.matchAll(VARIABLE)) {
    const values = valuesOf(found[1] ?? found[2], vars, pwd) ?? [found[0]];
    const literal = word.slice(last, found.index);
    words = words.flatMap((text) => values.map((value) => text + literal + value)).slice(0, MAX_VALUES);
    last = found.index + found[0].length;
  }
  return words.map((text) => text + word.slice(last));
}

/**
 * The words `word` may be once the variables it names are read: `$HOME` and `${HOME}` as the home folder,
 * `$PWD` and `${PWD}` as `pwd` (the folder the word is read from), and a variable `vars` holds (assignedVars)
 * by each of its values, a value that names another variable read again (three passes). A variable with no
 * value stays in the word, which the judging code then skips, as it does any expansion it cannot tell.
 * @param {string} word
 * @param {Map<string, string[]>} vars
 * @param {string} pwd
 * @returns {string[]}
 */
export function withVariables(word, vars, pwd) {
  let words = [word];
  for (let pass = 0; pass < 3 && words.some((text) => text.includes('$')); pass++) {
    words = unique(words.flatMap((text) => (text.includes('$') ? substituted(text, vars, pwd) : [text]))).slice(0, MAX_VALUES);
  }
  return words;
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
  }
  return found;
}

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

/** The real paths the word `word`, read from the real folder `from`, may name once `~` and the variables of `vars` are replaced; none when it still starts with an expansion or is a `~user`. */
function placesOf(word, from, vars) {
  const text = word === null ? null : homed(word);
  if (text === null) return [];
  return withVariables(text, vars, from).filter((one) => !/^[$`*?[{]/.test(one)).map((one) => realOf(one, from));
}

/**
 * Every place a git call, run from the folder `dir`, may work in: its work tree (the folder after the
 * `-C`s, or `--work-tree`), its git directory (`--git-dir`, or null: git finds the repository from the
 * work tree) and `base`, the folder after the `-C`s, which its pathspecs are read from. Real paths, each
 * `-C` followed from the one before as git does. One place for each value a variable in its words may
 * have (`vars`, from {@link assignedVars}); none when a word cannot be told (it expands, or is a `~user`).
 * @param {ReturnType<typeof gitCall>} call
 * @param {string} dir the folder the command runs in
 * @param {Map<string, string[]>} [vars] the variables the command sets
 * @returns {{workTree: string, gitDir: string|null, base: string}[]}
 */
export function gitPlacesAll(call, dir, vars = NO_VARIABLES) {
  let bases = [realOf(dir)];
  for (const word of call.chdirs) bases = unique(bases.flatMap((from) => placesOf(word, from, vars)));
  const places = [];
  for (const base of bases) {
    const workTrees = call.workTree === null ? [base] : placesOf(call.workTree, base, vars);
    const gitDirs = call.gitDir === null ? [null] : placesOf(call.gitDir, base, vars);
    for (const workTree of workTrees) for (const gitDir of gitDirs) places.push({ workTree, gitDir, base });
  }
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
