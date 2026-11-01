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
// The text of a heredoc or a script is judged as commands, since the guard cannot tell a file's
// contents from a command: write such a file with the file tool, then run it. The special
// parameters `$?`, `$#`, `$$`, `$!`, `$-` expand to digits or option letters, never to a path;
// the positional parameters (`$@`, `$*`, `$0`–`$9`) may be anything. A redirection into exactly
// /dev/null is no redirection into a file.
// - a direct HTTP write to a connected service — `curl`/`wget` with a writing method or a body
//   to a host of CONNECTED_HOSTS or of the installation's site settings (or one the shell
//   expands; the host read in lower case, without the root's trailing dot), `gh api` with a
//   writing method or fields (a GraphQL call: a mutation, or a query the guard cannot read) — is
//   denied: the oikos tool does it, with its dry run. `gh`'s other commands are not looked at. curl's
//   and wget's config files count as their command line: `-K`/`--config <file>` and the user's
//   `$CURL_HOME/.curlrc`, `$XDG_CONFIG_HOME/curlrc` and `~/.curlrc` (unless `-q`/`--disable` is
//   the first option); wget's `--config <file>`, `$WGETRC` and `~/.wgetrc` (unless `--no-config`),
//   where a body or a writing method is a write. Each is read when it is a regular file of at most
//   64 KB, in the hook's environment and in the one the command gives the program (its
//   `VAR=`/`env VAR=` words, bare assignments and `export`s before it); one that cannot be read
//   (`-K -`, a path or an assigned folder the shell expands, a missing given file, a special or
//   larger file) counts as a write, to the hosts the command line names;
// - code handed to another shell — the string of `bash|sh|zsh|dash [options] -c <string>`, also
//   behind a wrapper (`timeout`, `env`), and the words of `eval` — is classified the same way, up
//   to three levels deep. A literal read is a read; an oikos write or a direct HTTP write in it is
//   denied, to be run as a standalone command; a string the outer shell expands is denied when it
//   holds a write command word or an HTTP write option; a string with a `$` that is given
//   words after it (`bash -c '"$@"' _ node …`) is not read either, and is denied when the whole
//   command holds a write command word or a cli.mjs;
// - a command that does not mention a write tool passes. A tool is mentioned only through its
//   script: `<tool>/cli.mjs` in the text (backslashes and quotes removed), a word that really
//   leads to its cli.mjs (symlinks, `..`, literal `cd`s), a cli.mjs the guard cannot pin (a
//   relative one after an unknown `cd`, one inside a word of code), the tool's name as the script
//   of a package runner (`npm run jira`), or a word the shell may expand into a cli.mjs where it
//   may run — anywhere but in a segment that only reads, and anywhere at all once the command
//   substitutes or pipes or redirects into a file next to a segment that does not only read;
// - a mention with no write command word in the text and nothing the shell expands passes too,
//   unless a cli.mjs is mentioned inside a word of code, which may build its command at run time;
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
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { CORE_ROOT } from '../common/paths.mjs';
import { print, readState, shellSegments, writeState } from './common.mjs';
import { shellCommand } from './host.mjs';
import {
  ASSIGNMENT, bodyOf, CLEAN_PATH, EXPANDING_PATH, EXPANDS, executedFrom, executedWords, mayExpand, plainCommand, plainText, real,
  shellSyntax, unique, withoutRedirections, workingDirs,
} from './shell.mjs';
import { WRITES } from './writes.mjs';

export { plainCommand, withoutRedirections };

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
/** Programs that run a package's script by its name (`npm run jira`). */
const RUNNERS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno', 'corepack']);

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
/** A wgetrc command (`-e`, a wgetrc line) that sends a body or sets the method; wget ignores `_` and `-` in its name. */
const WGET_RC_WRITE = /^\s*(?:post[-_]?data|post[-_]?file|body[-_]?data|body[-_]?file|method)\s*=/i;
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
/** A positional parameter in a word (`$@`, `$*`, `${@}`, `$0`–`$9`, `${1}`): the words a script or `-c` string is given. */
const POSITIONAL = /\$(?:[@*\d]|\{[@*\d]\})/;
/** curl, wget or `gh api` in code the guard cannot read, and an option of theirs that may write. */
const HTTP_PROGRAM = /(?:^|[^\w-])(?:curl|wget|gh\s+api)(?![\w-])/;
const HTTP_WRITE_OPTION = /(?:^|\s)(?:-[A-Za-z]*[XdFTKfe]|--(?:request|method|data|form|upload-file|json|post|body|field|raw-field|input|config|execute))/;

