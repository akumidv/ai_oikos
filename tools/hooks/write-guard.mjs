#!/usr/bin/env node
// Enforces "writes need confirmation" (OIKOS.md) for every oikos tool that changes a remote
// service: the tools and commands listed in tools/hooks/writes.mjs, and nothing else.
//
// A changing command (tools/hooks/writes.mjs) runs for real only if the same command was first
// run with --dry-run in this session AND the user has sent a prompt since — i.e. the user has
// seen the dry run and had a turn to answer. Otherwise the call is denied with the reason, in
// every permission mode, so auto mode cannot skip the step. The hook cannot judge what the user
// answered; it guarantees the dry run was shown and the user had the word.
//
// Wired twice: UserPromptSubmit counts the user's prompts, PreToolUse(shell) checks the command.
// An allow-list that fails closed for what the command text shows. Known limits — what the text
// cannot show: arguments read from files (`xargs -a`, a script written earlier and run now), globs
// that expand to file names prepared earlier (`node *`), variables set outside the command (the
// environment), and `node -e` code that imports tools/common.
// - a direct HTTP write to a connected service — `curl`/`wget` with a writing method or a body
//   to a host of CONNECTED_HOSTS or of the installation's site settings (or one the shell
//   expands), `gh api` with a writing method or fields (a GraphQL call: a mutation, or a query
//   the guard cannot read) — is denied: the oikos tool does it, with its dry run. curl's config
//   files count as its command line: `-K`/`--config <file>` and the user's `$CURL_HOME/.curlrc`
//   and `~/.curlrc` (unless `-q`/`--disable` is the first option), each read when it is a regular
//   file of at most 64 KB; one that cannot be read (`-K -`, a path the shell expands, a missing,
//   special or larger file) counts as a write, to the hosts the command line names;
// - code handed to another shell — the string of `bash|sh|zsh|dash [options] -c <string>`, also
//   behind a wrapper (`timeout`, `env`), and the words of `eval` — is classified the same way, up
//   to three levels deep. A literal read is a read; an oikos write or a direct HTTP write in it is
//   denied, to be run as a standalone command; a string the outer shell expands is denied when it
//   holds a write command word or an HTTP write option;
// - a command that does not mention a write tool passes. A tool is mentioned only through its
//   script: `<tool>/cli.mjs` in the text (backslashes and quotes removed), a word that really
//   leads to its cli.mjs (symlinks, `..`, literal `cd`s), a cli.mjs the guard cannot pin (a
//   relative one after an unknown `cd`, one inside a word of code), the tool's name as the script
//   of a package runner (`npm run jira`), or a word the shell may expand into a cli.mjs where it
//   may run — anywhere but in a segment that only reads, and anywhere at all once the command
//   substitutes or pipes or redirects into a file next to a segment that does not only read;
// - a mention with no write command word in the text and nothing the shell expands passes too;
// - otherwise it passes only in the strict form — one plain command `[VAR=…] node <path to
//   tools/<tool>/cli.mjs> <command> …`: nothing chained, piped, redirected, substituted,
//   expanded or commented — or as a read: every part a reader (cat, grep, rg, cut, sort, find
//   without actions, git log …), a `cd`, a bare assignment, a loop or `if` around such parts, a
//   strict-form call of a read command, a literal `bash -c`/`eval` read, or a call of a script it
//   cannot pin whose command word is literal and no tool's write command, with no substitution and
//   no redirection into a file. A part whose command word expands (`$CMD …`) is never a read, and
//   no part with a word the shell expands is one once the command holds a write command word
//   anywhere, quoted or not (`V='… comment'; node $V`). Anything else is denied; a guard failure
//   is a deny too;
// - in the strict form `--help` before `--` is help, `--dry-run` before `--` a dry run, and
//   "the same command" is the working folder and the tokens with `--dry-run` removed.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { CORE_ROOT } from '../common/paths.mjs';
import { print, readState, shellSegments, writeState } from './common.mjs';
import { shellCommand } from './host.mjs';
import { WRITES } from './writes.mjs';

