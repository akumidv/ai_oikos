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

const STATE_DIR = join(tmpdir(), 'oikos-hooks');
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

/**
 * A Bash command split into segments at `;` `&&` `||` `|` `&` newlines and parentheses, each a
 * list of quote-aware tokens with the leading control words (`if`, `then`, `do`, `!`, `{`, …),
 * `VAR=…`, `env …` and the wrappers (`command`, `nohup`, `time`, `exec`, `timeout`, `nice`, `xargs`, …)
 * stripped, so `exe` is the program actually run (`for b in x; do git push; done` runs `git`). Best effort: text inside `bash -c "…"` or a
 * heredoc is one token and is not looked into here (the write guard reads `bash -c` itself).
 */
export function shellSegments(command) {
  const segments = [];
  let tokens = [];
  let token = null;
  let quote = null;
  const endToken = () => { if (token !== null) tokens.push(token); token = null; };
  const endSegment = () => { endToken(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      // In double quotes bash drops a backslash only before $ ` " \ and a newline (the pair
      // `\`+newline vanishes); before any other character it stays.
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && command[i + 1] === '\n') i++;
      else if (ch === '\\' && quote === '"' && '$`"\\'.includes(command[i + 1] ?? 'x')) token += command[++i];
      else token += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      token ??= '';
    } else if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] === '\n') i++;
      else token = (token ?? '') + command[++i];
    } else if (';&|\n()'.includes(ch)) {
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      token = (token ?? '') + ch;
    }
  }
  endSegment();
  return segments.map(stripPrefix);
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
 * nothing runs (`command -v git`). `env` has its own reading, in stripPrefix. A program that takes its
 * command as one string (`flock -c`, `watch`, `su -c`) is not here.
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
  xargs: { values: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--max-lines', '--process-slot-var'] },
};
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const programOf = (word) => (word ? word.split('/').pop() : null);

/** The index of the command after the wrapper `spec` whose own words end before `from`: its options, their values and its operands passed; -1 when nothing runs after it (`command -v git`). */
function afterWrapper(tokens, from, spec) {
  let i = from;
  for (; i < tokens.length && tokens[i].startsWith('-') && tokens[i].length > 1; i++) {
    if (tokens[i] === '--') { i++; break; }
    if (spec.stopAt?.includes(tokens[i])) return -1;
    if (spec.values?.includes(tokens[i])) i++;
  }
  return Math.min(i + (spec.operands ?? 0), tokens.length);
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
function afterEnv(tokens, from) {
  let words = tokens;
  let i = from;
  while (i < words.length && (words[i].startsWith('-') || ASSIGNMENT_WORD.test(words[i]))) {
    const split = splitString(words, i);
    if (split) words = [...words.slice(0, i), ...splitWords(split.text), ...words.slice(i + split.used)];
    else i += ENV_VALUES.includes(words[i]) ? 2 : 1;
  }
  return { words, at: i };
}

/**
 * One segment's tokens read as shellSegments reads them: the leading control words, `VAR=…`, `env …` and
 * the wrappers (WRAPPERS) stripped to find `exe`, the program actually run. `env -S "git …"` is read as
 * the words of its string, which replace it in `tokens`; otherwise `tokens` stays the segment as written.
 * @param {string[]} tokens
 * @returns {{exe: string|null, args: string[], viaEnv: boolean, tokens: string[]}}
 */
export function stripPrefix(tokens) {
  let words = tokens;
  let i = 0;
  let viaEnv = false;
  while (i < words.length && CONTROL_WORDS.has(words[i])) i++;
  for (;;) {
    while (i < words.length && ASSIGNMENT_WORD.test(words[i])) i++;
    const program = programOf(words[i]);
    if (program === 'env') {
      viaEnv = true;
      ({ words, at: i } = afterEnv(words, i + 1));
      continue;
    }
    const after = program !== null && Object.hasOwn(WRAPPERS, program) ? afterWrapper(words, i + 1, WRAPPERS[program]) : -1;
    if (after < 0) break;
    i = after;
  }
  return { exe: programOf(words[i]), args: words.slice(i + 1), viaEnv, tokens: words };
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