/** The variables that say where curl and wget find their default config files. */
const CONFIG_HOMES = Object.freeze({ curl: ['CURL_HOME', 'XDG_CONFIG_HOME', 'HOME'], wget: ['WGETRC', 'HOME'] });
const CONFIG_VARIABLES = unique(Object.values(CONFIG_HOMES).flat());
const NO_DEFAULTS = Object.freeze({ files: [], unread: false });

/** Every tool's write command words (writes.mjs). */
const allVerbs = (writes) => unique(Object.values(writes).flat());

/** Each write tool's cli.mjs by its real path. */
function realClis(writes) {
  const found = new Map();
  for (const tool of Object.keys(writes)) {
    const path = real(resolve(CORE_ROOT, 'tools', tool, 'cli.mjs'));
    if (path) found.set(path, tool);
  }
  return found;
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
      // `${…}`, `$NAME`, and the positional parameters `$@`, `$*`, `$0`–`$9`: anything.
      if (base[i + 1] === '{') i = Math.max(base.indexOf('}', i), i);
      else if (/^[@*]/.test(base.slice(i + 1))) i++;
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
 * The write tools a command mentions; `'?'` stands for one that cannot be told. `coded`: a cli.mjs
 * is mentioned inside a word of code (not a path), where code may build the command at run time.
 * @param {string} command a shell command
 * @param {{segments: object[], cwd: string, clis: Map<string, string>, writes: object}} parsed
 * @returns {{tools: Set<string>, coded: boolean}}
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
  return { tools: found, coded: parsed.segments.some((segment) => segment.tokens.some(codeMention)) };
}

/** Whether a word is code, not a path, that mentions a cli.mjs (backslashes and quotes removed). */
const codeMention = (word) => !CLEAN_PATH.test(word) && !EXPANDING_PATH.test(word) && plainText(word).includes('cli.mjs');

/** Whether the text holds one of `verbs` as a whole word (not part of `--flag` or `a-b`). */
function hasVerbWord(text, verbs) {
  const words = [...verbs].map((verb) => verb.replace(/[-]/g, '\\-')).join('|');
  return words !== '' && new RegExp(`(?:^|[^\\w-])(?:${words})(?![\\w-])`).test(text);
}

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

/**
 * The entry of the tool's write list that makes `call` a write, or null. An entry is a command word —
 * the call's first argument, and not a help request — or, for a tool with no commands (`sync`), an
 * `--option` of the call: that one counts wherever it stands before `--`, and `--help` does not
 * excuse it, since such a tool takes `--help` for nothing.
 */
function writeWord(call, writes) {
  const option = writes[call.tool].find((word) => word.startsWith('--') && options(call).includes(word));
  if (option) return option;
  return isHelp(call) ? null : (writes[call.tool].find((word) => word === call.verb) ?? null);
}

const isWriteCall = (call, writes) => writeWord(call, writes) !== null;
const isReadCall = (call, writes) => !isWriteCall(call, writes) && (isHelp(call) || (COMMAND_WORD.test(call.verb) && !writes[call.tool].includes(call.verb)));

/** Whether a call is a dry run: `--dry-run` as a token before `--`. */
export const isDryRun = (call) => options(call).includes('--dry-run');