/** Characters the shell may expand in a word: parameters, substitutions, globs, braces. */
const EXPANDS = /[$`*?[{]/;
/** A word that is a plain path and nothing else. */
const CLEAN_PATH = /^[\w@%+:./-]+$/;
/** A word that is a path the shell may expand: path characters and expansions, no code. */
const EXPANDING_PATH = /^[\w@%+:./${}*?[\],~-]+$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_WORD = /^[a-z][a-z-]*$/;
const READERS = new Set([
  'cat', 'head', 'tail', 'less', 'wc', 'ls', 'stat', 'file', 'diff', 'grep', 'egrep', 'rg', 'realpath', 'readlink',
  'md5sum', 'sha256sum', 'echo', 'printf', 'cut', 'sort', 'uniq', 'tr', 'jq', 'nl', 'column', 'basename', 'dirname',
]);
/** git subcommands that only read, plus `commit`, whose message may mention a tool as text. */
const GIT_READS = new Set(['log', 'diff', 'show', 'status', 'grep', 'blame', 'commit']);
/** git options that run a command or bring in configuration. */
const GIT_RUNS = /^(?:-c|--config-env|--exec-path|-O|--open-files-in-pager|--ext-diff)/;
/** find actions that run a command or write a file. */
const FIND_ACTS = /^-(?:exec|execdir|ok|okdir|delete|fls|fprint\w*)$/;
/** A `sed -n` script that only prints line ranges: `179,184p;222,226p`. */
const SED_PRINTS = /^\d+(?:,(?:\d+|\$))?p(?:;\d+(?:,(?:\d+|\$))?p)*;?$/;
/** Words that open or continue a compound command; the command after them is its body. */
const OPENERS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do']);
/** Words that close a compound command. */
const CLOSERS = new Set(['done', 'fi', 'esac']);
/** Programs that run a package's script by its name (`npm run jira`). */
const RUNNERS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno', 'corepack']);
const MAX_DIRS = 16;

/**
 * The hosts of the services oikos connects to, whatever the installation: `*.x` is `x` and its
 * subdomains. The installation's own sites (SITE_SETTINGS) are added at run time.
 */
export const CONNECTED_HOSTS = Object.freeze(['*.atlassian.net', 'api.github.com', 'github.com', 'gitlab.com', '*.slack.com', '*.googleapis.com']);
/** The installation's settings that name a connected site (tools/common/env.mjs `lookup`). */
const SITE_SETTINGS = ['JIRA_BASE_URL', 'CONFLUENCE_BASE_URL', 'GITLAB_URL', 'GITHUB_API_URL', 'GITHUB_SERVER_URL'];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** curl's options that take a value: the short letters and the long names. */
const CURL_SHORT = 'AbcCdDeEFHKmoPQrtTuUwxXyYz';
const CURL_LONG = new Set([
  '--request', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--form', '--form-string',
  '--upload-file', '--json', '--header', '--user', '--user-agent', '--referer', '--cookie', '--cookie-jar', '--output',
  '--output-dir', '--write-out', '--proxy', '--proxy-user', '--cert', '--key', '--cacert', '--capath', '--config',
  '--max-time', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time', '--range', '--url', '--url-query',
  '--oauth2-bearer', '--resolve', '--connect-to', '--limit-rate', '--max-filesize', '--interface', '--dns-servers',
  '--unix-socket', '--aws-sigv4', '--variable', '--continue-at', '--dump-header', '--stderr', '--trace',
  '--trace-ascii', '--netrc-file', '--time-cond', '--local-port', '--keepalive-time', '--max-redirs', '--request-target',
]);
/** curl's options that send a body. */
const CURL_BODY = /^(?:-d|-F|-T|--data(?:-\w+)?|--form(?:-string)?|--upload-file|--json)$/;
/** wget's options that take a value. */
const WGET_SHORT = 'aABDeiIloOPQRtTUwX';
const WGET_LONG = new Set([
  '--method', '--post-data', '--post-file', '--body-data', '--body-file', '--header', '--user', '--password',
  '--http-user', '--http-password', '--output-document', '--output-file', '--append-output', '--execute', '--input-file',
  '--base', '--tries', '--timeout', '--wait', '--quota', '--directory-prefix', '--user-agent', '--level', '--accept',
  '--reject', '--domains', '--include-directories', '--exclude-directories', '--load-cookies', '--save-cookies',
  '--referer', '--bind-address', '--limit-rate', '--ca-certificate', '--certificate', '--private-key',
]);
/** wget's options that send a body or set the method; getopt takes any unambiguous prefix of them. */
const WGET_WRITES = ['--method', '--post-data', '--post-file', '--body-data', '--body-file'];
/** A wgetrc command (`-e`) that sends a body or sets the method. */
const WGET_RC_WRITE = /^\s*(?:post_?data|post_?file|body_?data|body_?file|method)\s*=/i;
/** `gh api`'s options that take a value. */
const GH_SHORT = 'XfFHqtp';
const GH_LONG = new Set(['--method', '--raw-field', '--field', '--header', '--input', '--jq', '--template', '--cache', '--preview', '--hostname']);
const GH_FIELDS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);
/** A GraphQL operation that changes data: the word `mutation`, in any case. */
const MUTATION = /\bmutation\b/i;
/** The largest curl config file the guard reads; a larger one counts as unreadable. */
const CURL_CONFIG_MAX = 64 * 1024;
/** The shells whose `-c` string the guard reads as a command of its own. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
/** Programs that only run the command after them: a shell behind one is still the command run. */
const SHELL_WRAPPERS = new Set(['timeout', 'nice', 'ionice', 'stdbuf', 'setsid']);
/** How many levels of `bash -c` / `eval` the guard reads; deeper code is code it cannot read. */
const MAX_DEPTH = 3;
/** Shell special parameters that expand to digits or option letters, never to a path. */
const SPECIAL_PARAMETERS = '?#$!-';
/** curl, wget or `gh api` in code the guard cannot read, and an option of theirs that may write. */
const HTTP_PROGRAM = /(?:^|[^\w-])(?:curl|wget|gh\s+api)(?![\w-])/;
const HTTP_WRITE_OPTION = /(?:^|\s)(?:-[A-Za-z]*[XdFTKfe]|--(?:request|method|data|form|upload-file|json|post|body|field|raw-field|input|config|execute))/;

const unique = (list) => [...new Set(list)];

/**
 * Whether a word may be other than it reads: it holds an expansion character and the command
 * expands somewhere. The lexer drops quotes, so the command's syntax decides for every word.
 * @param {string} word a word of the command, quotes removed
 * @param {Set<string>} syntax the command's shell syntax (shellSyntax)
 * @returns {boolean}
 */
const mayExpand = (word, syntax) => (/[$`]/.test(word) && syntax.has('substitution')) || (/[*?[{~]/.test(word) && syntax.has('expansion'));

/** Every tool's write command words (writes.mjs). */
const allVerbs = (writes) => unique(Object.values(writes).flat());

/** The words a segment runs with: its command word and every word after it (none without a command). */
function executedWords(segment) {
  if (segment.exe === null) return [];
  return segment.tokens.slice(segment.tokens.length - segment.args.length - 1);
}

const real = (path) => {
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

/** Each write tool's cli.mjs by its real path. */
function realClis(writes) {
  const found = new Map();
  for (const tool of Object.keys(writes)) {
    const path = real(resolve(CORE_ROOT, 'tools', tool, 'cli.mjs'));
    if (path) found.set(path, tool);
  }
  return found;
}

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
function bodyOf(segment) {
  const { tokens } = segment;
  let i = 0;
  while (i < tokens.length && OPENERS.has(tokens[i])) i++;
  const rest = tokens.slice(i);
  if (rest.length === 0 || rest[0] === 'for' || rest[0] === 'case' || (rest.length === 1 && CLOSERS.has(rest[0]))) {
    return { exe: null, args: [], viaEnv: false, tokens: rest, control: true };
  }
  return i ? { ...segment, tokens: rest } : segment;
}

/** Whether `base` (a basename) may be expanded by the shell into `cli.mjs`. */
function couldBeCli(base) {
  let pattern = '';
  for (let i = 0; i < base.length; i++) {
    const ch = base[i];
    const close = { '`': '`', '{': '}', '[': ']' }[ch];
    const end = close ? base.indexOf(close, i + 1) : -1;
    if (ch === '$' && SPECIAL_PARAMETERS.includes(base[i + 1] ?? 'x')) {
      // `$?`, `$#`, `$$`, `$!`, `$-`: digits or option letters (`echo "exit=$?"`).
      i++;
      pattern += '\\w*';
    } else if (ch === '$') {
      if (base[i + 1] === '{') i = Math.max(base.indexOf('}', i), i);
      else while (/\w/.test(base[i + 1] ?? '')) i++;
      pattern += '.*';
    } else if (end > i && (ch !== '{' || /,|\.\./.test(base.slice(i, end)))) {
      i = end;
      pattern += ch === '[' ? '.' : '.*';
    } else if (ch === '*' || ch === '`') pattern += '.*';
    else if (ch === '?') pattern += '.';
    else pattern += ch.replace(/[.+^()|\\[\]{}]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`).test('cli.mjs');
}

/** Whether a word is a script the guard cannot pin: a cli.mjs, or a path that may expand into one. */
const scriptLike = (word) => {
  const base = posix.basename(word);
  return base === 'cli.mjs' || (EXPANDS.test(word) && couldBeCli(base));
};

/**
 * The write tool a word names (`'?'` when it may name one that cannot be told), or null.
 * `where.runner`: the word is in a package runner's segment, where a tool's name is its script;
 * `executes`: the word sits where the shell may run it, so a path that expands counts.
 */
function wordTool(word, where, executes) {
  const path = word.includes('=') ? word.slice(word.indexOf('=') + 1) : word;
  if (where.runner && (Object.hasOwn(where.writes, word) || Object.hasOwn(where.writes, path))) return where.writes[word] ? word : path;
  for (const candidate of unique([word, path])) {
    if (!candidate) continue;
    for (const dir of where.dirs) {
      const tool = where.clis.get(real(resolve(dir, candidate)));
      if (tool) return tool;
    }
  }
  if (!CLEAN_PATH.test(word) && !EXPANDING_PATH.test(word) && word.includes('cli.mjs')) return '?';
  const base = posix.basename(path);
  if (EXPANDS.test(path) && couldBeCli(base)) return executes ? '?' : null;
  if (base !== 'cli.mjs') return null;
  const relative = !posix.isAbsolute(path);
  return (relative && where.unknown) || !where.dirs.some((dir) => real(resolve(dir, path))) ? '?' : null;
}

/**
 * The write tools a command mentions; `'?'` stands for one that cannot be told.
 * @param {string} command a shell command
 * @param {{segments: object[], cwd: string, clis: Map<string, string>, writes: object}} parsed
 * @returns {Set<string>}
 */
function mentionedTools(command, parsed) {
  const text = plainText(command);
  const named = (tool) => {
    const name = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w-])${name}/cli\\.mjs`).test(text);
  };
  const found = new Set(Object.keys(parsed.writes).filter(named));
  const where = { ...workingDirs(parsed.segments, parsed.cwd), clis: parsed.clis, writes: parsed.writes };
  // Where a word lands cannot be told once code runs inside the command or a reader's output may
  // feed a program that runs it (`echo … | bash`, `echo … > x.sh`).
  const syntax = shellSyntax(command);
  const loud = parsed.segments.some((segment) => !quietSegment(segment));
  const blind = syntax.has('command substitution') || (loud && (command.includes('|') || syntax.has('file redirection')));
  const seen = new Set();
  for (const segment of parsed.segments) {
    const executes = blind || !quietSegment(segment);
    const runner = RUNNERS.has(segment.exe) || (segment.exe === 'node' && segment.args.some((a) => a === '--run' || a.startsWith('--run=')));
    for (const word of segment.tokens) {
      const key = `${Number(executes)}${Number(runner)}${word}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tool = wordTool(word, { ...where, runner }, executes);
      if (tool) found.add(tool);
    }
  }
  return found;
}

/** Whether the text holds one of `verbs` as a whole word (not part of `--flag` or `a-b`). */
function hasVerbWord(text, verbs) {
  const words = [...verbs].map((verb) => verb.replace(/[-]/g, '\\-')).join('|');
  return words !== '' && new RegExp(`(?:^|[^\\w-])(?:${words})(?![\\w-])`).test(text);
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

/** The shell syntax one unquoted character brings in (`next` is the text after it). */
function syntaxOf(ch, next, wordStart) {
  if (ch === '`' || (ch === '$' && next[0] === '(') || ((ch === '<' || ch === '>') && next[0] === '(')) return ['substitution', 'command substitution'];
  if (ch === '$') return ['substitution'];
  if (ch === '>') return /^&[\d-]/.test(next) ? ['redirection'] : ['redirection', 'file redirection'];
  if (ch === '<') return ['redirection'];
  if (';&|()\n'.includes(ch)) return ['chaining'];
  if (ch === '#' && wordStart) return ['comment'];
  if ('*?[{'.includes(ch) || (ch === '~' && wordStart)) return ['expansion'];
  return [];
}

/**
 * The shell syntax that makes `command` more than one plain command: `chaining` (`; & | ( )`, a
 * newline), `redirection` (`file redirection` when into a file), `substitution` (`command
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
      for (const f of syntaxOf(ch, command.slice(i + 1, i + 3), wordStart)) found.add(f);
    }
  }
  if (quote) found.add('unclosed quote');
  return found;
}

/** Whether `command` is one plain command: nothing chained, piped, redirected, substituted, expanded or commented. */
export const plainCommand = (command) => shellSyntax(command).size === 0;

/**
 * The strict-form call of a segment: `[VAR=…] node <path that really is tools/<tool>/cli.mjs>
 * …`, the path read from `cwd`; null when the segment has any other shape.
 * @param {{tokens: string[]}} segment from shellSegments
 * @param {string} cwd the folder the command runs in
 * @param {Map<string, string>} clis write tools by the real path of their cli.mjs
 * @returns {{tool: string, verb: string|undefined, args: string[], tokens: string[]}|null}
 */
export function strictCall(segment, cwd, clis) {
  const { tokens } = segment;
  let i = 0;
  while (i < tokens.length && ASSIGNMENT.test(tokens[i])) i++;
  if (tokens.slice(0, i).some((t) => t.startsWith('NODE_OPTIONS='))) return null;
  const [node, script] = [tokens[i], tokens[i + 1]];
  if (!node || !CLEAN_PATH.test(node) || posix.basename(node) !== 'node') return null;
  if (!script || !CLEAN_PATH.test(script) || script.startsWith('-')) return null;
  const tool = clis.get(real(resolve(cwd, script)));
  if (!tool) return null;
  const args = tokens.slice(i + 2);
  return { tool, verb: args[0], args, tokens };
}

/** A call's arguments before `--`: after it they are positionals, never options. */
function options(call) {
  const end = call.args.indexOf('--');
  return end < 0 ? call.args : call.args.slice(0, end);
}

const isHelp = (call) => call.verb === undefined || call.verb === '-h' || options(call).includes('--help');
const isWriteCall = (call, writes) => writes[call.tool].includes(call.verb) && !isHelp(call);
const isReadCall = (call, writes) => isHelp(call) || (COMMAND_WORD.test(call.verb) && !writes[call.tool].includes(call.verb));

/** Whether a call is a dry run: `--dry-run` as a token before `--`. */
export const isDryRun = (call) => options(call).includes('--dry-run');

/**
 * Whether a segment calls a script the guard cannot pin and only reads: `[VAR=…] [node] <script>
 * <command>`, the script a cli.mjs or a path that may expand into one, and the command word
 * absent, `--help`, `-h`, or a literal that is no tool's write command. The tool's command is the
 * first word after the script (tools/common/cli.mjs), so that word alone decides — unless the
 * shell may split a word into more: the command word must be literal (`$CMD` may be any program
 * with any words), and no word may expand once the command holds a write command word anywhere
 * (`V='cli.mjs comment P'; node $V` runs `comment`).
 * @param {{tokens: string[]}} segment
 * @param {Record<string, string[]>} writes tool -> its changing commands
 * @param {{syntax: Set<string>, verbWord: boolean}} text the command's shell syntax and whether it holds a write command word
 * @returns {boolean}
 */
function looseReadCall({ tokens }, writes, { syntax, verbWord }) {
  let i = 0;
  while (i < tokens.length && ASSIGNMENT.test(tokens[i])) i++;
  if (tokens.slice(0, i).some((t) => t.startsWith('NODE_OPTIONS='))) return false;
  if (EXPANDS.test(tokens[i] ?? '')) return false;
  if (verbWord && tokens.slice(i).some((word) => mayExpand(word, syntax))) return false;
  if (CLEAN_PATH.test(tokens[i] ?? '') && posix.basename(tokens[i]) === 'node') i++;
  const script = tokens[i];
  if (!script || script.startsWith('-') || !EXPANDING_PATH.test(script) || !scriptLike(script)) return false;
  const verb = tokens[i + 1];
  if (verb === undefined || verb === '--help' || verb === '-h') return true;
  return COMMAND_WORD.test(verb) && !Object.values(writes).some((verbs) => verbs.includes(verb));
}

/** Whether a segment is a reader that cannot run a command: no prefix, a listed program, safe options. */
function readerSegment({ exe, args, tokens }) {
  if (tokens.length !== args.length + 1 || !CLEAN_PATH.test(tokens[0])) return false;
  if (exe === 'sed') return args[0] === '-n' && SED_PRINTS.test(args[1] ?? '') && args.slice(2).every((a) => !a.startsWith('-'));
  if (exe === 'find') return !args.some((a) => FIND_ACTS.test(a));
  if (exe === 'git') {
    if (args.some((a) => GIT_RUNS.test(a))) return false;
    const at = args.findIndex((a, i) => !a.startsWith('-') && args[i - 1] !== '-C');
    return GIT_READS.has(args[at]);
  }
  if (exe === 'rg' && args.some((a) => a === '--pre' || a.startsWith('--pre='))) return false;
  if (exe === 'sort' && args.some((a) => a.startsWith('--co'))) return false;
  return READERS.has(exe);
}

/**
 * Whether a segment runs nothing that could act on a tool: a reader, a `cd`, a bare assignment
 * `VAR=value`, or the header or closing word of a loop, `if` or `case`. A segment whose command
 * word may expand (`$CMD …`, `${D}/cd`) is never quiet: the program is not what the text says.
 */
function quietSegment(segment) {
  if (segment.control) return true;
  const { exe, tokens } = segment;
  if (exe === null) return tokens.every((t) => ASSIGNMENT.test(t));
  if (EXPANDS.test(executedWords(segment)[0])) return false;
  return exe === 'cd' || exe === 'pushd' || readerSegment(segment);
}

/**
 * Whether a command that mentions a write tool only reads: quiet segments, strict read calls,
 * literal `bash -c`/`eval` reads run directly, and loose read calls. Once the command holds a write
 * command word anywhere (quoted strings included), a segment that runs a word the shell may expand
 * is no read: the word may carry the write (`CMD='… comment …'; $CMD`).
 */
function readOnly(command, parsed) {
  const syntax = shellSyntax(command);
  if (['command substitution', 'file redirection', 'comment', 'unclosed quote', 'control character'].some((f) => syntax.has(f))) return false;
  const verbWord = hasVerbWord(command, allVerbs(parsed.writes));
  return parsed.segments.every((segment) => {
    if (quietSegment(segment)) return true;
    if (verbWord && executedWords(segment).some((word) => mayExpand(word, syntax))) return false;
    const call = strictCall(segment, parsed.cwd, parsed.clis);
    if (call) return isReadCall(call, parsed.writes);
    const nested = parsed.nested.get(segment);
    if (nested) return nested.direct && nested.inner?.verdict === 'free';
    return looseReadCall(segment, parsed.writes, { syntax, verbWord });
  });
}

/**
 * The options a `bash|sh|zsh|dash` call gets before its command: the `-c` string it runs, or
 * undefined when it runs no `-c` string (a script, standard input). `-o`/`-O` and `--rcfile`,
 * `--init-file` take a value; `-lc`, `-e -c` are read as options.
 * @param {string[]} args the shell's arguments
 * @returns {string|undefined}
 */
function shellString(args) {
  let command = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' || arg === '-') return command ? args[i + 1] : undefined;
    if (arg.startsWith('--')) {
      if (arg === '--rcfile' || arg === '--init-file') i++;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(arg)) {
      if (arg[0] === '-' && arg.includes('c')) command = true;
      if (/[oO]/.test(arg)) i++;
      continue;
    }
    return command ? arg : undefined;
  }
  return undefined;
}

/**
 * The code a segment hands to another shell: the string of `bash|sh|zsh|dash … -c <string>`
 * anywhere among the words it runs, or the words of `eval`; null when there is none. `direct`: the
 * shell is the command word or runs behind a wrapper that only runs it (SHELL_WRAPPERS, `env` and
 * the prefixes stripPrefix takes off), so the segment does what the code does.
 * @param {{exe: string|null, args: string[], tokens: string[]}} segment
 * @returns {{shell: string, words: string[], direct: boolean}|null}
 */
function nestedCode(segment) {
  if (segment.exe === null) return null;
  if (segment.exe === 'eval') return { shell: 'eval', words: segment.args, direct: true };
  const { tokens } = segment;
  const from = tokens.length - segment.args.length - 1;
  for (let i = from; i < tokens.length; i++) {
    const name = posix.basename(tokens[i]);
    if (!SHELLS.has(name)) continue;
    const code = shellString(tokens.slice(i + 1));
    if (code === undefined) continue;
    return { shell: `${name} -c`, words: [code], direct: i === from || SHELL_WRAPPERS.has(posix.basename(tokens[from])) };
  }
  return null;
}

/**
 * The nested code of a segment, classified: a literal string by classify one level deeper
 * (`inner`); a string the outer shell expands, or one past MAX_DEPTH, is not read (`inner`
 * undefined) and `unsafe` when it holds a write command word or an HTTP write option.
 */
function nestedOf(segment, syntax, context) {
  const nested = nestedCode(segment);
  if (!nested) return null;
  const code = nested.words.join(' ');
  if (context.depth < MAX_DEPTH && !nested.words.some((word) => mayExpand(word, syntax))) {
    const inner = classify(code, context.cwd, context.writes, context.hosts, { curlrc: context.curlrc, depth: context.depth + 1 });
    return { ...nested, inner, unsafe: inner.verdict !== 'free' };
  }
  const unsafe = hasVerbWord(code, allVerbs(context.writes)) || (HTTP_PROGRAM.test(code) && HTTP_WRITE_OPTION.test(code));
  return { ...nested, unsafe };
}

/**
 * A program's arguments read by its options: those that take a value take the rest of their
 * short bundle, the text after `=`, or the next word.
 * @param {string[]} args the program's arguments
 * @param {string} short the short option letters that take a value
 * @param {(name: string) => boolean} takesValue whether a long option takes a value
 * @returns {{options: {name: string, value: string|undefined}[], positionals: string[]}}
 */
function readOptions(args, short, takesValue) {
  const found = [];
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg : arg.slice(0, eq);
      found.push({ name, value: eq >= 0 ? arg.slice(eq + 1) : takesValue(name) ? args[++i] : undefined });
    } else if (arg.length > 1 && arg.startsWith('-')) {
      for (let j = 1; j < arg.length; j++) {
        if (!short.includes(arg[j])) {
          found.push({ name: `-${arg[j]}`, value: undefined });
          continue;
        }
        found.push({ name: `-${arg[j]}`, value: j + 1 < arg.length ? arg.slice(j + 1) : args[++i] });
        break;
      }
    } else positionals.push(arg);
  }
  return { options: found, positionals };
}

/** Whether a method sends a change: anything but GET, HEAD, OPTIONS — an unknown one included. */
const writesBy = (method) => method === undefined || !READ_METHODS.has(method.toUpperCase());

/** The host of a URL word, lower case; null when the shell may expand it. */
export function urlHost(url) {
  const [, host] = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/?#]*@)?([^/?#]*)/i.exec(url);
  return /[$`*{[~]/.test(host) ? null : host.replace(/:\d*$/, '').toLowerCase();
}

/** Whether `host` is one of `hosts` (`*.x` is `x` and its subdomains); an expanding host is. */
function connected(host, hosts) {
  if (host === null) return true;
  return hosts.some((pattern) => (pattern.startsWith('*.') ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : host === pattern));
}

/** A double-quoted curl config value: up to the closing quote, with `\\ \" \t \n \r \v` read. */
function unquoteCurl(text) {
  let out = '';
  for (let i = 1; i < text.length && text[i] !== '"'; i++) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const next = text[++i];
      out += { t: '\t', n: '\n', r: '\r', v: '\v' }[next] ?? next;
    } else out += text[i];
  }
  return out;
}

/**
 * The options of a curl config file as command-line words. A line is `name = value`, `name:
 * value` or `name value` (a long name without its dashes), or `--name value`, `-X POST` (dashes,
 * then whitespace only); `#` starts a comment line; a double-quoted value may hold spaces.
 * @param {string} text the file's content
 * @returns {string[]}
 */
export function curlConfigArgs(text) {
  const args = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const dashed = line.startsWith('-');
    const [name] = (dashed ? /^\S+/ : /^[^\s=:]+/).exec(line);
    let rest = line.slice(name.length).trimStart();
    if (!dashed && /^[=:]/.test(rest)) rest = rest.slice(1).trimStart();
    const value = rest === '' ? undefined : rest.startsWith('"') ? unquoteCurl(rest) : /^\S*/.exec(rest)[0];
    const long = dashed ? name : `--${name}`;
    if (long.startsWith('--')) args.push(value === undefined ? long : `${long}=${value}`);
    else args.push(...(value === undefined ? [long] : [long, value]));
  }
  return args;
}

/** A file's text when it is a regular file of at most CURL_CONFIG_MAX; undefined when there is none; null when it cannot be read. */
function smallFile(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch (e) {
    return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? undefined : null;
  }
  if (!stat.isFile() || stat.size > CURL_CONFIG_MAX) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** A curl config's options as readOptions gives them, its bare words as `--url`; null when it names another config. */
function configOptions(text) {
  const { options: found, positionals } = readOptions(curlConfigArgs(text), CURL_SHORT, (name) => CURL_LONG.has(name));
  if (found.some((o) => o.name === '-K' || o.name === '--config')) return null;
  return [...found, ...positionals.map((value) => ({ name: '--url', value }))];
}

/**
 * The options curl reads from config files: the user's curlrc files (unless `-q`/`--disable` is
 * the first option) and each `-K`/`--config` file, read from every folder the command may be in.
 * `unread`: one could not be read — standard input, a path the shell expands, a missing, special
 * or larger file, a config naming another; its options are unknown, so it counts as a write.
 * @param {string[]} args curl's arguments
 * @param {{name: string, value: string|undefined}[]} given the options of the command line
 * @param {{curlrc: string[], dirs: string[], unknown: boolean}} context
 * @returns {{options: {name: string, value: string|undefined}[], unread: boolean}}
 */
function curlConfigs(args, given, context) {
  const found = [];
  let unread = false;
  const add = (text) => {
    const options = typeof text === 'string' ? configOptions(text) : null;
    if (options) found.push(...options);
    else unread = true;
  };
  if (args[0] !== '-q' && args[0] !== '--disable') {
    for (const file of context.curlrc) {
      const text = smallFile(file);
      if (text !== undefined) add(text);
    }
  }
  for (const { name, value } of given) {
    if (name !== '-K' && name !== '--config') continue;
    let files = [];
    if (value !== undefined && value !== '-' && !/[$`*?[{~]/.test(value)) {
      if (posix.isAbsolute(value)) files = [value];
      else if (!context.unknown) files = unique(context.dirs.map((dir) => resolve(dir, value)));
    }
    const texts = files.map(smallFile).filter((text) => typeof text === 'string');
    if (texts.length) texts.forEach(add);
    else unread = true;
  }
  return { options: found, unread };
}

/**
 * The curlrc files curl reads by default: `$CURL_HOME/.curlrc` and `~/.curlrc`. curl stops at the
 * first it finds; the guard reads both.
 * @param {Record<string, string|undefined>} env the environment
 * @returns {string[]}
 */
export function curlrcPaths(env) {
  return unique([env.CURL_HOME ? join(resolve(env.CURL_HOME), '.curlrc') : null, join(env.HOME || homedir(), '.curlrc')].filter(Boolean));
}

/**
 * Whether `gh api` with these arguments writes. `graphql` always POSTs and its fields are the
 * query and its variables: it writes through a `query` field that names a mutation or that the
 * guard cannot read (a file `@…`, an expansion, a key that expands), `--input`, or a method other
 * than GET or POST. Any other endpoint writes with a writing method, `--input`, or fields — unless
 * every method given is GET, which sends the fields as query parameters.
 * @param {string[]} args the arguments after `api`
 * @param {Set<string>} syntax the command's shell syntax (shellSyntax)
 * @returns {boolean}
 */
function ghApiWrites(args, syntax) {
  const { options: opts, positionals } = readOptions(args, GH_SHORT, (name) => GH_LONG.has(name));
  if (opts.some((o) => o.name === '--input')) return true;
  const methods = opts.filter((o) => o.name === '-X' || o.name === '--method').map((o) => o.value?.toUpperCase());
  const fields = opts.filter((o) => GH_FIELDS.has(o.name)).map((o) => o.value ?? '');
  if (positionals[0] === 'graphql') {
    if (methods.some((method) => method !== 'POST' && writesBy(method))) return true;
    return fields.some((field) => {
      const eq = field.indexOf('=');
      const key = eq < 0 ? field : field.slice(0, eq);
      if (mayExpand(key, syntax)) return true;
      if (key !== 'query' && !key.startsWith('query[')) return false;
      const value = field.slice(eq + 1);
      return value.startsWith('@') || mayExpand(value, syntax) || MUTATION.test(value);
    });
  }
  if (methods.some(writesBy)) return true;
  return fields.length > 0 && !(methods.length > 0 && methods.every((method) => method === 'GET'));
}

/**
 * The direct HTTP write a segment makes to a connected service, as `<program> to <host>`, or
 * null: `curl` or `wget` with a writing method or a body to a connected host (or to none it can
 * name), `gh api` that writes (ghApiWrites). `gh`'s other commands are not looked at. curl's
 * config files add their options (curlConfigs); one that cannot be read makes it a write.
 * @param {{exe: string|null, args: string[], tokens: string[]}} segment
 * @param {string[]} hosts the connected hosts
 * @param {Set<string>} syntax the command's shell syntax (shellSyntax)
 * @param {{curlrc: string[], dirs: string[], unknown: boolean}} context where curl's config files are
 * @returns {string|null}
 */
function httpWrite(segment, hosts, syntax, context) {
  if (quietSegment(segment)) return null;
  const { tokens } = segment;
  const from = tokens.length - segment.args.length - 1;
  const at = tokens.findIndex((t, i) => i >= from && ['curl', 'wget', 'gh'].includes(posix.basename(t)));
  if (at < 0) return null;
  const program = posix.basename(tokens[at]);
  const args = tokens.slice(at + 1);
  if (program === 'gh') {
    const api = args.findIndex((a) => !a.startsWith('-'));
    if (args[api] !== 'api') return null;
    return ghApiWrites(args.slice(api + 1), syntax) ? 'gh api to GitHub' : null;
  }
  let write;
  let read;
  if (program === 'curl') {
    read = readOptions(args, CURL_SHORT, (name) => CURL_LONG.has(name));
    const config = curlConfigs(args, read.options, context);
    read = { options: [...read.options, ...config.options], positionals: read.positionals };
    write = config.unread || read.options.some((o) => ((o.name === '-X' || o.name === '--request') && writesBy(o.value)) || CURL_BODY.test(o.name));
  } else {
    const wgetWrite = (name) => name.length > 3 && WGET_WRITES.some((option) => option.startsWith(name));
    read = readOptions(args, WGET_SHORT, (name) => WGET_LONG.has(name) || wgetWrite(name));
    write = read.options.some((o) => (wgetWrite(o.name) && (!o.name.startsWith('--me') || writesBy(o.value)))
      || ((o.name === '-e' || o.name === '--execute') && WGET_RC_WRITE.test(o.value ?? '') && !/^\s*method\s*=\s*(?:get|head|options)\s*$/i.test(o.value)));
  }
  if (!write) return null;
  const urls = [...read.positionals, ...read.options.filter((o) => o.name === '--url').map((o) => o.value ?? '')];
  if (!urls.length) return `${program} to a host it cannot name`;
  const host = urls.map(urlHost).find((h) => connected(h, hosts));
  return host === undefined ? null : `${program} to ${host ?? 'a host the shell expands'}`;
}

/**
 * The connected hosts with the installation's own sites (SITE_SETTINGS), read through
 * tools/common/env.mjs only when asked: a configuration that cannot be read leaves the fixed list.
 * @returns {Promise<string[]>}
 */
async function connectedHosts() {
  try {
    const { lookup } = await import('../common/env.mjs');
    const sites = SITE_SETTINGS.map((name) => lookup(name).value).filter(Boolean).map(urlHost);
    return unique([...CONNECTED_HOSTS, ...sites.filter(Boolean)]);
  } catch {
    return [...CONNECTED_HOSTS];
  }
}

/**
 * What the guard makes of a shell command: `free` (runs), `denied`, or `write` — a strict-form
 * call of a write command, which then needs its confirmed dry run. A denied direct HTTP write
 * carries `http`, what it writes to; a write inside `bash -c`/`eval` carries `nested`, the shell
 * and what the code inside does.
 * @param {string} command a shell command
 * @param {string} cwd the folder it runs in
 * @param {Record<string, string[]>} [writes] tool -> its changing commands (writes.mjs)
 * @param {readonly string[]} [hosts] the connected hosts (CONNECTED_HOSTS and the installation's sites)
 * @param {{curlrc?: string[], depth?: number}} [options] curl's default config files (curlrcPaths),
 *   and how many shells deep `command` runs
 * @returns {{verdict: 'free'|'denied'|'write', tools: string[], call?: object, http?: string, nested?: {shell: string, inner: string}}}
 */
export function classify(command, cwd, writes = WRITES, hosts = CONNECTED_HOSTS, { curlrc = [], depth = 0 } = {}) {
  const raw = shellSegments(withoutRedirections(command));
  const parsed = { segments: raw.map(bodyOf), cwd, clis: realClis(writes), writes, nested: new Map() };
  const syntax = shellSyntax(command);
  const context = { ...workingDirs(parsed.segments, cwd), curlrc, cwd, writes, hosts, depth };
  const http = parsed.segments.map((segment) => httpWrite(segment, hosts, syntax, context)).find(Boolean);
  if (http) return { verdict: 'denied', tools: [], http };
  // A write inside another shell is denied, not matched with its dry run: the dry run would have
  // to be the same code through the same layers of quoting, and a standalone command is both
  // simpler for the agent and the form the user confirms.
  for (const segment of parsed.segments) {
    if (quietSegment(segment) || strictCall(segment, cwd, parsed.clis)) continue;
    const nested = nestedOf(segment, syntax, context);
    if (!nested) continue;
    parsed.nested.set(segment, nested);
    if (!nested.unsafe) continue;
    const { inner } = nested;
    const what = !inner ? 'code the guard cannot read, with a write command or an HTTP write option,'
      : inner.nested ? inner.nested.inner
        : inner.http ? `a direct write to a connected service (${inner.http})` : 'an oikos tool call that may write';
    return { verdict: 'denied', tools: inner?.tools ?? ['?'], nested: { shell: nested.shell, inner: what } };
  }
  const tools = mentionedTools(command, parsed);
  const free = { verdict: 'free', tools: [...tools] };
  if (!tools.size) return free;
  const verbs = (tools.has('?') ? Object.keys(writes) : [...tools]).flatMap((tool) => writes[tool]);
  const text = plainText(command);
  if (!hasVerbWord(text, verbs) && !EXPANDS.test(text)) return free;
  // The strict form is read from the segment as written: `if node … edit` is not a call.
  const single = raw.length === 1 && plainCommand(command);
  const call = single ? strictCall(raw[0], cwd, parsed.clis) : null;
  if (call && isWriteCall(call, writes)) return { verdict: 'write', tools: [call.tool], call };
  if ((call && isReadCall(call, writes)) || readOnly(command, parsed)) return free;
  return { verdict: 'denied', tools: [...tools] };
}

/** The identity of a call for "the same command": the working folder and the tokens without `--dry-run`. */
export function signature(call, cwd) {
  const start = call.tokens.length - call.args.length;
  const end = call.args.indexOf('--');
  const args = call.args.filter((arg, i) => arg !== '--dry-run' || (end >= 0 && i > end));
  return JSON.stringify([real(cwd) ?? cwd, ...call.tokens.slice(0, start), ...args]);
}

/** The recorded state when it has the expected shape, else a fresh one (a forged record is lost). */
function validState(state) {
  const fresh = { prompts: 0, dryRuns: {} };
  if (!state || typeof state !== 'object' || !Number.isFinite(state.prompts) || state.prompts < 0) return fresh;
  const { dryRuns } = state;
  if (!dryRuns || typeof dryRuns !== 'object' || Array.isArray(dryRuns) || !Object.values(dryRuns).every(Number.isFinite)) return fresh;
  return state;
}

function deny(reason) {
  print({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

const strictForm = (tools) => {
  const names = tools.filter((t) => t !== '?');
  const tool = names.length ? names.join(', ') : 'an oikos tool';
  return `oikos write guard: a command that names ${tool} and a write verb runs only as ` +
    `\`node oikos/tools/${names[0] ?? '<tool>'}/cli.mjs <verb> …\`, one standalone command ` +
    '(no env/cd/find/npm/wrappers, nothing chained, piped, redirected or substituted).';
};

/** The deny reason for a write inside `bash -c` or `eval`: run it as a standalone command. */
const nestedReason = ({ shell, inner }, tools) => {
  const name = tools.find((t) => t !== '?') ?? '<tool>';
  return `oikos write guard: ${inner} inside \`${shell}\` is not run from there. Run the oikos tool call as a standalone ` +
    `command — \`node oikos/tools/${name}/cli.mjs <verb> … --dry-run\`, show it to the user, then the same command ` +
    'without --dry-run after they confirm; a direct HTTP write goes through the oikos tool the same way.';
};

/** The PreToolUse decision for one command. */
function check(command, cwd, sid, hosts, curlrc) {
  const result = classify(command, cwd, WRITES, hosts, { curlrc });
  if (result.verdict === 'free') return;
  if (result.nested) return deny(nestedReason(result.nested, result.tools));
  if (result.http) {
    return deny(`oikos write guard: direct write to a connected service (${result.http}) — use the oikos tool with --dry-run.`);
  }
  if (result.verdict === 'denied') return deny(strictForm(result.tools));
  const { call } = result;
  const label = `${call.tool} ${call.verb}`;
  const state = validState(readState(sid, 'writes', null));
  const sig = signature(call, cwd);
  if (isDryRun(call)) {
    state.dryRuns[sig] = state.prompts;
    writeState(sid, 'writes', state);
    return;
  }
  const shownAt = Object.hasOwn(state.dryRuns, sig) ? state.dryRuns[sig] : undefined;
  if (shownAt === undefined) {
    return deny(
      `oikos write guard: ${label} changes a remote service. Run the same command with --dry-run first, ` +
        'show the result to the user and wait for their confirmation; then run it again unchanged without --dry-run.',
    );
  }
  if (shownAt >= state.prompts) {
    return deny(
      `oikos write guard: the dry run of ${label} has not been answered yet. ` +
        'Show it to the user and wait for their confirmation in their next message.',
    );
  }
  delete state.dryRuns[sig];
  writeState(sid, 'writes', state);
}

export async function run(payload) {
  const sid = payload.session_id;
  if (payload.hook_event_name === 'UserPromptSubmit') {
    if (payload.agent_id) return;
    const state = validState(readState(sid, 'writes', null));
    state.prompts += 1;
    writeState(sid, 'writes', state);
    return;
  }

  const command = shellCommand(payload);
  if (!command) return;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  try {
    const hosts = /\b(?:curl|wget)\b/.test(command) ? await connectedHosts() : CONNECTED_HOSTS;
    check(command, cwd, sid, hosts, /\bcurl\b/.test(command) ? curlrcPaths(process.env) : []);
  } catch (e) {
    // Fail closed where it matters: a command that may name a write tool, or make a direct HTTP
    // write, is denied, not let through.
    if (Object.keys(WRITES).some((tool) => command.includes(tool)) || command.includes('cli.mjs') || /\b(?:curl|wget|gh)\b/.test(command)) {
      deny(`oikos write guard: could not read this command (${e.message}); ${strictForm([])}`);
    }
  }
}
