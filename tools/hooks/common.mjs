// Shared plumbing for the oikos hooks in tools/hooks/: payload in, JSON out, per-session state in
// the temp directory. A hook never crashes a tool call or a prompt: on its own failure it says so
// in the UI and lets the action through (fail open). The event payload and
// this output shape are the same in every agent host oikos runs under; where the hosts differ is
// the names of their tools, and that is tools/hooks/host.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function readPayload() {
  try {
    const data = JSON.parse(readFileSync(0, 'utf8') || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function print(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

/** The folder where the hooks keep their per-session state; no tool of an agent writes there (the shell guard and package-guard deny it). */
export const STATE_DIR = join(tmpdir(), 'oikos-hooks');
const statePath = (sessionId, kind) => join(STATE_DIR, `${kind}-${String(sessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export function readState(sessionId, kind, fallback) {
  try {
    return JSON.parse(readFileSync(statePath(sessionId, kind), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeState(sessionId, kind, value) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(sessionId, kind), JSON.stringify(value));
}

/** The characters after which an unquoted `~` is still expanded: an assignment, a path list, a brace group. */
const TILDE_AFTER = ['=', ':', '{', ','];

/**
 * A Bash command split into segments at `;` `&&` `||` `|` `&` newlines and parentheses, each a
 * list of quote-aware tokens with the leading control words (`if`, `then`, `do`, `!`, `{`, …),
 * `VAR=…`, `env …` and the wrappers (`command`, `nohup`, `time`, `exec`, `timeout`, `nice`, `xargs`, …)
 * stripped, so `exe` is the program actually run (`for b in x; do git push; done` runs `git`). Best effort: text inside `bash -c "…"` is one
 * token and is not looked into here (the write guard reads `bash -c` itself). The text of a heredoc is
 * tokenized as commands, line by line (no quote reaches over a line of it), and its segments are `heredoc`.
 *
 * Each segment also carries `quoting`, one entry per token: what the shell may still expand in it,
 * `{ tilde, brace }` — a `~` at the start of the token (or after an unquoted `=` or `:`, or `{` or `,`) and a `{`, both
 * outside quotes and not escaped — or null when that is not known (a word `env -S` split out of a string).
 * @param {string} command
 * @returns {{exe: string|null, args: string[], viaEnv: boolean, tokens: string[], quoting: ({tilde: boolean, brace: boolean}|null)[], heredoc: boolean}[]}
 */
export function shellSegments(command) {
  const segments = [];
  let tokens = [];
  let quoting = [];
  let token = null;
  let live = { tilde: false, brace: false };
  let previous = null; // the last character added to the token; null when it was quoted
  let quote = null;
  let body = null; // { delimiters, lineStart } while the lines of a heredoc body are read
  let waiting = []; // the heredocs opened on the line being read, whose bodies follow it
  let arithmetic = 0; // how many `((` are open
  const endToken = () => {
    if (token !== null) { tokens.push(token); quoting.push(live); }
    token = null;
    live = { tilde: false, brace: false };
    previous = null;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push({ tokens, quoting, heredoc: body !== null });
    tokens = [];
    quoting = [];
  };
  const add = (ch, unquoted) => {
    if (unquoted && ch === '{') live.brace = true;
    if (unquoted && ch === '~' && (token === null || TILDE_AFTER.includes(previous))) live.tilde = true;
    token = (token ?? '') + ch;
    previous = unquoted ? ch : null;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (body !== null && ch === '\n') {
      // A heredoc body is plain lines: no quote reaches over one, and the line equal to the delimiter ends it.
      const line = command.slice(body.lineStart, i);
      endSegment();
      quote = null;
      const [{ delimiter, strip }] = body.delimiters;
      if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) body.delimiters.shift();
      body = body.delimiters.length ? { delimiters: body.delimiters, lineStart: i + 1 } : null;
      continue;
    }
    if (quote) {
      // In double quotes bash drops a backslash only before $ ` " \ and a newline (the pair
      // `\`+newline vanishes); before any other character it stays.
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && command[i + 1] === '\n') i++;
      else if (ch === '\\' && quote === '"' && '$`"\\'.includes(command[i + 1] ?? 'x')) add(command[++i], false);
      else add(ch, false);
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      token ??= '';
      previous = null;
    } else if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] === '\n') i++;
      else add(command[++i], false);
    } else if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<' && body === null && arithmetic === 0) {
      waiting.push(heredocAt(command, i + 2));
      add(ch, true);
    } else if (ch === '\n' && body === null && waiting.length) {
      endSegment();
      body = { delimiters: waiting, lineStart: i + 1 };
      waiting = [];
    } else if (';&|\n()'.includes(ch)) {
      if (ch === '(' && command[i - 1] === '(') arithmetic++; // `((1<<2))`: a shift, no heredoc
      else if (ch === ')' && command[i - 1] === ')' && arithmetic > 0) arithmetic--;
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      add(ch, true);
    }
  }
  endSegment();
  return segments.map(({ tokens: words, quoting: marks, heredoc }) => stripPrefix(words, { quoting: marks, heredoc }));
}

/** The heredoc whose `<<` ends just before `from`: its delimiter, quotes removed, and whether the operator was `<<-` (the leading tabs of the body's lines are ignored). */
function heredocAt(command, from) {
  let i = from;
  const strip = command[i] === '-';
  if (strip) i++;
  while (command[i] === ' ' || command[i] === '\t') i++;
  return { delimiter: delimiterAt(command, i), strip };
}

/** The word that starts at `from` in `command`, quotes and backslashes removed: the delimiter of a heredoc. */
function delimiterAt(command, from) {
  let delimiter = '';
  let quote = null;
  for (let i = from; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else delimiter += ch;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\' && i + 1 < command.length) delimiter += command[++i];
    else if (/[\s;&|()<>]/.test(ch)) break;
    else delimiter += ch;
  }
  return delimiter;
}

/**
 * The shell's control words that may stand before a command in one segment: the command after
 * them is the one that runs. A reserved word counts only as the first word of a command or after
 * another one, so they are stripped before any `VAR=…` or prefix, never after.
 */
const CONTROL_WORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{']);

/**
 * The programs that run the command written after them (`timeout 30 git push`), each with how many words
 * it takes before that command: `values` the options whose value is the next word (`-s KILL`; an attached
 * `-sKILL` or `--signal=KILL` is one word and needs no entry) and `operands` the plain words that follow
 * the options (a duration, a priority, a mask, a lock file). `stopAt` lists the options after which
 * nothing runs (`command -v git`), and `optionsAfter` that options may follow the operands (`setarch x86_64
 * -R git`). `env` has its own reading, in stripPrefix. Short options may be clustered (`strace -fo file`:
 * `f` is a flag and `o` takes the next word; `-ofile` carries its value), read from the single-letter
 * entries of `values`. A program that takes its command as one string (`flock -c`, `su -c`) is not
 * here (`watch` is: it runs the words after its options as one command, and `busybox` runs the applet that follows it), and nor is a configuration value that names one (`git -c core.pager="cat > file" log`): accepted
 * residuals (ADR 0007 D02, task L5) — what such a string runs is no longer a word of the command.
 */
const WRAPPERS = {
  command: { stopAt: ['-v', '-V'] },
  nohup: {},
  builtin: {},
  exec: { values: ['-a'] },
  time: { values: ['-f', '-o', '--format', '--output'] },
  timeout: { values: ['-s', '--signal', '-k', '--kill-after'], operands: 1 },
  nice: { values: ['-n', '--adjustment'] },
  ionice: { values: ['-c', '--class', '-n', '--classdata', '-P', '--pgid', '-u', '--uid'] },
  stdbuf: { values: ['-i', '--input', '-o', '--output', '-e', '--error'] },
  setsid: {},
  flock: { values: ['-w', '--timeout', '-E', '--conflict-exit-code'], operands: 1 },
  taskset: { operands: 1 },
  chrt: { values: ['-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline'], operands: 1 },
  strace: { values: ['-a', '-b', '-e', '-E', '-I', '-o', '-O', '-p', '-P', '-s', '-S', '-u', '-U', '-X', '--output', '--trace', '--env', '--user', '--attach', '--string-limit', '--signal'] },
  ltrace: { values: ['-a', '-A', '-D', '-e', '-F', '-l', '-n', '-o', '-p', '-s', '-u', '-w', '-x', '--output'] },
  setarch: { operands: 1, optionsAfter: true },
  unshare: { values: ['-S', '-G', '-R', '-w', '--map-user', '--map-group', '--map-users', '--map-groups', '--setgroups', '--propagation', '--root', '--wd', '--setuid', '--setgid'] },
  prlimit: { values: ['-p', '--pid'] },
  nsenter: { values: ['-t', '--target', '-S', '--setuid', '-G', '--setgid', '--wdns'] },
  firejail: {},
  'systemd-run': { values: ['-p', '--property', '-u', '--unit', '--slice', '-E', '--setenv', '--uid', '--gid', '-M', '--machine', '-H', '--host', '--description', '--service-type', '--nice', '--working-directory', '--on-active', '--on-calendar'] },
  eatmydata: {},
  fakeroot: { values: ['-l', '--lib', '--faked', '-i', '-s', '-b', '--fd-base'] },
  faketime: { operands: 1 },
  valgrind: {},
  busybox: {},
  watch: { values: ['-n', '--interval'] },
  xargs: { values: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--max-lines', '--process-slot-var'] },
};
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const programOf = (word) => (word ? word.split('/').pop() : null);

/** The first of the single `letters` that a clustered short-option word (`-fo`) holds, with whether it is the word's last letter (its value is then the next word; otherwise it is attached); null when none, or the word is no cluster. */
function clustered(word, letters) {
  if (word.length < 3 || word[1] === '-') return null;
  for (let at = 1; at < word.length; at++) {
    if (letters.includes(word[at])) return { letter: word[at], last: at === word.length - 1 };
  }
  return null;
}

/** The single letters among the options `names` (`-o` gives `o`). */
const lettersOf = (names = []) => names.filter((name) => /^-[A-Za-z]$/.test(name)).map((name) => name[1]).join('');

/** The index just after the options (and their values) of the wrapper `spec` that start at `from`; -1 when one of them ends the command (`command -v git`). */
function afterOptions(tokens, from, spec) {
  let i = from;
  const valued = lettersOf(spec.values);
  const stopping = lettersOf(spec.stopAt);
  for (; i < tokens.length && tokens[i].startsWith('-') && tokens[i].length > 1; i++) {
    if (tokens[i] === '--') return i + 1;
    const taken = optionTakes(tokens[i], spec, { valued, stopping });
    if (taken < 0) return -1;
    i += taken;
  }
  return i;
}

/** How many words after the option `word` of the wrapper `spec` it takes (0 or 1), or -1 when it ends the command; `valued` and `stopping` are the letters of the short options that take a value or end the command. */
function optionTakes(word, spec, { valued, stopping }) {
  if (spec.stopAt?.includes(word)) return -1;
  if (spec.values?.includes(word)) return 1;
  const cluster = clustered(word, stopping + valued);
  if (cluster && stopping.includes(cluster.letter)) return -1;
  return cluster?.last && valued.includes(cluster.letter) ? 1 : 0;
}

/** The index of the command after the wrapper `program` that stands at `tokens[at]`; -1 when `program` is none or nothing runs after it. */
const wrapperEnd = (tokens, at, program) => (program !== null && Object.hasOwn(WRAPPERS, program) ? afterWrapper(tokens, at + 1, WRAPPERS[program]) : -1);

/** The index of the command after the wrapper `spec` whose own words end before `from`: its options, their values and its operands passed; -1 when nothing runs after it (`command -v git`). */
function afterWrapper(tokens, from, spec) {
  const options = afterOptions(tokens, from, spec);
  if (options < 0) return -1;
  const operands = Math.min(options + (spec.operands ?? 0), tokens.length);
  return spec.optionsAfter && operands > options ? afterOptions(tokens, operands, spec) : operands;
}

const WORD = /(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+/g;
const QUOTED_PIECE = /"((?:[^"\\]|\\.)*)"|'([^']*)'|\\(.)/g;

/** The words of the string `env -S` is given: split at spaces, with quotes (single or double) and backslashes honoured. */
const splitWords = (text) => (text.match(WORD) ?? []).map((word) => word.replace(QUOTED_PIECE,
  (_, double, single, escaped) => double?.replace(/\\(.)/g, '$1') ?? single ?? escaped));

/** The string the option of `env` at `tokens[i]` carries when it is `-S` / `--split-string`, and how many tokens it spans; null for any other option. */
function splitString(tokens, i) {
  const word = tokens[i];
  if (word === '-S' || word === '--split-string') return tokens[i + 1] === undefined ? null : { text: tokens[i + 1], used: 2 };
  if (word.startsWith('--split-string=')) return { text: word.slice('--split-string='.length), used: 1 };
  if (/^-S./.test(word)) return { text: word.slice(2), used: 1 };
  return null;
}

/** The options of `env` that take the next word as their value. */
const ENV_VALUES = ['-u', '--unset', '-C', '--chdir'];

/** The words after `env` from `from` on, with the string of an `-S` option split into the words it stands for, and the index of the command they lead to. */
function afterEnv(tokens, marks, from) {
  let words = tokens;
  let quoting = marks;
  let i = from;
  while (i < words.length && (words[i].startsWith('-') || ASSIGNMENT_WORD.test(words[i]))) {
    const split = splitString(words, i);
    if (split) {
      const inner = splitWords(split.text);
      words = [...words.slice(0, i), ...inner, ...words.slice(i + split.used)];
      quoting = [...quoting.slice(0, i), ...inner.map(() => null), ...quoting.slice(i + split.used)];
    } else i += ENV_VALUES.includes(words[i]) ? 2 : 1;
  }
  return { words, quoting, at: i };
}

/** The index of the command after the control words that start `words` (`if`, `{`, …) and a `function name` header. */
function afterControl(words, from) {
  let i = from;
  while (i < words.length && CONTROL_WORDS.has(words[i])) i++;
  if (words[i] !== 'function') return i;
  i = Math.min(i + 2, words.length);
  while (i < words.length && CONTROL_WORDS.has(words[i])) i++;
  return i;
}

/**
 * One segment's tokens read as shellSegments reads them: the leading control words, `VAR=…`, `env …` and
 * the wrappers (WRAPPERS) stripped to find `exe`, the program actually run. `env -S "git …"` is read as
 * the words of its string, which replace it in `tokens` (and are unknown in `quoting`); otherwise `tokens`
 * stays the segment as written.
 * @param {string[]} tokens
 * @param {{quoting?: ({tilde: boolean, brace: boolean}|null)[], heredoc?: boolean}} [kept] what shellSegments knows of the tokens: `quoting` as it gives it (null for every token when absent), and `heredoc`
 * @returns {{exe: string|null, args: string[], viaEnv: boolean, tokens: string[], quoting: ({tilde: boolean, brace: boolean}|null)[], heredoc: boolean}}
 */
export function stripPrefix(tokens, kept = {}) {
  let words = tokens;
  let quoting = kept.quoting ?? tokens.map(() => null);
  let i = 0;
  let viaEnv = false;
  i = afterControl(words, i);
  for (;;) {
    while (i < words.length && ASSIGNMENT_WORD.test(words[i])) i++;
    const program = programOf(words[i]);
    if (program === 'env') {
      viaEnv = true;
      ({ words, quoting, at: i } = afterEnv(words, quoting, i + 1));
      continue;
    }
    const after = wrapperEnd(words, i, program);
    if (after < 0) break;
    i = after;
  }
  return { exe: programOf(words[i]), args: words.slice(i + 1), viaEnv, tokens: words, quoting, heredoc: kept.heredoc === true };
}

/** PreToolUse decisions. `ask` reaches a person only in an interactive default mode — Claude Code
 * names it `default`, Qwen Code too (`plan|default|auto-edit|auto|yolo`); an unattended ask was
 * measured to be a silent no-op. Everywhere else it is turned into a deny that says how to run
 * the command oneself. */
export function decide(payload, decision, reason) {
  const unattended = decision === 'ask' && payload.permission_mode && payload.permission_mode !== 'default';
  print({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: unattended ? 'deny' : decision,
      permissionDecisionReason: unattended
        ? `${reason} (Permission mode "${payload.permission_mode}" cannot ask, so this is denied: the user runs it themselves with \`! <command>\`, or in the default mode.)`
        : reason,
    },
  });
}