/**
 * Whether a segment calls a script the guard cannot pin and only reads: `[VAR=…] [node] <script>
 * <command>`, the script a cli.mjs or a path that may expand into one, and the command word
 * absent, `--help`, `-h`, or a literal that is no tool's write command. The tool's command is the
 * first word after the script (tools/common/cli.mjs), so that word alone decides — unless the
 * shell may split a word into more: the command word must be literal (`$CMD` may be any program
 * with any words), and no word may expand once the command holds a write command word anywhere
 * (`V='cli.mjs comment P'; node $V` runs `comment`). A positional parameter is never the script:
 * it brings the words after it along (`node "$@"`).
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
  if (!script || script.startsWith('-') || POSITIONAL.test(script) || !EXPANDING_PATH.test(script) || !scriptLike(script)) return false;
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
 * The options a `bash|sh|zsh|dash` call gets before its command: the index of the `-c` string it
 * runs, or -1 when it runs no `-c` string (a script, standard input). The words after the string
 * are its `$0`, `$1`, … `-o`/`-O` and `--rcfile`, `--init-file` take a value; `-lc`, `-e -c` are
 * read as options.
 * @param {string[]} args the shell's arguments
 * @returns {number}
 */
function shellString(args) {
  let command = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' || arg === '-') return command ? i + 1 : -1;
    if (arg.startsWith('--')) {
      if (arg === '--rcfile' || arg === '--init-file') i++;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(arg)) {
      if (arg[0] === '-' && arg.includes('c')) command = true;
      if (/[oO]/.test(arg)) i++;
      continue;
    }
    return command ? i : -1;
  }
  return -1;
}

/**
 * The code a segment hands to another shell: the string of `bash|sh|zsh|dash … -c <string>`
 * anywhere among the words it runs, or the words of `eval`; null when there is none. `passed`:
 * the words after the string, which the code gets as `$0`, `$1`, … `direct`: the shell is the
 * command word or runs behind a wrapper that only runs it (SHELL_WRAPPERS, `env` and the prefixes
 * stripPrefix takes off), so the segment does what the code does.
 * @param {{exe: string|null, args: string[], tokens: string[]}} segment
 * @returns {{shell: string, words: string[], passed: string[], direct: boolean}|null}
 */
function nestedCode(segment) {
  if (segment.exe === null) return null;
  if (segment.exe === 'eval') return { shell: 'eval', words: segment.args, passed: [], direct: true };
  const { tokens } = segment;
  const from = tokens.length - segment.args.length - 1;
  for (let i = from; i < tokens.length; i++) {
    const name = posix.basename(tokens[i]);
    if (!SHELLS.has(name)) continue;
    const at = shellString(tokens.slice(i + 1)) + i + 1;
    if (at === i || at >= tokens.length) continue;
    const direct = i === from || SHELL_WRAPPERS.has(posix.basename(tokens[from]));
    return { shell: `${name} -c`, words: [tokens[at]], passed: tokens.slice(at + 1), direct };
  }
  return null;
}

/**
 * The nested code of a segment, classified: a literal string by classify one level deeper
 * (`inner`); a string the outer shell expands, one past MAX_DEPTH, or one with a `$` that is given
 * words of its own (`bash -c '"$@"' _ node …` runs them) is not read (`inner` undefined) and
 * `unsafe` when it holds a write command word or an HTTP write option — for one given words, when
 * the whole command holds one or mentions a cli.mjs.
 */
function nestedOf(segment, syntax, context) {
  const nested = nestedCode(segment);
  if (!nested) return null;
  const code = nested.words.join(' ');
  const passes = nested.passed.length > 0 && code.includes('$');
  if (context.depth < MAX_DEPTH && !passes && !nested.words.some((word) => mayExpand(word, syntax))) {
    const envs = programEnvs(programWords(segment, executedFrom(segment), context), context);
    const inner = classify(code, context.cwd, context.writes, context.hosts, { envs, depth: context.depth + 1 });
    return { ...nested, inner, unsafe: inner.verdict !== 'free' };
  }
  return { ...nested, unsafe: unreadableWrites(passes ? context.text : code, passes, context.writes) };
}

/** Whether code the guard cannot read may write: a write command word, curl/wget/`gh api` with a write option, or — for code given words (`passes`) — a cli.mjs. */
function unreadableWrites(text, passes, writes) {
  const http = HTTP_PROGRAM.test(text) && HTTP_WRITE_OPTION.test(text);
  return http || hasVerbWord(text, allVerbs(writes)) || (passes && text.includes('cli.mjs'));
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

/** The host of a URL word, lower case and without the root's trailing dot; null when the shell may expand it. */
export function urlHost(url) {
  const [, host] = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/?#]*@)?([^/?#]*)/i.exec(url);
  return /[$`*{[~]/.test(host) ? null : host.replace(/:\d*$/, '').replace(/\.$/, '').toLowerCase();
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

/** Where a config option's value may be: nowhere the guard can read for standard input or a path the shell expands. */
function givenFiles(value, context) {
  if (value === undefined || value === '-' || /[$`*?[{~]/.test(value)) return [];
  if (posix.isAbsolute(value)) return [value];
  return context.unknown ? [] : unique(context.dirs.map((dir) => resolve(dir, value)));
}

/**
 * The texts of the config files a program reads: its default files (programDefaults) that exist,
 * and each file it is given (the values of its config options), read from every folder the command
 * may be in. `unread`: one could not be read — standard input, a path the shell expands, a missing
 * given file, a special or larger file, a default folder the guard cannot tell.
 * @param {{files: string[], unread: boolean}} defaults the program's default files
 * @param {(string|undefined)[]} given the values of its config options
 * @param {{dirs: string[], unknown: boolean}} context
 * @returns {{texts: string[], unread: boolean}}
 */
function configTexts(defaults, given, context) {
  const texts = [];
  let unread = defaults.unread;
  for (const file of defaults.files) {
    const text = smallFile(file);
    if (text === null) unread = true;
    else if (text !== undefined) texts.push(text);
  }
  for (const value of given) {
    const found = givenFiles(value, context).map(smallFile).filter((text) => typeof text === 'string');
    if (found.length) texts.push(...found);
    else unread = true;
  }
  return { texts, unread };
}

/**
 * The options curl reads from config files: the user's curlrc files (unless `-q`/`--disable` is
 * the first option) and each `-K`/`--config` file (configTexts). `unread`: one could not be read,
 * or names another config; its options are unknown, so it counts as a write.
 * @param {string[]} args curl's arguments
 * @param {{name: string, value: string|undefined}[]} given the options of the command line
 * @param {{files: string[], unread: boolean}} defaults the curlrc files (programDefaults)
 * @param {{dirs: string[], unknown: boolean}} context
 * @returns {{options: {name: string, value: string|undefined}[], unread: boolean}}
 */
function curlConfigs(args, given, defaults, context) {
  const off = args[0] === '-q' || args[0] === '--disable';
  const values = given.filter((o) => o.name === '-K' || o.name === '--config').map((o) => o.value);
  const { texts, unread } = configTexts(off ? NO_DEFAULTS : defaults, values, context);
  const options = texts.map(configOptions);
  return { options: options.filter(Boolean).flat(), unread: unread || options.includes(null) };
}

/**
 * The curlrc files curl reads by default: `$CURL_HOME/.curlrc`, `$XDG_CONFIG_HOME/curlrc` (and
 * `.curlrc` there) and `~/.curlrc`. curl stops at the first it finds; the guard reads them all.
 * @param {Record<string, string|null|undefined>} env the environment
 * @returns {string[]}
 */
export function curlrcPaths(env) {
  const xdg = env.XDG_CONFIG_HOME ? [join(resolve(env.XDG_CONFIG_HOME), 'curlrc'), join(resolve(env.XDG_CONFIG_HOME), '.curlrc')] : [];
  return unique([env.CURL_HOME ? join(resolve(env.CURL_HOME), '.curlrc') : null, ...xdg, join(env.HOME || homedir(), '.curlrc')].filter(Boolean));
}

/**
 * The wgetrc files wget reads by default: `$WGETRC`, else `~/.wgetrc` (the system wgetrc is the
 * administrator's); the guard reads both.
 */
const wgetrcPaths = (env) => unique([env.WGETRC ? resolve(env.WGETRC) : null, join(env.HOME || homedir(), '.wgetrc')].filter(Boolean));

/** A config variable's assigned value as a path, `~` resolved; null when the shell expands it or it is relative to a folder that cannot be told. */
function configHome(value, context) {
  const leading = /^~(?=\/|$)/;
  if (/[$`]/.test(value) || value.replace(leading, '').includes('~')) return null;
  const path = value.replace(leading, () => context.envs[0]?.HOME || homedir());
  if (path === '' || posix.isAbsolute(path)) return path;
  return context.dirs.length === 1 && !context.unknown ? resolve(context.dirs[0], path) : null;
}

/**
 * The words that may set a program's environment: the bare assignments and `export` words of the
 * parts before `segment`, and the segment's own words before the program at `at` (prefixes, `env`).
 */
function programWords(segment, at, context) {
  const before = context.segments.slice(0, Math.max(context.segments.indexOf(segment), 0));
  const set = before.filter((s) => s.exe === null || s.exe === 'export').flatMap((s) => s.tokens);
  return [...set, ...segment.tokens.slice(0, at)];
}

/**
 * The environments a program may start with: the hook's own (`context.envs`) and, when `words`
 * assign a variable of CONFIG_HOMES, each of them with those values — both, so an assignment that
 * does not take effect never hides a file. A value the guard cannot tell is null (configHome).
 * @param {string[]} words the words before the program (programWords)
 * @param {{envs: Record<string, string|null|undefined>[], dirs: string[], unknown: boolean}} context
 * @returns {Record<string, string|null|undefined>[]}
 */
function programEnvs(words, context) {
  const given = {};
  for (const word of words) {
    const name = word.slice(0, Math.max(word.indexOf('='), 0));
    if (ASSIGNMENT.test(word) && CONFIG_VARIABLES.includes(name)) given[name] = configHome(word.slice(name.length + 1), context);
  }
  if (Object.keys(given).length === 0) return context.envs;
  const bases = context.envs.length ? context.envs : [{}];
  return [...context.envs, ...bases.map((env) => ({ ...env, ...given }))];
}

/** The default config files of `curl` or `wget` in the environments it may start with; `unread` when one names their folder in a way the guard cannot tell. */
function programDefaults(program, envs) {
  const unread = envs.some((env) => CONFIG_HOMES[program].some((name) => env[name] === null));
  return { files: unique(envs.flatMap(program === 'curl' ? curlrcPaths : wgetrcPaths)), unread };
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

/** The write a `gh api` call makes (ghApiWrites), or null; `gh`'s other commands are not looked at. */
function ghWrite(args, syntax) {
  const api = args.findIndex((a) => !a.startsWith('-'));
  if (args[api] !== 'api') return null;
  return ghApiWrites(args.slice(api + 1), syntax) ? 'gh api to GitHub' : null;
}

/** Whether curl's arguments and config files (curlConfigs) send a change, with the options read. */
function curlWrites(args, defaults, context) {
  const given = readOptions(args, CURL_SHORT, (name) => CURL_LONG.has(name));
  const config = curlConfigs(args, given.options, defaults, context);
  const read = { options: [...given.options, ...config.options], positionals: given.positionals };
  const write = config.unread || read.options.some((o) => ((o.name === '-X' || o.name === '--request') && writesBy(o.value)) || CURL_BODY.test(o.name));
  return { read, write };
}

/** A wget option that sends a body or sets the method, by any unambiguous prefix (`--post-d`). */
const wgetWrite = (name) => name.length > 3 && WGET_WRITES.some((option) => option.startsWith(name));
/** wget's `--config` option, by any unambiguous prefix (`--conf`). */
const wgetConfig = (name) => name.length >= 6 && '--config'.startsWith(name);
/** A wgetrc command that sends a body or sets a method other than GET, HEAD or OPTIONS. */
const wgetrcWrites = (line) => WGET_RC_WRITE.test(line) && !/^\s*method\s*=\s*(?:get|head|options)\s*$/i.test(line);

/**
 * Whether wget's arguments and config files send a change, with the options read: a writing
 * option, an `-e` command or a line of a wgetrc (its default files unless `--no-config`, and each
 * `--config` file; configTexts) that writes (wgetrcWrites), or a config file it cannot read.
 */
function wgetWrites(args, defaults, context) {
  const read = readOptions(args, WGET_SHORT, (name) => WGET_LONG.has(name) || wgetWrite(name) || wgetConfig(name));
  const off = read.options.some((o) => o.name === '--no-config');
  const config = configTexts(off ? NO_DEFAULTS : defaults, read.options.filter((o) => wgetConfig(o.name)).map((o) => o.value), context);
  const commands = read.options.filter((o) => o.name === '-e' || o.name === '--execute').map((o) => o.value ?? '');
  const lines = [...commands, ...config.texts.flatMap((text) => text.split(/\r?\n/))];
  const write = config.unread || lines.some(wgetrcWrites) || read.options.some((o) => wgetWrite(o.name) && (!o.name.startsWith('--me') || writesBy(o.value)));
  return { read, write };
}

/**
 * The direct write a segment makes to a connected service, as `<program> to <host>`, or null:
 * `curl` or `wget` with a writing method or a body to a connected host (or to none it can name),
 * `gh api` that writes (ghWrite). `gh`'s other commands are not looked at. curl's and wget's
 * config files add their options, found in the environments the command gives them
 * (programEnvs); one that cannot be read makes it a write.
 * @param {{exe: string|null, args: string[], tokens: string[]}} segment
 * @param {string[]} hosts the connected hosts
 * @param {Set<string>} syntax the command's shell syntax (shellSyntax)
 * @param {{envs: object[], segments: object[], dirs: string[], unknown: boolean}} context where the config files are
 * @returns {string|null}
 */
function httpWrite(segment, hosts, syntax, context) {
  if (quietSegment(segment)) return null;
  const { tokens } = segment;
  const from = executedFrom(segment);
  const at = tokens.findIndex((t, i) => i >= from && ['curl', 'wget', 'gh'].includes(posix.basename(t)));
  if (at < 0) return null;
  const program = posix.basename(tokens[at]);
  const args = tokens.slice(at + 1);
  if (program === 'gh') return ghWrite(args, syntax);
  const defaults = programDefaults(program, programEnvs(programWords(segment, at, context), context));
  const { read, write } = (program === 'curl' ? curlWrites : wgetWrites)(args, defaults, context);
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
 * @param {{envs?: Record<string, string|null|undefined>[], depth?: number}} [options] the environments
 *   the command may start with, where curl's and wget's default config files are found (none: no
 *   default file is read unless the command names its folder), and how many shells deep `command` runs
 * @returns {{verdict: 'free'|'denied'|'write', tools: string[], call?: object, http?: string, nested?: {shell: string, inner: string}}}
 */
export function classify(command, cwd, writes = WRITES, hosts = CONNECTED_HOSTS, { envs = [], depth = 0 } = {}) {
  const raw = shellSegments(withoutRedirections(command));
  const parsed = { segments: raw.map(bodyOf), cwd, clis: realClis(writes), writes, nested: new Map() };
  const syntax = shellSyntax(command);
  const context = { ...workingDirs(parsed.segments, cwd), envs, segments: parsed.segments, text: plainText(command), cwd, writes, hosts, depth };
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
  const { tools, coded } = mentionedTools(command, parsed);
  const free = { verdict: 'free', tools: [...tools] };
  if (!tools.size) return free;
  const verbs = (tools.has('?') ? Object.keys(writes) : [...tools]).flatMap((tool) => writes[tool]);
  // Code that mentions a tool may build its command word at run time (`'com'+'ment'`): it passes as a read only.
  if (!coded && !hasVerbWord(context.text, verbs) && !EXPANDS.test(context.text)) return free;
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
function check(command, cwd, sid, hosts) {
  const result = classify(command, cwd, WRITES, hosts, { envs: [process.env] });
  if (result.verdict === 'free') return;
  if (result.nested) return deny(nestedReason(result.nested, result.tools));
  if (result.http) {
    return deny(`oikos write guard: direct write to a connected service (${result.http}) — use the oikos tool with --dry-run.`);
  }
  if (result.verdict === 'denied') return deny(strictForm(result.tools));
  const { call } = result;
  const label = `${call.tool} ${writeWord(call, WRITES) ?? call.verb}`;
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
    check(command, cwd, sid, hosts);
  } catch (e) {
    // Fail closed where it matters: a command that may name a write tool, or make a direct HTTP
    // write, is denied, not let through.
    if (Object.keys(WRITES).some((tool) => command.includes(tool)) || command.includes('cli.mjs') || /\b(?:curl|wget|gh)\b/.test(command)) {
      deny(`oikos write guard: could not read this command (${e.message}); ${strictForm([])}`);
    }
  }
}
